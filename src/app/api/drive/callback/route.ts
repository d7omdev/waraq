import { NextResponse } from "next/server";
import { api, isHttps } from "@/lib/server/http";
import { publicBaseUrl } from "@/lib/server/config";
import { completeConnect, connectReturnPath, DRIVE_STATE_COOKIE, verifyConnectState } from "@/lib/server/drive";

// Google redirects the browser here (top-level GET, so the SameSite=Lax session cookie is sent).
// Requires the session (api wrapper) AND a single-use state bound to that session + this browser's cookie.
export const GET = api(async (req, _p, { session }) => {
  const sp = req.nextUrl.searchParams;
  const back = connectReturnPath();
  const done = (result: "connected" | "error", reason?: string) => {
    const u = new URL(back, publicBaseUrl());
    u.searchParams.set("drive", result);
    if (reason) u.searchParams.set("reason", reason);
    const res = NextResponse.redirect(u, 303);
    res.cookies.set(DRIVE_STATE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: isHttps(req), path: "/api/drive", maxAge: 0 });
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  };

  if (!verifyConnectState(sp.get("state"), req.cookies.get(DRIVE_STATE_COOKIE)?.value, session!.id)) {
    return done("error", "invalid_state");
  }
  const error = sp.get("error");
  if (error) return done("error", error === "access_denied" ? "access_denied" : "google_error");
  const code = sp.get("code");
  if (!code || code.length > 2048) return done("error", "missing_code");
  try {
    await completeConnect(code);
  } catch (e) {
    console.error("[waraq] drive connect failed:", (e as Error).message);
    return done("error", "exchange_failed");
  }
  return done("connected");
});
