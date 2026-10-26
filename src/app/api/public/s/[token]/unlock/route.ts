import { NextResponse } from "next/server";
import { api, clientIp, isHttps, readJson } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { hit, resetKey } from "@/lib/server/ratelimit";
import { UNLOCK_RATE } from "@/lib/server/config";
import { unlockBody } from "@/lib/server/validation";
import { checkSharePassword, makeUnlockCookie, resolveShare, unlockCookieName } from "@/lib/server/shares";

export const POST = api<{ token: string }>(
  async (req, { token }) => {
    const { share } = resolveShare(token);
    const key = `unlock:${clientIp(req)}:${share.id}`;
    const retry = hit(key, UNLOCK_RATE.max, UNLOCK_RATE.windowMs);
    if (retry) throw new HttpError(429, "rate_limited", "Too many attempts, try again later", { "Retry-After": String(retry) });
    const { password } = await readJson(req, unlockBody);
    if (!(await checkSharePassword(share, password))) {
      throw new HttpError(401, "invalid_password", "Wrong password");
    }
    resetKey(key);
    const res = NextResponse.json({ ok: true });
    if (share.password_hash) {
      const c = makeUnlockCookie(share.id, Date.now(), share.password_hash);
      res.cookies.set(unlockCookieName(share.id), c.value, {
        httpOnly: true,
        sameSite: "lax",
        secure: isHttps(req),
        path: "/",
        maxAge: c.maxAge,
      });
    }
    return res;
  },
  { auth: false, public: true },
);
