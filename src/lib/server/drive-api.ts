// Minimal Google OAuth + Drive v3 REST client (plain fetch, no googleapis dependency).
// Never include tokens or secrets in thrown messages or logs.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { driveCredentials, driveRedirectUri, getRefreshToken } from "./drive-store";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,parents,webViewLink,trashed,md5Checksum,size";

export class DriveError extends Error {
  status: number;
  retryable: boolean;
  retryAfterMs?: number;
  reason?: string;
  constructor(message: string, status: number, opts: { retryable?: boolean; retryAfterMs?: number; reason?: string } = {}) {
    super(message);
    this.name = "DriveError";
    this.status = status;
    this.retryable = !!opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
    this.reason = opts.reason;
  }
}

/** The refresh token is missing, revoked or the client credentials are wrong: the owner has to reconnect. */
export class DriveAuthError extends DriveError {
  constructor(message: string) {
    super(message, 401);
    this.name = "DriveAuthError";
  }
}

export interface DriveFile {
  id: string;
  name?: string;
  parents?: string[];
  webViewLink?: string;
  trashed?: boolean;
  md5Checksum?: string;
  size?: string;
}

// The owner's cached Drive access token (process-wide).
const g = globalThis as unknown as { __waraqDriveToken?: { token: string; exp: number } | null };

/** Forget the cached access token. */
export function resetAccessToken(): void {
  g.__waraqDriveToken = null;
}

const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError", "sharingRateLimitExceeded"]);

function retryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.min(s, 3600) * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.min(t - Date.now(), 3600_000)) : undefined;
}

async function toDriveError(res: Response, what: string): Promise<DriveError> {
  let message = `${what} failed (HTTP ${res.status})`;
  let reason: string | undefined;
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } | string; error_description?: string };
    if (body && typeof body.error === "object") {
      reason = body.error.errors?.[0]?.reason;
      if (body.error.message) message = `${what}: ${body.error.message}`.slice(0, 240);
    } else if (typeof body?.error === "string") {
      reason = body.error;
      message = `${what}: ${body.error_description || body.error}`.slice(0, 240);
    }
  } catch {
    /* non-JSON error body */
  }
  const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && !!reason && RATE_REASONS.has(reason));
  return new DriveError(message, res.status, { retryable, retryAfterMs: retryAfter(res), reason });
}

async function gfetch(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // network errors / timeouts are transient
    throw new DriveError(`Network error talking to Google (${(e as Error).name})`, 0, { retryable: true });
  }
}

function form(data: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data).toString(),
  };
}

async function tokenRequest(data: Record<string, string>, what: string): Promise<{ access_token: string; expires_in?: number; refresh_token?: string }> {
  const res = await gfetch(GOOGLE_TOKEN_URL, form(data), 30_000);
  if (!res.ok) {
    const err = await toDriveError(res, what);
    if (["invalid_grant", "invalid_client", "unauthorized_client"].includes(err.reason ?? "")) {
      throw new DriveAuthError(
        err.reason === "invalid_grant"
          ? "Google access expired or was revoked. Reconnect Google Drive."
          : "Google rejected the OAuth client credentials. Check the client ID and secret.",
      );
    }
    throw err;
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!body.access_token) throw new DriveError(`${what}: no access token returned`, 502, { retryable: true });
  return body as { access_token: string; expires_in?: number; refresh_token?: string };
}

export async function accessToken(): Promise<string> {
  const c = g.__waraqDriveToken;
  if (c && c.exp > Date.now() + 60_000) return c.token;
  const creds = driveCredentials();
  const rt = getRefreshToken();
  if (!creds || !rt) throw new DriveAuthError("Google Drive is not connected");
  const t = await tokenRequest(
    { client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: rt, grant_type: "refresh_token" },
    "Token refresh",
  );
  g.__waraqDriveToken = { token: t.access_token, exp: Date.now() + (t.expires_in ?? 3600) * 1000 };
  return t.access_token;
}

/** Authorized Drive request: refreshes the access token once on 401. Throws DriveError on any non-2xx. */
export async function driveFetch(url: string, init: RequestInit = {}, what = "Drive request", timeoutMs = 60_000): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const res = await gfetch(url, { ...init, headers }, timeoutMs);
    if (res.status === 401 && attempt === 0) {
      resetAccessToken();
      continue;
    }
    if (!res.ok) throw await toDriveError(res, what);
    return res;
  }
}

/* ---------------------------------------------------------------- OAuth */

export function buildAuthUrl(clientId: string, state: string): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", driveRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", DRIVE_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  u.searchParams.set("state", state);
  return u.toString();
}

/** Exchanges an authorization code (from the web OAuth redirect) for tokens. */
export async function exchangeCode(code: string): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> {
  const creds = driveCredentials();
  if (!creds) throw new DriveAuthError("Google OAuth client is not configured");
  const t = await tokenRequest(
    {
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: driveRedirectUri(),
      grant_type: "authorization_code",
    },
    "Code exchange",
  );
  if (!t.refresh_token) throw new DriveError("Google did not return a refresh token", 400);
  g.__waraqDriveToken = { token: t.access_token, exp: Date.now() + (t.expires_in ?? 3600) * 1000 };
  return { refreshToken: t.refresh_token, accessToken: t.access_token, expiresIn: t.expires_in ?? 3600 };
}

export async function revokeToken(token: string): Promise<void> {
  try {
    await gfetch(GOOGLE_REVOKE_URL, form({ token }), 10_000);
  } catch {
    /* best effort */
  }
}

/* ---------------------------------------------------------------- Drive v3 */

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  return s.toString();
};

export async function aboutUser(): Promise<{ email: string | null; name: string | null }> {
  const res = await driveFetch(`${API}/about?fields=user(emailAddress,displayName)`, {}, "Account lookup");
  const b = (await res.json()) as { user?: { emailAddress?: string; displayName?: string } };
  return { email: b.user?.emailAddress ?? null, name: b.user?.displayName ?? null };
}

export async function getFile(id: string): Promise<DriveFile | null> {
  try {
    const res = await driveFetch(`${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`, {}, "Drive lookup");
    return (await res.json()) as DriveFile;
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return null;
    throw e;
  }
}

export async function findByAppProperty(key: string, value: string): Promise<DriveFile | null> {
  const query = `appProperties has { key='${key}' and value='${value}' } and trashed = false`;
  const res = await driveFetch(`${API}/files?${q({ q: query, fields: `files(${FILE_FIELDS})`, pageSize: "10", spaces: "drive" })}`, {}, "Drive search");
  const b = (await res.json()) as { files?: DriveFile[] };
  return b.files?.[0] ?? null;
}

export async function hasChildren(folderId: string): Promise<boolean> {
  const query = `'${folderId.replace(/'/g, "")}' in parents and trashed = false`;
  const res = await driveFetch(`${API}/files?${q({ q: query, fields: "files(id)", pageSize: "1" })}`, {}, "Drive search");
  const b = (await res.json()) as { files?: DriveFile[] };
  return (b.files?.length ?? 0) > 0;
}

export async function createFolder(name: string, parentId: string, appProperties?: Record<string, string>): Promise<DriveFile> {
  const res = await driveFetch(
    `${API}/files?fields=${FILE_FIELDS}`,
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties }),
    },
    "Create Drive folder",
  );
  return (await res.json()) as DriveFile;
}

export interface MoveOpts {
  addParents?: string | null;
  removeParents?: string | null;
}

export async function updateMetadata(id: string, meta: { name?: string; trashed?: boolean }, move: MoveOpts = {}): Promise<DriveFile> {
  const res = await driveFetch(
    `${API}/files/${encodeURIComponent(id)}?${q({ fields: FILE_FIELDS, addParents: move.addParents ?? undefined, removeParents: move.removeParents ?? undefined })}`,
    { method: "PATCH", headers: { "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify(meta) },
    "Update Drive file",
  );
  return (await res.json()) as DriveFile;
}

/** Above this size uploads use the resumable protocol (Google recommends multipart only for small files). */
function multipartMax(): number {
  const v = Number(process.env.WARAQ_DRIVE_MULTIPART_MAX);
  return Number.isFinite(v) && v > 0 ? v : 5 * 1024 * 1024;
}

const asBody = (b: Uint8Array) => b as unknown as BodyInit;

/** Create (no fileId, uses parentId) or replace the content of (fileId) a PDF; `move` re-parents in the same call. */
export async function uploadPdf(opts: {
  fileId?: string | null;
  name: string;
  parentId: string;
  move?: MoveOpts;
  bytes: Uint8Array;
  appProperties?: Record<string, string>;
}): Promise<DriveFile> {
  const creating = !opts.fileId;
  const meta: Record<string, unknown> = { name: opts.name };
  if (creating) {
    meta.mimeType = "application/pdf";
    meta.parents = [opts.parentId];
    if (opts.appProperties) meta.appProperties = opts.appProperties;
  }
  const params = (uploadType: string) =>
    q({
      uploadType,
      fields: FILE_FIELDS,
      addParents: creating ? undefined : (opts.move?.addParents ?? undefined),
      removeParents: creating ? undefined : (opts.move?.removeParents ?? undefined),
    });
  const path = creating ? `${UPLOAD}/files` : `${UPLOAD}/files/${encodeURIComponent(opts.fileId!)}`;
  const method = creating ? "POST" : "PATCH";
  const timeout = 120_000 + Math.ceil(opts.bytes.byteLength / (256 * 1024)) * 1000;

  if (opts.bytes.byteLength <= multipartMax()) {
    const boundary = `waraq${randomBytes(12).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from(opts.bytes.buffer, opts.bytes.byteOffset, opts.bytes.byteLength),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await driveFetch(
      `${path}?${params("multipart")}`,
      { method, headers: { "content-type": `multipart/related; boundary=${boundary}` }, body: asBody(body) },
      creating ? "Upload to Drive" : "Update Drive file",
      timeout,
    );
    return (await res.json()) as DriveFile;
  }

  const init = await driveFetch(
    `${path}?${params("resumable")}`,
    {
      method,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": "application/pdf",
        "x-upload-content-length": String(opts.bytes.byteLength),
      },
      body: JSON.stringify(meta),
    },
    "Start Drive upload",
  );
  const location = init.headers.get("location");
  if (!location || !location.startsWith("https://www.googleapis.com/")) {
    throw new DriveError("Drive did not return an upload session", 502, { retryable: true });
  }
  const res = await driveFetch(
    location,
    { method: "PUT", headers: { "content-type": "application/pdf" }, body: asBody(opts.bytes) },
    "Upload to Drive",
    timeout,
  );
  return (await res.json()) as DriveFile;
}

/** Google said the user's Drive is full (uploads can't succeed until they free space). */
export const isDriveFull = (e: unknown) =>
  e instanceof DriveError && (e.reason === "storageQuotaExceeded" || e.reason === "quotaExceeded" || /storage quota/i.test(e.message));

/**
 * Stream a file's content (alt=media) to `dest` (written to a temp name, renamed when complete).
 * Returns the byte count and md5 of what was written.
 */
export async function downloadFile(id: string, dest: string): Promise<{ bytes: number; md5: string }> {
  const res = await driveFetch(`${API}/files/${encodeURIComponent(id)}?alt=media`, {}, "Drive download", 300_000);
  const tmp = `${dest}.${randomBytes(4).toString("hex")}.part`;
  const hash = createHash("md5");
  let bytes = 0;
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  try {
    if (!res.body) throw new DriveError("Drive download returned no content", 502, { retryable: true });
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      bytes += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    await fsp.rename(tmp, dest);
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    if (e instanceof DriveError) throw e;
    throw new DriveError(`Drive download interrupted (${(e as Error).name})`, 0, { retryable: true });
  }
  return { bytes, md5: hash.digest("hex") };
}

export const fileViewUrl = (id: string) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;

export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;

/* ---------------------------------------------------------------- Drive OCR (free: import an image as a Google Doc) */

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

/**
 * Upload an image converted to a Google Doc: Drive runs OCR on it (`ocrLanguage` = ISO 639-1 hint).
 * Drive only OCRs images up to ~2 MB, so callers keep JPEGs below that.
 */
export async function uploadImageForOcr(opts: { name: string; parentId: string; jpeg: Uint8Array; language: string }): Promise<DriveFile> {
  const boundary = `waraq${randomBytes(12).toString("hex")}`;
  const meta = { name: opts.name, mimeType: GOOGLE_DOC_MIME, parents: [opts.parentId], appProperties: { waraqOcrTmp: "1" } };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`),
    Buffer.from(opts.jpeg.buffer, opts.jpeg.byteOffset, opts.jpeg.byteLength),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await driveFetch(
    `${UPLOAD}/files?${q({ uploadType: "multipart", ocrLanguage: opts.language, fields: "id,name" })}`,
    { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body: asBody(body) },
    "Drive OCR upload",
    120_000,
  );
  return (await res.json()) as DriveFile;
}

/** Export a Google Doc as plain text (UTF-8, BOM stripped). */
export async function exportPlainText(id: string): Promise<string> {
  const res = await driveFetch(`${API}/files/${encodeURIComponent(id)}/export?${q({ mimeType: "text/plain" })}`, {}, "Drive OCR export", 60_000);
  return (await res.text()).replace(/^\uFEFF/, "");
}

/** Permanently delete an app-created temporary file (only used for OCR scratch docs). 404 is fine. */
export async function deleteFile(id: string): Promise<void> {
  try {
    await driveFetch(`${API}/files/${encodeURIComponent(id)}`, { method: "DELETE" }, "Drive delete", 30_000);
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return;
    throw e;
  }
}

export async function listChildren(folderId: string, pageSize = 50): Promise<DriveFile[]> {
  const query = `'${folderId.replace(/'/g, "")}' in parents and trashed = false`;
  const res = await driveFetch(`${API}/files?${q({ q: query, fields: "files(id,name)", pageSize: String(pageSize) })}`, {}, "Drive search");
  const b = (await res.json()) as { files?: DriveFile[] };
  return b.files ?? [];
}
