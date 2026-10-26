import { api, json, readJson } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { requestSync } from "@/lib/server/drive";
import { driveSyncBody } from "@/lib/server/drive-validation";

export const POST = api(async (req) => {
  const body = await readJson(req, driveSyncBody);
  if (!body.all && !body.ids?.length) throw new HttpError(400, "validation_error", "Pass ids or all: true");
  const r = requestSync(body);
  return json(r);
});
