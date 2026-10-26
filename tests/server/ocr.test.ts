import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createDocument, getDocRow, listDocs } from "@/lib/server/docs";
import { buildPdfFromInputs } from "@/lib/server/pdf";
import { startOcrWorker, waitForOcrIdle } from "@/lib/server/ocr";
import { getDb } from "@/lib/server/db";
import { textImage } from "./helpers";

function has(cmd: string) {
  try {
    execFileSync(cmd, [cmd === "pdftotext" ? "-v" : "--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const enabled = has("ocrmypdf") && has("pdftotext");

describe.skipIf(!enabled)("OCR pipeline", () => {
  it("OCRs a scanned image, stores text, bumps version and makes it searchable", async () => {
    const pdf = await buildPdfFromInputs([{ kind: "png", bytes: await textImage("WARAQ INVOICE 2026") }]);
    const id = await createDocument({ pdf, title: "Scan", source: "scan" });
    expect(getDocRow(id)!.ocr_status).toBe("queued");
    startOcrWorker();
    await waitForOcrIdle();
    const row = getDocRow(id)!;
    expect(row.ocr_status).toBe("done");
    expect(row.version).toBe(2);
    expect(row.ocr_text?.toUpperCase()).toContain("INVOICE");
    expect(listDocs({ q: "invoice" }).items.map((d) => d.id)).toEqual([id]);
  }, 180_000);

  it("re-queues interrupted jobs on restart", async () => {
    const pdf = await buildPdfFromInputs([{ kind: "png", bytes: await textImage("HELLO") }]);
    const id = await createDocument({ pdf, title: "Restart", source: "scan", ocr: false });
    const now = new Date().toISOString();
    getDb().prepare("INSERT INTO jobs (doc_id, kind, status, created_at, updated_at) VALUES (?, 'ocr', 'running', ?, ?)").run(id, now, now);
    (globalThis as { __waraqOcr?: { started: boolean } }).__waraqOcr!.started = false; // simulate a fresh process
    startOcrWorker();
    await waitForOcrIdle();
    expect(getDocRow(id)!.ocr_status).toBe("done");
  }, 180_000);

  it("a failing OCR never loses the original", async () => {
    const pdf = await buildPdfFromInputs([{ kind: "png", bytes: await textImage("KEEP") }]);
    const id = await createDocument({ pdf, title: "Fail", source: "scan", ocr: false });
    const before = getDocRow(id)!;
    process.env.WARAQ_OCR_LANGS = "zzz_missing_lang";
    getDb().prepare("INSERT INTO jobs (doc_id, kind, status, created_at, updated_at) VALUES (?, 'ocr', 'queued', datetime(), datetime())").run(id);
    startOcrWorker();
    (globalThis as { __waraqOcrKick?: () => void }).__waraqOcrKick?.();
    await waitForOcrIdle();
    delete process.env.WARAQ_OCR_LANGS;
    const after = getDocRow(id)!;
    expect(after.ocr_status).toBe("error");
    expect(after.version).toBe(before.version);
    expect(after.size_bytes).toBe(before.size_bytes);
  }, 180_000);
});
