import type { Folder } from "@/lib/types";
import { getDb } from "./db";
import { HttpError } from "./errors";
import { assertId, newId, nowIso } from "./ids";
import { enqueueDriveFolder, enqueueDriveSync, enqueueDriveTrashFile } from "./drive-queue";
import { thumbUrl } from "./docs";

interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
  doc_count: number;
  child_count: number;
}

const SELECT = `SELECT f.*,
  (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.trashed_at IS NULL) AS doc_count,
  (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS child_count
  FROM folders f WHERE 1 = 1`;

/** Up to 3 thumbnails: the folder's own most recent docs first, then docs from its subfolders. */
function previewThumbs(folderId: string): string[] {
  const rows = getDb()
    .prepare(
      `WITH RECURSIVE sub(id, depth) AS (SELECT ?, 0 UNION SELECT f.id, sub.depth + 1 FROM folders f JOIN sub ON f.parent_id = sub.id WHERE sub.depth < 32)
       SELECT d.id, d.version FROM documents d JOIN sub ON d.folder_id = sub.id
       WHERE d.trashed_at IS NULL AND d.status != 'error'
       ORDER BY sub.depth = 0 DESC, d.updated_at DESC LIMIT 3`,
    )
    .all(folderId) as { id: string; version: number }[];
  return rows.map((r) => thumbUrl(r.id, 0, r.version));
}

function toApi(r: FolderRow): Folder {
  return {
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    color: r.color,
    docCount: r.doc_count,
    childCount: r.child_count,
    previewThumbs: previewThumbs(r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listFolders(): Folder[] {
  return (getDb().prepare(`${SELECT} ORDER BY f.name COLLATE NOCASE`).all() as FolderRow[]).map(toApi);
}

export function getFolder(id: string): Folder {
  assertId(id, "Folder not found");
  const r = getDb().prepare(`${SELECT} AND f.id = ?`).get(id) as FolderRow | undefined;
  if (!r) throw new HttpError(404, "not_found", "Folder not found");
  return toApi(r);
}

function checkParent(id: string | null, parentId: string | null | undefined): string | null {
  if (parentId === undefined || parentId === null || parentId === "root") return null;
  const parent = getFolder(parentId);
  if (id) {
    // walk up from parent; if we reach `id`, it's a cycle
    const db = getDb();
    let cur: string | null = parent.id;
    let guard = 0;
    while (cur && guard++ < 1000) {
      if (cur === id) throw new HttpError(400, "folder_cycle", "A folder cannot be moved inside itself");
      cur = (db.prepare("SELECT parent_id FROM folders WHERE id = ?").get(cur) as { parent_id: string | null } | undefined)
        ?.parent_id ?? null;
    }
  }
  return parent.id;
}

export function createFolder(input: { name: string; parentId?: string | null; color?: string | null }): Folder {
  const id = newId();
  const now = nowIso();
  const parent = checkParent(null, input.parentId);
  getDb()
    .prepare("INSERT INTO folders (id, name, parent_id, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, input.name, parent, input.color ?? null, now, now);
  return getFolder(id);
}

export function updateFolder(id: string, patch: { name?: string; parentId?: string | null; color?: string | null }): Folder {
  getFolder(id);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    vals.push(patch.name);
  }
  if (patch.parentId !== undefined) {
    sets.push("parent_id = ?");
    vals.push(checkParent(id, patch.parentId));
  }
  if (patch.color !== undefined) {
    sets.push("color = ?");
    vals.push(patch.color);
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    vals.push(nowIso());
    getDb()
      .prepare(`UPDATE folders SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals, id);
    if (patch.name !== undefined || patch.parentId !== undefined) enqueueDriveFolder(id);
  }
  return getFolder(id);
}

/** Docs inside move to root; subfolders are re-parented to the deleted folder's parent. */
export function deleteFolder(id: string): void {
  const f = getFolder(id);
  const db = getDb();
  const now = nowIso();
  const docIds = (db.prepare("SELECT id FROM documents WHERE folder_id = ?").all(id) as { id: string }[]).map((r) => r.id);
  const childIds = (db.prepare("SELECT id FROM folders WHERE parent_id = ?").all(id) as { id: string }[]).map((r) => r.id);
  const driveFolder = db.prepare("SELECT drive_id FROM drive_folders WHERE folder_id = ?").get(id) as { drive_id: string } | undefined;
  db.transaction(() => {
    db.prepare("UPDATE documents SET folder_id = NULL, updated_at = ? WHERE folder_id = ?").run(now, id);
    db.prepare("UPDATE folders SET parent_id = ?, updated_at = ? WHERE parent_id = ?").run(f.parentId, now, id);
    db.prepare("DELETE FROM folders WHERE id = ?").run(id);
  })();
  // Drive mirror: move contents out first, then the (now empty) Drive folder is trashed.
  docIds.forEach((d) => enqueueDriveSync(d));
  childIds.forEach((c) => enqueueDriveFolder(c));
  if (driveFolder) enqueueDriveTrashFile(driveFolder.drive_id);
}
