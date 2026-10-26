import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { addImagePage, normalizeImage, sniffType } from "@/lib/server/pdf";
import { PDFDocument } from "pdf-lib";
import { makePdf, solidImage } from "./helpers";

describe("image normalisation", () => {
  it("sniffs types by magic bytes", async () => {
    expect(sniffType(await solidImage(10, 10, "png"))).toBe("png");
    expect(sniffType(await solidImage(10, 10, "jpeg"))).toBe("jpeg");
    expect(sniffType(await solidImage(10, 10, "webp"))).toBe("webp");
    expect(sniffType(await makePdf(1))).toBe("pdf");
    expect(sniffType(Buffer.from("hello world, not a file"))).toBeNull();
  });

  it("auto-orients by EXIF", async () => {
    // 600x300 landscape pixels with orientation 6 (rotate 90° CW) => displayed portrait 300x600
    const jpeg = await sharp(await solidImage(600, 300, "png")).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const n = await normalizeImage(jpeg);
    expect([n.width, n.height]).toEqual([300, 600]);
  });

  it("caps the long edge at 3000px and outputs JPEG", async () => {
    const n = await normalizeImage(await solidImage(4000, 1000, "webp"));
    expect([n.width, n.height]).toEqual([3000, 750]);
    expect(sniffType(n.jpeg)).toBe("jpeg");
  });

  it("flattens transparency and embeds at 595pt width matching aspect", async () => {
    const png = await sharp({ create: { width: 200, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const n = await normalizeImage(png);
    const { data } = await sharp(n.jpeg).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240); // white, not black
    const doc = await PDFDocument.create();
    await addImagePage(doc, n);
    const p = doc.getPage(0);
    expect(p.getWidth()).toBe(595);
    expect(p.getHeight()).toBeCloseTo(892.5, 1);
  });

  it("rejects corrupt images", async () => {
    await expect(normalizeImage(Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toMatchObject({
      code: "invalid_image",
    });
  });
});
