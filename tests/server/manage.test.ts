import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createShare,
  getShareById,
  listAllShares,
  makeUnlockCookie,
  purgeShare,
  revokeAllShares,
  revokeShare,
  updateShare,
  verifyUnlockCookie,
} from "@/lib/server/shares";
import { createDocument, listDocs, updateMeta } from "@/lib/server/docs";
import { createFolder, listFolders } from "@/lib/server/folders";
import { authReady, listSessions, publicSessionId, resolveSession, revokeOtherSessions, revokeSessionByPublicId } from "@/lib/server/auth";
import { signInOwner } from "./auth-helpers";
import { readVersionInfo } from "@/lib/server/version";
import { getDb } from "@/lib/server/db";
import { makePdf } from "./helpers";

const mkDoc = async (title = "Doc", folderId: string | null = null) =>
  createDocument({ pdf: await makePdf(1), title, folderId, source: "import", ocr: false });
const ownerUserId = () => (getDb().prepare(`SELECT id FROM "user" LIMIT 1`).get() as { id: string }).id;

describe("shared links management", () => {
  it("lists every link with doc info and status, newest first, filterable", async () => {
    const a = await mkDoc("Alpha");
    const b = await mkDoc("Beta");
    const s1 = await createShare(a, { expiresIn: "never", allowDownload: true });
    const s2 = await createShare(b, { expiresIn: "1h", allowDownload: false });
    const s3 = await createShare(a, { expiresIn: "1d", allowDownload: false });
    getDb().prepare("UPDATE shares SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", s1.id);
    getDb().prepare("UPDATE shares SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), s2.id);
    revokeShare(s3.id);
    const all = listAllShares("all").filter((s) => [s1.id, s2.id, s3.id].includes(s.id));
    expect(all.map((s) => s.id)[2]).toBe(s1.id);
    const byId = Object.fromEntries(all.map((s) => [s.id, s]));
    expect(byId[s1.id]).toMatchObject({ status: "active", docTitle: "Alpha", docThumbUrl: `/api/docs/${a}/pages/0/thumb?v=1` });
    expect(byId[s2.id].status).toBe("expired");
    expect(byId[s3.id].status).toBe("revoked");
    expect(listAllShares("expired").map((s) => s.id)).toContain(s2.id);
    expect(listAllShares("active").some((s) => s.id === s2.id || s.id === s3.id)).toBe(false);
  });

  it("patches expiry (re-based from now), password and download flag", async () => {
    const d = await mkDoc();
    const s = await createShare(d, { expiresIn: "1h", allowDownload: false });
    getDb().prepare("UPDATE shares SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), s.id);
    const revived = await updateShare(s.id, { expiresIn: "7d" });
    expect(revived.status).toBe("active");
    expect(Date.parse(revived.expiresAt!) - Date.now()).toBeGreaterThan(6.9 * 86400_000);
    const never = await updateShare(s.id, { expiresIn: "never", allowDownload: true });
    expect(never).toMatchObject({ expiresAt: null, allowDownload: true, hasPassword: false });

    const withPw = await updateShare(s.id, { password: "hunter2" });
    expect(withPw.hasPassword).toBe(true);
    const hash1 = getShareById(s.id)!.password_hash;
    const cookie = makeUnlockCookie(s.id, Date.now(), hash1);
    expect(verifyUnlockCookie(s.id, cookie.value, Date.now(), hash1)).toBe(true);
    await updateShare(s.id, { password: "another" });
    const hash2 = getShareById(s.id)!.password_hash;
    // changing the password invalidates earlier unlocks
    expect(verifyUnlockCookie(s.id, cookie.value, Date.now(), hash2)).toBe(false);
    expect((await updateShare(s.id, { password: null })).hasPassword).toBe(false);

    revokeShare(s.id);
    await expect(updateShare(s.id, { allowDownload: false })).rejects.toMatchObject({ status: 409, code: "share_revoked" });
    await expect(updateShare("missingmissing1", {})).rejects.toMatchObject({ status: 404 });
  });

  it("purges only revoked/expired links and revokes all (optionally per doc)", async () => {
    const a = await mkDoc();
    const b = await mkDoc();
    const s1 = await createShare(a, { expiresIn: "never", allowDownload: false });
    const s2 = await createShare(a, { expiresIn: "never", allowDownload: false });
    const s3 = await createShare(b, { expiresIn: "never", allowDownload: false });
    expect(() => purgeShare(s1.id)).toThrow(expect.objectContaining({ status: 409, code: "share_active" }));
    expect(revokeAllShares(a)).toBe(2);
    expect(getShareById(s3.id)!.revoked_at).toBeNull();
    purgeShare(s1.id);
    expect(getShareById(s1.id)).toBeUndefined();
    expect(getShareById(s2.id)!.revoked_at).not.toBeNull();
    expect(revokeAllShares()).toBeGreaterThanOrEqual(1);
    expect(getShareById(s3.id)!.revoked_at).not.toBeNull();
  });
});

describe("sessions management", () => {
  it("lists sessions with the current one marked, never exposing raw ids", async () => {
    const uid = ownerUserId();
    await authReady();
    getDb().prepare(`DELETE FROM session WHERE "userId" = ?`).run(uid);
    const a = await signInOwner("Mozilla/5.0 (Android 14) Chrome/130");
    const b = await signInOwner("Mozilla/5.0 (X11; Linux) Firefox/131");
    const rawA = (await resolveSession(new Headers({ cookie: a })))!.session.id;
    const list = listSessions(uid, rawA);
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.find((s) => s.current)!.userAgent).toContain("Android");
    expect(list.some((s) => s.id === rawA)).toBe(false);
    expect(list.find((s) => s.current)!.id).toBe(publicSessionId(rawA));
    const other = list.find((s) => !s.current)!;
    // another user can't revoke it
    expect(revokeSessionByPublicId("someone-else", other.id).found).toBe(false);
    expect(revokeSessionByPublicId(uid, other.id).found).toBe(true);
    expect(await resolveSession(new Headers({ cookie: b }))).toBeNull();
    expect(revokeSessionByPublicId(uid, other.id).found).toBe(false);
    expect(await resolveSession(new Headers({ cookie: a }))).not.toBeNull();
  });

  it("revokes every other session", async () => {
    const uid = ownerUserId();
    const keep = await signInOwner("keep");
    await signInOwner("x");
    await signInOwner("y");
    const raw = (await resolveSession(new Headers({ cookie: keep })))!.session.id;
    expect(revokeOtherSessions(uid, raw)).toBeGreaterThanOrEqual(2);
    expect(listSessions(uid, raw).map((s) => s.current)).toEqual([true]);
  });
});

describe("version info", () => {
  it("reads .next/BUILD_ID and its mtime", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waraq-ver-"));
    expect(readVersionInfo(dir).buildId).toBe(process.env.NEXT_PUBLIC_WARAQ_BUILD_ID || "development");
    fs.mkdirSync(path.join(dir, ".next"));
    fs.writeFileSync(path.join(dir, ".next", "BUILD_ID"), "abc123-xyz\n");
    const t = new Date("2026-10-01T10:00:00Z");
    fs.utimesSync(path.join(dir, ".next", "BUILD_ID"), t, t);
    expect(readVersionInfo(dir)).toEqual({ buildId: "abc123-xyz", builtAt: t.toISOString() });
    fs.rmSync(dir, { recursive: true });
  });
});

describe("folders v4", () => {
  it("reports childCount and up to 3 preview thumbs (own docs first, then subfolders)", async () => {
    const top = createFolder({ name: "Top" });
    const sub = createFolder({ name: "Sub", parentId: top.id });
    const deep = createFolder({ name: "Deep", parentId: sub.id });
    const s1 = await mkDoc("in sub", sub.id);
    const d1 = await mkDoc("in deep", deep.id);
    let f = listFolders().find((x) => x.id === top.id)!;
    expect(f.childCount).toBe(1);
    expect(f.docCount).toBe(0);
    expect(f.previewThumbs).toHaveLength(2);
    const t1 = await mkDoc("in top", top.id);
    f = listFolders().find((x) => x.id === top.id)!;
    expect(f.previewThumbs![0]).toContain(t1);
    expect(f.previewThumbs).toHaveLength(3);
    expect(listFolders().find((x) => x.id === deep.id)!.childCount).toBe(0);

    // direct vs recursive listing
    expect(listDocs({ folderId: top.id }).items.map((d) => d.id)).toEqual([t1]);
    const rec = listDocs({ folderId: top.id, includeSubfolders: true }).items.map((d) => d.id).sort();
    expect(rec).toEqual([t1, s1, d1].sort());
    expect(listDocs({ folderId: sub.id, includeSubfolders: true }).items.map((d) => d.id).sort()).toEqual([s1, d1].sort());
    // root-only listing excludes docs in folders
    const root = await mkDoc("at root");
    const rootIds = listDocs({ folderId: "root", limit: 200 }).items.map((d) => d.id);
    expect(rootIds).toContain(root);
    expect(rootIds).not.toContain(t1);
    updateMeta(root, { folderId: deep.id });
    expect(listDocs({ folderId: top.id, includeSubfolders: true }).items.map((d) => d.id)).toContain(root);
  });
});
