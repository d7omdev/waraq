// Drive mirror queue: tiny synchronous enqueue helpers called from document/folder mutations.
// They must NEVER throw into core operations: every public hook swallows and logs its own errors.
import { getDb } from "./db";
import { nowIso } from "./ids";
import { autoSyncEnabled, isDriveConnected } from "./drive-store";

/**
 * doc/delete/folder: the optional Drive mirror of documents stored on this server.
 * trash_file: move a mirrored Drive file or folder to Drive's trash after its row is gone (target_id is the Drive id).
 */
export type DriveJobKind = "doc" | "delete" | "folder" | "trash_file";

/** Wait this long after the last change before uploading (coalesces rapid edits). */
export const DRIVE_DEBOUNCE_MS = 10_000;

const g = globalThis as unknown as { __waraqDriveKick?: () => void };

export function setDriveKick(fn: () => void) {
  g.__waraqDriveKick = fn;
}

function kick() {
  try {
    g.__waraqDriveKick?.();
  } catch {
    /* ignore */
  }
}

function safe(what: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.error(`[waraq] drive ${what} skipped:`, (e as Error).message);
  }
}

/** Insert or debounce a queued job. Clears earlier failures for the same target. */
export function addDriveJob(kind: DriveJobKind, targetId: string, opts: { immediate?: boolean; manual?: boolean } = {}): void {
  const db = getDb();
  const now = Date.now();
  const due = opts.immediate ? now : now + DRIVE_DEBOUNCE_MS;
  const iso = nowIso();
  db.transaction(() => {
    db.prepare("DELETE FROM drive_jobs WHERE kind = ? AND target_id = ? AND status = 'error'").run(kind, targetId);
    const existing = db
      .prepare("SELECT id, due_at FROM drive_jobs WHERE kind = ? AND target_id = ? AND status = 'queued'")
      .get(kind, targetId) as { id: number; due_at: number } | undefined;
    if (existing) {
      const nextDue = opts.immediate ? Math.min(existing.due_at, due) : Math.max(existing.due_at, due);
      db.prepare("UPDATE drive_jobs SET due_at = ?, attempts = 0, manual = MAX(manual, ?), updated_at = ? WHERE id = ?").run(
        nextDue,
        opts.manual ? 1 : 0,
        iso,
        existing.id,
      );
    } else {
      db.prepare(
        "INSERT INTO drive_jobs (kind, target_id, status, attempts, manual, due_at, created_at, updated_at) VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)",
      ).run(kind, targetId, opts.manual ? 1 : 0, due, iso, iso);
    }
  })();
}

function markMirrored(docId: string) {
  getDb()
    .prepare("INSERT INTO drive_docs (doc_id, updated_at) SELECT id, ? FROM documents WHERE id = ? ON CONFLICT(doc_id) DO NOTHING")
    .run(nowIso(), docId);
}

function isMirrored(docId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM drive_docs WHERE doc_id = ?").get(docId);
}

/**
 * Queue a mirror of a document (create / content / rename / move / trash / restore are all one reconcile job).
 * With auto-sync off, only documents already mirrored (or explicitly forced) are queued.
 */
export function enqueueDriveSync(docId: string, opts: { force?: boolean; immediate?: boolean } = {}): void {
  safe("sync enqueue", () => {
    if (!isDriveConnected()) return;
    if (!opts.force && !autoSyncEnabled() && !isMirrored(docId)) return;
    markMirrored(docId);
    addDriveJob("doc", docId, { immediate: opts.immediate, manual: opts.force });
    kick();
  });
}

/** Permanent delete: the worker moves the Drive copy to Drive's trash (never a permanent delete). */
export function enqueueDriveDelete(docId: string): void {
  safe("delete enqueue", () => {
    const db = getDb();
    if (!isMirrored(docId)) return;
    if (!isDriveConnected()) {
      db.prepare("DELETE FROM drive_docs WHERE doc_id = ?").run(docId);
      return;
    }
    db.prepare("DELETE FROM drive_jobs WHERE kind = 'doc' AND target_id = ? AND status != 'running'").run(docId);
    addDriveJob("delete", docId, { immediate: true });
    kick();
  });
}

/** A mirrored file or folder lost its app row (permanent delete): move it to Drive's trash, never a hard delete. */
export function enqueueDriveTrashFile(fileId: string): void {
  safe("trash enqueue", () => {
    if (!isDriveConnected()) return;
    addDriveJob("trash_file", fileId, { immediate: true });
    kick();
  });
}

/** Folder renamed / moved / deleted: reconcile its Drive folder if one exists. */
export function enqueueDriveFolder(folderId: string): void {
  safe("folder enqueue", () => {
    if (!isDriveConnected()) return;
    if (!getDb().prepare("SELECT 1 FROM drive_folders WHERE folder_id = ?").get(folderId)) return;
    addDriveJob("folder", folderId);
    kick();
  });
}

/** Manual "Save to Drive" / "Sync everything": returns how many documents were queued. */
export function enqueueDriveSyncMany(ids: string[]): number {
  let n = 0;
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM documents WHERE id = ?");
  db.transaction(() => {
    for (const id of ids) {
      if (!exists.get(id)) continue;
      markMirrored(id);
      addDriveJob("doc", id, { immediate: true, manual: true });
      n++;
    }
  })();
  kick();
  return n;
}
