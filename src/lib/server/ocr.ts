import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getDb } from "./db";
import { nowIso } from "./ids";
import { LIMITS } from "./config";
import { run } from "./exec";
import { enqueueJob, jobPayload, kickJobs, markJob, requeueRunning, setJobKick, type OcrJobPayload } from "./jobs";
import { withDocLock } from "./locks";
import { withTempDir } from "./storage";
import { docPdfFile, pruneRenders, writeDocBytes } from "./doc-storage";
import { inspectPdf } from "./pdf";
import { ftsSync, getDocRow } from "./docs";
import { enqueueDriveSync } from "./drive-queue";
import { isDriveConnected } from "./drive-store";
import { getPrefs, tesseractLanguages } from "./prefs";

interface JobRow {
  id: number;
  doc_id: string;
  payload: string | null;
}

const g = globalThis as unknown as {
  __waraqOcr?: { running: boolean; started: boolean; idle: Array<() => void> };
};

function state() {
  return (g.__waraqOcr ??= { running: false, started: false, idle: [] });
}

/** Tesseract languages in prefs order (e.g. "ara+eng"); WARAQ_OCR_LANGS overrides. */
export function ocrLanguages(): string {
  return tesseractLanguages();
}

/* ------------------------------------------------------------------ Tesseract config */

const SYSTEM_TESSDATA = "/usr/share/tesseract-ocr/5/tessdata";

/**
 * Optional alternative model dir (e.g. tessdata_best) from `WARAQ_TESSDATA_DIR`, used only when it has every
 * requested language; otherwise null = distro models. The v4 benchmark found tessdata_best ~2x slower with no
 * readability gain on the owner's documents, so it is opt-in (docs/OPERATIONS.md "OCR engines").
 */
export function tessdataDir(langs: string[]): string | null {
  const env = process.env.WARAQ_TESSDATA_DIR;
  if (!env || env === "system") return null;
  for (const d of [env]) {
    if (langs.every((l) => fs.existsSync(path.join(d, `${l}.traineddata`)))) return d;
  }
  return null;
}

function ocrJobs(): string {
  const n = Number(process.env.WARAQ_OCR_JOBS);
  return String(Number.isInteger(n) && n >= 1 && n <= 4 ? n : 2);
}

/**
 * ocrmypdf arguments (benchmarks: --clean/--deskew/--oversample 300 were 3-7x
 * slower on 2 vCPU and added noise on phone photos, so the plain config wins; page images are never modified).
 * - first run: `--skip-text` leaves born-digital pages alone and only OCRs image pages;
 * - manual re-run (`redo`): `--redo-ocr` strips our previous invisible text and OCRs again (visible text is kept).
 * - `WARAQ_OCR_ROTATE=1` adds --rotate-pages (needs osd.traineddata).
 */
export function ocrmypdfArgs(opts: { redo: boolean; langs: string; osd: boolean }, inp: string, out: string): string[] {
  return [
    opts.redo ? "--redo-ocr" : "--skip-text",
    ...(opts.osd && process.env.WARAQ_OCR_ROTATE === "1" ? ["--rotate-pages"] : []),
    "-l",
    opts.langs,
    "--output-type",
    "pdf",
    "--optimize",
    "1",
    "--jobs",
    ocrJobs(),
    "-q",
    inp,
    out,
  ];
}

export function driveOcrEnabled(): boolean {
  try {
    return isDriveConnected() && getPrefs().ocr.useDriveOcr;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ worker */

/** Start the single-concurrency worker once per process; re-queues jobs interrupted by a restart. */
export function startOcrWorker(): void {
  const s = state();
  setJobKick("ocr", () => void pump());
  if (s.started) return;
  s.started = true;
  const db = getDb();
  requeueRunning("ocr");
  db.prepare(
    "UPDATE documents SET ocr_status = 'queued' WHERE ocr_status = 'running' OR id IN (SELECT doc_id FROM jobs WHERE status = 'queued' AND kind = 'ocr')",
  ).run();
  setTimeout(() => void pump(), 50);
}

/** Resolves when the Tesseract queue is drained (for tests). */
export function waitForOcrIdle(): Promise<void> {
  const s = state();
  const pending = getDb().prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running') AND kind = 'ocr' LIMIT 1").get();
  if (!s.running && !pending) return Promise.resolve();
  return new Promise((r) => s.idle.push(r));
}

async function pump(): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    for (;;) {
      const job = getDb()
        .prepare("SELECT id, doc_id, payload FROM jobs WHERE status = 'queued' AND kind = 'ocr' ORDER BY id LIMIT 1")
        .get() as JobRow | undefined;
      if (!job) break;
      await Promise.resolve().then(() => runJob(job)).catch((e) => {
        console.error(`[waraq] ocr job ${job.id} crashed:`, (e as Error).message);
        markJob(job.id, "error", (e as Error).message);
        getDb().prepare("UPDATE documents SET ocr_status = 'error' WHERE id = ? AND ocr_status = 'running'").run(job.doc_id);
      });
    }
  } finally {
    s.running = false;
    const waiters = s.idle.splice(0);
    waiters.forEach((w) => w());
  }
}

export function cleanText(s: string): string {
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, LIMITS.ocrTextMaxChars);
}

export async function extractText(pdfPath: string): Promise<string> {
  const r = await run("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
    timeoutMs: 300_000,
    maxStdout: LIMITS.ocrTextMaxChars * 4,
  });
  if (r.code !== 0) throw new Error(`pdftotext exited ${r.code}`);
  return cleanText(r.stdout.toString("utf8"));
}

/** Queue the Drive OCR pass when enabled and Drive is connected (never throws). */
export function maybeQueueDriveOcr(docId: string, opts: { force?: boolean } = {}): boolean {
  try {
    if (!driveOcrEnabled()) return false;
    enqueueJob(docId, "ocr_drive", { force: !!opts.force });
    kickJobs("ocr_drive");
    return true;
  } catch (e) {
    console.error("[waraq] drive ocr enqueue skipped:", (e as Error).message);
    return false;
  }
}

async function runJob(job: JobRow): Promise<void> {
  const db = getDb();
  const row = getDocRow(job.doc_id);
  if (!row || row.status !== "ready") {
    // deleted, or still being assembled (the build job queues OCR again when it finishes)
    markJob(job.id, "done", row ? "not ready" : undefined);
    if (row) db.prepare("UPDATE documents SET ocr_status = 'none' WHERE id = ? AND ocr_status IN ('queued','running')").run(row.id);
    return;
  }
  const payload = jobPayload<OcrJobPayload>(job.payload);
  const version = row.version;
  db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(nowIso(), job.id);
  db.prepare("UPDATE documents SET ocr_status = 'running' WHERE id = ? AND version = ?").run(job.doc_id, version);

  const langs = ocrLanguages();
  const tessdata = tessdataDir(langs.split("+").filter(Boolean));
  const osd = fs.existsSync(path.join(tessdata ?? SYSTEM_TESSDATA, "osd.traineddata"));
  const env: Record<string, string> = { OMP_THREAD_LIMIT: "1" };
  if (tessdata) env.TESSDATA_PREFIX = tessdata;

  await withTempDir("ocr", async (dir) => {
    const inp = path.join(dir, "in.pdf");
    const out = path.join(dir, "out.pdf");
    // snapshot the current content under the lock so we never read a half-replaced file
    await withDocLock(job.doc_id, async () => fsp.copyFile(await docPdfFile(job.doc_id), inp));

    let ocrOk = false;
    let errMsg: string | undefined;
    try {
      const timeoutMs = Math.max(180_000, row.page_count * 90_000);
      const r = await run("ocrmypdf", ocrmypdfArgs({ redo: !!payload.redo, langs, osd }, inp, out), {
        timeoutMs,
        maxStdout: 1024 * 1024,
        env,
      });
      if (r.code === 0) {
        await inspectPdf(await fsp.readFile(out)); // sanity check the output is a valid PDF
        ocrOk = true;
      } else {
        errMsg = `ocrmypdf exited ${r.code}: ${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200)}`;
      }
    } catch (e) {
      errMsg = (e as Error).message;
    }

    let text = "";
    try {
      text = await extractText(ocrOk ? out : inp);
    } catch (e) {
      errMsg ??= (e as Error).message;
    }

    const driveNext = driveOcrEnabled();
    let applied = false;
    await withDocLock(job.doc_id, async () => {
      const cur = getDocRow(job.doc_id);
      if (!cur || cur.version !== version) {
        // superseded by a newer content change (which queued its own job) or deleted
        markJob(job.id, "done", "superseded");
        return;
      }
      applied = true;
      // Drive OCR text stays the document text until the next Drive pass replaces it.
      const keep = driveNext && cur.ocr_engine === "drive" && !!cur.ocr_text ? 1 : 0;
      let stored: { bytes: Buffer; info: Awaited<ReturnType<typeof inspectPdf>> } | null = null;
      if (ocrOk) {
        try {
          const bytes = await fsp.readFile(out);
          const info = await inspectPdf(bytes);
          await writeDocBytes(job.doc_id, bytes); // Drive documents: uploads the searchable PDF
          stored = { bytes, info };
        } catch (e) {
          errMsg = (e as Error).message;
        }
      }
      if (stored) {
        const { bytes, info } = stored;
        const nextVersion = cur.version + 1;
        db.prepare(
          `UPDATE documents SET version = ?, size_bytes = ?, page_count = ?, pages_json = ?, ocr_layer_text = ?,
             ocr_text = CASE WHEN ? THEN ocr_text ELSE ? END,
             ocr_engine = CASE WHEN ? THEN ocr_engine ELSE 'tesseract' END,
             ocr_status = 'done'
           WHERE id = ?`,
        ).run(nextVersion, bytes.byteLength, info.pageCount, JSON.stringify(info.pages), text, keep, text, keep, job.doc_id);
        if (!keep) db.prepare("DELETE FROM ocr_pages WHERE doc_id = ? AND engine = 'drive'").run(job.doc_id);
        await pruneRenders(job.doc_id, nextVersion);
        markJob(job.id, "done");
        enqueueDriveSync(job.doc_id);
      } else {
        // original stays untouched; keep any text layer it already had
        db.prepare(
          `UPDATE documents SET ocr_layer_text = COALESCE(NULLIF(?, ''), ocr_layer_text),
             ocr_text = CASE WHEN ? THEN ocr_text ELSE COALESCE(NULLIF(?, ''), ocr_text) END,
             ocr_engine = CASE WHEN ? THEN ocr_engine WHEN ? != '' THEN 'tesseract' ELSE ocr_engine END,
             ocr_status = 'error' WHERE id = ?`,
        ).run(text, keep, text, keep, text, job.doc_id);
        console.error(`[waraq] ocr failed for job ${job.id}: ${(errMsg ?? "unknown").slice(0, 200)}`);
        markJob(job.id, "error", errMsg);
      }
      ftsSync(job.doc_id);
    });
    // Drive OCR reads the page images, so it runs even when Tesseract failed.
    if (applied && driveNext) maybeQueueDriveOcr(job.doc_id, { force: payload.force });
  });
}
