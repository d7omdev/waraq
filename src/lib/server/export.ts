import fsp from "node:fs/promises";
import path from "node:path";
import { ZipArchive } from "archiver";
import { PassThrough } from "node:stream";
import type { CompressLevel, ExportFormat } from "@/lib/types";
import { LIMITS } from "./config";
import { HttpError } from "./errors";
import { run, runOk } from "./exec";
import { extractPages } from "./pdf";
import { withTempDir } from "./storage";
import { docPdfFile, readDocBytes } from "./doc-storage";
import { ocrPageTexts, type DocRow } from "./docs";

export interface ExportResult {
  body: Uint8Array;
  contentType: string;
  filename: string;
}

/** Filesystem/header-safe base name derived from a title. */
export function safeBaseName(title: string): string {
  const s = title
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return s || "document";
}

/** RFC 6266/5987 Content-Disposition with ASCII fallback + UTF-8 filename*. */
export function contentDisposition(filename: string, type: "attachment" | "inline" = "attachment"): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%;]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function zipFiles(files: { name: string; path: string }[]): Promise<Uint8Array> {
  const archive = new ZipArchive({ store: true });
  const pass = new PassThrough();
  const chunks: Buffer[] = [];
  pass.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    pass.on("end", () => resolve());
    archive.on("error", reject);
  });
  archive.pipe(pass);
  for (const f of files) archive.file(f.path, { name: f.name });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

function selectPages(row: DocRow, pages?: number[]): number[] {
  if (!pages || pages.length === 0) return Array.from({ length: row.page_count }, (_, i) => i);
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 0 || p >= row.page_count) throw new HttpError(400, "invalid_page", `Page index ${p} out of range`);
  }
  return pages;
}

export async function encryptPdf(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  return withTempDir("enc", async (dir) => {
    const inp = path.join(dir, "in.pdf");
    const out = path.join(dir, "out.pdf");
    // qpdf job file (mode 600, .json so qpdf's AppArmor profile may read it): keeps the password out of argv
    const job = path.join(dir, "job.json");
    await fsp.writeFile(inp, bytes);
    await fsp.writeFile(
      job,
      JSON.stringify({
        inputFile: inp,
        outputFile: out,
        encrypt: { userPassword: password, ownerPassword: password, "256bit": {} },
      }),
      { mode: 0o600 },
    );
    try {
      const r = await run("qpdf", [`--job-json-file=${job}`], { timeoutMs: 120_000 });
      if (r.code !== 0 && r.code !== 3) throw new HttpError(500, "encrypt_failed", "Could not encrypt PDF");
    } finally {
      await fsp.rm(job, { force: true });
    }
    return fsp.readFile(out);
  });
}

export async function buildExport(
  row: DocRow,
  opts: { format: ExportFormat; pages?: number[]; password?: string },
): Promise<ExportResult> {
  const base = safeBaseName(row.title);
  const pages = selectPages(row, opts.pages);
  const subset = !!opts.pages && opts.pages.length > 0;
  if (opts.password && opts.format !== "pdf") {
    throw new HttpError(400, "validation_error", "Password protection is only available for PDF export");
  }
  switch (opts.format) {
    case "pdf": {
      let bytes: Uint8Array = await readDocBytes(row.id);
      if (subset) bytes = await extractPages(bytes, pages);
      if (opts.password) bytes = await encryptPdf(bytes, opts.password);
      return { body: bytes, contentType: "application/pdf", filename: `${base}.pdf` };
    }
    case "jpg-zip":
    case "png-zip": {
      const png = opts.format === "png-zip";
      const src = await docPdfFile(row.id);
      return withTempDir("export", async (dir) => {
        const files: { name: string; path: string }[] = [];
        const pad = String(row.page_count).length < 3 ? 3 : String(row.page_count).length;
        for (const p of pages) {
          const prefix = path.join(dir, `p${p}`);
          await runOk(
            "pdftoppm",
            [
              "-f", String(p + 1), "-l", String(p + 1),
              "-r", String(LIMITS.exportDpi),
              ...(png ? ["-png"] : ["-jpeg", "-jpegopt", "quality=90"]),
              "-singlefile",
              src,
              prefix,
            ],
            { timeoutMs: 180_000 },
          );
          const ext = png ? "png" : "jpg";
          files.push({ name: `${base}-${String(p + 1).padStart(pad, "0")}.${ext}`, path: `${prefix}.${ext}` });
        }
        return { body: await zipFiles(files), contentType: "application/zip", filename: `${base}-${png ? "png" : "jpg"}.zip` };
      });
    }
    case "txt": {
      let text = "";
      const drivePages = row.ocr_engine === "drive" ? ocrPageTexts(row.id) : null;
      if (subset && drivePages) {
        text = pages.map((p) => (drivePages[p] ?? "").trim()).join("\n\n\f\n\n");
      } else if (subset) {
        const src = await docPdfFile(row.id);
        const parts: string[] = [];
        for (const p of pages) {
          const r = await run("pdftotext", ["-layout", "-enc", "UTF-8", "-f", String(p + 1), "-l", String(p + 1), src, "-"]);
          parts.push(r.code === 0 ? r.stdout.toString("utf8").trim() : "");
        }
        text = parts.join("\n\n\f\n\n");
      } else {
        text = row.ocr_text ?? "";
        if (!text) {
          const r = await run("pdftotext", ["-layout", "-enc", "UTF-8", await docPdfFile(row.id), "-"]);
          text = r.code === 0 ? r.stdout.toString("utf8").trim() : "";
        }
      }
      return { body: Buffer.from(text, "utf8"), contentType: "text/plain; charset=utf-8", filename: `${base}.txt` };
    }
  }
}

const GS_PRESET: Record<CompressLevel, string> = { low: "/printer", medium: "/ebook", high: "/screen" };

/** Ghostscript re-distill; returns the new bytes or null when not smaller. */
export async function compressPdf(bytes: Uint8Array, level: CompressLevel): Promise<Uint8Array | null> {
  return withTempDir("gs", async (dir) => {
    const inp = path.join(dir, "in.pdf");
    const out = path.join(dir, "out.pdf");
    await fsp.writeFile(inp, bytes);
    const r = await run(
      "gs",
      [
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.6",
        `-dPDFSETTINGS=${GS_PRESET[level]}`,
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        "-dSAFER",
        "-dDetectDuplicateImages=true",
        `-sOutputFile=${out}`,
        inp,
      ],
      { timeoutMs: 600_000 },
    );
    if (r.code !== 0) throw new HttpError(500, "compress_failed", "Compression failed");
    const res = await fsp.readFile(out);
    return res.byteLength < bytes.byteLength ? res : null;
  });
}
