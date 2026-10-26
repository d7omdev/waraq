import { api, json, parseQuery } from "@/lib/server/http";
import { listAllShares } from "@/lib/server/shares";
import { sharesListQuery } from "@/lib/server/validation";

export const GET = api(async (req) => {
  const { status } = parseQuery(req, sharesListQuery);
  return json(listAllShares(status), 200, { "Cache-Control": "private, no-store" });
});
