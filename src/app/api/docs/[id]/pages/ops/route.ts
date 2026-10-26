import { api, json, readJson } from "@/lib/server/http";
import { getDocDetail, mutateContent } from "@/lib/server/docs";
import { applyPageOps } from "@/lib/server/pdf";
import { opsBody } from "@/lib/server/validation";
import type { PageOp } from "@/lib/types";

export const POST = api<{ id: string }>(async (req, { id }) => {
  const body = await readJson(req, opsBody);
  await mutateContent(id, (cur) => applyPageOps(cur, body.ops as PageOp[]));
  return json(getDocDetail(id));
});
