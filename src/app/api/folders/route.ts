import { api, json, readJson } from "@/lib/server/http";
import { createFolder, listFolders } from "@/lib/server/folders";
import { folderCreateBody } from "@/lib/server/validation";

export const GET = api(async () => json(listFolders()));

export const POST = api(async (req) => {
  const body = await readJson(req, folderCreateBody);
  const f = createFolder(body);
  return json(f, 201);
});
