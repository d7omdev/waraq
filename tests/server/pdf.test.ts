import { describe, expect, it } from "vitest";
import {
  applyOpsToRefs,
  applyPageOps,
  buildPdfFromInputs,
  extractPages,
  insertPages,
  mergePdfs,
  replacePage,
  splitPdf,
  splitRanges,
  inspectPdf,
} from "@/lib/server/pdf";
import { HttpError } from "@/lib/server/errors";
import { makePdf, pageRotations, pageWidths, solidImage } from "./helpers";

describe("page ops", () => {
  it("rotates selected pages clockwise relative to current rotation", async () => {
    const src = await makePdf(3, { rotations: [0, 90, 0] });
    const out = await applyPageOps(src, [{ op: "rotate", pages: [1, 2], degrees: 270 }]);
    expect(await pageRotations(out)).toEqual([0, 0, 270]);
    const out2 = await applyPageOps(out, [{ op: "rotate", pages: [0, 2], degrees: 180 }]);
    expect(await pageRotations(out2)).toEqual([180, 0, 90]);
  });

  it("deletes pages", async () => {
    const out = await applyPageOps(await makePdf(5), [{ op: "delete", pages: [0, 3] }]);
    expect(await pageWidths(out)).toEqual([101, 102, 104]);
  });

  it("refuses to delete every page", async () => {
    await expect(applyPageOps(await makePdf(2), [{ op: "delete", pages: [0, 1] }])).rejects.toMatchObject({
      code: "empty_document",
    });
  });

  it("reorders by permutation and validates it", async () => {
    const out = await applyPageOps(await makePdf(4), [{ op: "reorder", order: [3, 0, 2, 1] }]);
    expect(await pageWidths(out)).toEqual([103, 100, 102, 101]);
    expect(() => applyOpsToRefs(3, [{ op: "reorder", order: [0, 0, 1] }])).toThrow(HttpError);
    expect(() => applyOpsToRefs(3, [{ op: "reorder", order: [0, 1] }])).toThrow(HttpError);
  });

  it("duplicates pages right after the original as independent copies", async () => {
    const out = await applyPageOps(await makePdf(3), [
      { op: "duplicate", pages: [0, 2] },
      { op: "rotate", pages: [1], degrees: 90 },
    ]);
    expect(await pageWidths(out)).toEqual([100, 100, 101, 102, 102]);
    expect(await pageRotations(out)).toEqual([0, 90, 0, 0, 0]);
  });

  it("applies op sequences against the evolving page list", async () => {
    const out = await applyPageOps(await makePdf(4), [
      { op: "delete", pages: [1] }, // 100,102,103
      { op: "reorder", order: [2, 1, 0] }, // 103,102,100
      { op: "rotate", pages: [0], degrees: 90 },
    ]);
    expect(await pageWidths(out)).toEqual([103, 102, 100]);
    expect(await pageRotations(out)).toEqual([90, 0, 0]);
  });

  it("rejects out-of-range indexes", () => {
    expect(() => applyOpsToRefs(2, [{ op: "rotate", pages: [2], degrees: 90 }])).toThrow(/out of range/);
  });
});

describe("structural ops", () => {
  it("inserts pages at an index and at the end", async () => {
    const a = await makePdf(3);
    const b = await makePdf(2, { widthBase: 200 });
    expect(await pageWidths(await insertPages(a, b, 1))).toEqual([100, 200, 201, 101, 102]);
    expect(await pageWidths(await insertPages(a, b))).toEqual([100, 101, 102, 200, 201]);
    await expect(insertPages(a, b, 9)).rejects.toMatchObject({ code: "invalid_page" });
  });

  it("replaces a page", async () => {
    const out = await replacePage(await makePdf(3), 1, await makePdf(1, { widthBase: 300 }));
    expect(await pageWidths(out)).toEqual([100, 300, 102]);
  });

  it("extracts pages in the requested order", async () => {
    const out = await extractPages(await makePdf(5), [4, 1]);
    expect(await pageWidths(out)).toEqual([104, 101]);
  });

  it("splits by ranges and by every n", async () => {
    const src = await makePdf(5);
    const parts = await splitPdf(src, splitRanges(5, { ranges: [[0, 1], [4], [2, 3]] }));
    expect(await Promise.all(parts.map(pageWidths))).toEqual([[100, 101], [104], [102, 103]]);
    expect(splitRanges(5, { every: 2 })).toEqual([[0, 1], [2, 3], [4]]);
  });

  it("merges in order", async () => {
    const out = await mergePdfs([await makePdf(2), await makePdf(1, { widthBase: 300 }), await makePdf(1, { widthBase: 400 })]);
    expect(await pageWidths(out)).toEqual([100, 101, 300, 400]);
  });

  it("preserves rotation through extract/merge", async () => {
    const src = await makePdf(2, { rotations: [90, 180] });
    expect(await pageRotations(await mergePdfs([src, src]))).toEqual([90, 180, 90, 180]);
    expect(await pageRotations(await extractPages(src, [1]))).toEqual([180]);
  });
});

describe("upload assembly", () => {
  it("combines images and PDFs in order", async () => {
    const out = await buildPdfFromInputs([
      { kind: "png", bytes: await solidImage(400, 800, "png") },
      { kind: "pdf", bytes: await makePdf(2) },
      { kind: "jpeg", bytes: await solidImage(800, 400, "jpeg") },
    ]);
    const info = await inspectPdf(out);
    expect(info.pageCount).toBe(4);
    expect(info.pages[0]).toMatchObject({ width: 595, height: 1190 });
    expect(info.pages[1].width).toBe(100);
    expect(info.pages[3]).toMatchObject({ width: 595, height: 297.5 });
  });

  it("rejects garbage PDFs", async () => {
    await expect(buildPdfFromInputs([{ kind: "pdf", bytes: Buffer.from("%PDF-1.4 garbage") }])).rejects.toBeInstanceOf(HttpError);
  });
});
