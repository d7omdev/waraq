// The one place that knows where a document's PDF lives (always DATA_DIR/docs/<id>/ on this server).
// Google Drive is only an optional mirror (see drive-sync.ts); core reads and writes never touch it.
import fsp from "node:fs/promises";
import { atomicWrite, cacheDir, docPdfPath, pruneCache, removeDocFiles } from "./storage";

/** Local path of the document's current PDF. */
export async function docPdfFile(id: string): Promise<string> {
  return docPdfPath(id);
}

export async function readDocBytes(id: string): Promise<Buffer> {
  return fsp.readFile(/* turbopackIgnore: true */ docPdfPath(id));
}

/** Replace the document's PDF atomically. */
export async function writeDocBytes(id: string, bytes: Uint8Array): Promise<void> {
  return atomicWrite(docPdfPath(id), bytes);
}

/** Where page renders/thumbnails for a document version go. */
export function renderCacheDir(id: string, version: number): string {
  return cacheDir(id, version);
}

/** Remove render caches for versions other than `keep`. */
export async function pruneRenders(id: string, keep: number): Promise<void> {
  await pruneCache(id, keep);
}

/** After the document row is gone: remove its server files (docs/<id> and render caches). */
export async function deleteDocFiles(id: string): Promise<void> {
  await removeDocFiles(id);
}
