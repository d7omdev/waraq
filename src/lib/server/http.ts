import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { connection, type NextRequest } from "next/server";

/** In `next build` prerendering, stop here (connection() postpones); at request time / in tests it's a no-op. */
export async function buildTimeBailout(): Promise<void> {
  if (process.env.NEXT_PHASE === "phase-production-build") await connection();
}
import { z } from "zod";
import { LIMITS, publicBaseUrl } from "./config";
import { HttpError } from "./errors";
import { resolveSession, type Session } from "./auth";
import { ensureBoot } from "./boot";
import { resolveClientIp } from "./client-ip";

export type Ctx<P> = { params: Promise<P> };

export interface ApiOptions {
  /** require a valid session (default true) */
  auth?: boolean;
  /** public share endpoints: add no-store + noindex headers */
  public?: boolean;
  /** CSRF origin check on mutating methods: "strict" (default), "lenient" (allow null origin), false */
  csrf?: "strict" | "lenient" | false;
}

export interface ApiContext {
  session: Session | null;
}

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(data, { status, headers });
}

export function ok(): Response {
  return json({ ok: true });
}

function firstHeader(req: Request, name: string): string | null {
  const v = req.headers.get(name);
  return v ? v.split(",")[0].trim() : null;
}

/** Caddy is trusted: x-forwarded-proto/host/for describe the real client request. */
export function requestProto(req: Request): "http" | "https" {
  const p = firstHeader(req, "x-forwarded-proto");
  if (p === "https" || p === "http") return p;
  return new URL(req.url).protocol === "https:" ? "https" : "http";
}

export function requestHost(req: Request): string {
  return firstHeader(req, "x-forwarded-host") || req.headers.get("host") || new URL(req.url).host;
}

export function requestOrigin(req: Request): string {
  return `${requestProto(req)}://${requestHost(req)}`;
}

/** Visitor address for rate-limit keys (see client-ip.ts); "local" when none can be trusted (dev, tests). */
export function clientIp(req: Request): string {
  return resolveClientIp(req.headers) || "local";
}

export const isHttps = (req: Request) => requestProto(req) === "https";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function originAllowed(req: Request, lenient = false): boolean {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (!origin || origin === "null") {
    // Browsers always send Origin on cross-site POSTs; a missing Origin means a non-browser client holding the cookie.
    if (site === "cross-site") return false;
    if (!origin) return true;
    return lenient;
  }
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  try {
    if (o.origin === new URL(publicBaseUrl()).origin) return true;
  } catch {
    /* ignore bad PUBLIC_BASE_URL */
  }
  if (o.host === requestHost(req)) return true;
  if (LOCAL_HOSTS.has(o.hostname)) {
    const reqHostname = requestHost(req).replace(/:\d+$/, "");
    return process.env.NODE_ENV !== "production" || LOCAL_HOSTS.has(reqHostname);
  }
  return false;
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    return json({ error: e.message, code: e.code }, e.status, e.headers);
  }
  if (e instanceof z.ZodError) {
    const issue = e.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    return json({ error: `${where}${issue?.message ?? "Invalid input"}`, code: "validation_error" }, 400);
  }
  const err = e as Error;
  console.error("[waraq] unhandled error:", err?.stack?.split("\n").slice(0, 6).join("\n") ?? String(e));
  return json({ error: "Internal server error", code: "internal_error" }, 500);
}

function addPublicHeaders(res: Response): Response {
  try {
    res.headers.set("Cache-Control", "private, no-store");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    res.headers.set("Referrer-Policy", "no-referrer");
  } catch {
    /* immutable headers */
  }
  return res;
}

/** Full Better Auth session check (DB row, expiry, disabled user). */
export async function sessionFromRequest(req: Request): Promise<Session | null> {
  return (await resolveSession(req.headers))?.session ?? null;
}

function appendCookies(res: Response, cookies: string[]): Response {
  if (!cookies.length) return res;
  try {
    for (const c of cookies) res.headers.append("Set-Cookie", c);
    return res;
  } catch {
    const h = new Headers(res.headers);
    for (const c of cookies) h.append("Set-Cookie", c);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
}

export function api<P = Record<string, never>>(
  fn: (req: NextRequest, params: P, ctx: ApiContext) => Promise<Response>,
  opts: ApiOptions = {},
) {
  return async (req: NextRequest, ctx: Ctx<P>): Promise<Response> => {
    // Never run at build time: `next build` prerenders GET handlers, and anything past this point opens the DB at
    // DATA_DIR (the production volume when .env.local is present). Outside the try so the prerender bail-out
    // isn't turned into a 500 by errorResponse.
    await buildTimeBailout();
    let res: Response;
    try {
      ensureBoot();
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if (mutating && opts.csrf !== false && !originAllowed(req, opts.csrf === "lenient")) {
        throw new HttpError(403, "forbidden_origin", "Cross-origin request blocked");
      }
      let session: Session | null = null;
      let refresh: string[] = [];
      if (opts.auth !== false) {
        const r = await resolveSession(req.headers);
        if (!r) throw new HttpError(401, "unauthorized", "Not signed in");
        session = r.session;
        refresh = r.setCookies;
      }
      const params = (ctx?.params ? await ctx.params : {}) as P;
      res = await fn(req, params, { session });
      res = appendCookies(res, refresh);
    } catch (e) {
      res = errorResponse(e);
    }
    return opts.public ? addPublicHeaders(res) : defaultNoStore(res);
  };
}

/**
 * JSON API answers describe live state (a doc flips from processing to ready within a second) and must never be
 * reused from an HTTP cache, including the Android WebView's (no service worker there). Handlers that set their own
 * Cache-Control (images, exports) keep it.
 */
function defaultNoStore(res: Response): Response {
  try {
    if (!res.headers.has("Cache-Control") && (res.headers.get("Content-Type") ?? "").includes("json")) {
      res.headers.set("Cache-Control", "private, no-store");
    }
  } catch {
    /* immutable headers */
  }
  return res;
}

export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  const len = Number(req.headers.get("content-length") || "0");
  if (len > LIMITS.jsonBytes) throw new HttpError(413, "payload_too_large", "Request body too large");
  const text = await req.text();
  if (text.length > LIMITS.jsonBytes) throw new HttpError(413, "payload_too_large", "Request body too large");
  let data: unknown = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new HttpError(400, "invalid_json", "Body must be valid JSON");
    }
  }
  return schema.parse(data);
}

export function parseQuery<S extends z.ZodType>(req: NextRequest, schema: S): z.infer<S> {
  const obj: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    if (v !== "") obj[k] = v;
  });
  return schema.parse(obj);
}

/** Stream a file with optional single-range support. */
export async function serveFile(
  req: Request,
  filePath: string,
  opts: { contentType: string; disposition?: string; cacheControl?: string; extraHeaders?: Record<string, string> },
): Promise<Response> {
  let st: fs.Stats;
  try {
    st = await fsp.stat(filePath);
  } catch {
    throw new HttpError(404, "not_found", "File not found");
  }
  const size = st.size;
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType,
    "Accept-Ranges": "bytes",
    "Last-Modified": st.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
    ...(opts.cacheControl ? { "Cache-Control": opts.cacheControl } : {}),
    ...(opts.disposition ? { "Content-Disposition": opts.disposition } : {}),
    ...(opts.extraHeaders ?? {}),
  };
  const range = req.headers.get("range");
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range && size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2])) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(m[2]));
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["Content-Length"] = String(size === 0 ? 0 : end - start + 1);
  if (req.method === "HEAD" || size === 0) return new Response(null, { status, headers });
  const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers });
}

export function bytesResponse(body: Uint8Array, headers: Record<string, string>, status = 200): Response {
  return new Response(body as unknown as BodyInit, {
    status,
    headers: { "Content-Length": String(body.byteLength), "X-Content-Type-Options": "nosniff", ...headers },
  });
}
