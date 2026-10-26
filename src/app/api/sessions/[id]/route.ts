import { NextResponse } from "next/server";
import { api } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { revokeSessionByPublicId, sessionCookieNames } from "@/lib/server/auth";

/** Sign one of your devices out. Revoking the current session also clears its cookies (same as sign-out). */
export const DELETE = api<{ id: string }>(async (_req, { id }, { session }) => {
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) throw new HttpError(404, "not_found", "Session not found");
  const r = revokeSessionByPublicId(session!.userId, id);
  if (!r.found) throw new HttpError(404, "not_found", "Session not found");
  const current = r.rawId === session!.id;
  const res = NextResponse.json({ ok: true, current });
  if (current) for (const n of sessionCookieNames()) res.cookies.set(n, "", { path: "/", maxAge: 0 });
  return res;
});
