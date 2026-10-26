import { api } from "@/lib/server/http";
import { parseIndex } from "@/lib/server/ids";
import { requireDoc } from "@/lib/server/docs";
import { renderResponse } from "@/lib/server/actions";

export const GET = api<{ id: string; index: string }>(async (req, p) => {
  const index = parseIndex(p.index);
  const row = requireDoc(p.id, { allowTrashed: true });
  return renderResponse(req, row, index, "image", { cache: "private" });
});
