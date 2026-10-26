import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createDocument, getDocRow, hardDeleteDoc, mutateContent, restoreDoc, trashDoc, updateMeta } from "@/lib/server/docs";
import { createFolder, deleteFolder, updateFolder } from "@/lib/server/folders";
import { applyPageOps } from "@/lib/server/pdf";
import { getDb } from "@/lib/server/db";
import { docPdfPath } from "@/lib/server/storage";
import { seal, unseal } from "@/lib/server/drive-crypto";
import { DRIVE_KEYS, getSetting, saveCredentials, setSetting } from "@/lib/server/drive-store";
import { resetAccessToken } from "@/lib/server/drive-api";
import { DRIVE_DEBOUNCE_MS, enqueueDriveSync } from "@/lib/server/drive-queue";
import { DRIVE_MAX_ATTEMPTS, drainDriveQueue, driveName, pump, resetDriveWorkerState } from "@/lib/server/drive-sync";
import {
  beginConnect,
  completeConnect,
  disconnectDrive,
  driveSyncInfo,
  getDriveStatus,
  requestSync,
  setAutoSync,
  setDriveConfig,
  verifyConnectState,
} from "@/lib/server/drive";
import { FakeGoogle, fakeJson } from "./drive-fake";
import { makePdf } from "./helpers";

const CLIENT_ID = "1234567890-abcdefghijk.apps.googleusercontent.com";
let fake: FakeGoogle;

const mk = async (title: string, folderId: string | null = null) =>
  createDocument({ pdf: await makePdf(2), title, folderId, source: "import", ocr: false });

const jobs = () => getDb().prepare("SELECT * FROM drive_jobs ORDER BY id").all() as Record<string, unknown>[];
const mapping = (docId: string) =>
  getDb().prepare("SELECT * FROM drive_docs WHERE doc_id = ?").get(docId) as { file_id: string; synced_version: number } | undefined;

async function connect() {
  setDriveConfig(CLIENT_ID, "secret-123");
  await completeConnect("good-code");
}

beforeEach(async () => {
  // never use real credentials from the environment in tests
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  fake = new FakeGoogle();
  vi.stubGlobal("fetch", fake.fetch);
  await disconnectDrive();
  setSetting(DRIVE_KEYS.autoSync, null);
  resetAccessToken();
  resetDriveWorkerState();
  fake.revoked = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WARAQ_DRIVE_MULTIPART_MAX;
});

describe("drive secrets", () => {
  it("seals with AES-GCM and round-trips; tamper and junk fail closed", () => {
    const a = seal("1//refresh-token-value");
    const b = seal("1//refresh-token-value");
    expect(a).not.toBe(b); // random IV
    expect(a).not.toContain("refresh-token");
    expect(unseal(a)).toBe("1//refresh-token-value");
    const raw = Buffer.from(a.slice(3), "base64url");
    raw[raw.length - 1] ^= 1;
    expect(unseal(`v1:${raw.toString("base64url")}`)).toBeNull();
    expect(unseal("garbage")).toBeNull();
    expect(unseal(null)).toBeNull();
  });

  it("stores client secret + refresh token encrypted and never exposes them in status", async () => {
    expect(getDriveStatus()).toMatchObject({ connected: false, redirectUri: "https://scan.example.test/api/drive/callback" });
    await connect();
    const st = getDriveStatus();
    expect(st).toMatchObject({ configured: true, connected: true, email: "owner@example.com", autoSync: true, credentialsSource: "settings" });
    expect(st.clientIdMasked).toBe("123456…hijk.apps.googleusercontent.com");
    const dump = JSON.stringify(getDb().prepare("SELECT key, value FROM settings").all());
    expect(dump).not.toContain("secret-123");
    expect(dump).not.toContain("rt-good");
    expect(JSON.stringify(st)).not.toContain("secret-123");
    expect(JSON.stringify(st)).not.toContain("rt-good");
  });
});

describe("drive oauth", () => {
  it("builds the consent URL and enforces single-use, session-bound state", () => {
    saveCredentials(CLIENT_ID, "secret-123");
    const { url, state } = beginConnect("session-a");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: "https://scan.example.test/api/drive/callback",
      scope: "https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      prompt: "consent",
      response_type: "code",
      state,
    });
    expect(verifyConnectState(state, state, "session-a")).toBe(true);
    expect(verifyConnectState(state, state, "session-a")).toBe(false); // consumed

    const s2 = beginConnect("session-a").state;
    expect(verifyConnectState(s2, s2, "session-b")).toBe(false); // other session
    const s3 = beginConnect("session-a").state;
    expect(verifyConnectState(`${s3}x`, `${s3}x`, "session-a")).toBe(false); // forged signature
    const s4 = beginConnect("session-a").state;
    expect(verifyConnectState(s4, null, "session-a")).toBe(false); // missing browser cookie
  });

  it("disconnect revokes at Google and forgets tokens + mappings", async () => {
    await connect();
    const id = await mk("Disc");
    await drainDriveQueue();
    expect(mapping(id)?.file_id).toBeTruthy();
    await disconnectDrive();
    expect(fake.revoked).toEqual(["rt-good"]);
    expect(getDriveStatus()).toMatchObject({ connected: false, email: null, queue: { pending: 0, failed: 0 } });
    expect(mapping(id)).toBeUndefined();
    expect(getSetting(DRIVE_KEYS.refreshToken)).toBeNull();
  });
});

describe("drive mirror", () => {
  it("does nothing while disconnected", async () => {
    const id = await mk("Offline");
    expect(jobs()).toHaveLength(0);
    expect(mapping(id)).toBeUndefined();
  });

  it("debounces rapid changes into one job", async () => {
    await connect();
    const id = await mk("Debounce");
    updateMeta(id, { title: "Debounce 2" });
    updateMeta(id, { title: "Debounce 3" });
    const js = jobs();
    expect(js).toHaveLength(1);
    expect(Number(js[0].due_at)).toBeGreaterThan(Date.now() + DRIVE_DEBOUNCE_MS - 2000);
    expect(await pump()).toBe(0); // not due yet
    expect(fake.pdfs()).toHaveLength(0);
  });

  it("creates the folder hierarchy and uploads, then updates the same file", async () => {
    await connect();
    const a = createFolder({ name: "Bills" });
    const b = createFolder({ name: "2026/Q1", parentId: a.id });
    const id = await mk("Electricity: March", b.id);
    await drainDriveQueue();

    const [root] = fake.byName("Waraq");
    const [bills] = fake.byName("Bills");
    const [q1] = fake.byName("2026 Q1");
    expect(root.parents).toEqual(["root"]);
    expect(bills.parents).toEqual([root.id]);
    expect(q1.parents).toEqual([bills.id]);
    const [file] = fake.pdfs();
    expect(file.name).toBe("Electricity March.pdf");
    expect(file.parents).toEqual([q1.id]);
    expect(file.appProperties.waraqDocId).toBe(id);
    expect(file.content!.equals(fs.readFileSync(docPdfPath(id)))).toBe(true);
    expect(driveSyncInfo([id]).get(id)).toMatchObject({ status: "synced", webViewLink: expect.stringContaining(file.id) });
    expect(getDriveStatus()).toMatchObject({ queue: { pending: 0, failed: 0 }, rootFolderUrl: `https://drive.google.com/drive/folders/${root.id}` });

    await mutateContent(id, (cur) => applyPageOps(cur, [{ op: "delete", pages: [0] }]), { ocr: false });
    expect(driveSyncInfo([id]).get(id)?.status).toBe("pending");
    await drainDriveQueue();
    expect(fake.pdfs()).toHaveLength(1);
    expect(fake.pdfs()[0].id).toBe(file.id);
    expect(fake.pdfs()[0].content!.equals(fs.readFileSync(docPdfPath(id)))).toBe(true);
    expect(mapping(id)?.synced_version).toBe(getDocRow(id)!.version);
    expect(fake.byName("Waraq")).toHaveLength(1); // root reused
  });

  it("renames/moves files and folders without duplicates", async () => {
    await connect();
    const f1 = createFolder({ name: "Work" });
    const f2 = createFolder({ name: "Home" });
    const id = await mk("Contract", f1.id);
    await drainDriveQueue();
    const fileId = mapping(id)!.file_id;
    const uploads = fake.log.filter((l) => l.includes("/upload/")).length;

    updateMeta(id, { title: "Contract signed", folderId: f2.id });
    await drainDriveQueue();
    const f = fake.files.get(fileId)!;
    expect(f.name).toBe("Contract signed.pdf");
    expect(f.parents).toEqual([fake.byName("Home")[0].id]);
    expect(fake.log.filter((l) => l.includes("/upload/")).length).toBe(uploads); // metadata-only, no re-upload

    updateFolder(f2.id, { name: "Personal", parentId: f1.id });
    await drainDriveQueue();
    const home = fake.files.get(fake.byName("Personal")[0].id)!;
    expect(home.parents).toEqual([fake.byName("Work")[0].id]);
    expect(fake.pdfs()).toHaveLength(1);

    // folder deleted in the app: doc moves to Waraq/, the empty Drive folder goes to Drive trash
    deleteFolder(f2.id);
    await drainDriveQueue();
    expect(fake.files.get(fileId)!.parents).toEqual([fake.byName("Waraq")[0].id]);
    expect(home.trashed).toBe(true);
  });

  it("trash -> Waraq/Trash, restore -> back, permanent delete -> Drive trash", async () => {
    await connect();
    const folder = createFolder({ name: "Receipts" });
    const id = await mk("Receipt", folder.id);
    await drainDriveQueue();
    const fileId = mapping(id)!.file_id;
    const receipts = fake.byName("Receipts")[0].id;

    trashDoc(id);
    await drainDriveQueue();
    const trash = fake.byName("Trash")[0];
    expect(trash.parents).toEqual([fake.byName("Waraq")[0].id]);
    expect(fake.files.get(fileId)!.parents).toEqual([trash.id]);
    expect(fake.files.get(fileId)!.trashed).toBe(false);

    restoreDoc(id);
    await drainDriveQueue();
    expect(fake.files.get(fileId)!.parents).toEqual([receipts]);

    trashDoc(id);
    await hardDeleteDoc(id);
    await drainDriveQueue();
    expect(fake.files.get(fileId)!.trashed).toBe(true);
    expect(fake.files.has(fileId)).toBe(true); // never permanently deleted
    expect(mapping(id)).toBeUndefined();
    expect(jobs()).toHaveLength(0);
  });

  it("re-creates a file the owner deleted in Drive", async () => {
    await connect();
    const id = await mk("Gone");
    await drainDriveQueue();
    fake.files.delete(mapping(id)!.file_id);
    updateMeta(id, { title: "Gone again" });
    await drainDriveQueue();
    expect(fake.pdfs()).toHaveLength(1);
    expect(fake.pdfs()[0].name).toBe("Gone again.pdf");
  });

  it("uses resumable upload for large files", async () => {
    process.env.WARAQ_DRIVE_MULTIPART_MAX = "100";
    await connect();
    const id = await mk("Big");
    await drainDriveQueue();
    expect(fake.log.some((l) => l.endsWith("?resumable"))).toBe(true);
    expect(fake.pdfs()[0].content!.equals(fs.readFileSync(docPdfPath(id)))).toBe(true);
  });

  it("refreshes the access token on 401 and retries", async () => {
    await connect();
    const id = await mk("Token");
    fake.validTokens.clear(); // cached access token now rejected
    const before = fake.tokenCalls;
    await drainDriveQueue();
    expect(fake.tokenCalls).toBe(before + 1);
    expect(mapping(id)?.file_id).toBeTruthy();
  });

  it("backs off on 429/5xx, then succeeds; gives up after max attempts", async () => {
    await connect();
    const id = await mk("Flaky");
    fake.intercept.push(({ url }) => (url.pathname.startsWith("/upload/") ? fakeJson({ error: { code: 429, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } }, 429, { "retry-after": "30" }) : null));
    await drainDriveQueue();
    let [job] = jobs();
    expect(job).toMatchObject({ status: "queued", attempts: 1 });
    expect(Number(job.due_at)).toBeGreaterThanOrEqual(Date.now() + 25_000);
    expect(driveSyncInfo([id]).get(id)?.status).toBe("pending");
    expect(getDriveStatus().lastError).toContain("Rate Limit");
    expect(await pump()).toBe(0); // paused / not due
    resetDriveWorkerState();
    await drainDriveQueue();
    expect(jobs()).toHaveLength(0);
    expect(mapping(id)?.file_id).toBeTruthy();
    expect(getDriveStatus().lastError).toBeNull();

    // persistent 503 -> error after DRIVE_MAX_ATTEMPTS
    updateMeta(id, { title: "Flaky 2" });
    for (let i = 0; i < DRIVE_MAX_ATTEMPTS + 2; i++) {
      fake.intercept.push(({ method, url }) => (method === "PATCH" && url.pathname.includes("/files/") ? fakeJson({ error: { code: 503 } }, 503) : null));
    }
    for (let i = 0; i < DRIVE_MAX_ATTEMPTS; i++) {
      resetDriveWorkerState();
      await drainDriveQueue();
    }
    [job] = jobs();
    expect(job).toMatchObject({ status: "error", attempts: DRIVE_MAX_ATTEMPTS });
    expect(getDriveStatus().queue).toEqual({ pending: 0, failed: 1 });
    expect(driveSyncInfo([id]).get(id)?.status).toBe("error");
    fake.intercept = [];
    requestSync({ ids: [id] }); // manual retry clears the failure
    await drainDriveQueue();
    expect(getDriveStatus().queue).toEqual({ pending: 0, failed: 0 });
    expect(fake.pdfs()[0].name).toBe("Flaky 2.pdf");
  });

  it("revoked grant: keeps the queue, flags reconnect", async () => {
    await connect();
    await mk("Revoked");
    fake.refreshTokens.clear();
    resetAccessToken();
    await drainDriveQueue();
    const st = getDriveStatus();
    expect(st).toMatchObject({ connected: false, needsReconnect: true, queue: { pending: 1, failed: 0 } });
    expect(st.lastError).toMatch(/reconnect/i);
    expect(jobs()[0]).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("auto-sync off: only manual Save to Drive mirrors, and those stay mirrored", async () => {
    await connect();
    setAutoSync(false);
    const a = await mk("Auto off");
    expect(jobs()).toHaveLength(0);
    expect(requestSync({ ids: [a, "doesnotexist1"] })).toEqual({ queued: 1 });
    await drainDriveQueue();
    expect(fake.pdfs()).toHaveLength(1);
    updateMeta(a, { title: "Auto off renamed" });
    expect(jobs()).toHaveLength(1);
    await drainDriveQueue();
    expect(fake.pdfs()[0].name).toBe("Auto off renamed.pdf");

    const b = await mk("Backfill me");
    const status = getDriveStatus();
    expect(status.docs.synced).toBeLessThan(status.docs.total);
    requestSync({ all: true });
    await drainDriveQueue();
    expect(mapping(b)?.file_id).toBeTruthy();
    const after = getDriveStatus();
    expect(after.docs.synced).toBe(after.docs.total);
  });

  it("drive name sanitising", () => {
    expect(driveName("a/b\\c:d*e?f\"g<h>i|j", ".pdf")).toBe("a b c d e f g h i j.pdf");
    expect(driveName("   ", ".pdf")).toBe("Untitled.pdf");
    expect(driveName("Report.PDF", ".pdf")).toBe("Report.PDF");
    expect(driveName("..hidden")).toBe("hidden");
  });
});

describe("core operations are isolated from Drive failures", () => {
  it("succeed when Google is unreachable", async () => {
    await connect();
    fake.throwAll = true;
    const id = await mk("Network down");
    updateMeta(id, { title: "Still works" });
    trashDoc(id);
    restoreDoc(id);
    await drainDriveQueue();
    expect(getDocRow(id)!.title).toBe("Still works");
    expect(jobs()[0]).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("succeed when the Drive queue itself throws", async () => {
    await connect();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    getDb().exec("ALTER TABLE drive_jobs RENAME TO drive_jobs_off");
    try {
      const f = createFolder({ name: "Iso" });
      const id = await mk("Queue broken", f.id);
      updateMeta(id, { title: "Queue broken 2" });
      await mutateContent(id, (cur) => applyPageOps(cur, [{ op: "rotate", pages: [0], degrees: 90 }]), { ocr: false });
      updateFolder(f.id, { name: "Iso 2" });
      trashDoc(id);
      restoreDoc(id);
      trashDoc(id);
      await hardDeleteDoc(id);
      deleteFolder(f.id);
      expect(getDocRow(id)).toBeUndefined();
      expect(err).toHaveBeenCalled();
    } finally {
      getDb().exec("ALTER TABLE drive_jobs_off RENAME TO drive_jobs");
      err.mockRestore();
    }
  });

  it("env credentials take precedence over saved ones and block the setup form", () => {
    saveCredentials(CLIENT_ID, "secret-123");
    process.env.GOOGLE_CLIENT_ID = "9999999999-envclientid.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "env-secret-xyz";
    try {
      const st = getDriveStatus();
      expect(st).toMatchObject({ configured: true, credentialsSource: "env" });
      expect(st.clientIdMasked).toBe("999999…ntid.apps.googleusercontent.com");
      expect(new URL(beginConnect("s").url).searchParams.get("client_id")).toBe(process.env.GOOGLE_CLIENT_ID);
      expect(() => setDriveConfig(CLIENT_ID, "secret-123")).toThrow(/GOOGLE_CLIENT_ID/);
      expect(JSON.stringify(st)).not.toContain("env-secret-xyz");
    } finally {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
    }
  });

  it("enqueue never throws even without a DB table", () => {
    expect(() => enqueueDriveSync("nonexistent1")).not.toThrow();
  });
});
