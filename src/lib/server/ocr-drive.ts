// Free Google Drive OCR: each page is rendered to a JPEG, uploaded into the hidden `Waraq/.ocr-tmp` folder as a
// Google Doc (Drive OCRs images on import), exported as text/plain, then the temporary Doc is deleted.
// Sequential, per-page retry with backoff, page cap, result cache by page-image hash, and Tesseract fallback
// per page. Runs in its own worker so it never blocks document operations or the Tesseract queue.
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getDb } from "./db";
import { nowIso } from "./ids";
import { run } from "./exec";
import { jobPayload, markJob, requeueRunning, setJobKick, type OcrJobPayload } from "./jobs";
import { withDocLock } from "./locks";
import { withTempDir } from "./storage";
import { docPdfFile } from "./doc-storage";
import { renderPdfPageJpeg } from "./render";
import { ftsSync, getDocRow } from "./docs";
import { DRIVE_KEYS, getSetting, isDriveConnected, setRefreshToken, setSetting, setLastError } from "./drive-store";
import {
  createFolder,
  deleteFile,
  DriveAuthError,
  DriveError,
  exportPlainText,
  findByAppProperty,
  getFile,
  listChildren,
  resetAccessToken,
  uploadImageForOcr,
} from "./drive-api";
import { ensureRoot } from "./drive-sync";
import { getPrefs } from "./prefs";
import { cleanText } from "./ocr";

interface JobRow {
  id: number;
  doc_id: string;
  payload: string | null;
  attempts: number;
}

/** Drive only OCRs images up to 2 MB. */
const MAX_JPEG_BYTES = 1_900_000;
const RENDER_WIDTH = 2000;
const PAGE_SEPARATOR = "\f";

export const DRIVE_OCR = {
  pageRetries: 4,
  backoffBaseMs: 2000,
  backoffMaxMs: 60_000,
  gapMs: 300,
  /** give up on the rest of the document after this many pages in a row failed */
  maxConsecutiveFailures: 3,
};

export function driveOcrMaxPages(): number {
  const v = Number(process.env.WARAQ_DRIVE_OCR_MAX_PAGES);
  return Number.isInteger(v) && v > 0 ? v : 150;
}

const ISO: Record<string, string> = { ara: "ar", eng: "en" };

/** Drive `ocrLanguage` hints in preference order (primary first, then fallback). */
export function driveOcrLanguages(): string[] {
  const langs = getPrefs().ocr.languages.map((l) => ISO[l]).filter(Boolean);
  return langs.length ? langs : ["ar", "en"];
}

const g = globalThis as unknown as {
  __waraqDriveOcr?: { running: boolean; started: boolean; idle: Array<() => void>; tmpVerified: number; sleep?: (ms: number) => Promise<void> };
};

function state() {
  return (g.__waraqDriveOcr ??= { running: false, started: false, idle: [], tmpVerified: 0 });
}

const sleep = (ms: number) => (state().sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);

/** Tests: replace timers so backoff does not slow the suite. */
export function setDriveOcrSleep(fn: ((ms: number) => Promise<void>) | undefined) {
  state().sleep = fn;
}

export function resetDriveOcrState() {
  state().tmpVerified = 0;
}

export function startDriveOcrWorker(): void {
  const s = state();
  setJobKick("ocr_drive", () => void pumpDriveOcr());
  if (s.started) return;
  s.started = true;
  requeueRunning("ocr_drive");
  setTimeout(() => void pumpDriveOcr(), 3000).unref?.();
}

export function waitForDriveOcrIdle(): Promise<void> {
  const s = state();
  const pending = getDb().prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running') AND kind = 'ocr_drive' LIMIT 1").get();
  if (!s.running && !pending) return Promise.resolve();
  return new Promise((r) => s.idle.push(r));
}

export async function pumpDriveOcr(): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    for (;;) {
      const job = getDb()
        .prepare("SELECT id, doc_id, payload, attempts FROM jobs WHERE status = 'queued' AND kind = 'ocr_drive' ORDER BY id LIMIT 1")
        .get() as JobRow | undefined;
      if (!job) break;
      await Promise.resolve().then(() => runDriveOcrJob(job)).catch((e) => {
        console.error(`[waraq] drive ocr job ${job.id} crashed:`, (e as Error).message);
        markJob(job.id, "error", (e as Error).message);
      });
    }
  } finally {
    s.running = false;
    s.idle.splice(0).forEach((w) => w());
  }
}

/* ------------------------------------------------------------------ Drive scratch folder */

async function ensureTmpFolder(): Promise<string> {
  const root = await ensureRoot();
  const s = state();
  const id = getSetting(DRIVE_KEYS.ocrTmpFolderId);
  if (id && Date.now() - s.tmpVerified < 10 * 60_000) return id;
  if (id) {
    const f = await getFile(id);
    if (f && !f.trashed) {
      s.tmpVerified = Date.now();
      return id;
    }
  }
  const found = await findByAppProperty("waraqOcrTmpFolder", "1");
  const f = found && found.parents?.includes(root) ? found : await createFolder(".ocr-tmp", root, { waraqOcrTmpFolder: "1" });
  setSetting(DRIVE_KEYS.ocrTmpFolderId, f.id);
  s.tmpVerified = Date.now();
  // leftovers from a crash between upload and delete
  try {
    for (const c of await listChildren(f.id)) await deleteFile(c.id);
  } catch {
    /* best effort */
  }
  return f.id;
}

/* ------------------------------------------------------------------ per page */

/** Render a page to a JPEG under Drive's 2 MB OCR limit. */
export async function renderPageForOcr(pdfPath: string, index: number, dir: string): Promise<Buffer> {
  const p = path.join(dir, `p${index}.jpg`);
  await renderPdfPageJpeg(pdfPath, index, p, RENDER_WIDTH);
  let buf = await fsp.readFile(p);
  await fsp.rm(p, { force: true });
  for (const [width, quality] of [[RENDER_WIDTH, 80], [1800, 72], [1600, 65]] as const) {
    if (buf.byteLength <= MAX_JPEG_BYTES) break;
    buf = await sharp(buf).resize({ width, withoutEnlargement: true }).jpeg({ quality }).toBuffer();
  }
  return buf;
}

function retryDelay(e: unknown, attempt: number): number {
  const base = Math.min(DRIVE_OCR.backoffBaseMs * 2 ** attempt, DRIVE_OCR.backoffMaxMs);
  const hinted = e instanceof DriveError ? (e.retryAfterMs ?? 0) : 0;
  return Math.min(Math.max(base, hinted), 5 * 60_000);
}

function retryable(e: unknown): boolean {
  if (e instanceof DriveAuthError) return false;
  if (e instanceof DriveError) return e.retryable || e.status === 0 || e.status >= 500;
  return true;
}

/** One Drive OCR round trip; the temporary Google Doc is always deleted. */
async function ocrOnce(jpeg: Buffer, folder: string, language: string, name: string): Promise<string> {
  const f = await uploadImageForOcr({ name, parentId: folder, jpeg, language });
  try {
    return await exportPlainText(f.id);
  } finally {
    try {
      await deleteFile(f.id);
    } catch {
      /* swept on next folder check */
    }
  }
}

async function ocrPage(jpeg: Buffer, folder: string, name: string): Promise<string> {
  const langs = driveOcrLanguages();
  let text = "";
  for (let li = 0; li < langs.length; li++) {
    for (let attempt = 0; ; attempt++) {
      try {
        text = await ocrOnce(jpeg, folder, langs[li], name);
        break;
      } catch (e) {
        if (!retryable(e) || attempt >= DRIVE_OCR.pageRetries) throw e;
        await sleep(retryDelay(e, attempt));
      }
    }
    if (text.trim()) break; // nothing recognised with the primary language: try the fallback hint
  }
  return text;
}

/* ------------------------------------------------------------------ job */

async function tesseractPages(pdf: string): Promise<string[]> {
  const r = await run("pdftotext", ["-layout", "-enc", "UTF-8", pdf, "-"], { timeoutMs: 300_000 });
  if (r.code !== 0) return [];
  const pages = r.stdout.toString("utf8").split("\f");
  return pages.map((p) => cleanText(p));
}

export async function runDriveOcrJob(job: JobRow): Promise<void> {
  const db = getDb();
  const row = getDocRow(job.doc_id);
  if (!row || row.status !== "ready" || row.trashed_at) return markJob(job.id, "done", row ? "skipped" : undefined);
  if (!isDriveConnected() || !getPrefs().ocr.useDriveOcr) return markJob(job.id, "done", "drive ocr disabled");
  const payload = jobPayload<OcrJobPayload>(job.payload);
  const version = row.version;
  db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(nowIso(), job.id);

  await withTempDir("drive-ocr", async (dir) => {
    const pdf = path.join(dir, "in.pdf");
    await withDocLock(job.doc_id, async () => fsp.copyFile(await docPdfFile(job.doc_id), pdf));
    const fromPdf = await tesseractPages(pdf);
    const stored = (row.ocr_layer_text ?? "").split(PAGE_SEPARATOR);
    const fallback = Array.from({ length: row.page_count }, (_, i) =>
      fromPdf[i] || (stored.length >= row.page_count ? cleanText(stored[i] ?? "") : ""),
    );
    const max = driveOcrMaxPages();
    const cacheQ = db.prepare(
      "SELECT text FROM ocr_pages WHERE hash = ? AND engine = 'drive' LIMIT 1",
    );
    const results: { engine: "drive" | "tesseract"; hash: string | null; text: string }[] = [];
    let folder: string | null = null;
    let consecutive = 0;
    let lastError: string | null = null;
    let aborted = false;

    for (let i = 0; i < row.page_count; i++) {
      const tess = fallback[i] ?? "";
      if (aborted || i >= max) {
        results.push({ engine: "tesseract", hash: null, text: tess });
        continue;
      }
      let jpeg: Buffer;
      try {
        jpeg = await renderPageForOcr(pdf, i, dir);
      } catch (e) {
        lastError = (e as Error).message;
        results.push({ engine: "tesseract", hash: null, text: tess });
        continue;
      }
      const hash = createHash("sha256").update(driveOcrLanguages().join(",")).update(jpeg).digest("hex");
      const cached = payload.force ? undefined : (cacheQ.get(hash) as { text: string } | undefined);
      if (cached) {
        results.push({ engine: "drive", hash, text: cached.text });
        continue;
      }
      try {
        folder ??= await ensureTmpFolder();
        const text = cleanText(await ocrPage(jpeg, folder, `waraq-ocr-${job.doc_id}-p${i + 1}`));
        results.push({ engine: "drive", hash, text });
        consecutive = 0;
        await sleep(DRIVE_OCR.gapMs);
      } catch (e) {
        lastError = (e as Error).message;
        results.push({ engine: "tesseract", hash: null, text: tess });
        if (e instanceof DriveAuthError) {
          setRefreshToken(null);
          resetAccessToken();
          setSetting(DRIVE_KEYS.needsReconnect, "1");
          setLastError(e.message);
          aborted = true;
        } else if (++consecutive >= DRIVE_OCR.maxConsecutiveFailures) {
          aborted = true;
        }
      }
    }

    const drivePages = results.filter((r) => r.engine === "drive").length;
    await withDocLock(job.doc_id, async () => {
      const cur = getDocRow(job.doc_id);
      if (!cur || cur.version !== version) return markJob(job.id, "done", "superseded");
      if (drivePages === 0) {
        // nothing improved: keep the Tesseract text
        return markJob(job.id, "error", lastError ?? "Drive OCR produced no pages");
      }
      const text = results.map((r) => r.text).join(PAGE_SEPARATOR).trim();
      const now = nowIso();
      db.transaction(() => {
        db.prepare("DELETE FROM ocr_pages WHERE doc_id = ?").run(job.doc_id);
        const ins = db.prepare("INSERT INTO ocr_pages (doc_id, page, engine, hash, text, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
        results.forEach((r, i) => ins.run(job.doc_id, i, r.engine, r.hash, r.text, now));
        db.prepare("UPDATE documents SET ocr_text = ?, ocr_engine = 'drive' WHERE id = ?").run(text, job.doc_id);
      })();
      ftsSync(job.doc_id);
      markJob(job.id, lastError ? "error" : "done", lastError ?? undefined);
    });
    if (lastError) console.error(`[waraq] drive ocr for job ${job.id}: ${drivePages}/${row.page_count} pages via Drive; last error: ${lastError.slice(0, 160)}`);
  });
}
