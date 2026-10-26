import { api, json, ok, readJson } from "@/lib/server/http";
import { deleteFolder, getFolder, updateFolder } from "@/lib/server/folders";
import { folderPatchBody } from "@/lib/server/validation";

type P = { id: string };

export const GET = api<P>(async (_req, { id }) => json(getFolder(id)));

export const PATCH = api<P>(async (req, { id }) => {
  const body = await readJson(req, folderPatchBody);
  const f = updateFolder(id, body);
  return json(f);
});

export const DELETE = api<P>(async (_req, { id }) => {
  deleteFolder(id);
  return ok();
});
