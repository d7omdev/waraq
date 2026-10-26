import { NextResponse, type NextRequest } from "next/server";
import { isPublicPath, looksLikeSessionCookie, SESSION_TOKEN_COOKIES } from "@/lib/server/gate";

// Optimistic auth gate: only checks that a Better Auth session cookie is present (no DB access here).
// Every API route handler re-validates the session against the database.

function first(v: string | null): string | null {
  return v ? v.split(",")[0].trim() : null;
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (isPublicPath(path)) return NextResponse.next();

  if (SESSION_TOKEN_COOKIES.some((n) => looksLikeSessionCookie(req.cookies.get(n)?.value))) return NextResponse.next();

  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in", code: "unauthorized" }, { status: 401 });
  }
  const proto = first(req.headers.get("x-forwarded-proto")) || req.nextUrl.protocol.replace(":", "");
  const host = first(req.headers.get("x-forwarded-host")) || req.headers.get("host") || req.nextUrl.host;
  const url = new URL("/login", `${proto}://${host}`);
  url.searchParams.set("next", `${path}${req.nextUrl.search}`);
  return NextResponse.redirect(url, req.method === "GET" || req.method === "HEAD" ? 307 : 303);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
