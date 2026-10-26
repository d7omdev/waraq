import { describe, expect, it } from "vitest";
import {
  checkSharePassword,
  createShare,
  expiryFrom,
  getShareById,
  makeUnlockCookie,
  resolveShare,
  revokeShare,
  shareState,
  verifyUnlockCookie,
} from "@/lib/server/shares";
import { createDocument, trashDoc } from "@/lib/server/docs";
import { getDb } from "@/lib/server/db";
import { makePdf } from "./helpers";

async function newDoc() {
  return createDocument({ pdf: await makePdf(2), title: "Shared doc", source: "import", ocr: false });
}

describe("share expiry + state", () => {
  it("computes expiries", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(expiryFrom("1h", now)).toBe("2026-01-01T01:00:00.000Z");
    expect(expiryFrom("7d", now)).toBe("2026-01-08T00:00:00.000Z");
    expect(expiryFrom("never", now)).toBeNull();
  });

  it("evaluates state", () => {
    const base = { id: "x", token: "t", doc_id: "d", password_hash: null, allow_download: 0, views: 0, created_at: "", revoked_at: null };
    const doc = { trashed_at: null };
    expect(shareState(undefined, doc)).toBe("not_found");
    expect(shareState({ ...base, expires_at: null }, doc)).toBe("ok");
    expect(shareState({ ...base, expires_at: new Date(Date.now() - 1).toISOString() }, doc)).toBe("expired");
    expect(shareState({ ...base, expires_at: new Date(Date.now() + 60_000).toISOString() }, doc)).toBe("ok");
    expect(shareState({ ...base, expires_at: null, revoked_at: "2026-01-01" }, doc)).toBe("revoked");
    expect(shareState({ ...base, expires_at: null }, { trashed_at: "2026-01-01" })).toBe("unavailable");
  });
});

describe("share lifecycle", () => {
  it("creates a 24-char token link with hashed password and resolves it", async () => {
    const docId = await newDoc();
    const link = await createShare(docId, { expiresIn: "1d", password: "s3cret pw", allowDownload: true });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(link.url).toBe(`https://scan.example.test/s/${link.token}`);
    expect(link.hasPassword).toBe(true);
    const row = getShareById(link.id)!;
    expect(row.password_hash).not.toContain("s3cret");
    expect(await checkSharePassword(row, "s3cret pw")).toBe(true);
    expect(await checkSharePassword(row, "nope")).toBe(false);
    expect(resolveShare(link.token).doc.id).toBe(docId);
  });

  it("returns 410 codes for revoked, expired and trashed", async () => {
    const docId = await newDoc();
    const a = await createShare(docId, { expiresIn: "never", allowDownload: false });
    revokeShare(a.id);
    expect(() => resolveShare(a.token)).toThrow(expect.objectContaining({ status: 410, code: "share_revoked" }));

    const b = await createShare(docId, { expiresIn: "1h", allowDownload: false });
    getDb().prepare("UPDATE shares SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), b.id);
    expect(() => resolveShare(b.token)).toThrow(expect.objectContaining({ status: 410, code: "share_expired" }));

    const c = await createShare(docId, { expiresIn: "never", allowDownload: false });
    trashDoc(docId);
    expect(() => resolveShare(c.token)).toThrow(expect.objectContaining({ status: 410, code: "share_unavailable" }));
    expect(() => resolveShare("x".repeat(24))).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("unlock cookies are bound to share id and expire", () => {
    const now = Date.now();
    const c = makeUnlockCookie("share1", now);
    expect(verifyUnlockCookie("share1", c.value, now + 1000)).toBe(true);
    expect(verifyUnlockCookie("share2", c.value, now + 1000)).toBe(false);
    expect(verifyUnlockCookie("share1", c.value, now + 13 * 3600_000)).toBe(false);
    expect(verifyUnlockCookie("share1", c.value.slice(0, -2) + "xx", now)).toBe(false);
  });
});
