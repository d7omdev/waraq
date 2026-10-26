import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { createDocumentAsync, estimatePages, insertPagesAsync, pumpBuilds, retryProcessing } from "@/lib/server/ingest";
import { createDocument, getDocDetail, getDocRow, mutateContent, pagePending, requireReadyDoc } from "@/lib/server/docs";
import { applyPageOps, inspectPdf } from "@/lib/server/pdf";
import { renderResponse } from "@/lib/server/actions";
import { cacheDir, docDir, readDocPdf } from "@/lib/server/storage";
import { getDb } from "@/lib/server/db";
import { HttpError } from "@/lib/server/errors";
import { makePdf, pageWidths, solidImage } from "./helpers";

const png = async (w: number, h: number) => ({ kind: "png" as const, bytes: await solidImage(w, h) });
const req = (url = "http://localhost/x") => new NextRequest(url);
const jobsFor = (id: string) =>
  getDb().prepare("SELECT kind, status FROM jobs WHERE doc_id = ? ORDER BY id").all(id) as { kind: string; status: string }[];

describe("async document creation", () => {
  it("responds with a processing doc (layout estimated) and builds it in the background", async () => {
    const t0 = Date.now();
    const id = await createDocumentAsync({
      files: [await png(600, 800), { kind: "pdf", bytes: await makePdf(2) }, await png(800, 600)],
      title: "Async",
      source: "scan",
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    const d = getDocDetail(id);
    expect(d.status).toBe("processing");
    expect(d.pageCount).toBe(4);
    expect(d.processing).toEqual({ stage: "queued", pagesDone: 0, pagesTotal: 4 });
    expect(d.pages.map((p) => p.status)).toEqual(["processing", "processing", "processing", "processing"]);
    expect(d.pages[0].height).toBeCloseTo((595 * 800) / 600, 1);
    expect(d.pages[3].height).toBeCloseTo((595 * 600) / 800, 1);
    expect(fs.existsSync(path.join(docDir(id), "doc.pdf"))).toBe(false);

    const r = await renderResponse(req(), getDocRow(id)!, 0, "thumb", { cache: "private" });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ code: "processing" });
    expect(() => requireReadyDoc(id)).toThrow(HttpError);
    await expect(mutateContent(id, async () => null)).rejects.toMatchObject({ status: 409, code: "processing" });

    await pumpBuilds();
    const done = getDocDetail(id);
    expect(done.status).toBe("ready");
    expect(done.processing).toBeNull();
    expect(done.pageCount).toBe(4);
    expect(done.version).toBe(1);
    expect(done.pages.every((p) => p.status === "ready")).toBe(true);
    expect((await inspectPdf(await readDocPdf(id))).pageCount).toBe(4);
    // image pages were pre-rendered while assembling; the PDF page renders lazily
    expect(fs.existsSync(path.join(cacheDir(id, 1), "p0-thumb.webp"))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir(id, 1), "p3.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir(id, 1), "p1.jpg"))).toBe(false);
    const thumb = await renderResponse(req(), getDocRow(id)!, 1, "thumb", { cache: "private" });
    expect(thumb.status).toBe(200);
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect(meta.format).toBe("webp");
    // originals removed, OCR queued after the build
    expect(fs.existsSync(path.join(docDir(id), "incoming"))).toBe(true);
    expect(fs.readdirSync(path.join(docDir(id), "incoming"))).toEqual([]);
    expect(jobsFor(id).map((j) => j.kind)).toEqual(["build", "ocr"]);
    expect(getDocRow(id)!.ocr_status).toBe("queued");
  });

  it("estimates EXIF-rotated images and PDF page sizes", async () => {
    const rotated = await sharp(await solidImage(800, 600)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await estimatePages({ kind: "jpeg", bytes: rotated }))[0].height).toBeCloseTo((595 * 800) / 600, 1);
    expect(await estimatePages({ kind: "pdf", bytes: await makePdf(3) })).toHaveLength(3);
    expect(await estimatePages({ kind: "pdf", bytes: Buffer.from("%PDF-1.4 junk junk") })).toHaveLength(1);
  });

  it("keeps originals on failure and retries", async () => {
    const bad = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]); // JPEG magic, garbage body
    const id = await createDocumentAsync({ files: [await png(300, 400), { kind: "jpeg", bytes: bad }], title: "Bad", source: "scan" });
    await pumpBuilds();
    const d = getDocDetail(id);
    expect(d.status).toBe("error");
    expect(d.processingError).toMatch(/image/i);
    expect(d.processing).toBeNull();
    const r = renderResponse(req(), getDocRow(id)!, 0, "thumb", { cache: "private" });
    await expect(r).rejects.toMatchObject({ status: 409, code: "processing_failed" });
    // the owner fixes nothing but the file is replaced on disk (simulates a transient failure) → retry succeeds
    const batchDir = path.join(docDir(id), "incoming", fs.readdirSync(path.join(docDir(id), "incoming"))[0]);
    fs.writeFileSync(path.join(batchDir, "0001.jpg"), await solidImage(300, 400, "jpeg"));
    await retryProcessing(id);
    expect(getDocRow(id)!.status).toBe("processing");
    await pumpBuilds();
    expect(getDocDetail(id)).toMatchObject({ status: "ready", pageCount: 2, processingError: null });
    await expect(retryProcessing(id)).rejects.toMatchObject({ status: 409, code: "nothing_to_retry" });
  });
});

describe("async page insertion", () => {
  it("grows the layout immediately, serves old pages from the current PDF and builds new ones", async () => {
    const id = await createDocument({ pdf: await makePdf(3), title: "Insert", source: "import", ocr: false });
    await insertPagesAsync(id, [await png(600, 900), await png(600, 900)], 1);
    const row = getDocRow(id)!;
    expect(row.status).toBe("processing");
    expect(row.version).toBe(2);
    const d = getDocDetail(id);
    expect(d.pageCount).toBe(5);
    expect(d.pages.map((p) => p.status)).toEqual(["ready", "processing", "processing", "ready", "ready"]);
    expect([0, 1, 2, 3, 4].map((i) => pagePending(row, i))).toEqual([false, true, true, false, false]);
    expect((await renderResponse(req(), row, 1, "thumb", { cache: "private" })).status).toBe(202);
    // layout index 3 is old page 1 (width 101) → rendered from the current PDF
    const old = await renderResponse(req(), row, 3, "image", { cache: "private" });
    expect(old.status).toBe(200);
    // a second insert while processing is refused (client retries)
    await expect(insertPagesAsync(id, [await png(10, 10)])).rejects.toMatchObject({ status: 409, code: "processing" });

    await pumpBuilds();
    const done = getDocDetail(id);
    expect(done.status).toBe("ready");
    expect(done.version).toBe(2);
    expect(await pageWidths(await readDocPdf(id))).toEqual([100, 595, 595, 101, 102]);
    // the render cached for layout index 3 during processing is still the right page
    const after = await renderResponse(req(), getDocRow(id)!, 3, "image", { cache: "private" });
    expect(after.status).toBe(200);
    expect(jobsFor(id).map((j) => j.kind)).toEqual(["build", "ocr"]);
  });

  it("restores the existing pages when the insert fails, and retry re-inserts", async () => {
    const id = await createDocument({ pdf: await makePdf(2), title: "Insert fail", source: "import", ocr: false });
    const bad = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG"), Buffer.alloc(64, 7)]);
    await insertPagesAsync(id, [{ kind: "png", bytes: bad }]);
    await pumpBuilds();
    const d = getDocDetail(id);
    expect(d.status).toBe("error");
    expect(d.pageCount).toBe(2);
    expect(d.processingError).toBeTruthy();
    // the document stays usable
    expect((await renderResponse(req(), getDocRow(id)!, 1, "thumb", { cache: "private" })).status).toBe(200);
    await mutateContent(id, (cur) => applyPageOps(cur, [{ op: "rotate", pages: [0], degrees: 90 }]), { ocr: false });
    const inc = path.join(docDir(id), "incoming");
    const batch = path.join(inc, fs.readdirSync(inc)[0]);
    fs.writeFileSync(path.join(batch, "0000.png"), await solidImage(200, 200));
    await retryProcessing(id);
    await pumpBuilds();
    expect(getDocDetail(id)).toMatchObject({ status: "ready", pageCount: 3, processingError: null });
  });
});
