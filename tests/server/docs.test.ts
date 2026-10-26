import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  createDocument,
  getDocDetail,
  getDocRow,
  hardDeleteDoc,
  listDocs,
  listTags,
  mutateContent,
  purgeTrash,
  restoreDoc,
  trashDoc,
  updateMeta,
} from "@/lib/server/docs";
import { applyPageOps, sniffType } from "@/lib/server/pdf";
import { getRender } from "@/lib/server/render";
import { buildExport, compressPdf, contentDisposition } from "@/lib/server/export";
import { createFolder, deleteFolder, listFolders, updateFolder } from "@/lib/server/folders";
import { getDb } from "@/lib/server/db";
import { docDir } from "@/lib/server/storage";
import { makePdf, solidImage } from "./helpers";
import { buildPdfFromInputs } from "@/lib/server/pdf";

const mk = async (title: string, extra: Partial<Parameters<typeof createDocument>[0]> = {}) =>
  createDocument({ pdf: await makePdf(3), title, source: "import", ocr: false, ...extra });

describe("documents", () => {
  it("creates and returns detail with page info and urls", async () => {
    const id = await mk("Invoice");
    const d = getDocDetail(id);
    expect(d.pageCount).toBe(3);
    expect(d.version).toBe(1);
    expect(d.pages[1]).toMatchObject({ index: 1, width: 101, height: 500, rotation: 0 });
    expect(d.pages[1].thumbUrl).toBe(`/api/docs/${id}/pages/1/thumb?v=1`);
    expect(d.thumbUrl).toBe(`/api/docs/${id}/pages/0/thumb?v=1`);
    expect(d.hasPassword).toBe(false);
  });

  it("mutates content atomically with version bump and cache pruning", async () => {
    const id = await mk("Mutable");
    const thumb = await getRender(id, 1, 0, "thumb");
    expect(fs.existsSync(thumb)).toBe(true);
    const { row } = await mutateContent(id, (cur) => applyPageOps(cur, [{ op: "delete", pages: [0] }]), { ocr: false });
    expect(row.version).toBe(2);
    expect(row.page_count).toBe(2);
    expect(fs.existsSync(thumb)).toBe(false);
    expect(getDocRow(id)!.size_bytes).toBe(fs.statSync(`${docDir(id)}/doc.pdf`).size);
  });

  it("renders thumbs (webp ~360px) and images (jpeg 1600px)", async () => {
    const id = await createDocument({
      pdf: await buildPdfFromInputs([{ kind: "png", bytes: await solidImage(600, 800) }]),
      title: "Render",
      source: "scan",
      ocr: false,
    });
    const sharp = (await import("sharp")).default;
    const t = await sharp(await getRender(id, 1, 0, "thumb")).metadata();
    const i = await sharp(await getRender(id, 1, 0, "image")).metadata();
    expect([t.format, t.width]).toEqual(["webp", 360]);
    expect([i.format, i.width]).toEqual(["jpeg", 1600]);
  });

  it("lists with filters, sort, pagination, search with Arabic normalisation", async () => {
    const f = createFolder({ name: "Bills" });
    const a = await mk("Electricity bill", { folderId: f.id, tags: ["home"] });
    const b = await mk("فاتورة الكهرباء", { tags: ["Home", "ar"] });
    updateMeta(b, { starred: true });
    expect(listDocs({ folderId: f.id }).items.map((d) => d.id)).toEqual([a]);
    expect(listDocs({ folderId: "root" }).items.some((d) => d.id === a)).toBe(false);
    expect(listDocs({ starred: true }).items.map((d) => d.id)).toEqual([b]);
    expect(listDocs({ tag: "home" }).items.length).toBe(2);
    const hit = listDocs({ q: "فاتوره" }).items; // ة/ه normalised
    expect(hit.map((d) => d.id)).toEqual([b]);
    expect(hit[0].snippet).toContain("[[");
    expect(listDocs({ q: "electr" }).items.map((d) => d.id)).toEqual([a]);
    expect(listDocs({ q: '"); DROP TABLE documents; --' }).items).toEqual([]);
    const page1 = listDocs({ limit: 2, sort: "title", dir: "asc" });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = listDocs({ limit: 2, sort: "title", dir: "asc", cursor: page1.nextCursor! });
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect(listTags().find((t) => t.tag.toLowerCase() === "home")?.count).toBe(2);
  });

  it("trash, restore, permanent delete and 30-day purge", async () => {
    const id = await mk("Trash me");
    trashDoc(id);
    expect(listDocs({ trash: true }).items.map((d) => d.id)).toContain(id);
    expect(listDocs({}).items.map((d) => d.id)).not.toContain(id);
    restoreDoc(id);
    expect(getDocRow(id)!.trashed_at).toBeNull();
    trashDoc(id);
    getDb().prepare("UPDATE documents SET trashed_at = ? WHERE id = ?").run(new Date(Date.now() - 31 * 86400_000).toISOString(), id);
    const keep = await mk("Recently trashed");
    trashDoc(keep);
    expect(await purgeTrash()).toBe(1);
    expect(getDocRow(id)).toBeUndefined();
    expect(fs.existsSync(docDir(id))).toBe(false);
    expect(getDocRow(keep)).toBeDefined();
    await hardDeleteDoc(keep);
    expect(getDocRow(keep)).toBeUndefined();
  });

  it("folders: delete moves docs to root and re-parents children; cycles rejected", async () => {
    const top = createFolder({ name: "Top" });
    const mid = createFolder({ name: "Mid", parentId: top.id });
    const leaf = createFolder({ name: "Leaf", parentId: mid.id });
    expect(() => updateFolder(top.id, { parentId: leaf.id })).toThrow(/inside itself/);
    const d = await mk("In mid", { folderId: mid.id });
    expect(listFolders().find((f) => f.id === mid.id)!.docCount).toBe(1);
    deleteFolder(mid.id);
    expect(getDocRow(d)!.folder_id).toBeNull();
    expect(listFolders().find((f) => f.id === leaf.id)!.parentId).toBe(top.id);
  });
});

describe("export + compress", () => {
  it("exports encrypted PDF (qpdf AES-256) and page subsets", async () => {
    const id = await mk("Secret report");
    const out = await buildExport(getDocRow(id)!, { format: "pdf", pages: [2, 0], password: "pa ss" });
    expect(out.filename).toBe("Secret report.pdf");
    const p = `${process.env.DATA_DIR}/enc-test.pdf`;
    fs.writeFileSync(p, out.body);
    const info = execFileSync("qpdf", ["--show-encryption", "--password=pa ss", p]).toString();
    expect(info).toMatch(/AESv3|aes-256|256/i);
    const pages = execFileSync("qpdf", ["--show-npages", "--password=pa ss", p]).toString().trim();
    expect(pages).toBe("2");
  });

  it("exports jpg-zip and txt", async () => {
    const id = await mk("Zip me");
    const zip = await buildExport(getDocRow(id)!, { format: "jpg-zip", pages: [0, 1] });
    expect(zip.contentType).toBe("application/zip");
    expect(Buffer.from(zip.body.subarray(0, 2)).toString()).toBe("PK");
    const listing = execFileSync("python3", ["-c", "import sys,zipfile,io;print(zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).namelist())"], {
      input: Buffer.from(zip.body),
    }).toString();
    expect(listing).toContain("Zip me-001.jpg");
    expect(listing).toContain("Zip me-002.jpg");
    const txt = await buildExport(getDocRow(id)!, { format: "txt" });
    expect(txt.contentType).toMatch(/text\/plain/);
  });

  it("compress keeps the result only if smaller", async () => {
    const big = await buildPdfFromInputs([{ kind: "png", bytes: await solidImage(2400, 3000) }]);
    const res = await compressPdf(big, "high");
    if (res) {
      expect(res.byteLength).toBeLessThan(big.byteLength);
      expect(sniffType(res)).toBe("pdf");
    }
    const tiny = await makePdf(1);
    // a minimal PDF should not shrink; result must be null rather than a bigger file
    const r2 = await compressPdf(tiny, "low");
    if (r2) expect(r2.byteLength).toBeLessThan(tiny.byteLength);
  });

  it("builds RFC 5987 content-disposition", () => {
    const cd = contentDisposition('فاتورة "يناير".pdf');
    expect(cd).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    expect(cd).toContain("%D9%81");
    expect(cd).not.toContain('"يناير"');
  });
});
