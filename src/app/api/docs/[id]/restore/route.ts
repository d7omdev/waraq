import { api, json } from "@/lib/server/http";
import { restoreDoc } from "@/lib/server/docs";

export const POST = api<{ id: string }>(async (_req, { id }) => {
  const d = restoreDoc(id);
  return json(d);
});
