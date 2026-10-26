import { api, json, readJson } from "@/lib/server/http";
import { requireDoc } from "@/lib/server/docs";
import { listShares } from "@/lib/server/share-model";
import { createShare } from "@/lib/server/shares";
import { shareCreateBody } from "@/lib/server/validation";

export const GET = api<{ id: string }>(async (_req, { id }) => {
  requireDoc(id, { allowTrashed: true });
  return json(listShares(id));
});

export const POST = api<{ id: string }>(async (req, { id }) => {
  const body = await readJson(req, shareCreateBody);
  requireDoc(id); // live (not trashed) documents only
  const s = await createShare(id, { ...body, password: body.password || null });
  return json(s, 201);
});
