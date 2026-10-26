import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocument, getDocDetail, getDocRow, listDocs } from "@/lib/server/docs";
import { getDb } from "@/lib/server/db";
import { DRIVE_KEYS, getSetting, setSetting } from "@/lib/server/drive-store";
import { resetAccessToken } from "@/lib/server/drive-api";
import { completeConnect, disconnectDrive, setDriveConfig } from "@/lib/server/drive";
import { resetDriveWorkerState } from "@/lib/server/drive-sync";
import { DRIVE_OCR, pumpDriveOcr, resetDriveOcrState, setDriveOcrSleep } from "@/lib/server/ocr-drive";
import { enqueueJob } from "@/lib/server/jobs";
import { maybeQueueDriveOcr } from "@/lib/server/ocr";
import { rerunOcr, ocrStatus } from "@/lib/server/ocr-maintenance";
import { updatePrefs } from "@/lib/server/prefs";
import { buildExport } from "@/lib/server/export";
import { buildPdfFromInputs } from "@/lib/server/pdf";
import { FakeGoogle, fakeJson } from "./drive-fake";
import { textImage } from "./helpers";

let fake: FakeGoogle;
const sleeps: number[] = [];

async function connect() {
  setDriveConfig("1234567890-abcdefghijk.apps.googleusercontent.com", "secret-123");
  await completeConnect("good-code");
}

async function mkDoc(pages = 2, opts: { tesseract?: string } = {}) {
  const imgs = [];
  for (let i = 0; i < pages; i++) imgs.push({ kind: "png" as const, bytes: await textImage(`PAGE ${i + 1} ${Math.random().toString(36).slice(2, 8)}`) });
  const id = await createDocument({
    pdf: await buildPdfFromInputs(imgs),
    title: "Drive OCR doc",
    source: "scan",
    ocr: false,
    ocrText: opts.tesseract ?? "tesseract garbage",
    ocrLayerText: opts.tesseract ?? "tesseract garbage",
    ocrStatus: "done",
  });
  return id;
}

const ocrUploads = () => fake.log.filter((l) => l.startsWith("POST https://www.googleapis.com/upload/drive/v3/files?multipart"));
const jobRow = (id: string) =>
  getDb().prepare("SELECT status, error FROM jobs WHERE doc_id = ? AND kind = 'ocr_drive' ORDER BY id DESC LIMIT 1").get(id) as {
    status: string;
    error: string | null;
  };

beforeEach(async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  fake = new FakeGoogle();
  vi.stubGlobal("fetch", fake.fetch);
  await disconnectDrive();
  resetAccessToken();
  resetDriveWorkerState();
  resetDriveOcrState();
  sleeps.length = 0;
  setDriveOcrSleep(async (ms) => void sleeps.push(ms));
  updatePrefs({ ocr: { useDriveOcr: true, languages: ["ara", "eng"] } });
  getDb().prepare("DELETE FROM jobs").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setDriveOcrSleep(undefined);
});

describe("Drive OCR", () => {
  it("is skipped when Drive is not connected or disabled in prefs", async () => {
    const id = await mkDoc(1);
    expect(maybeQueueDriveOcr(id)).toBe(false);
    await connect();
    updatePrefs({ ocr: { useDriveOcr: false } });
    expect(maybeQueueDriveOcr(id)).toBe(false);
    expect(ocrStatus().engineAvailable).toEqual({ drive: true, tesseract: true });
  });

  it("OCRs every page via a temporary Google Doc, stores per-page text and deletes the temp files", async () => {
    await connect();
    const id = await mkDoc(2);
    expect(maybeQueueDriveOcr(id)).toBe(true);
    await pumpDriveOcr();
    const row = getDocRow(id)!;
    expect(row.ocr_engine).toBe("drive");
    const pages = row.ocr_text!.split("\f");
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatch(/^DRIVE TEXT \[ar\] \d+$/); // BOM stripped, Arabic primary language hint
    expect(row.ocr_layer_text).toBe("tesseract garbage"); // Tesseract layer kept
    expect(getDocDetail(id).ocrEngine).toBe("drive");
    // uploads went into Waraq/.ocr-tmp as Google Docs and were deleted afterwards
    const tmp = getSetting(DRIVE_KEYS.ocrTmpFolderId)!;
    expect(fake.files.get(tmp)!.name).toBe(".ocr-tmp");
    expect(ocrUploads()).toHaveLength(2);
    expect(fake.deleted).toHaveLength(2);
    expect([...fake.files.values()].filter((f) => f.mimeType === "application/vnd.google-apps.document")).toHaveLength(0);
    expect(jobRow(id).status).toBe("done");
    // FTS indexes both texts
    expect(listDocs({ q: "drive" }).items.map((d) => d.id)).toContain(id);
    expect(listDocs({ q: "garbage" }).items.map((d) => d.id)).toContain(id);
    // txt export prefers the Drive text, also for page subsets
    const txt = await buildExport(row, { format: "txt", pages: [1] });
    expect(Buffer.from(txt.body).toString("utf8")).toMatch(/^DRIVE TEXT/);
  });

  it("reuses cached page results unless forced (re-run)", async () => {
    await connect();
    const id = await mkDoc(2);
    maybeQueueDriveOcr(id);
    await pumpDriveOcr();
    const before = ocrUploads().length;
    maybeQueueDriveOcr(id);
    await pumpDriveOcr();
    expect(ocrUploads().length).toBe(before);
    maybeQueueDriveOcr(id, { force: true });
    await pumpDriveOcr();
    expect(ocrUploads().length).toBe(before + 2);
  });

  it("falls back to the English hint when Arabic finds nothing", async () => {
    await connect();
    fake.ocrResult = (f) => (f.ocrLanguage === "ar" ? "\uFEFF  \n" : "english words");
    const id = await mkDoc(1);
    maybeQueueDriveOcr(id);
    await pumpDriveOcr();
    expect(getDocRow(id)!.ocr_text).toBe("english words");
  });

  it("retries rate limits with backoff (honouring Retry-After)", async () => {
    await connect();
    const id = await mkDoc(1);
    let n = 0;
    fake.intercept.push((r) =>
      r.url.searchParams.get("ocrLanguage") && n++ === 0
        ? fakeJson({ error: { code: 429, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } }, 429, { "retry-after": "7" })
        : null,
    );
    maybeQueueDriveOcr(id);
    await pumpDriveOcr();
    expect(getDocRow(id)!.ocr_engine).toBe("drive");
    expect(sleeps).toContain(7000);
    expect(jobRow(id).status).toBe("done");
  });

  it("keeps Tesseract text for pages that keep failing and stops after repeated failures", async () => {
    await connect();
    const id = await mkDoc(5, { tesseract: "T1\fT2\fT3\fT4\fT5" });
    // page 1 works, every later upload fails with a 500
    let uploads = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.searchParams.get("ocrLanguage") && ++uploads > 1) return fakeJson({ error: { code: 500, message: "backend" } }, 500);
      return fake.fetch(input, init);
    });
    maybeQueueDriveOcr(id);
    await pumpDriveOcr();
    const row = getDocRow(id)!;
    expect(row.ocr_engine).toBe("drive");
    const pages = row.ocr_text!.split("\f");
    expect(pages[0]).toMatch(/^DRIVE TEXT/);
    // failed pages keep their Tesseract text
    expect(pages).toEqual([pages[0], "T2", "T3", "T4", "T5"]);
    // 1 success + (maxConsecutiveFailures pages × (retries+1) attempts), then abort
    expect(uploads).toBe(1 + DRIVE_OCR.maxConsecutiveFailures * (DRIVE_OCR.pageRetries + 1));
    expect(jobRow(id)).toMatchObject({ status: "error" });
    expect(getDb().prepare("SELECT engine FROM ocr_pages WHERE doc_id = ? ORDER BY page").all(id)).toEqual([
      { engine: "drive" },
      { engine: "tesseract" },
      { engine: "tesseract" },
      { engine: "tesseract" },
      { engine: "tesseract" },
    ]);
  });

  it("keeps the Tesseract text when Drive fails completely and flags reconnect on revoked grants", async () => {
    await connect();
    const id = await mkDoc(1);
    fake.refreshTokens.clear();
    fake.validTokens.clear();
    resetAccessToken();
    maybeQueueDriveOcr(id);
    await pumpDriveOcr();
    const row = getDocRow(id)!;
    expect(row.ocr_text).toBe("tesseract garbage");
    expect(row.ocr_engine).toBe("tesseract");
    expect(jobRow(id).status).toBe("error");
    expect(getSetting(DRIVE_KEYS.needsReconnect)).toBe("1");
    setSetting(DRIVE_KEYS.needsReconnect, null);
  });

  it("caps the number of pages sent to Drive", async () => {
    await connect();
    process.env.WARAQ_DRIVE_OCR_MAX_PAGES = "1";
    const id = await mkDoc(2);
    maybeQueueDriveOcr(id);
    await pumpDriveOcr();
    delete process.env.WARAQ_DRIVE_OCR_MAX_PAGES;
    expect(ocrUploads()).toHaveLength(1);
    expect(getDb().prepare("SELECT engine FROM ocr_pages WHERE doc_id = ? ORDER BY page").all(id)).toEqual([
      { engine: "drive" },
      { engine: "tesseract" },
    ]);
  });

  it("skips superseded content and docs that are not ready", async () => {
    await connect();
    const id = await mkDoc(1);
    getDb().prepare("UPDATE documents SET status = 'processing' WHERE id = ?").run(id);
    enqueueJob(id, "ocr_drive", {});
    await pumpDriveOcr();
    expect(ocrUploads()).toHaveLength(0);
    expect(jobRow(id).status).toBe("done");
  });

  it("re-run queues Tesseract redo + forced Drive pass and reports status", async () => {
    const a = await mkDoc(1);
    const b = await mkDoc(1);
    getDb().prepare("UPDATE documents SET trashed_at = ? WHERE id = ?").run(new Date().toISOString(), b);
    expect(rerunOcr({ ids: [a, b, "doesnotexist12"] })).toEqual({ queued: 1 });
    const job = getDb().prepare("SELECT payload FROM jobs WHERE doc_id = ? AND kind = 'ocr'").get(a) as { payload: string };
    expect(JSON.parse(job.payload)).toEqual({ redo: true, force: true });
    expect(getDocRow(a)!.ocr_status).toBe("queued");
    const st = ocrStatus();
    expect(st.pending).toBeGreaterThanOrEqual(1);
    expect(st.running).toBeNull();
    expect(rerunOcr({ all: true }).queued).toBeGreaterThanOrEqual(1);
  });
});
