import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import type { ShareLink, ShareLinkWithDoc } from "@/lib/types";
import { getDb } from "./db";
import { HttpError } from "./errors";
import { newId, newShareToken, nowIso } from "./ids";
import { getDocRowForShare, requireDoc, thumbUrl, type DocRow } from "./docs";
import { shareToApi, type ShareRow } from "./share-model";
import { sessionSecret, SHARE_UNLOCK_TTL_MS } from "./config";
import { signValue, verifyValue } from "./token";

export type ExpiresIn = "1h" | "1d" | "7d" | "30d" | "never";

const DURATIONS: Record<Exclude<ExpiresIn, "never">, number> = {
  "1h": 3600_000,
  "1d": 86400_000,
  "7d": 7 * 86400_000,
  "30d": 30 * 86400_000,
};

export function expiryFrom(expiresIn: ExpiresIn, now = Date.now()): string | null {
  return expiresIn === "never" ? null : new Date(now + DURATIONS[expiresIn]).toISOString();
}

export async function createShare(
  docId: string,
  input: { expiresIn: ExpiresIn; password?: string | null; allowDownload: boolean },
): Promise<ShareLink> {
  requireDoc(docId, { allowTrashed: true }); // must exist
  const id = newId();
  const token = newShareToken();
  const hash = input.password ? await bcrypt.hash(input.password, 10) : null;
  getDb()
    .prepare(
      `INSERT INTO shares (id, token, doc_id, password_hash, allow_download, expires_at, views, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(id, token, docId, hash, input.allowDownload ? 1 : 0, expiryFrom(input.expiresIn), nowIso());
  return shareToApi(getShareById(id)!);
}

export function getShareById(id: string): ShareRow | undefined {
  return getDb().prepare("SELECT * FROM shares WHERE id = ?").get(id) as ShareRow | undefined;
}

export function revokeShare(id: string): void {
  const s = getShareById(id);
  if (!s) throw new HttpError(404, "not_found", "Share not found");
  if (!s.revoked_at) getDb().prepare("UPDATE shares SET revoked_at = ? WHERE id = ?").run(nowIso(), id);
}

export type ShareState = "ok" | "not_found" | "revoked" | "expired" | "unavailable";

/** Pure-ish status evaluation (exported for tests). */
export function shareState(share: ShareRow | undefined, doc: Pick<DocRow, "trashed_at"> | undefined, now = Date.now()): ShareState {
  if (!share) return "not_found";
  if (share.revoked_at) return "revoked";
  if (share.expires_at && Date.parse(share.expires_at) <= now) return "expired";
  if (!doc || doc.trashed_at) return "unavailable";
  return "ok";
}

const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;

/** Resolve a public token to an active share + doc, or throw 404/410. */
export function resolveShare(token: string): { share: ShareRow; doc: DocRow } {
  const share = TOKEN_RE.test(token)
    ? (getDb().prepare("SELECT * FROM shares WHERE token = ?").get(token) as ShareRow | undefined)
    : undefined;
  const doc = share ? getDocRowForShare(share.doc_id) : undefined;
  const st = shareState(share, doc);
  switch (st) {
    case "ok":
      return { share: share!, doc: doc! };
    case "not_found":
      throw new HttpError(404, "not_found", "This link does not exist");
    case "revoked":
      throw new HttpError(410, "share_revoked", "This link has been revoked");
    case "expired":
      throw new HttpError(410, "share_expired", "This link has expired");
    default:
      throw new HttpError(410, "share_unavailable", "This document is no longer available");
  }
}

export const unlockCookieName = (shareId: string) => `waraq_share_${shareId}`;
export const viewCookieName = (shareId: string) => `waraq_sv_${shareId}`;

/** Binds an unlock cookie to the current password: changing or removing it invalidates earlier unlocks. */
function passwordTag(hash: string | null | undefined): string {
  return hash ? createHash("sha256").update(hash).digest("base64url").slice(0, 12) : "";
}

export function makeUnlockCookie(shareId: string, now = Date.now(), passwordHash?: string | null): { value: string; maxAge: number } {
  const exp = now + SHARE_UNLOCK_TTL_MS;
  return {
    value: signValue(`${shareId}:${exp}:${passwordTag(passwordHash)}`, sessionSecret(), "share"),
    maxAge: Math.floor(SHARE_UNLOCK_TTL_MS / 1000),
  };
}

export function verifyUnlockCookie(shareId: string, value: string | undefined, now = Date.now(), passwordHash?: string | null): boolean {
  const payload = verifyValue(value, sessionSecret(), "share");
  if (!payload) return false;
  const [id, exp, tag] = payload.split(":");
  return id === shareId && Number(exp) > now && (tag ?? "") === passwordTag(passwordHash);
}

export async function checkSharePassword(share: ShareRow, password: string): Promise<boolean> {
  if (!share.password_hash) return true;
  return bcrypt.compare(password, share.password_hash);
}

export function incrementViews(shareId: string): void {
  getDb().prepare("UPDATE shares SET views = views + 1 WHERE id = ?").run(shareId);
}

/* ------------------------------------------------------------------ management (Settings → Shared links) */

export type ShareListStatus = ShareLinkWithDoc["status"];

export function shareStatus(r: Pick<ShareRow, "revoked_at" | "expires_at">, now = Date.now()): ShareListStatus {
  if (r.revoked_at) return "revoked";
  if (r.expires_at && Date.parse(r.expires_at) <= now) return "expired";
  return "active";
}

type ShareJoinRow = ShareRow & { doc_title: string; doc_version: number };

function withDoc(r: ShareJoinRow): ShareLinkWithDoc {
  return { ...shareToApi(r), docTitle: r.doc_title, docThumbUrl: thumbUrl(r.doc_id, 0, r.doc_version), status: shareStatus(r) };
}

const JOIN =
  "SELECT s.*, d.title AS doc_title, d.version AS doc_version FROM shares s JOIN documents d ON d.id = s.doc_id WHERE 1 = 1";

/** Every share link with its document, newest first. */
export function listAllShares(status: ShareListStatus | "all" = "all"): ShareLinkWithDoc[] {
  const rows = getDb().prepare(`${JOIN} ORDER BY s.created_at DESC, s.id DESC`).all() as ShareJoinRow[];
  const out = rows.map(withDoc);
  return status === "all" ? out : out.filter((s) => s.status === status);
}

export function getShareWithDoc(id: string): ShareLinkWithDoc {
  const r = getDb().prepare(`${JOIN} AND s.id = ?`).get(id) as ShareJoinRow | undefined;
  if (!r) throw new HttpError(404, "not_found", "Share not found");
  return withDoc(r);
}

/** Edit a link. `expiresIn` re-bases from now (so it also revives an expired link); `password: null` removes it. */
export async function updateShare(
  id: string,
  patch: { expiresIn?: ExpiresIn; password?: string | null; allowDownload?: boolean },
): Promise<ShareLinkWithDoc> {
  const s = getShareById(id);
  if (!s) throw new HttpError(404, "not_found", "Share not found");
  if (s.revoked_at) throw new HttpError(409, "share_revoked", "Revoked links cannot be edited; create a new one");
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.expiresIn !== undefined) {
    sets.push("expires_at = ?");
    vals.push(expiryFrom(patch.expiresIn));
  }
  if (patch.password !== undefined) {
    sets.push("password_hash = ?");
    vals.push(patch.password ? await bcrypt.hash(patch.password, 10) : null);
  }
  if (patch.allowDownload !== undefined) {
    sets.push("allow_download = ?");
    vals.push(patch.allowDownload ? 1 : 0);
  }
  if (sets.length) getDb().prepare(`UPDATE shares SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return getShareWithDoc(id);
}

/** Remove a revoked or expired link from the list (active links must be revoked first). */
export function purgeShare(id: string): void {
  const s = getShareById(id);
  if (!s) throw new HttpError(404, "not_found", "Share not found");
  if (shareStatus(s) === "active") throw new HttpError(409, "share_active", "Revoke the link before removing it");
  getDb().prepare("DELETE FROM shares WHERE id = ?").run(id);
}

/** Revoke every active link (optionally only for one document). Returns how many were revoked. */
export function revokeAllShares(docId?: string): number {
  const now = nowIso();
  const r = docId
    ? getDb().prepare("UPDATE shares SET revoked_at = ? WHERE revoked_at IS NULL AND doc_id = ?").run(now, docId)
    : getDb().prepare("UPDATE shares SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
  return r.changes;
}
