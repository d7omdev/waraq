// Pure helpers for the proxy auth gate (no DB / Next imports).

const PUBLIC_EXACT = new Set([
  "/login",
  "/setup",
  "/offline",
  "/manifest.webmanifest",
  "/sw.js",
  "/favicon.ico",
  "/robots.txt",
  "/api/version",
  "/api/health",
  "/api/setup",
]);
// /api/auth/* = Better Auth (each endpoint enforces its own session); /s/ + /api/public/ = share links by token
const PUBLIC_PREFIX = ["/s/", "/api/auth/", "/icons/", "/vendor/", "/api/public/", "/_next/"];
// root-level static files from public/ (icons, apple-touch-icon, workbox chunks, …)
const ROOT_ASSET = /^\/[^/]+\.(?:png|ico|svg|webmanifest|txt|xml|js|map|webp|jpg|jpeg|json|woff2?)$/i;

export function isPublicPath(p: string): boolean {
  return PUBLIC_EXACT.has(p) || PUBLIC_PREFIX.some((x) => p.startsWith(x)) || ROOT_ASSET.test(p);
}

/** Better Auth session cookie names (prefix "waraq"; `__Secure-` variant on https). */
export const SESSION_TOKEN_COOKIES = ["__Secure-waraq.session_token", "waraq.session_token"];

/** Optimistic: a Better Auth session cookie of the right shape (`<token>.<signature>`) is present. */
export function looksLikeSessionCookie(value: string | undefined): boolean {
  if (!value) return false;
  let v = value;
  try {
    v = decodeURIComponent(value);
  } catch {
    return false;
  }
  return v.length > 20 && v.length < 512 && v.includes(".");
}
