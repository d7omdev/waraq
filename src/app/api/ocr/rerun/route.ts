import { api, json, readJson } from "@/lib/server/http";
import { rerunOcr } from "@/lib/server/ocr-maintenance";
import { ocrRerunBody } from "@/lib/server/validation";

export const POST = api(async (req) => {
  const body = await readJson(req, ocrRerunBody);
  const r = rerunOcr(body);
  return json(r);
});
