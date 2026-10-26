import { api, json, ok, readJson } from "@/lib/server/http";
import { assertId } from "@/lib/server/ids";
import { getShareById, purgeShare, revokeShare, updateShare } from "@/lib/server/shares";
import { shareToApi } from "@/lib/server/share-model";
import { HttpError } from "@/lib/server/errors";
import { sharePatchBody } from "@/lib/server/validation";

export const GET = api<{ id: string }>(async (_req, { id }) => {
  const s = getShareById(assertId(id));
  if (!s) throw new HttpError(404, "not_found", "Share not found");
  return json(shareToApi(s));
});

/** `{expiresIn?, password?: string | null, allowDownload?}` → ShareLinkWithDoc. Empty/null password removes it. */
export const PATCH = api<{ id: string }>(async (req, { id }) => {
  const body = await readJson(req, sharePatchBody);
  const s = await updateShare(assertId(id), { ...body, password: body.password === "" ? null : body.password });
  return json(s);
});

/** Revoke; with `?purge=1` remove a revoked/expired link from the list (409 share_active otherwise). */
export const DELETE = api<{ id: string }>(async (req, { id }) => {
  const purge = req.nextUrl.searchParams.get("purge");
  if (purge === "1" || purge === "true") purgeShare(assertId(id));
  else revokeShare(assertId(id));
  return ok();
});
