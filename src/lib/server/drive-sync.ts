// Google Drive mirror worker: single concurrency, persisted queue (drive_jobs), exponential backoff,
// re-queues interrupted jobs on restart, pauses globally on rate limits, stops cleanly when disconnected.
import fsp from "node:fs/promises";
import { getDb } from "./db";
import { nowIso } from "./ids";
import { withDocLock } from "./locks";
import { docPdfPath } from "./storage";
import { getDocRow, parseProcessing } from "./docs";
import { setDriveKick, addDriveJob, type DriveJobKind } from "./drive-queue";
import {
  DRIVE_KEYS,
  getSetting,
  setLastError,
  setRefreshToken,
  setSetting,
  wipeDriveMappings,
} from "./drive-store";
import {
  createFolder,
  DriveAuthError,
  DriveError,
  findByAppProperty,
  getFile,
  hasChildren,
  resetAccessToken,
  updateMetadata,
  uploadPdf,
  type DriveFile,
} from "./drive-api";

export const DRIVE_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 3600_000;
const VERIFY_TTL_MS = 10 * 60_000;
const GAP_BETWEEN_JOBS_MS = 250;
const OCR_DEFER_MS = 30_000;
const OCR_DEFER_WINDOW_MS = 15 * 60_000;

interface JobRow {
  id: number;
  kind: DriveJobKind;
  target_id: string;
  attempts: number;
  manual: number;
  due_at: number;
}

interface DriveDocRow {
  doc_id: string;
  file_id: string | null;
  web_view_link: string | null;
  synced_version: number | null;
  synced_name: string | null;
  synced_parent: string | null;
}

interface FolderMapRow {
  folder_id: string;
  drive_id: string;
  synced_name: string | null;
  synced_parent: string | null;
}

interface WorkerState {
  started: boolean;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** rate-limit pause for the connected Google account */
  pausedUntil: number;
  verified: Map<string, number>; // drive folder id -> last verified at
  idle: Array<() => void>;
}

const g = globalThis as unknown as { __waraqDrive?: WorkerState };
function state(): WorkerState {
  return (g.__waraqDrive ??= { started: false, running: false, timer: null, pausedUntil: 0, verified: new Map(), idle: [] });
}

/** Thrown by a handler to re-run the job later without counting an attempt. */
class Defer extends Error {
  ms: number;
  constructor(ms: number) {
    super("deferred");
    this.ms = ms;
  }
}

export function backoffMs(attempts: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
  return Math.round(base * (1 + Math.random() * 0.2));
}

/* -------------------------------------------------------------- naming */

export function driveName(title: string, ext = ""): string {
  let s = title
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 150)
    .trim();
  if (!s) s = "Untitled";
  if (ext && !s.toLowerCase().endsWith(ext)) s += ext;
  return s;
}

/* -------------------------------------------------------------- folders */

function verifiedRecently(driveId: string): boolean {
  const t = state().verified.get(driveId);
  return !!t && Date.now() - t < VERIFY_TTL_MS;
}

async function aliveFolder(driveId: string): Promise<DriveFile | null> {
  const f = await getFile(driveId);
  if (!f || f.trashed) {
    state().verified.delete(driveId);
    return null;
  }
  state().verified.set(driveId, Date.now());
  return f;
}

/** The app's root folder "Waraq" (created by the app; drive.file scope only sees app-created files). */
export async function ensureRoot(): Promise<string> {
  const id = getSetting(DRIVE_KEYS.rootFolderId);
  if (id) {
    if (verifiedRecently(id)) return id;
    if (await aliveFolder(id)) return id;
    // The owner deleted/trashed the Waraq folder in Drive: forget mappings and re-mirror everything we had.
    const mirrored = getDb().prepare("SELECT doc_id FROM drive_docs").all() as { doc_id: string }[];
    wipeDriveMappings({ keepQueue: true });
    for (const r of mirrored) addDriveJob("doc", r.doc_id);
  }
  const found = await findByAppProperty("waraqRoot", "1");
  const root = found ?? (await createFolder("Waraq", "root", { waraqRoot: "1" }));
  setSetting(DRIVE_KEYS.rootFolderId, root.id);
  state().verified.set(root.id, Date.now());
  return root.id;
}

/** "Waraq/Trash": where app-trashed documents live until restored or permanently deleted. */
export async function ensureTrashFolder(): Promise<string> {
  const root = await ensureRoot();
  const id = getSetting(DRIVE_KEYS.trashFolderId);
  if (id && (verifiedRecently(id) || (await aliveFolder(id)))) return id;
  const found = await findByAppProperty("waraqTrash", "1");
  const f = found && found.parents?.includes(root) ? found : await createFolder("Trash", root, { waraqTrash: "1" });
  setSetting(DRIVE_KEYS.trashFolderId, f.id);
  state().verified.set(f.id, Date.now());
  return f.id;
}

function saveFolderMap(folderId: string, driveId: string, name: string, parent: string) {
  getDb()
    .prepare(
      `INSERT INTO drive_folders (folder_id, drive_id, synced_name, synced_parent, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(folder_id) DO UPDATE SET drive_id = excluded.drive_id, synced_name = excluded.synced_name, synced_parent = excluded.synced_parent, updated_at = excluded.updated_at`,
    )
    .run(folderId, driveId, name, parent, nowIso());
}

/** Drive folder id for an app folder (null = root), creating / renaming / moving the chain as needed. */
export async function ensureFolder(folderId: string | null, depth = 0): Promise<string> {
  if (!folderId || depth > 64) return ensureRoot();
  const db = getDb();
  const f = db.prepare("SELECT id, name, parent_id FROM folders WHERE id = ?").get(folderId) as
    | { id: string; name: string; parent_id: string | null }
    | undefined;
  if (!f) return ensureRoot();
  const parent = await ensureFolder(f.parent_id, depth + 1);
  const name = driveName(f.name);
  const m = db.prepare("SELECT * FROM drive_folders WHERE folder_id = ?").get(folderId) as FolderMapRow | undefined;
  if (m) {
    let actualParents: string[] | undefined;
    let alive = verifiedRecently(m.drive_id);
    if (!alive) {
      const live = await aliveFolder(m.drive_id);
      alive = !!live;
      actualParents = live?.parents;
    }
    if (alive) {
      const curParent = actualParents ? actualParents.join(",") : m.synced_parent;
      const moved = actualParents ? !(actualParents.length === 1 && actualParents[0] === parent) : m.synced_parent !== parent;
      if (m.synced_name !== name || moved) {
        await updateMetadata(m.drive_id, { name }, moved ? { addParents: parent, removeParents: curParent } : {});
        saveFolderMap(folderId, m.drive_id, name, parent);
      }
      return m.drive_id;
    }
    db.prepare("DELETE FROM drive_folders WHERE folder_id = ?").run(folderId);
  }
  const created = await createFolder(name, parent, { waraqFolderId: folderId });
  saveFolderMap(folderId, created.id, name, parent);
  state().verified.set(created.id, Date.now());
  return created.id;
}

/* -------------------------------------------------------------- handlers */

function driveDoc(docId: string): DriveDocRow | undefined {
  return getDb().prepare("SELECT * FROM drive_docs WHERE doc_id = ?").get(docId) as DriveDocRow | undefined;
}

function saveDriveDoc(docId: string, f: DriveFile, version: number | null, name: string, parent: string) {
  getDb()
    .prepare(
      `INSERT INTO drive_docs (doc_id, file_id, web_view_link, synced_version, synced_name, synced_parent, synced_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(doc_id) DO UPDATE SET file_id = excluded.file_id, web_view_link = COALESCE(excluded.web_view_link, drive_docs.web_view_link),
         synced_version = COALESCE(excluded.synced_version, drive_docs.synced_version), synced_name = excluded.synced_name,
         synced_parent = excluded.synced_parent, synced_at = excluded.synced_at, last_error = NULL, updated_at = excluded.updated_at`,
    )
    .run(docId, f.id, f.webViewLink ?? null, version, name, parent, nowIso(), nowIso());
}

async function snapshot(docId: string): Promise<{ bytes: Buffer; version: number } | null> {
  return withDocLock(docId, async () => {
    const row = getDocRow(docId);
    if (!row) return null;
    return { bytes: await fsp.readFile(docPdfPath(docId)), version: row.version };
  });
}

const is404 = (e: unknown) => e instanceof DriveError && e.status === 404;

async function syncDoc(job: JobRow): Promise<void> {
  const docId = job.target_id;
  const row = getDocRow(docId);
  if (!row) return deleteDoc(docId);
  let dd = driveDoc(docId);
  if (row.trashed_at && !dd?.file_id) return; // nothing in Drive yet; don't upload trashed docs
  // Still being assembled (the build re-queues the sync) or creation failed (no PDF yet).
  if (row.status === "processing") throw new Defer(OCR_DEFER_MS);
  if (row.status === "error" && !dd?.file_id && parseProcessing(row.processing_json)?.kind === "create") return;

  // A fresh document is about to be OCR'd (which rewrites the PDF): wait instead of uploading twice.
  if (
    !dd?.file_id &&
    !job.manual &&
    (row.ocr_status === "queued" || row.ocr_status === "running") &&
    Date.now() - Date.parse(row.created_at) < OCR_DEFER_WINDOW_MS
  ) {
    throw new Defer(OCR_DEFER_MS);
  }

  const parent = row.trashed_at ? await ensureTrashFolder() : await ensureFolder(row.folder_id);
  const name = driveName(row.title, ".pdf");
  dd = driveDoc(docId);

  for (let pass = 0; pass < 2; pass++) {
    const fileId = dd?.file_id ?? null;
    const needsContent = !fileId || dd?.synced_version !== row.version;
    const move = fileId && dd?.synced_parent !== parent ? { addParents: parent, removeParents: dd?.synced_parent ?? null } : {};
    try {
      if (needsContent) {
        const snap = await snapshot(docId);
        if (!snap) return deleteDoc(docId);
        const f = await uploadPdf({ fileId, name, parentId: parent, move, bytes: snap.bytes, appProperties: { waraqDocId: docId } });
        saveDriveDoc(docId, f, snap.version, name, parent);
      } else if (dd?.synced_name !== name || move.addParents) {
        const f = await updateMetadata(fileId!, { name }, move);
        saveDriveDoc(docId, f, null, name, parent);
      }
      return;
    } catch (e) {
      // The file was deleted in Drive by the owner: forget it and upload a fresh copy.
      if (fileId && is404(e) && pass === 0) {
        getDb()
          .prepare("UPDATE drive_docs SET file_id = NULL, web_view_link = NULL, synced_version = NULL, synced_parent = NULL WHERE doc_id = ?")
          .run(docId);
        dd = driveDoc(docId);
        continue;
      }
      throw e;
    }
  }
}

/** Permanent delete in the app: move the Drive copy to Drive's own trash (recoverable for 30 days there). */
async function deleteDoc(docId: string): Promise<void> {
  const dd = driveDoc(docId);
  if (dd?.file_id && !getDocRow(docId)) {
    try {
      await updateMetadata(dd.file_id, { trashed: true });
    } catch (e) {
      if (!is404(e)) throw e;
    }
  }
  if (!getDocRow(docId)) getDb().prepare("DELETE FROM drive_docs WHERE doc_id = ?").run(docId);
}

async function syncFolder(job: JobRow): Promise<void> {
  const folderId = job.target_id;
  const db = getDb();
  const m = db.prepare("SELECT * FROM drive_folders WHERE folder_id = ?").get(folderId) as FolderMapRow | undefined;
  if (!m) return;
  if (db.prepare("SELECT 1 FROM folders WHERE id = ?").get(folderId)) {
    await ensureFolder(folderId);
    return;
  }
  // Folder deleted in the app: its docs/subfolders were re-queued first. Trash the Drive folder only once empty
  // (trashing a Drive folder trashes everything inside it).
  try {
    if (await hasChildren(m.drive_id)) {
      if (job.attempts < 4) throw new DriveError("Drive folder still has items; waiting for them to move", 409, { retryable: true });
    } else {
      await updateMetadata(m.drive_id, { trashed: true });
    }
  } catch (e) {
    if (!is404(e)) throw e;
  }
  db.prepare("DELETE FROM drive_folders WHERE folder_id = ?").run(folderId);
}

/** Permanently deleted mirror item: Drive's trash keeps it for 30 days (never a hard delete). */
async function trashFile(job: JobRow): Promise<void> {
  // never trash a file that a live document (still) points at
  if (getDb().prepare("SELECT 1 FROM drive_docs WHERE file_id = ?").get(job.target_id)) return;
  try {
    await updateMetadata(job.target_id, { trashed: true });
  } catch (e) {
    if (!is404(e)) throw e;
  }
}

const HANDLERS: Record<JobRow["kind"], (job: JobRow) => Promise<void>> = {
  doc: syncDoc,
  delete: async (job) => deleteDoc(job.target_id),
  folder: syncFolder,
  trash_file: trashFile,
};

/* -------------------------------------------------------------- worker */

function schedule(ms: number) {
  const s = state();
  if (!s.started) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    void pump();
  }, Math.max(0, ms));
  s.timer.unref?.();
}

/** Start once per process; interrupted jobs go back to the queue. */
export function startDriveWorker(): void {
  const s = state();
  setDriveKick(() => schedule(300));
  if (s.started) return;
  s.started = true;
  getDb().prepare("UPDATE drive_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(nowIso());
  schedule(2000);
}

export function kickDriveWorker(): void {
  schedule(100);
}

function recordFailure(job: JobRow, e: unknown) {
  const db = getDb();
  const msg = ((e as Error)?.message || "Drive sync failed").slice(0, 300);
  const attempts = job.attempts + 1;
  const err = e instanceof DriveError ? e : null;
  const retryable = !err || err.retryable || err.status === 0 || err.status >= 500;
  const exhausted = attempts >= DRIVE_MAX_ATTEMPTS || (!retryable && attempts >= 3);
  if (exhausted) {
    db.prepare("UPDATE drive_jobs SET status = 'error', error = ?, updated_at = ? WHERE id = ?").run(msg, nowIso(), job.id);
  } else {
    const wait = Math.max(err?.retryAfterMs ?? 0, backoffMs(attempts));
    db.prepare("UPDATE drive_jobs SET status = 'queued', due_at = ?, error = ?, updated_at = ? WHERE id = ?").run(
      Date.now() + wait,
      msg,
      nowIso(),
      job.id,
    );
    if (err && (err.status === 429 || (err.status === 403 && err.retryable))) {
      state().pausedUntil = Date.now() + wait; // whole-account rate limit: pause the queue
    }
  }
  if (job.kind === "doc" || job.kind === "delete") db.prepare("UPDATE drive_docs SET last_error = ? WHERE doc_id = ?").run(msg, job.target_id);
  setLastError(msg);
  console.error(`[waraq] drive ${job.kind} job ${job.id} failed (attempt ${attempts}): ${msg}`);
}

async function runJob(job: JobRow): Promise<"ok" | "stop"> {
  const db = getDb();
  db.prepare("UPDATE drive_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(nowIso(), job.id);
  try {
    await HANDLERS[job.kind](job);
    db.prepare("DELETE FROM drive_jobs WHERE id = ?").run(job.id);
    setSetting(DRIVE_KEYS.lastSyncAt, nowIso());
    setLastError(null);
    return "ok";
  } catch (e) {
    if (e instanceof Defer) {
      db.prepare("UPDATE drive_jobs SET status = 'queued', attempts = attempts - 1, due_at = ?, updated_at = ? WHERE id = ?").run(
        Date.now() + e.ms,
        nowIso(),
        job.id,
      );
      return "ok";
    }
    if (e instanceof DriveAuthError) {
      // Revoked / expired grant: keep the queue and mappings, ask the owner to reconnect.
      db.prepare("UPDATE drive_jobs SET status = 'queued', attempts = attempts - 1, updated_at = ? WHERE id = ?").run(nowIso(), job.id);
      setRefreshToken(null);
      resetAccessToken();
      setSetting(DRIVE_KEYS.needsReconnect, "1");
      setLastError(e.message);
      console.error(`[waraq] drive auth failed; reconnect required`);
      return "stop";
    }
    recordFailure(job, e); // attempts was already incremented when the job started
    return "ok";
  }
}

export interface DrainOptions {
  /** run queued jobs even if not yet due (tests / manual flush); each job runs at most once per drain */
  ignoreDue?: boolean;
  maxJobs?: number;
}

/** Process due jobs until none remain. Returns the number of jobs run. */
export async function pump(opts: DrainOptions = {}): Promise<number> {
  const s = state();
  if (s.running) return 0;
  s.running = true;
  let ran = 0;
  const seen = new Set<number>();

  try {
    for (;;) {
      if (ran >= (opts.maxJobs ?? 10_000)) break;
      const now = Date.now();
      const db = getDb();
      const candidates = db
        .prepare(
          `SELECT j.* FROM drive_jobs j
           WHERE j.status = 'queued' ${opts.ignoreDue ? "" : "AND j.due_at <= ?"} ORDER BY j.due_at, j.id LIMIT 200`,
        )
        .all(...(opts.ignoreDue ? [] : [now])) as JobRow[];
      const paused = !opts.ignoreDue && s.pausedUntil > now;
      const job = paused ? undefined : candidates.find((j) => !seen.has(j.id));
      if (!job) {
        const next = db
          .prepare(`SELECT MIN(due_at) AS d FROM drive_jobs WHERE status = 'queued'`)
          .get() as { d: number | null };
        const wake = Math.max(next.d ?? Infinity, paused ? s.pausedUntil : 0);
        if (Number.isFinite(wake)) schedule(Math.max(wake - Date.now(), 500));
        break;
      }
      seen.add(job.id);
      ran++;
      const r = await runJob(job).catch((e) => {
        console.error(`[waraq] drive job ${job.id} crashed:`, (e as Error).message);
        return "ok" as const;
      });
      if (r === "stop") break; // grant failed: wait for the owner to reconnect
      if (!opts.ignoreDue) await new Promise((res) => setTimeout(res, GAP_BETWEEN_JOBS_MS));
    }
  } finally {
    s.running = false;
    s.idle.splice(0).forEach((w) => w());
  }
  return ran;
}

/** For tests: run every queued job once, ignoring debounce/backoff timers. */
export const drainDriveQueue = (opts: DrainOptions = {}) => pump({ ignoreDue: true, ...opts });

/** For tests: forget cached folder verification and rate-limit pauses. */
export function resetDriveWorkerState(): void {
  const s = state();
  s.verified.clear();
  s.pausedUntil = 0;
}
