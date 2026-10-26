"use client";

import type {
  CompressLevel,
  DocDetail,
  DocSummary,
  ExportFormat,
  Folder,
  LinkedAccount,
  Me,
  PageOp,
  ShareLink,
} from "@/lib/types";
import type {
  DeepPartial,
  OcrQueueStatus,
  Prefs,
  SessionInfo,
  ShareLinkWithDoc,
  ShareStatus,
  VersionInfo,
} from "@/lib/client/contract";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class ApiRequestError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
  get isNetwork() {
    return this.status === 0;
  }
}

export function errorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (err instanceof ApiRequestError) {
    if (err.isNetwork) return "You are offline or the server is unreachable";
    return err.message || fallback;
  }
  if (err instanceof DOMException && err.name === "AbortError") return "Cancelled";
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

let redirectingToLogin = false;
function handleUnauthorized() {
  if (typeof window === "undefined" || redirectingToLogin) return;
  const path = window.location.pathname;
  if (path.startsWith("/login") || path.startsWith("/s/") || path.startsWith("/setup")) return;
  redirectingToLogin = true;
  const next = encodeURIComponent(path + window.location.search);
  window.location.replace(`/login?next=${next}`);
}

async function parseError(res: Response): Promise<ApiRequestError> {
  let message = `Request failed (${res.status})`;
  let code: string | undefined;
  try {
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      // ours: {error, code}; Better Auth: {message, code}
      const body = (await res.json()) as { error?: string; message?: string; code?: string };
      if (body?.error) message = body.error;
      else if (body?.message) message = body.message;
      code = body?.code;
    } else {
      const text = (await res.text()).trim();
      if (text && text.length < 200 && !text.startsWith("<")) message = text;
    }
  } catch {
    /* ignore body parse errors */
  }
  return new ApiRequestError(message, res.status, code);
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  json?: unknown;
  body?: BodyInit | null;
  /** Do not redirect to /login on 401 (used by login + public pages). */
  public?: boolean;
}

export async function rawRequest(path: string, opts: RequestOptions = {}): Promise<Response> {
  const { json, public: isPublic, headers, ...rest } = opts;
  const init: RequestInit = { credentials: "same-origin", ...rest };
  const h = new Headers(headers);
  if (json !== undefined) {
    h.set("content-type", "application/json");
    init.body = JSON.stringify(json);
  }
  h.set("accept", h.get("accept") ?? "application/json");
  init.headers = h;
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiRequestError("Network error", 0);
  }
  if (res.status === 401 && !isPublic) {
    handleUnauthorized();
  }
  if (!res.ok) throw await parseError(res);
  return res;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await rawRequest(path, opts);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) return undefined as T;
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Upload with progress (XHR)                                          */
/* ------------------------------------------------------------------ */

export interface UploadProgress {
  loaded: number;
  total: number;
  fraction: number;
}

export interface UploadHandle<T> {
  promise: Promise<T>;
  abort: () => void;
}

export function uploadForm<T>(
  url: string,
  form: FormData,
  onProgress?: (p: UploadProgress) => void,
): UploadHandle<T> {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (!onProgress) return;
      const total = e.lengthComputable ? e.total : 0;
      onProgress({ loaded: e.loaded, total, fraction: total ? e.loaded / total : 0 });
    };
    xhr.onerror = () => reject(new ApiRequestError("Network error during upload", 0));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
        return;
      }
      if (xhr.status === 401) handleUnauthorized();
      const b = body as { error?: string; code?: string } | null;
      reject(
        new ApiRequestError(b?.error ?? `Upload failed (${xhr.status})`, xhr.status, b?.code),
      );
    };
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

export type SortKey = "updated" | "created" | "title" | "size";
export type SortDir = "asc" | "desc";

export interface DocListQuery {
  folderId?: string | "root";
  q?: string;
  tag?: string;
  starred?: boolean;
  trash?: boolean;
  sort?: SortKey;
  dir?: SortDir;
  limit?: number;
  cursor?: string | null;
}

export interface DocListResult {
  items: DocSummary[];
  nextCursor: string | null;
}

export function docListUrl(q: DocListQuery): string {
  const p = new URLSearchParams();
  if (q.folderId) p.set("folderId", q.folderId);
  if (q.q) p.set("q", q.q);
  if (q.tag) p.set("tag", q.tag);
  if (q.starred) p.set("starred", "1");
  if (q.trash) p.set("trash", "1");
  if (q.sort) p.set("sort", q.sort);
  if (q.dir) p.set("dir", q.dir);
  if (q.limit) p.set("limit", String(q.limit));
  if (q.cursor) p.set("cursor", q.cursor);
  const s = p.toString();
  return `/api/docs${s ? `?${s}` : ""}`;
}

export type ShareExpiry = "1h" | "1d" | "7d" | "30d" | "never";

export interface PublicShare {
  title: string;
  pageCount: number;
  allowDownload: boolean;
  pages: { thumbUrl: string; imageUrl: string }[];
}

const enc = encodeURIComponent;

export const api = {
  // auth (Better Auth endpoints under /api/auth/*): owner password sign-in, optional linked Google sign-in.
  login: (username: string, password: string) =>
    request<unknown>("/api/auth/sign-in/username", {
      method: "POST",
      json: { username, password, rememberMe: true },
      public: true,
    }),
  logout: () => request<unknown>("/api/auth/sign-out", { method: "POST", json: {}, public: true }),
  me: () => request<Me>("/api/auth/me", { public: true }),
  /** Start Google OAuth; resolves with the Google URL to navigate to. */
  googleSignIn: (opts: { callbackURL: string; errorCallbackURL: string }) =>
    request<{ url: string }>("/api/auth/sign-in/social", {
      method: "POST",
      json: { provider: "google", disableRedirect: true, ...opts },
      public: true,
    }),
  linkGoogle: () =>
    request<{ url: string }>("/api/auth/link-social", {
      method: "POST",
      json: { provider: "google", callbackURL: "/settings/account?linked=google", errorCallbackURL: "/settings/account", disableRedirect: true },
    }),
  unlinkAccount: (accountId: string) => request<unknown>("/api/auth/unlink-account", { method: "POST", json: { accountId } }),
  updateName: (name: string) => request<unknown>("/api/auth/update-user", { method: "POST", json: { name } }),
  accounts: () => request<{ accounts: LinkedAccount[]; googleAvailable: boolean }>("/api/account/accounts"),

  // folders
  folders: () => request<Folder[]>("/api/folders"),
  createFolder: (body: { name: string; parentId?: string | null; color?: string | null }) =>
    request<Folder>("/api/folders", { method: "POST", json: body }),
  updateFolder: (
    id: string,
    body: { name?: string; parentId?: string | null; color?: string | null },
  ) => request<Folder>(`/api/folders/${enc(id)}`, { method: "PATCH", json: body }),
  deleteFolder: (id: string) => request<unknown>(`/api/folders/${enc(id)}`, { method: "DELETE" }),

  // docs
  docs: (q: DocListQuery, signal?: AbortSignal) => request<DocListResult>(docListUrl(q), { signal }),
  doc: (id: string, signal?: AbortSignal) => request<DocDetail>(`/api/docs/${enc(id)}`, { signal }),
  updateDoc: (
    id: string,
    body: { title?: string; folderId?: string | null; tags?: string[]; starred?: boolean },
  ) => request<DocSummary>(`/api/docs/${enc(id)}`, { method: "PATCH", json: body }),
  trashDoc: (id: string) => request<unknown>(`/api/docs/${enc(id)}`, { method: "DELETE" }),
  deleteForever: (id: string) =>
    request<unknown>(`/api/docs/${enc(id)}?permanent=1`, { method: "DELETE" }),
  /** Replace the file of a Drive document that was deleted from the user's Drive. */

  restoreDoc: (id: string) =>
    request<unknown>(`/api/docs/${enc(id)}/restore`, { method: "POST" }),
  createDoc: (
    files: (File | Blob)[],
    opts: { title?: string; folderId?: string | null; source?: "scan" | "import" | "share-target" },
    onProgress?: (p: UploadProgress) => void,
  ) => {
    const fd = new FormData();
    files.forEach((f, i) => fd.append("files[]", f, fileName(f, i)));
    if (opts.title) fd.append("title", opts.title);
    if (opts.folderId) fd.append("folderId", opts.folderId);
    if (opts.source) fd.append("source", opts.source);
    return uploadForm<DocDetail>("/api/docs", fd, onProgress);
  },
  addPages: (
    id: string,
    files: (File | Blob)[],
    at?: number,
    onProgress?: (p: UploadProgress) => void,
  ) => {
    const fd = new FormData();
    files.forEach((f, i) => fd.append("files[]", f, fileName(f, i)));
    if (at !== undefined) fd.append("at", String(at));
    return uploadForm<DocDetail>(`/api/docs/${enc(id)}/pages`, fd, onProgress);
  },
  replacePage: (id: string, index: number, file: Blob, onProgress?: (p: UploadProgress) => void) => {
    const fd = new FormData();
    fd.append("file", file, `page-${index + 1}.jpg`);
    return uploadForm<DocDetail>(`/api/docs/${enc(id)}/pages/${index}/replace`, fd, onProgress);
  },
  pageOps: (id: string, ops: PageOp[]) =>
    request<DocDetail>(`/api/docs/${enc(id)}/pages/ops`, { method: "POST", json: { ops } }),
  extract: (id: string, body: { pages: number[]; title?: string; removeFromSource?: boolean }) =>
    request<DocDetail>(`/api/docs/${enc(id)}/extract`, { method: "POST", json: body }),
  split: (id: string, body: { ranges: number[][] } | { every: number }) =>
    request<{ docs: DocSummary[] }>(`/api/docs/${enc(id)}/split`, { method: "POST", json: body }),
  merge: (body: { ids: string[]; title?: string; trashSources?: boolean }) =>
    request<DocDetail>("/api/docs/merge", { method: "POST", json: body }),
  duplicate: (id: string) =>
    request<DocDetail>(`/api/docs/${enc(id)}/duplicate`, { method: "POST" }),
  compress: async (id: string, level: CompressLevel) => {
    const res = await rawRequest(`/api/docs/${enc(id)}/compress`, {
      method: "POST",
      json: { level },
    });
    const savedBytes = Number(res.headers.get("x-saved-bytes") ?? "0") || 0;
    const doc = (await res.json()) as DocDetail;
    return { doc, savedBytes };
  },
  rerunOcr: (id: string) => request<{ ok: true }>(`/api/docs/${enc(id)}/ocr`, { method: "POST" }),
  text: (id: string) => request<{ text: string }>(`/api/docs/${enc(id)}/text`),
  exportPost: async (
    id: string,
    body: { format: ExportFormat; pages?: number[]; password?: string },
  ) => {
    const res = await rawRequest(`/api/docs/${enc(id)}/export`, {
      method: "POST",
      json: body,
      headers: { accept: "*/*" },
    });
    return { blob: await res.blob(), filename: filenameFromResponse(res) };
  },
  exportUrl: (id: string, format: ExportFormat, pages?: number[]) => {
    const p = new URLSearchParams({ format });
    if (pages?.length) p.set("pages", pages.join(","));
    return `/api/docs/${enc(id)}/export?${p}`;
  },
  fileUrl: (id: string, download = false) =>
    `/api/docs/${enc(id)}/file${download ? "?download=1" : ""}`,

  // tags
  tags: () => request<{ tag: string; count: number }[]>("/api/tags"),

  // shares
  shares: (docId: string) => request<ShareLink[]>(`/api/docs/${enc(docId)}/shares`),
  createShare: (
    docId: string,
    body: { expiresIn: ShareExpiry; password?: string; allowDownload: boolean },
  ) => request<ShareLink>(`/api/docs/${enc(docId)}/shares`, { method: "POST", json: body }),
  revokeShare: (id: string) => request<unknown>(`/api/shares/${enc(id)}`, { method: "DELETE" }),
  shareQrUrl: (id: string) => `/api/shares/${enc(id)}/qr`,

  // public
  publicShare: (token: string) =>
    request<PublicShare>(`/api/public/s/${enc(token)}`, { public: true, cache: "no-store" }),
  unlockShare: (token: string, password: string) =>
    request<{ ok: true }>(`/api/public/s/${enc(token)}/unlock`, {
      method: "POST",
      json: { password },
      public: true,
    }),
  publicFileUrl: (token: string) => `/api/public/s/${enc(token)}/file`,

  /* ---------------------------- v4 contract ---------------------------- */
  // all shares across documents
  allShares: (status: ShareStatus | "all" = "all") =>
    request<ShareLinkWithDoc[]>(`/api/shares?status=${status}`),
  updateShare: (
    id: string,
    body: { expiresIn?: ShareExpiry; password?: string | null; allowDownload?: boolean },
  ) => request<ShareLinkWithDoc>(`/api/shares/${enc(id)}`, { method: "PATCH", json: body }),
  purgeShare: (id: string) => request<unknown>(`/api/shares/${enc(id)}?purge=1`, { method: "DELETE" }),
  revokeAllShares: (docId?: string) =>
    request<unknown>("/api/shares/revoke-all", { method: "POST", json: docId ? { docId } : {} }),

  // prefs
  prefs: () => request<Prefs>("/api/prefs"),
  patchPrefs: (body: DeepPartial<Prefs>) => request<Prefs>("/api/prefs", { method: "PATCH", json: body }),

  // sessions
  sessions: () => request<SessionInfo[]>("/api/sessions"),
  revokeSession: (id: string) => request<unknown>(`/api/sessions/${enc(id)}`, { method: "DELETE" }),
  revokeOtherSessions: () => request<unknown>("/api/sessions/revoke-others", { method: "POST" }),

  // OCR
  ocrStatus: () => request<OcrQueueStatus>("/api/ocr/status"),
  ocrRerun: (body: { ids?: string[]; all?: boolean }) =>
    request<{ queued: number }>("/api/ocr/rerun", { method: "POST", json: body }),

  // processing
  retryDoc: (id: string) => request<DocDetail>(`/api/docs/${enc(id)}/retry`, { method: "POST" }),

  // build
  version: () => request<VersionInfo>("/api/version", { public: true, cache: "no-store" }),

  /** Compressed copy for sending; the stored document is not changed. */
  exportCompressed: async (id: string, level: CompressLevel, pages?: number[]) => {
    const res = await rawRequest(`/api/docs/${enc(id)}/export`, {
      method: "POST",
      json: { format: "pdf", pages, compress: level },
      headers: { accept: "*/*" },
    });
    return { blob: await res.blob(), filename: filenameFromResponse(res) };
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fileName(f: File | Blob, i: number): string {
  if (f instanceof File && f.name) return f.name;
  const ext = f.type === "application/pdf" ? "pdf" : f.type === "image/png" ? "png" : "jpg";
  return `page-${String(i + 1).padStart(3, "0")}.${ext}`;
}

export function filenameFromResponse(res: Response, fallback = "download"): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fallthrough */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  if (plain) return plain[1];
  return fallback;
}

export async function fetchBlob(
  url: string,
  init?: RequestOptions,
): Promise<{ blob: Blob; filename: string }> {
  const res = await rawRequest(url, { headers: { accept: "*/*" }, ...init });
  return { blob: await res.blob(), filename: filenameFromResponse(res) };
}
