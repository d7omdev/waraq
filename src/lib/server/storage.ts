import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { dataDir } from "./config";
import { assertId } from "./ids";

export function docsRoot(): string {
  return path.join(dataDir(), "docs");
}

export function docDir(id: string): string {
  return path.join(docsRoot(), assertId(id));
}

export function docPdfPath(id: string): string {
  return path.join(docDir(id), "doc.pdf");
}

export function cacheDir(id: string, version: number): string {
  return path.join(docDir(id), "cache", `v${Math.trunc(version)}`);
}

/** Writes bytes to a temp file in the same dir, fsyncs, renames atomically, fsyncs the dir. */
export async function atomicWrite(target: string, data: Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${nanoid(8)}.tmp`);
  const fh = await fsp.open(tmp, "w", 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, target);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  try {
    const dfh = await fsp.open(dir, "r");
    try {
      await dfh.sync();
    } finally {
      await dfh.close();
    }
  } catch {
    /* directory fsync unsupported: ignore */
  }
}

export async function readDocPdf(id: string): Promise<Buffer> {
  return fsp.readFile(docPdfPath(id));
}

export async function makeTempDir(prefix = "job"): Promise<string> {
  const base = path.join(dataDir(), "tmp");
  await fsp.mkdir(base, { recursive: true });
  return fsp.mkdtemp(path.join(base, `${prefix}-`));
}

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Remove render caches for versions other than `keep`. */
export async function pruneCache(id: string, keep: number): Promise<void> {
  const root = path.join(docDir(id), "cache");
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries.filter((e) => e !== `v${keep}`).map((e) => fsp.rm(path.join(root, e), { recursive: true, force: true })),
  );
}

export async function removeDocFiles(id: string): Promise<void> {
  await fsp.rm(docDir(id), { recursive: true, force: true });
}

export function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Remove stale temp dirs (e.g. left by a crash). */
export async function cleanTmp(maxAgeMs = 6 * 3600 * 1000): Promise<void> {
  const base = path.join(dataDir(), "tmp");
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(base);
  } catch {
    return;
  }
  const now = Date.now();
  for (const e of entries) {
    const p = path.join(base, e);
    try {
      const st = await fsp.stat(p);
      if (now - st.mtimeMs > maxAgeMs) await fsp.rm(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
