import { NextResponse } from "next/server";
import { api, isHttps } from "@/lib/server/http";
import { beginConnect, DRIVE_STATE_COOKIE } from "@/lib/server/drive";

// Top-level navigation from the settings page: 302 to Google's consent screen.
export const GET = api(async (req, _p, { session }) => {
  const { url, state } = beginConnect(session!.id, req.nextUrl.searchParams.get("return"));
  const res = NextResponse.redirect(url, 302);
  res.cookies.set(DRIVE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(req),
    path: "/api/drive",
    maxAge: 600,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
});
