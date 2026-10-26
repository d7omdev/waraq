import { api, json, readJson } from "@/lib/server/http";
import { getDriveStatus, setAutoSync } from "@/lib/server/drive";
import { driveSettingsBody } from "@/lib/server/drive-validation";

export const PATCH = api(async (req) => {
  const body = await readJson(req, driveSettingsBody);
  if (body.autoSync !== undefined) setAutoSync(body.autoSync);
  return json(getDriveStatus());
});
