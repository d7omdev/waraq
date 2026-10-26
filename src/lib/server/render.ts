import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { LIMITS } from "./config";
import { HttpError } from "./errors";
import { runOk } from "./exec";
import { docPdfFile, renderCacheDir } from "./doc-storage";
import { nanoid } from "nanoid";

export type RenderKind = "thumb" | "image";

const g = globalThis as unknown as { __waraqRenders?: Map<string, Promise<string>> };
const inflight = (g.__waraqRenders ??= new Map());

async function exists(p: string) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Render a page with pdftoppm to a JPEG `width` px wide (keeps page rotation). */
export async function renderPdfPageJpeg(pdfPath: string, index: number, outPath: string, width: number): Promise<void> {
  const prefix = `${outPath}.${nanoid(6)}`;
  await runOk(
    "pdftoppm",
    [
      "-f", String(index + 1),
      "-l", String(index + 1),
      "-scale-to-x", String(width),
      "-scale-to-y", "-1",
      "-jpeg",
      "-jpegopt", "quality=85,optimize=y",
      "-aa", "yes",
      "-aaVector", "yes",
      "-singlefile",
      pdfPath,
      prefix,
    ],
    { timeoutMs: 120_000 },
  );
  await fsp.rename(`${prefix}.jpg`, outPath);
}

/**
 * Lazily render & cache a page image for the given (current) version. Returns the file path.
 * Caller must have validated version/index against the DB row.
 */
export async function getRender(
  id: string,
  version: number,
  index: number,
  kind: RenderKind,
  stillCurrent: () => boolean = () => true,
  /** page index inside doc.pdf when it differs from the layout index (pages being inserted) */
  srcIndex: number = index,
): Promise<string> {
  const dir = renderCacheDir(id, version);
  const jpg = path.join(dir, `p${index}.jpg`);
  const webp = path.join(dir, `p${index}-thumb.webp`);
  const target = kind === "thumb" ? webp : jpg;
  if (await exists(target)) {
    const now = new Date();
    await fsp.utimes(target, now, now).catch(() => undefined); // keeps Drive-cache renders alive while in use
    return target;
  }
  const key = `${id}:${version}:${index}:${kind}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    await fsp.mkdir(dir, { recursive: true });
    if (!(await exists(jpg))) {
      const jkey = `${id}:${version}:${index}:image`;
      const jp = kind === "thumb" ? inflight.get(jkey) : undefined;
      if (jp) await jp;
      else {
        const tmpJpg = `${jpg}.${nanoid(6)}.tmp`;
        await renderPdfPageJpeg(await docPdfFile(id), srcIndex, tmpJpg, LIMITS.imageWidth);
        // the PDF may have been replaced while rendering; never cache new content under an old version
        if (!stillCurrent()) {
          await fsp.rm(tmpJpg, { force: true });
          throw new HttpError(409, "stale_version", "Document changed; reload");
        }
        await fsp.rename(tmpJpg, jpg);
      }
    }
    if (kind === "thumb") {
      const tmp = `${webp}.${nanoid(6)}.tmp`;
      await sharp(jpg).resize({ width: LIMITS.thumbWidth, withoutEnlargement: true }).webp({ quality: 72 }).toFile(tmp);
      await fsp.rename(tmp, webp);
    }
    return target;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, "render_failed", `Could not render page: ${(e as Error).message.slice(0, 100)}`);
  } finally {
    inflight.delete(key);
  }
}
