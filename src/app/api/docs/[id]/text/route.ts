import { api, json } from "@/lib/server/http";
import { requireDoc } from "@/lib/server/docs";

export const GET = api<{ id: string }>(async (_req, { id }) => {
  const row = requireDoc(id, { allowTrashed: true });
  return json({ text: row.ocr_text ?? "" });
});
