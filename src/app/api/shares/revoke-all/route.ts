import { api, json, readJson } from "@/lib/server/http";
import { assertId } from "@/lib/server/ids";
import { revokeAllShares } from "@/lib/server/shares";
import { revokeAllBody } from "@/lib/server/validation";

export const POST = api(async (req) => {
  const body = await readJson(req, revokeAllBody);
  const revoked = revokeAllShares(body.docId ? assertId(body.docId) : undefined);
  return json({ revoked });
});
