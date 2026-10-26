// Async document creation / page insertion. The request only persists the raw uploads and placeholder page
// layout (fast); a single-concurrency background "build" job assembles the PDF, pre-renders image pages as it
// goes (so thumbnails appear page by page), then hands over to OCR and the Drive mirror.
import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { HttpError } from "./errors";
import { newId, nowIso } from "./ids";
import { LIMITS } from "./config";
import { addImagePage, inspectPdf, insertPages, loadImportedPdf, normalizeImage, pageMetas, type InputKind, type PageMeta } from "./pdf";
import {
  assertFolder,
  assertReady,
  ftsSync,
  getDocRow,
  parseProcessing,
  requireDoc,
  type DocRow,
  type DocSource,
  type ProcessingState,
} from "./docs";
import { atomicWrite, docDir } from "./storage";
import { pruneRenders, readDocBytes, renderCacheDir, writeDocBytes } from "./doc-storage";
import { withDocLock } from "./locks";
import { enqueueJob, enqueueOcr, jobPayload, kickJobs, markJob, requeueRunning, setJobKick } from "./jobs";
import { enqueueDriveSync } from "./drive-queue";

export interface StagedFile {
  kind: InputKind;
  bytes: Uint8Array;
  name?: string;
}

interface ManifestEntry {
  file: string;
  kind: InputKind;
  name: string;
  pages: number; // estimated
}

interface BuildPayload {
  batch: string;
}

const A4: PageMeta = { width: 595, height: 842, rotation: 0 };

function incomingDir(id: string, batch: string): string {
  return path.join(docDir(id), "incoming", batch.replace(/[^A-Za-z0-9_-]/g, ""));
}

/** Cheap page layout estimate (headers only) so the doc has the right page count/aspect immediately. */
export async function estimatePages(f: StagedFile): Promise<PageMeta[]> {
  if (f.kind !== "pdf") {
    try {
      const m = await sharp(f.bytes, { limitInputPixels: 120_000_000 }).metadata();
      let w = m.width ?? 0;
      let h = m.height ?? 0;
      if ((m.orientation ?? 1) >= 5) [w, h] = [h, w];
      if (w > 0 && h > 0) return [{ width: LIMITS.pageWidthPt, height: Math.round(((LIMITS.pageWidthPt * h) / w) * 100) / 100, rotation: 0 }];
    } catch {
      /* the build reports the real error */
    }
    return [{ ...A4 }];
  }
  try {
    const doc = await PDFDocument.load(f.bytes, { ignoreEncryption: true, updateMetadata: false });
    const metas = pageMetas(doc);
    return metas.length ? metas : [{ ...A4 }];
  } catch {
    return [{ ...A4 }];
  }
}

/** Write the raw uploads to docs/<id>/incoming/<batch>/ (kept until the build succeeds, for retry). */
async function stageFiles(id: string, files: StagedFile[]): Promise<{ batch: string; metas: PageMeta[] }> {
  const batch = nanoid(10).replace(/[^A-Za-z0-9]/g, "x");
  const dir = incomingDir(id, batch);
  await fsp.mkdir(dir, { recursive: true });
  const manifest: ManifestEntry[] = [];
  const metas: PageMeta[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const file = `${String(i).padStart(4, "0")}.${f.kind === "jpeg" ? "jpg" : f.kind}`;
    await fsp.writeFile(path.join(dir, file), f.bytes, { mode: 0o600 });
    const pages = await estimatePages(f);
    metas.push(...pages);
    manifest.push({ file, kind: f.kind, name: (f.name ?? "").slice(0, 200), pages: pages.length });
  }
  if (metas.length > LIMITS.maxPagesPerDoc) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new HttpError(413, "too_many_pages", `Documents are limited to ${LIMITS.maxPagesPerDoc} pages`);
  }
  await atomicWrite(path.join(dir, "manifest.json"), Buffer.from(JSON.stringify(manifest)));
  return { batch, metas };
}

export interface CreateAsyncInput {
  files: StagedFile[];
  title: string;
  folderId?: string | null;
  source: DocSource;
}

/** Create a `processing` document right away and queue the build. Returns the new id. */
export async function createDocumentAsync(input: CreateAsyncInput): Promise<string> {
  if (input.files.length === 0) throw new HttpError(400, "no_files", "No files provided");
  const folderId = assertFolder(input.folderId ?? null);
  const id = newId();
  let staged: { batch: string; metas: PageMeta[] };
  try {
    staged = await stageFiles(id, input.files);
  } catch (e) {
    await fsp.rm(docDir(id), { recursive: true, force: true });
    throw e;
  }
  const state: ProcessingState = {
    kind: "create",
    batch: staged.batch,
    stage: "queued",
    pagesDone: 0,
    pagesTotal: staged.metas.length,
    at: 0,
    count: staged.metas.length,
    ready: [],
  };
  const now = nowIso();
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO documents (id, title, folder_id, tags, starred, page_count, size_bytes, pages_json, status, ocr_status, version, source, created_at, updated_at, processing_json)
       VALUES (?, ?, ?, '[]', 0, ?, ?, ?, 'processing', 'none', 1, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      folderId,
      staged.metas.length,
      input.files.reduce((n, f) => n + f.bytes.byteLength, 0),
      JSON.stringify(staged.metas),
      input.source,
      now,
      now,
      JSON.stringify(state),
    );
    enqueueJob(id, "build", { batch: staged.batch } satisfies BuildPayload);
  })();
  ftsSync(id);
  kickJobs("build");
  return id;
}

/** Insert pages asynchronously: the layout grows immediately, new pages report status "processing". */
export async function insertPagesAsync(id: string, files: StagedFile[], at?: number): Promise<void> {
  if (files.length === 0) throw new HttpError(400, "no_files", "No files provided");
  requireDoc(id);
  await withDocLock(id, async () => {
    const row = assertReady(requireDoc(id));
    const pos = at === undefined ? row.page_count : at;
    if (!Number.isInteger(pos) || pos < 0 || pos > row.page_count) {
      throw new HttpError(400, "invalid_page", `at must be in 0..${row.page_count}`);
    }
    const staged = await stageFiles(id, files);
    if (row.page_count + staged.metas.length > LIMITS.maxPagesPerDoc) {
      await fsp.rm(incomingDir(id, staged.batch), { recursive: true, force: true });
      throw new HttpError(413, "too_many_pages", `Documents are limited to ${LIMITS.maxPagesPerDoc} pages`);
    }
    beginInsert(row, staged.batch, staged.metas, pos);
  });
  kickJobs("build");
}

function currentMetas(row: DocRow): PageMeta[] {
  try {
    return JSON.parse(row.pages_json) as PageMeta[];
  } catch {
    return [];
  }
}

/** Switch a ready document into "processing" with the grown layout; bumps version so caches start fresh. */
function beginInsert(row: DocRow, batch: string, metas: PageMeta[], at: number) {
  const prev = parseProcessing(row.processing_json);
  if (prev && prev.batch !== batch) void fsp.rm(incomingDir(row.id, prev.batch), { recursive: true, force: true }); // superseded failed upload
  const cur = currentMetas(row);
  const pos = Math.min(Math.max(0, at), cur.length);
  const layout = [...cur.slice(0, pos), ...metas, ...cur.slice(pos)];
  const state: ProcessingState = {
    kind: "insert",
    batch,
    stage: "queued",
    pagesDone: 0,
    pagesTotal: metas.length,
    at: pos,
    count: metas.length,
    ready: [],
  };
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE documents SET status = 'processing', processing_error = NULL, processing_json = ?, page_count = ?, pages_json = ?,
         version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(state), layout.length, JSON.stringify(layout), nowIso(), row.id);
    enqueueJob(row.id, "build", { batch } satisfies BuildPayload);
  })();
  void pruneRenders(row.id, row.version + 1);
}

/** Re-queue a failed build (originals were kept). */
export async function retryProcessing(id: string): Promise<void> {
  await withDocLock(id, async () => {
    const row = requireDoc(id, { allowTrashed: true });
    const p = parseProcessing(row.processing_json);
    if (row.status !== "error" || !p) throw new HttpError(409, "nothing_to_retry", "This document has nothing to retry");
    const dir = incomingDir(id, p.batch);
    let manifest: ManifestEntry[];
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8"));
    } catch {
      throw new HttpError(410, "originals_missing", "The original upload is no longer available");
    }
    if (p.kind === "create") {
      const next: ProcessingState = { ...p, stage: "queued", pagesDone: 0, ready: [] };
      const db = getDb();
      db.transaction(() => {
        db.prepare("UPDATE documents SET status = 'processing', processing_error = NULL, processing_json = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(next),
          nowIso(),
          id,
        );
        enqueueJob(id, "build", { batch: p.batch } satisfies BuildPayload);
      })();
      void pruneRenders(id, row.version);
    } else {
      const metas: PageMeta[] = [];
      for (const m of manifest) {
        const bytes = await fsp.readFile(path.join(dir, m.file));
        metas.push(...(await estimatePages({ kind: m.kind, bytes })));
      }
      beginInsert(row, p.batch, metas, p.at);
    }
  });
  kickJobs("build");
}

/* ------------------------------------------------------------------ worker */

const g = globalThis as unknown as { __waraqBuild?: { running: boolean; started: boolean; idle: Array<() => void> } };
const state = () => (g.__waraqBuild ??= { running: false, started: false, idle: [] });

export function startBuildWorker(): void {
  const s = state();
  setJobKick("build", () => void pumpBuilds());
  if (s.started) return;
  s.started = true;
  requeueRunning("build");
  setTimeout(() => void pumpBuilds(), 20);
}

export function waitForBuildIdle(): Promise<void> {
  const s = state();
  const pending = getDb().prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running') AND kind = 'build' LIMIT 1").get();
  if (!s.running && !pending) return Promise.resolve();
  return new Promise((r) => s.idle.push(r));
}

export async function pumpBuilds(): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    for (;;) {
      const job = getDb()
        .prepare("SELECT id, doc_id, payload FROM jobs WHERE status = 'queued' AND kind = 'build' ORDER BY id LIMIT 1")
        .get() as { id: number; doc_id: string; payload: string | null } | undefined;
      if (!job) break;
      await Promise.resolve().then(() => runBuild(job)).catch((e) => {
        console.error(`[waraq] build job ${job.id} crashed:`, (e as Error).message);
        markJob(job.id, "error", (e as Error).message);
      });
    }
  } finally {
    s.running = false;
    s.idle.splice(0).forEach((w) => w());
  }
}

function saveProgress(id: string, p: ProcessingState) {
  getDb().prepare("UPDATE documents SET processing_json = ? WHERE id = ? AND status = 'processing'").run(JSON.stringify(p), id);
}

/** Write the 1600px page image + 360px thumb straight from the normalised scan (same output as a PDF render). */
async function prerender(id: string, version: number, index: number, jpeg: Buffer): Promise<void> {
  const dir = renderCacheDir(id, version);
  await fsp.mkdir(dir, { recursive: true });
  const jpg = path.join(dir, `p${index}.jpg`);
  const webp = path.join(dir, `p${index}-thumb.webp`);
  const img = await sharp(jpeg).resize({ width: LIMITS.imageWidth }).jpeg({ quality: 85 }).toBuffer();
  await fsp.writeFile(`${jpg}.tmp`, img);
  await fsp.rename(`${jpg}.tmp`, jpg);
  await sharp(img).resize({ width: LIMITS.thumbWidth, withoutEnlargement: true }).webp({ quality: 72 }).toFile(`${webp}.tmp`);
  await fsp.rename(`${webp}.tmp`, webp);
}

async function runBuild(job: { id: number; doc_id: string; payload: string | null }): Promise<void> {
  const id = job.doc_id;
  const payload = jobPayload<BuildPayload>(job.payload);
  const row = getDocRow(id);
  const p = row ? parseProcessing(row.processing_json) : null;
  if (!row || row.status !== "processing" || !p || p.batch !== payload.batch) {
    markJob(job.id, "done", "stale");
    return;
  }
  const db = getDb();
  db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(nowIso(), job.id);
  const dir = incomingDir(id, p.batch);
  const version = row.version;
  const prog: ProcessingState = { ...p, stage: "assembling", pagesDone: 0, ready: [] };
  saveProgress(id, prog);

  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8")) as ManifestEntry[];
    const out = await PDFDocument.create();
    out.setProducer("Waraq");
    out.setCreator("Waraq");
    for (const m of manifest) {
      const bytes = await fsp.readFile(path.join(dir, m.file));
      if (m.kind === "pdf") {
        const src = await loadImportedPdf(bytes);
        try {
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach((pg) => out.addPage(pg));
        } catch {
          throw new HttpError(422, "invalid_pdf", "Could not read PDF");
        }
      } else {
        const img = await normalizeImage(bytes);
        await addImagePage(out, img);
        const index = prog.at + out.getPageCount() - 1;
        // pre-render only while the estimate still lines up with the real layout
        if (out.getPageCount() - 1 < prog.count) {
          try {
            await prerender(id, version, index, img.jpeg);
            prog.ready.push(index);
          } catch {
            /* lazy render later */
          }
        }
      }
      if (out.getPageCount() > LIMITS.maxPagesPerDoc) {
        throw new HttpError(413, "too_many_pages", `Documents are limited to ${LIMITS.maxPagesPerDoc} pages`);
      }
      prog.pagesDone = Math.min(out.getPageCount(), prog.pagesTotal);
      saveProgress(id, prog);
    }
    if (out.getPageCount() === 0) throw new HttpError(422, "empty_document", "No pages found in upload");
    const built = await out.save();
    prog.stage = "rendering";
    saveProgress(id, prog);

    await withDocLock(id, async () => {
      const cur = getDocRow(id);
      if (!cur || cur.status !== "processing" || parseProcessing(cur.processing_json)?.batch !== p.batch) return;
      const finalBytes = p.kind === "create" ? built : await insertPages(await readDocBytes(id), built, p.at);
      const info = await inspectPdf(finalBytes);
      await writeDocBytes(id, finalBytes);
      // a mis-estimated PDF page count shifts indexes: start a fresh cache version so nothing stale is served
      const estimated = p.kind === "create" ? p.count : cur.page_count;
      const nextVersion = info.pageCount === estimated ? cur.version : cur.version + 1;
      db.prepare(
        `UPDATE documents SET status = 'ready', processing_json = NULL, processing_error = NULL, version = ?, page_count = ?,
           pages_json = ?, size_bytes = ?, updated_at = ? WHERE id = ?`,
      ).run(nextVersion, info.pageCount, JSON.stringify(info.pages), finalBytes.byteLength, nowIso(), id);
      if (nextVersion !== cur.version) await pruneRenders(id, nextVersion);
    });
    await fsp.rm(dir, { recursive: true, force: true });
    markJob(job.id, "done");
    const doneRow = getDocRow(id);
    if (doneRow?.status === "ready") {
      enqueueOcr(id);
      enqueueDriveSync(id);
    }
  } catch (e) {
    const msg0 = e instanceof HttpError ? e.message : `Processing failed: ${(e as Error).message.slice(0, 160)}`;
    if (!(e instanceof HttpError)) console.error(`[waraq] build ${job.id} failed:`, (e as Error).message);
    const msg = msg0;
    await withDocLock(id, async () => {
      const cur = getDocRow(id);
      if (!cur || cur.status !== "processing") return;
      const failed: ProcessingState = { ...p, stage: "queued", pagesDone: 0, ready: [] };
      if (p.kind === "insert") {
        // the existing pages are untouched: restore their layout so the document stays usable
        const info = await inspectPdf(await readDocBytes(id)).catch(() => null);
        if (!info) {
          db.prepare("UPDATE documents SET status = 'error', processing_error = ?, processing_json = ?, updated_at = ? WHERE id = ?").run(
            msg,
            JSON.stringify(failed),
            nowIso(),
            id,
          );
          return;
        }
        db.prepare(
          `UPDATE documents SET status = 'error', processing_error = ?, processing_json = ?, page_count = ?, pages_json = ?,
             version = version + 1, updated_at = ? WHERE id = ?`,
        ).run(msg, JSON.stringify(failed), info.pageCount, JSON.stringify(info.pages), nowIso(), id);
        await pruneRenders(id, cur.version + 1);
      } else {
        db.prepare("UPDATE documents SET status = 'error', processing_error = ?, processing_json = ?, updated_at = ? WHERE id = ?").run(
          msg,
          JSON.stringify(failed),
          nowIso(),
          id,
        );
      }
    });
    markJob(job.id, "error", msg);
  }
}

/** Documents whose build is queued or running (for /api/ocr/status style dashboards and tests). */
export function processingCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'processing'").get() as { n: number }).n;
}
