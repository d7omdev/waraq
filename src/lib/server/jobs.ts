import { getDb } from "./db";
import { nowIso } from "./ids";

export type JobKind = "ocr" | "ocr_drive" | "build";

export interface OcrJobPayload {
  /** strip our previous invisible OCR text and run Tesseract again (manual re-run) */
  redo?: boolean;
  /** ignore cached per-page Drive OCR results */
  force?: boolean;
}

const g = globalThis as unknown as { __waraqKicks?: Partial<Record<JobKind, () => void>>; __waraqOcrKick?: () => void };
const kicks = () => (g.__waraqKicks ??= {});

export function setJobKick(kind: JobKind, fn: () => void) {
  kicks()[kind] = fn;
  if (kind === "ocr") g.__waraqOcrKick = fn;
}

export function kickJobs(kind: JobKind) {
  try {
    kicks()[kind]?.();
  } catch {
    /* ignore */
  }
}

export const setOcrKick = (fn: () => void) => setJobKick("ocr", fn);

export function jobPayload<T>(raw: string | null | undefined): T {
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    return {} as T;
  }
}

/** Insert a queued job for a document; an already-queued job of the same kind absorbs the payload. */
export function enqueueJob(docId: string, kind: JobKind, payload: object = {}): void {
  const db = getDb();
  const now = nowIso();
  if (!db.prepare("SELECT 1 FROM documents WHERE id = ?").get(docId)) return; // gone
  const existing = db
    .prepare("SELECT id, payload FROM jobs WHERE doc_id = ? AND kind = ? AND status = 'queued'")
    .get(docId, kind) as { id: number; payload: string | null } | undefined;
  if (existing) {
    const merged = jobPayload<Record<string, unknown>>(existing.payload);
    for (const [k, v] of Object.entries(payload)) merged[k] = typeof v === "boolean" ? !!merged[k] || v : v;
    db.prepare("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), now, existing.id);
  } else {
    db.prepare("INSERT INTO jobs (doc_id, kind, status, payload, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)").run(
      docId,
      kind,
      JSON.stringify(payload),
      now,
      now,
    );
  }
}

/** Queue OCR for a document (dedupes an already-queued job) and wake the worker. */
export function enqueueOcr(docId: string, opts: OcrJobPayload = {}): void {
  const db = getDb();
  db.transaction(() => {
    enqueueJob(docId, "ocr", opts);
    db.prepare("UPDATE documents SET ocr_status = 'queued' WHERE id = ?").run(docId);
  })();
  kickJobs("ocr");
}

/** Interrupted jobs (process restart) go back to the queue. */
export function requeueRunning(kind: JobKind): void {
  getDb().prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running' AND kind = ?").run(nowIso(), kind);
}

export function markJob(id: number, status: string, error?: string) {
  getDb()
    .prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
    .run(status, error ? error.slice(0, 500) : null, nowIso(), id);
}

/** Keep the jobs table small: finished jobs older than a week are dropped. */
export function pruneFinishedJobs(maxAgeMs = 7 * 86400_000): void {
  getDb()
    .prepare("DELETE FROM jobs WHERE status IN ('done','error') AND updated_at < ?")
    .run(new Date(Date.now() - maxAgeMs).toISOString());
}

