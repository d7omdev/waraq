// Drive state for the single owner, stored in `settings`: the OAuth client (id/secret) and the connection (refresh
// token, email, folder ids, OAuth state, errors). Secrets are sealed (AES-256-GCM) and never leave the server.
import { getDb } from "./db";
import { nowIso } from "./ids";
import { publicBaseUrl } from "./config";
import { seal, unseal } from "./drive-crypto";
import { getAppSetting, setAppSetting } from "./settings";

export const DRIVE_KEYS = {
  clientId: "drive.client_id",
  clientSecret: "drive.client_secret", // sealed
  refreshToken: "drive.refresh_token", // sealed
  email: "drive.email",
  autoSync: "drive.auto_sync",
  rootFolderId: "drive.root_folder_id",
  trashFolderId: "drive.trash_folder_id",
  ocrTmpFolderId: "drive.ocr_tmp_folder_id",
  lastSyncAt: "drive.last_sync_at",
  lastError: "drive.last_error",
  needsReconnect: "drive.needs_reconnect",
  oauthState: "drive.oauth_state",
} as const;

export const getSetting = (key: string): string | null => getAppSetting(key);
export const setSetting = (key: string, value: string | null): void => setAppSetting(key, value);

export interface DriveCredentials {
  clientId: string;
  clientSecret: string;
  source: "env" | "settings";
}

export function envCredentials(): DriveCredentials | null {
  const id = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const secret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
  return id && secret ? { clientId: id, clientSecret: secret, source: "env" } : null;
}

export function driveCredentials(): DriveCredentials | null {
  const env = envCredentials();
  if (env) return env;
  const id = getSetting(DRIVE_KEYS.clientId);
  const secret = unseal(getSetting(DRIVE_KEYS.clientSecret));
  return id && secret ? { clientId: id, clientSecret: secret, source: "settings" } : null;
}

export function saveCredentials(clientId: string, clientSecret: string): void {
  getDb().transaction(() => {
    setSetting(DRIVE_KEYS.clientId, clientId);
    setSetting(DRIVE_KEYS.clientSecret, seal(clientSecret));
  })();
}

export function clearStoredCredentials(): void {
  setSetting(DRIVE_KEYS.clientId, null);
  setSetting(DRIVE_KEYS.clientSecret, null);
}

export function maskClientId(id: string): string {
  // "1234567890-abcdefgh.apps.googleusercontent.com" -> "1234…efgh.apps.googleusercontent.com"
  const suffix = id.endsWith(".apps.googleusercontent.com") ? ".apps.googleusercontent.com" : "";
  const head = suffix ? id.slice(0, -suffix.length) : id;
  if (head.length <= 10) return `${head.slice(0, 2)}…${suffix}`;
  return `${head.slice(0, 6)}…${head.slice(-4)}${suffix}`;
}

export function driveRedirectUri(): string {
  return `${publicBaseUrl()}/api/drive/callback`;
}

export function getRefreshToken(): string | null {
  return unseal(getSetting(DRIVE_KEYS.refreshToken));
}

export function setRefreshToken(token: string | null): void {
  setSetting(DRIVE_KEYS.refreshToken, token === null ? null : seal(token));
}

/** Cheap check (no decrypt) used on the hot path of document mutations. */
export function isDriveConnected(): boolean {
  return getSetting(DRIVE_KEYS.refreshToken) !== null;
}

export function autoSyncEnabled(): boolean {
  return getSetting(DRIVE_KEYS.autoSync) !== "0";
}

export function setLastError(message: string | null): void {
  setSetting(DRIVE_KEYS.lastError, message === null ? null : message.slice(0, 300));
}

/** Forget the Drive mappings (files stay in Drive). Used on disconnect / account switch / root folder loss. */
export function wipeDriveMappings(opts: { keepQueue?: boolean } = {}): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM drive_folders").run();
    if (opts.keepQueue) {
      db.prepare(
        "UPDATE drive_docs SET file_id = NULL, web_view_link = NULL, synced_version = NULL, synced_name = NULL, synced_parent = NULL, updated_at = ?",
      ).run(nowIso());
    } else {
      db.prepare("DELETE FROM drive_docs").run();
      db.prepare("DELETE FROM drive_jobs").run();
    }
    setSetting(DRIVE_KEYS.rootFolderId, null);
    setSetting(DRIVE_KEYS.trashFolderId, null);
    setSetting(DRIVE_KEYS.ocrTmpFolderId, null);
  })();
}
