import { api, json } from "@/lib/server/http";
import { getDriveStatus } from "@/lib/server/drive";

export const GET = api(async () => json(getDriveStatus(), 200, { "Cache-Control": "private, no-store" }));
