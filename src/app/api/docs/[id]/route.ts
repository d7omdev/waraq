import { api, json, ok, readJson } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { getDocDetail, hardDeleteDoc, requireDoc, trashDoc, updateMeta } from "@/lib/server/docs";
import { docPatchBody } from "@/lib/server/validation";
import { withDriveSync } from "@/lib/server/drive";

type P = { id: string };

export const GET = api<P>(async (_req, { id }) => {
  requireDoc(id, { allowTrashed: true });
  return json(withDriveSync([getDocDetail(id)])[0]);
});

export const PATCH = api<P>(async (req, { id }) => {
  const body = await readJson(req, docPatchBody);
  requireDoc(id, { allowTrashed: true });
  return json(updateMeta(id, body));
});

export const DELETE = api<P>(async (req, { id }) => {
  const row = requireDoc(id, { allowTrashed: true });
  const permanent = req.nextUrl.searchParams.get("permanent");
  if (permanent === "1" || permanent === "true") {
    if (!row.trashed_at) throw new HttpError(409, "not_in_trash", "Move the document to the trash first");
    await hardDeleteDoc(id);
    return ok();
  }
  trashDoc(id);
  return ok();
});
