import { api, json, readJson } from "@/lib/server/http";
import { getDriveStatus, resetDriveConfig, setDriveConfig } from "@/lib/server/drive";
// The OAuth client is app-wide: only the owner may set or reset it.
import { driveConfigBody } from "@/lib/server/drive-validation";

export const POST = api(async (req) => {
  const body = await readJson(req, driveConfigBody);
  setDriveConfig(body.clientId, body.clientSecret);
  return json(getDriveStatus());
});

export const DELETE = api(async () => {
  await resetDriveConfig();
  return json(getDriveStatus());
});
