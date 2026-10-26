import { api, json, parseQuery } from "@/lib/server/http";
import { listDocs } from "@/lib/server/docs";
import { listQuery } from "@/lib/server/validation";
import { createDocFromRequest } from "@/lib/server/actions";
import { withDriveSync } from "@/lib/server/drive";

export const GET = api(async (req) => {
  const q = parseQuery(req, listQuery);
  const r = listDocs(q);
  return json({ ...r, items: withDriveSync(r.items) });
});

export const POST = api(async (req) => {
  const d = await createDocFromRequest(req);
  return json(d, 201);
});
