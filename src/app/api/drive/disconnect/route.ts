import { api, json } from "@/lib/server/http";
import { disconnectDrive, getDriveStatus } from "@/lib/server/drive";

export const POST = api(async () => {
  await disconnectDrive();
  return json(getDriveStatus());
});
