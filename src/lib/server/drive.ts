// Drive feature façade used by the /api/drive/** route handlers.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DocSummary, DriveStatus, DriveSyncInfo } from "@/lib/types";
import { getDb } from "./db";
import { HttpError } from "./errors";
import { sessionSecret } from "./config";
import { signValue, verifyValue } from "./token";
import {
  autoSyncEnabled,
  clearStoredCredentials,
  driveCredentials,
  driveRedirectUri,
  DRIVE_KEYS,
  envCredentials,
  getRefreshToken,
  getSetting,
  isDriveConnected,
  maskClientId,
  saveCredentials,
  setLastError,
  setRefreshToken,
  setSetting,
  wipeDriveMappings,
} from "./drive-store";
import { aboutUser, buildAuthUrl, exchangeCode, folderUrl, resetAccessToken, revokeToken } from "./drive-api";
import { enqueueDriveSyncMany } from "./drive-queue";
import { kickDriveWorker } from "./drive-sync";

export const DRIVE_STATE_COOKIE = "waraq_drive_oauth";
const STATE_TTL_MS = 10 * 60_000;
const STATE_CTX = "drive-oauth";

const count = (sql: string, ...args: unknown[]) => (getDb().prepare(sql).get(...args) as { n: number }).n;

export function getDriveStatus(): DriveStatus {
  const creds = driveCredentials();
  const connected = isDriveConnected();
  const root = getSetting(DRIVE_KEYS.rootFolderId);
  return {
    configured: !!creds,
    credentialsSource: creds?.source ?? null,
    clientIdMasked: creds ? maskClientId(creds.clientId) : null,
    redirectUri: driveRedirectUri(),
    connected,
    needsReconnect: !connected && getSetting(DRIVE_KEYS.needsReconnect) === "1",
    email: getSetting(DRIVE_KEYS.email),
    autoSync: autoSyncEnabled(),
    rootFolderUrl: root ? folderUrl(root) : null,
    queue: {
      pending: count("SELECT COUNT(*) AS n FROM drive_jobs WHERE status IN ('queued','running')"),
      failed: count("SELECT COUNT(*) AS n FROM drive_jobs WHERE status = 'error'"),
    },
    docs: {
      total: count("SELECT COUNT(*) AS n FROM documents WHERE trashed_at IS NULL"),
      synced: count(
        `SELECT COUNT(*) AS n FROM documents d JOIN drive_docs m ON m.doc_id = d.id
         WHERE d.trashed_at IS NULL AND m.file_id IS NOT NULL AND m.synced_version = d.version`,
      ),
    },
    lastSyncAt: getSetting(DRIVE_KEYS.lastSyncAt),
    lastError: getSetting(DRIVE_KEYS.lastError),
  };
}

/* ------------------------------------------------------------ credentials */

export function setDriveConfig(clientId: string, clientSecret: string): void {
  if (envCredentials()) {
    throw new HttpError(409, "configured_by_env", "Credentials come from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server");
  }
  const prev = driveCredentials();
  if (prev && prev.clientId !== clientId && isDriveConnected()) {
    throw new HttpError(409, "connected", "Disconnect Google Drive before replacing the OAuth client");
  }
  saveCredentials(clientId, clientSecret);
}

export async function resetDriveConfig(): Promise<void> {
  if (envCredentials()) {
    throw new HttpError(409, "configured_by_env", "Credentials come from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server");
  }
  await disconnectDrive();
  clearStoredCredentials();
}

/* ------------------------------------------------------------ OAuth */

/** Where the callback may send the browser back to (relative paths only). */
const RETURN_PATHS = new Set(["/settings", "/settings/drive", "/", "/import-pending", "/connect-drive"]);
export const safeReturnPath = (p: string | null | undefined): string => (p && RETURN_PATHS.has(p) ? p : "/settings");

/** The OAuth state is bound to the owner's session; the callback must come back with the same session and cookie. */
export function beginConnect(sessionId: string, returnTo?: string | null): { url: string; state: string } {
  const creds = driveCredentials();
  if (!creds) throw new HttpError(409, "not_configured", "Add your Google OAuth client first");
  const nonce = randomBytes(24).toString("base64url");
  setSetting(
    DRIVE_KEYS.oauthState,
    JSON.stringify({ nonce, sid: sessionId, exp: Date.now() + STATE_TTL_MS, ret: safeReturnPath(returnTo) }),
  );
  const state = signValue(nonce, sessionSecret(), STATE_CTX);
  return { url: buildAuthUrl(creds.clientId, state), state };
}

function eq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The page the user started connecting from (read before verifyConnectState consumes the state). */
export function connectReturnPath(): string {
  try {
    return safeReturnPath((JSON.parse(getSetting(DRIVE_KEYS.oauthState) ?? "{}") as { ret?: string }).ret);
  } catch {
    return "/settings";
  }
}

/** Single-use: the stored state is consumed whether or not it matches. */
export function verifyConnectState(state: string | null, cookieState: string | null | undefined, sessionId: string): boolean {
  const raw = getSetting(DRIVE_KEYS.oauthState);
  setSetting(DRIVE_KEYS.oauthState, null);
  if (!state || !cookieState || !raw || !eq(state, cookieState)) return false;
  const nonce = verifyValue(state, sessionSecret(), STATE_CTX);
  if (!nonce) return false;
  try {
    const s = JSON.parse(raw) as { nonce: string; sid: string; exp: number };
    return eq(s.nonce, nonce) && eq(s.sid, sessionId) && s.exp > Date.now();
  } catch {
    return false;
  }
}

/** Exchange the OAuth code, store the refresh token (encrypted) and remember the Drive account email for Settings. */
export async function completeConnect(code: string): Promise<{ email: string | null }> {
  const t = await exchangeCode(code);
  let email: string | null = null;
  try {
    email = (await aboutUser()).email;
  } catch {
    /* email is cosmetic */
  }
  const prevEmail = getSetting(DRIVE_KEYS.email);
  if (prevEmail && email && prevEmail.toLowerCase() !== email.toLowerCase()) wipeDriveMappings(); // different account
  setRefreshToken(t.refreshToken);
  setSetting(DRIVE_KEYS.email, email);
  setSetting(DRIVE_KEYS.needsReconnect, null);
  setLastError(null);
  kickDriveWorker();
  return { email };
}

/** Revoke the grant at Google (best effort) and forget tokens + mappings. Files already in Drive are kept. */
export async function disconnectDrive(): Promise<void> {
  const rt = getRefreshToken();
  setRefreshToken(null);
  resetAccessToken();
  wipeDriveMappings();
  for (const k of [DRIVE_KEYS.email, DRIVE_KEYS.lastError, DRIVE_KEYS.lastSyncAt, DRIVE_KEYS.needsReconnect, DRIVE_KEYS.oauthState]) {
    setSetting(k, null);
  }
  if (rt) await revokeToken(rt);
}

/* ------------------------------------------------------------ sync */

export function setAutoSync(on: boolean): void {
  setSetting(DRIVE_KEYS.autoSync, on ? "1" : "0");
}

export function requestSync(input: { ids?: string[]; all?: boolean }): { queued: number } {
  if (!isDriveConnected()) throw new HttpError(409, "not_connected", "Connect Google Drive first");
  const db = getDb();
  let ids: string[];
  if (input.all) {
    ids = (
      db.prepare("SELECT id FROM documents WHERE trashed_at IS NULL ORDER BY updated_at DESC").all() as {
        id: string;
      }[]
    ).map(
      (r) => r.id,
    );
  } else {
    const wanted = [...new Set(input.ids ?? [])];
    const exists = db.prepare("SELECT 1 FROM documents WHERE id = ? AND trashed_at IS NULL");
    ids = wanted.filter((id) => exists.get(id));
  }
  return { queued: enqueueDriveSyncMany(ids) };
}

/** Per-document mirror state for DocSummary.driveSync (only when connected). */
export function driveSyncInfo(ids: string[]): Map<string, DriveSyncInfo | null> {
  const out = new Map<string, DriveSyncInfo | null>();
  if (!ids.length) return out;
  const db = getDb();
  const jobQ = db.prepare(
    "SELECT status, error FROM drive_jobs WHERE target_id = ? AND kind IN ('doc','delete') ORDER BY id DESC LIMIT 1",
  );
  const docQ = db.prepare("SELECT file_id, web_view_link, last_error FROM drive_docs WHERE doc_id = ?");
  for (const id of ids) {
    const job = jobQ.get(id) as { status: string; error: string | null } | undefined;
    const m = docQ.get(id) as { file_id: string | null; web_view_link: string | null; last_error: string | null } | undefined;
    const link = m?.web_view_link ?? undefined;
    if (job?.status === "error") out.set(id, { status: "error", error: job.error ?? "Drive sync failed", webViewLink: link });
    else if (job) out.set(id, { status: "pending", webViewLink: link });
    else if (m?.file_id) out.set(id, { status: "synced", webViewLink: link });
    else out.set(id, null);
  }
  return out;
}

/** Adds `driveSync` to summaries when Drive is connected; never throws (Drive state is decorative here). */
export function withDriveSync<T extends DocSummary>(docs: T[]): T[] {
  try {
    if (!isDriveConnected()) return docs;
    const info = driveSyncInfo(docs.map((d) => d.id));
    return docs.map((d) => ({ ...d, driveSync: info.get(d.id) ?? null }));
  } catch {
    return docs;
  }
}
