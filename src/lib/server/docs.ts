import type { DocDetail, DocProcessing, DocSummary, PageInfo } from "@/lib/types";
import { getDb } from "./db";
import { HttpError } from "./errors";
import { assertId, newId, nowIso } from "./ids";
import { atomicWrite, docPdfPath } from "./storage";
import { deleteDocFiles, pruneRenders, readDocBytes, writeDocBytes } from "./doc-storage";
import { inspectPdf, type PageMeta } from "./pdf";
import { withDocLock } from "./locks";
import { enqueueOcr } from "./jobs";
import { enqueueDriveSync, enqueueDriveTrashFile } from "./drive-queue";
import { listShares } from "./share-model";
import { buildFtsQuery, normalizeForSearch, SNIPPET_CLOSE, SNIPPET_OPEN } from "./search";
import { trashRetentionMs } from "./prefs";

export type DocSource = DocSummary["source"];

export interface DocRow {
  id: string;
  title: string;
  folder_id: string | null;
  tags: string;
  starred: number;
  page_count: number;
  size_bytes: number;
  pages_json: string;
  status: DocSummary["status"];
  ocr_status: DocSummary["ocrStatus"];
  ocr_text: string | null;
  version: number;
  source: DocSource;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
  processing_json: string | null;
  processing_error: string | null;
  ocr_engine: "drive" | "tesseract" | null;
  ocr_layer_text: string | null;
}

/** Internal processing state (documents.processing_json). Only stage/pagesDone/pagesTotal reach the API. */
export interface ProcessingState extends DocProcessing {
  kind: "create" | "insert";
  /** upload batch dir under docs/<id>/incoming/ */
  batch: string;
  /** insert: first new page index and number of new pages (estimated until built) */
  at: number;
  count: number;
  /** new page indexes already pre-rendered into the render cache */
  ready: number[];
  /**
   * Drive documents whose upload to the owner's Google Drive failed: automatic retries (the originals stay in
   * docs/<id>/incoming/ on the server until one succeeds). See retryDriveUploads in ingest.ts.
   */
}

export function parseProcessing(raw: string | null | undefined): ProcessingState | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as ProcessingState;
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

/** Is page `index` (current layout) still waiting to be built? */
export function pagePending(row: Pick<DocRow, "status" | "processing_json">, index: number): boolean {
  if (row.status !== "processing") return false;
  const p = parseProcessing(row.processing_json);
  if (!p) return true;
  if (p.kind === "insert" && (index < p.at || index >= p.at + p.count)) return false;
  return !p.ready?.includes(index);
}

/** While inserting, existing pages keep rendering from the current PDF: maps a layout index to the PDF index. */
export function sourcePageIndex(row: Pick<DocRow, "status" | "processing_json">, index: number): number {
  if (row.status !== "processing") return index;
  const p = parseProcessing(row.processing_json);
  if (!p || p.kind !== "insert") return index;
  return index < p.at ? index : index - p.count;
}

const SUMMARY_COLS =
  "d.id, d.title, d.folder_id, d.tags, d.starred, d.page_count, d.size_bytes, d.status, d.ocr_status, d.version, d.source, d.created_at, d.updated_at, d.trashed_at, d.processing_json, d.processing_error, d.ocr_engine";

export function thumbUrl(id: string, index: number, version: number) {
  return `/api/docs/${id}/pages/${index}/thumb?v=${version}`;
}
export function imageUrl(id: string, index: number, version: number) {
  return `/api/docs/${id}/pages/${index}/image?v=${version}`;
}

function parseTags(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

type SummaryRow = Omit<
  DocRow,
  "pages_json" | "ocr_text" | "ocr_layer_text" | "processing_json" | "processing_error" | "ocr_engine"
> &
  Partial<Pick<DocRow, "processing_json" | "processing_error" | "ocr_engine">> & { snippet?: string | null };

export function rowToSummary(r: SummaryRow): DocSummary {
  const s: DocSummary = {
    id: r.id,
    title: r.title,
    folderId: r.folder_id,
    tags: parseTags(r.tags),
    starred: !!r.starred,
    pageCount: r.page_count,
    sizeBytes: r.size_bytes,
    status: r.status,
    ocrStatus: r.ocr_status,
    version: r.version,
    thumbUrl: thumbUrl(r.id, 0, r.version),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    trashedAt: r.trashed_at,
    source: r.source,
    processing: null,
    processingError: r.status === "error" ? (r.processing_error ?? "Processing failed") : null,
    ocrEngine: r.ocr_engine ?? null,
  };
  if (r.status === "processing") {
    const p = parseProcessing(r.processing_json);
    s.processing = { stage: p?.stage ?? "queued", pagesDone: p?.pagesDone ?? 0, pagesTotal: p?.pagesTotal ?? r.page_count };
  }
  if (r.snippet) s.snippet = r.snippet;
  return s;
}

export function getDocRow(id: string): DocRow | undefined {
  return getDb().prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocRow | undefined;
}

/** Public share resolution (the share token is the authorization). */
export const getDocRowForShare = getDocRow;

export function requireDoc(id: string, opts: { allowTrashed?: boolean } = {}): DocRow {
  assertId(id, "Document not found");
  const row = getDocRow(id);
  if (!row) throw new HttpError(404, "not_found", "Document not found");
  if (row.trashed_at && !opts.allowTrashed) throw new HttpError(409, "trashed", "Document is in the trash");
  return row;
}

/** Content operations need a built PDF: 409 while processing (Retry-After) or when creation failed. */
export function assertReady(row: DocRow): DocRow {
  if (row.status === "processing") {
    throw new HttpError(409, "processing", "Document is still processing; try again in a moment", { "Retry-After": "2" });
  }
  if (row.status === "error" && parseProcessing(row.processing_json)?.kind === "create") {
    throw new HttpError(409, "processing_failed", row.processing_error || "Document processing failed; retry it first");
  }
  return row;
}

export function requireReadyDoc(id: string, opts: { allowTrashed?: boolean } = {}): DocRow {
  return assertReady(requireDoc(id, opts));
}

export function pageInfos(row: DocRow): PageInfo[] {
  let metas: PageMeta[] = [];
  try {
    metas = JSON.parse(row.pages_json);
  } catch {
    metas = [];
  }
  return metas.map((m, i) => ({
    index: i,
    width: m.width,
    height: m.height,
    rotation: m.rotation,
    thumbUrl: thumbUrl(row.id, i, row.version),
    imageUrl: imageUrl(row.id, i, row.version),
    status: pagePending(row, i) ? "processing" : "ready",
  }));
}

export function getDocDetail(id: string): DocDetail {
  const row = requireDoc(id, { allowTrashed: true });
  return {
    ...rowToSummary(row),
    pages: pageInfos(row),
    ocrText: row.ocr_text,
    hasPassword: false,
    shares: listShares(row.id),
  };
}

export function ftsSync(id: string): void {
  const db = getDb();
  const row = db.prepare("SELECT title, ocr_text, ocr_layer_text FROM documents WHERE id = ?").get(id) as
    | { title: string; ocr_text: string | null; ocr_layer_text: string | null }
    | undefined;
  if (!row) {
    // gone (or not ours): only drop an orphaned index row, never another user's
    if (!db.prepare("SELECT 1 FROM documents WHERE id = ?").get(id)) db.prepare("DELETE FROM docs_fts WHERE doc_id = ?").run(id);
    return;
  }
  db.prepare("DELETE FROM docs_fts WHERE doc_id = ?").run(id);
  {
    db.prepare("INSERT INTO docs_fts (doc_id, title, body) VALUES (?, ?, ?)").run(
      id,
      normalizeForSearch(row.title),
      normalizeForSearch(
        [row.ocr_text ?? "", row.ocr_layer_text && row.ocr_layer_text !== row.ocr_text ? row.ocr_layer_text : ""]
          .join("\n")
          .replace(/[\f\v]+/g, "\n"),
      ),
    );
  }
}

/** Per-page Drive OCR text (index = page), or null when the document text is not from Drive. */
export function ocrPageTexts(id: string): string[] | null {
  const rows = getDb()
    .prepare("SELECT page, engine, text FROM ocr_pages WHERE doc_id = ? ORDER BY page")
    .all(id) as {
    page: number;
    engine: string;
    text: string;
  }[];
  if (!rows.some((r) => r.engine === "drive")) return null;
  const out: string[] = [];
  rows.forEach((r) => (out[r.page] = r.text));
  return out;
}

export function copyOcrPages(from: string, to: string): void {
  getDb()
    .prepare(
      `INSERT INTO ocr_pages (doc_id, page, engine, hash, text, updated_at) SELECT ?, page, engine, hash, text, ? FROM ocr_pages
       WHERE doc_id = ? AND EXISTS (SELECT 1 FROM documents WHERE id = ?)`,
    )
    .run(to, nowIso(), from, to);
}

export function assertFolder(folderId: string | null | undefined): string | null {
  if (folderId === undefined || folderId === null || folderId === "" || folderId === "root") return null;
  assertId(folderId, "Folder not found");
  const f = getDb().prepare("SELECT id FROM folders WHERE id = ?").get(folderId);
  if (!f) throw new HttpError(404, "folder_not_found", "Folder not found");
  return folderId;
}

export function defaultTitle(prefix = "Scan"): string {
  const tz = process.env.WARAQ_TZ || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${prefix} ${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

export function cleanTitle(t: string | null | undefined, fallback: string): string {
  const s = (t ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return s || fallback;
}

export interface CreateDocInput {
  pdf: Uint8Array;
  title: string;
  folderId?: string | null;
  source: DocSource;
  tags?: string[];
  starred?: boolean;
  ocrText?: string | null;
  ocrStatus?: DocSummary["ocrStatus"];
  ocrLayerText?: string | null;
  ocrEngine?: DocRow["ocr_engine"];
  /** queue OCR after create (default true) */
  ocr?: boolean;
}

export async function createDocument(input: CreateDocInput): Promise<string> {
  const id = newId();
  const info = await inspectPdf(input.pdf);
  if (info.pageCount === 0) throw new HttpError(422, "empty_document", "Document has no pages");
  const folderId = assertFolder(input.folderId ?? null);
  await atomicWrite(docPdfPath(id), input.pdf);
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO documents (id, title, folder_id, tags, starred, page_count, size_bytes, pages_json, status, ocr_status, ocr_text, ocr_layer_text, ocr_engine, version, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      id,
      input.title,
      folderId,
      JSON.stringify(input.tags ?? []),
      input.starred ? 1 : 0,
      info.pageCount,
      input.pdf.byteLength,
      JSON.stringify(info.pages),
      input.ocrStatus ?? "none",
      input.ocrText ?? null,
      input.ocrLayerText ?? null,
      input.ocrText ? (input.ocrEngine ?? "tesseract") : null,
      input.source,
      now,
      now,
    );
  ftsSync(id);
  if (input.ocr !== false) enqueueOcr(id);
  enqueueDriveSync(id);
  return id;
}

/**
 * Replace a document's content atomically under the doc lock. `fn` receives current bytes and returns new ones.
 * Bumps version, prunes old render caches and (by default) re-queues OCR.
 */
export async function mutateContent(
  id: string,
  fn: (current: Buffer, row: DocRow) => Promise<Uint8Array | null>,
  opts: { ocr?: boolean } = {},
): Promise<{ row: DocRow; changed: boolean }> {
  requireReadyDoc(id);
  return withDocLock(id, async () => {
    const row = requireReadyDoc(id);
    const current = await readDocBytes(id);
    const next = await fn(current, row);
    if (!next) return { row, changed: false };
    const info = await inspectPdf(next);
    await writeDocBytes(id, next);
    const version = row.version + 1;
    getDb()
      .prepare(
        "UPDATE documents SET version = ?, page_count = ?, size_bytes = ?, pages_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(version, info.pageCount, next.byteLength, JSON.stringify(info.pages), nowIso(), id);
    if (opts.ocr !== false) enqueueOcr(id);
    enqueueDriveSync(id);
    await pruneRenders(id, version);
    return { row: getDocRow(id)!, changed: true };
  });
}

export interface MetaPatch {
  title?: string;
  folderId?: string | null;
  tags?: string[];
  starred?: boolean;
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.replace(/[\u0000-\u001f\u007f,]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    const key = t.toLowerCase();
    if (t && !seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out.slice(0, 30);
}

export function updateMeta(id: string, patch: MetaPatch): DocSummary {
  const row = requireDoc(id, { allowTrashed: true });
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    vals.push(cleanTitle(patch.title, row.title));
  }
  if (patch.folderId !== undefined) {
    sets.push("folder_id = ?");
    vals.push(assertFolder(patch.folderId));
  }
  if (patch.tags !== undefined) {
    sets.push("tags = ?");
    vals.push(JSON.stringify(normalizeTags(patch.tags)));
  }
  if (patch.starred !== undefined) {
    sets.push("starred = ?");
    vals.push(patch.starred ? 1 : 0);
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    vals.push(nowIso());
    getDb()
      .prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals, id);
    if (patch.title !== undefined) ftsSync(id);
    if (patch.title !== undefined || patch.folderId !== undefined) enqueueDriveSync(id);
  }
  return rowToSummary(getDocRow(id)!);
}

export function trashDoc(id: string): void {
  const row = requireDoc(id, { allowTrashed: true });
  if (row.trashed_at) return;
  getDb().prepare("UPDATE documents SET trashed_at = ? WHERE id = ?").run(nowIso(), id);
  enqueueDriveSync(id);
}

export function restoreDoc(id: string): DocSummary {
  const row = requireDoc(id, { allowTrashed: true });
  if (row.trashed_at) {
    getDb().prepare("UPDATE documents SET trashed_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id);
    enqueueDriveSync(id);
  }
  return rowToSummary(getDocRow(id)!);
}

export async function hardDeleteDoc(id: string): Promise<void> {
  requireDoc(id, { allowTrashed: true }); // 404 when missing
  const mirror = getDb().prepare("SELECT file_id FROM drive_docs WHERE doc_id = ?").get(id) as { file_id: string | null } | undefined;
  await withDocLock(id, async () => {
    const db = getDb();
    const row = getDocRow(id);
    if (!row) return;
    db.transaction(() => {
      db.prepare("DELETE FROM jobs WHERE doc_id = ?").run(id);
      db.prepare("DELETE FROM docs_fts WHERE doc_id = ?").run(id);
      db.prepare("DELETE FROM shares WHERE doc_id = ?").run(id);
      db.prepare("DELETE FROM ocr_pages WHERE doc_id = ?").run(id);
      db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    })();
    await deleteDocFiles(id);
  });
  if (mirror?.file_id) enqueueDriveTrashFile(mirror.file_id);
}

export async function purgeTrash(): Promise<number> {
  const cutoff = new Date(Date.now() - trashRetentionMs()).toISOString();
  const rows = getDb()
    .prepare("SELECT id, title, page_count FROM documents WHERE trashed_at IS NOT NULL AND trashed_at < ?")
    .all(cutoff) as { id: string; title: string; page_count: number }[];
  for (const r of rows) {
    await hardDeleteDoc(r.id);
  }
  return rows.length;
}

export interface ListParams {
  folderId?: string;
  /** with folderId=<id>: include documents in every descendant folder */
  includeSubfolders?: boolean;
  q?: string;
  tag?: string;
  starred?: boolean;
  trash?: boolean;
  sort?: "updated" | "created" | "title" | "size";
  dir?: "asc" | "desc";
  limit?: number;
  cursor?: string;
}

function decodeCursor(c?: string): number {
  if (!c) return 0;
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (Number.isInteger(v?.o) && v.o >= 0) return v.o;
  } catch {
    /* fallthrough */
  }
  throw new HttpError(400, "invalid_cursor", "Invalid cursor");
}

const encodeCursor = (o: number) => Buffer.from(JSON.stringify({ o })).toString("base64url");

export function listDocs(p: ListParams): { items: DocSummary[]; nextCursor: string | null } {
  const where: string[] = [];
  const vals: unknown[] = [];
  where.push(p.trash ? "d.trashed_at IS NOT NULL" : "d.trashed_at IS NULL");
  if (p.folderId === "root") where.push("d.folder_id IS NULL");
  else if (p.folderId) {
    assertId(p.folderId, "Folder not found");
    if (p.includeSubfolders) {
      where.push(
        "d.folder_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id) SELECT id FROM sub)",
      );
      vals.push(p.folderId);
    } else {
      where.push("d.folder_id = ?");
      vals.push(p.folderId);
    }
  }
  if (p.starred) where.push("d.starred = 1");
  if (p.tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(d.tags) WHERE lower(json_each.value) = lower(?))");
    vals.push(p.tag);
  }
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
  const offset = decodeCursor(p.cursor);
  const dir = p.dir === "asc" ? "ASC" : "DESC";
  const sortCol =
    p.sort === "created" ? "d.created_at" : p.sort === "title" ? "d.title COLLATE NOCASE" : p.sort === "size" ? "d.size_bytes" : "d.updated_at";

  const fts = p.q ? buildFtsQuery(p.q) : null;
  let sql: string;
  if (p.q && !fts) return { items: [], nextCursor: null };
  if (fts) {
    const order = p.sort ? `${sortCol} ${dir}, d.id` : "rank, d.updated_at DESC";
    sql = `SELECT ${SUMMARY_COLS}, snippet(docs_fts, -1, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 12) AS snippet, bm25(docs_fts, 0, 5.0, 1.0) AS rank
           FROM docs_fts JOIN documents d ON d.id = docs_fts.doc_id
           WHERE docs_fts MATCH ? AND ${where.join(" AND ")}
           ORDER BY ${order} LIMIT ? OFFSET ?`;
    vals.unshift(fts);
  } else {
    sql = `SELECT ${SUMMARY_COLS} FROM documents d WHERE ${where.join(" AND ")} ORDER BY ${sortCol} ${dir}, d.id ${dir} LIMIT ? OFFSET ?`;
  }
  const rows = getDb()
    .prepare(sql)
    .all(...vals, limit + 1, offset) as (DocRow & { snippet?: string })[];
  const more = rows.length > limit;
  return {
    items: rows.slice(0, limit).map(rowToSummary),
    nextCursor: more ? encodeCursor(offset + limit) : null,
  };
}

export function listTags(): { tag: string; count: number }[] {
  const rows = getDb()
    .prepare(
      `SELECT json_each.value AS tag, COUNT(*) AS count FROM documents d, json_each(d.tags)
       WHERE d.trashed_at IS NULL GROUP BY lower(json_each.value) ORDER BY count DESC, tag COLLATE NOCASE`,
    )
    .all() as { tag: string; count: number }[];
  return rows;
}
