import { PDFDocument, degrees, EncryptedPDFError } from "pdf-lib";
import sharp from "sharp";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PageOp } from "@/lib/types";
import { HttpError } from "./errors";
import { LIMITS } from "./config";
import { run } from "./exec";
import { withTempDir } from "./storage";

export interface PageMeta {
  width: number;
  height: number;
  rotation: number;
}

export interface PdfInfo {
  pageCount: number;
  pages: PageMeta[];
}

export type InputKind = "pdf" | "jpeg" | "png" | "webp";

/** Detect file type by magic bytes (never trust client mime types). */
export function sniffType(buf: Uint8Array): InputKind | null {
  if (buf.length < 12) return null;
  const s = (a: number, b: number) => Buffer.from(buf.subarray(a, b)).toString("latin1");
  // %PDF may be preceded by junk bytes within the first 1KB per spec
  const head = Buffer.from(buf.subarray(0, Math.min(1024, buf.length))).toString("latin1");
  if (head.includes("%PDF-")) return "pdf";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf[0] === 0x89 && s(1, 4) === "PNG") return "png";
  if (s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return "webp";
  return null;
}

export function normRotation(angle: number): number {
  return (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
}

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    throw new HttpError(422, "invalid_pdf", `Could not read PDF: ${(e as Error).message.slice(0, 120)}`);
  }
}

/**
 * Load a user-supplied PDF. Encrypted PDFs without a user password are decrypted with qpdf;
 * broken PDFs are repaired with qpdf when possible.
 */
export async function loadImportedPdf(bytes: Uint8Array): Promise<PDFDocument> {
  let encrypted = false;
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    if (doc.isEncrypted) encrypted = true;
    else if (doc.getPages().length > 0) return doc; // pdf-lib can "succeed" on junk; require real pages
  } catch (e) {
    if (e instanceof EncryptedPDFError) encrypted = true;
  }
  const fixed = await withTempDir("import", async (dir) => {
    const inp = path.join(dir, "in.pdf");
    const out = path.join(dir, "out.pdf");
    await fsp.writeFile(inp, bytes);
    const args = encrypted ? ["--decrypt", inp, out] : [inp, out];
    const r = await run("qpdf", args, { timeoutMs: 120_000 }).catch(() => null);
    // qpdf exit 3 = warnings but output written
    if (!r || (r.code !== 0 && r.code !== 3)) return null;
    return fsp.readFile(out).catch(() => null);
  });
  if (!fixed) {
    throw encrypted
      ? new HttpError(422, "encrypted_pdf", "This PDF is password-protected")
      : new HttpError(422, "invalid_pdf", "Could not read PDF");
  }
  try {
    const doc = await PDFDocument.load(fixed, { updateMetadata: false });
    if (doc.isEncrypted) throw new HttpError(422, "encrypted_pdf", "This PDF is password-protected");
    if (doc.getPages().length === 0) throw new HttpError(422, "empty_document", "PDF has no pages");
    return doc;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, encrypted ? "encrypted_pdf" : "invalid_pdf", "Could not read PDF");
  }
}

export function pageMetas(doc: PDFDocument): PageMeta[] {
  return doc.getPages().map((p) => {
    const box = p.getCropBox();
    return {
      width: Math.round(box.width * 100) / 100,
      height: Math.round(box.height * 100) / 100,
      rotation: normRotation(p.getRotation().angle),
    };
  });
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const doc = await loadPdf(bytes);
  const pages = pageMetas(doc);
  return { pageCount: pages.length, pages };
}

export interface NormalizedImage {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** Auto-orient by EXIF, cap long edge, flatten alpha onto white, JPEG q85. */
export async function normalizeImage(input: Uint8Array): Promise<NormalizedImage> {
  try {
    const { data, info } = await sharp(input, { failOn: "error", limitInputPixels: 120_000_000 })
      .rotate()
      .resize({
        width: LIMITS.imageMaxEdge,
        height: LIMITS.imageMaxEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85, mozjpeg: false })
      .toBuffer({ resolveWithObject: true });
    return { jpeg: data, width: info.width, height: info.height };
  } catch {
    throw new HttpError(422, "invalid_image", "Could not read image");
  }
}

/** Add one page (width 595pt, height by aspect) containing the image. */
export async function addImagePage(doc: PDFDocument, img: NormalizedImage): Promise<void> {
  const embedded = await doc.embedJpg(img.jpeg);
  const w = LIMITS.pageWidthPt;
  const h = Math.max(1, Math.round((w * img.height) / img.width * 100) / 100);
  const page = doc.addPage([w, h]);
  page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
}

export interface UploadInput {
  kind: InputKind;
  bytes: Uint8Array;
}

/** Build a single PDF from ordered images/PDFs. */
export async function buildPdfFromInputs(inputs: UploadInput[]): Promise<Uint8Array> {
  if (inputs.length === 0) throw new HttpError(400, "no_files", "No files provided");
  const out = await PDFDocument.create();
  out.setProducer("Waraq");
  out.setCreator("Waraq");
  for (const inp of inputs) {
    if (inp.kind === "pdf") {
      const src = await loadImportedPdf(inp.bytes);
      try {
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } catch {
        throw new HttpError(422, "invalid_pdf", "Could not read PDF");
      }
    } else {
      await addImagePage(out, await normalizeImage(inp.bytes));
    }
    if (out.getPageCount() > LIMITS.maxPagesPerDoc) {
      throw new HttpError(413, "too_many_pages", `Documents are limited to ${LIMITS.maxPagesPerDoc} pages`);
    }
  }
  if (out.getPageCount() === 0) throw new HttpError(422, "empty_document", "No pages found in upload");
  return out.save();
}

/** A page in a result document: page `page` of source `src`, rotated by `rotate` extra degrees. */
export interface PageRef {
  src: number;
  page: number;
  rotate: number;
}

/** Assemble a new PDF from page references into one or more source documents. */
export async function assemble(sources: PDFDocument[], refs: PageRef[]): Promise<Uint8Array> {
  if (refs.length === 0) throw new HttpError(400, "empty_document", "A document must have at least one page");
  if (refs.length > LIMITS.maxPagesPerDoc) {
    throw new HttpError(413, "too_many_pages", `Documents are limited to ${LIMITS.maxPagesPerDoc} pages`);
  }
  const out = await PDFDocument.create();
  out.setProducer("Waraq");
  out.setCreator("Waraq");
  // copy each source's needed pages in one batch (copyPages returns independent copies even for repeats)
  const copied = new Map<number, Awaited<ReturnType<PDFDocument["copyPages"]>>>();
  const positions = new Map<number, number[]>();
  refs.forEach((r) => {
    if (!positions.has(r.src)) positions.set(r.src, []);
    positions.get(r.src)!.push(r.page);
  });
  for (const [src, pages] of positions) copied.set(src, await out.copyPages(sources[src], pages));
  const cursor = new Map<number, number>();
  for (const r of refs) {
    const i = cursor.get(r.src) ?? 0;
    cursor.set(r.src, i + 1);
    const page = copied.get(r.src)![i];
    if (r.rotate) page.setRotation(degrees(normRotation(page.getRotation().angle + r.rotate)));
    else page.setRotation(degrees(normRotation(page.getRotation().angle)));
    out.addPage(page);
  }
  return out.save();
}

function checkPages(pages: number[], count: number, label = "pages"): void {
  if (!Array.isArray(pages) || pages.length === 0) throw new HttpError(400, "invalid_page", `${label} must not be empty`);
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 0 || p >= count) {
      throw new HttpError(400, "invalid_page", `Page index ${p} out of range (0..${count - 1})`);
    }
  }
}

/** Pure: apply page ops to a list of refs (all initially pointing at source 0). */
export function applyOpsToRefs(count: number, ops: PageOp[]): PageRef[] {
  let refs: PageRef[] = Array.from({ length: count }, (_, i) => ({ src: 0, page: i, rotate: 0 }));
  for (const op of ops) {
    const n = refs.length;
    switch (op.op) {
      case "rotate": {
        checkPages(op.pages, n);
        if (![90, 180, 270].includes(op.degrees)) throw new HttpError(400, "validation_error", "degrees must be 90, 180 or 270");
        const set = new Set(op.pages);
        refs = refs.map((r, i) => (set.has(i) ? { ...r, rotate: normRotation(r.rotate + op.degrees) } : r));
        break;
      }
      case "delete": {
        checkPages(op.pages, n);
        const set = new Set(op.pages);
        refs = refs.filter((_, i) => !set.has(i));
        if (refs.length === 0) throw new HttpError(400, "empty_document", "Cannot delete every page; delete the document instead");
        break;
      }
      case "reorder": {
        const order = op.order;
        if (!Array.isArray(order) || order.length !== n || new Set(order).size !== n) {
          throw new HttpError(400, "invalid_order", "order must be a permutation of all current page indexes");
        }
        checkPages(order, n, "order");
        refs = order.map((i) => refs[i]);
        break;
      }
      case "duplicate": {
        checkPages(op.pages, n);
        const set = new Set(op.pages);
        const next: PageRef[] = [];
        refs.forEach((r, i) => {
          next.push(r);
          if (set.has(i)) next.push({ ...r });
        });
        refs = next;
        break;
      }
      default:
        throw new HttpError(400, "validation_error", "Unknown op");
    }
  }
  return refs;
}

export async function applyPageOps(bytes: Uint8Array, ops: PageOp[]): Promise<Uint8Array> {
  const src = await loadPdf(bytes);
  const refs = applyOpsToRefs(src.getPageCount(), ops);
  return assemble([src], refs);
}

export async function insertPages(bytes: Uint8Array, newPdf: Uint8Array, at?: number): Promise<Uint8Array> {
  const a = await loadPdf(bytes);
  const b = await loadPdf(newPdf);
  const n = a.getPageCount();
  const pos = at === undefined ? n : at;
  if (!Number.isInteger(pos) || pos < 0 || pos > n) throw new HttpError(400, "invalid_page", `at must be in 0..${n}`);
  const refs: PageRef[] = [
    ...Array.from({ length: pos }, (_, i) => ({ src: 0, page: i, rotate: 0 })),
    ...b.getPageIndices().map((i) => ({ src: 1, page: i, rotate: 0 })),
    ...Array.from({ length: n - pos }, (_, i) => ({ src: 0, page: pos + i, rotate: 0 })),
  ];
  return assemble([a, b], refs);
}

export async function replacePage(bytes: Uint8Array, index: number, newPagePdf: Uint8Array): Promise<Uint8Array> {
  const a = await loadPdf(bytes);
  const b = await loadPdf(newPagePdf);
  const n = a.getPageCount();
  checkPages([index], n);
  const refs: PageRef[] = a.getPageIndices().map((i) =>
    i === index ? { src: 1, page: 0, rotate: 0 } : { src: 0, page: i, rotate: 0 },
  );
  return assemble([a, b], refs);
}

export async function extractPages(bytes: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const a = await loadPdf(bytes);
  checkPages(pages, a.getPageCount());
  return assemble([a], pages.map((p) => ({ src: 0, page: p, rotate: 0 })));
}

export function splitRanges(count: number, spec: { ranges?: number[][]; every?: number }): number[][] {
  if (spec.every !== undefined) {
    const n = spec.every;
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "validation_error", "every must be a positive integer");
    const out: number[][] = [];
    for (let i = 0; i < count; i += n) out.push(Array.from({ length: Math.min(n, count - i) }, (_, k) => i + k));
    return out;
  }
  const ranges = spec.ranges ?? [];
  if (ranges.length === 0) throw new HttpError(400, "validation_error", "ranges must not be empty");
  ranges.forEach((r) => checkPages(r, count, "range"));
  return ranges;
}

export async function splitPdf(bytes: Uint8Array, ranges: number[][]): Promise<Uint8Array[]> {
  const a = await loadPdf(bytes);
  const out: Uint8Array[] = [];
  for (const r of ranges) out.push(await assemble([a], r.map((p) => ({ src: 0, page: p, rotate: 0 }))));
  return out;
}

export async function mergePdfs(list: Uint8Array[]): Promise<Uint8Array> {
  const docs = await Promise.all(list.map((b) => loadPdf(b)));
  const refs: PageRef[] = [];
  docs.forEach((d, s) => d.getPageIndices().forEach((p) => refs.push({ src: s, page: p, rotate: 0 })));
  return assemble(docs, refs);
}
