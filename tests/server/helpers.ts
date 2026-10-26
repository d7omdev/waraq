import { PDFDocument, degrees } from "pdf-lib";
import sharp from "sharp";

/** PDF whose page i has width 100+i (so order is observable) and optional rotation. */
export async function makePdf(count: number, opts: { rotations?: number[]; widthBase?: number } = {}): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < count; i++) {
    const p = d.addPage([(opts.widthBase ?? 100) + i, 500]);
    if (opts.rotations?.[i]) p.setRotation(degrees(opts.rotations[i]));
  }
  return d.save();
}

export async function pageWidths(bytes: Uint8Array): Promise<number[]> {
  const d = await PDFDocument.load(bytes);
  return d.getPages().map((p) => p.getWidth());
}

export async function pageRotations(bytes: Uint8Array): Promise<number[]> {
  const d = await PDFDocument.load(bytes);
  return d.getPages().map((p) => p.getRotation().angle);
}

export async function solidImage(w: number, h: number, format: "png" | "jpeg" | "webp" = "png"): Promise<Buffer> {
  const img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 220, b: 240 } } });
  return format === "png" ? img.png().toBuffer() : format === "jpeg" ? img.jpeg().toBuffer() : img.webp().toBuffer();
}

/** White image with large black text (for OCR). */
export async function textImage(text: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600">
    <rect width="100%" height="100%" fill="white"/>
    <text x="80" y="330" font-family="DejaVu Sans" font-size="120" fill="black">${text}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
