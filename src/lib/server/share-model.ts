import type { ShareLink } from "@/lib/types";
import { publicBaseUrl } from "./config";
import { getDb } from "./db";

export interface ShareRow {
  id: string;
  token: string;
  doc_id: string;
  password_hash: string | null;
  allow_download: number;
  expires_at: string | null;
  views: number;
  created_at: string;
  revoked_at: string | null;
}

export function shareUrl(token: string): string {
  return `${publicBaseUrl()}/s/${token}`;
}

export function shareToApi(r: ShareRow): ShareLink {
  return {
    id: r.id,
    token: r.token,
    docId: r.doc_id,
    url: shareUrl(r.token),
    expiresAt: r.expires_at,
    hasPassword: !!r.password_hash,
    allowDownload: !!r.allow_download,
    views: r.views,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

/** All shares for a doc (including expired/revoked), newest first. */
export function listShares(docId: string): ShareLink[] {
  const rows = getDb()
    .prepare("SELECT * FROM shares WHERE doc_id = ? ORDER BY created_at DESC, id DESC")
    .all(docId) as ShareRow[];
  return rows.map(shareToApi);
}
