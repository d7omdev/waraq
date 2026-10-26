import { api, json } from "@/lib/server/http";
import { ocrStatus } from "@/lib/server/ocr-maintenance";

export const GET = api(async () => json(ocrStatus(), 200, { "Cache-Control": "private, no-store" }));
