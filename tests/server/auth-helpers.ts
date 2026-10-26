// Real Better Auth sessions for route tests: either a real password sign-in (signIn) or a session minted the way
// Better Auth stores it after a sign-in (mintSession), which is faster for tests that only need a cookie.
import { NextRequest } from "next/server";
import { serializeSignedCookie } from "better-call";
import { authReady } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import * as authRoute from "@/app/api/auth/[...all]/route";

export const BASE = "https://scan.example.test";

/** "name=value; name2=value2" from a response's Set-Cookie headers (ignores deletions). */
export function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((kv) => !/=$/.test(kv))
    .join("; ");
}

export async function authCall(path: string, body: unknown, cookie?: string, extra: Record<string, string> = {}): Promise<Response> {
  await authReady();
  const headers = new Headers({ "content-type": "application/json", origin: BASE, ...extra });
  if (cookie) headers.set("cookie", cookie);
  return authRoute.POST(new NextRequest(`${BASE}/api/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

export async function authGet(path: string, cookie?: string): Promise<Response> {
  await authReady();
  const headers = new Headers({ origin: BASE });
  if (cookie) headers.set("cookie", cookie);
  return authRoute.GET(new NextRequest(`${BASE}/api/auth${path}`, { method: "GET", headers }));
}

/** A session for `userId`, exactly as Better Auth stores and signs it after a sign-in. */
export async function mintSession(userId: string, userAgent = "vitest"): Promise<string> {
  const auth = await authReady();
  const ctx = await auth.$context;
  const s = await ctx.internalAdapter.createSession(userId, false, { userAgent });
  if (!s) throw new Error("session refused (disabled user?)");
  const cookie = await serializeSignedCookie(ctx.authCookies.sessionToken.name, s.token, ctx.secret);
  return cookie.split(";")[0];
}

/** The owner's local password sign-in through the real Better Auth route. */
export async function signIn(username: string, password: string, userAgent = "vitest"): Promise<string> {
  await authReady();
  const headers = new Headers({ "content-type": "application/json", origin: BASE, "user-agent": userAgent });
  const r = await authRoute.POST(
    new NextRequest(`${BASE}/api/auth/sign-in/username`, { method: "POST", headers, body: JSON.stringify({ username, password }) }),
  );
  if (r.status !== 200) throw new Error(`sign-in failed ${r.status}: ${await r.text()}`);
  return cookiesFrom(r);
}

export async function signInOwner(ua?: string) {
  await authReady();
  const owner = getDb().prepare(`SELECT id FROM "user" LIMIT 1`).get() as { id: string } | undefined;
  if (!owner) throw new Error("owner not configured");
  return mintSession(owner.id, ua);
}
