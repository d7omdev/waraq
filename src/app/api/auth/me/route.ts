import type { Me } from "@/lib/types";
import { getDb } from "@/lib/server/db";
import { api, json } from "@/lib/server/http";
import { DRIVE_KEYS, getSetting, isDriveConnected } from "@/lib/server/drive-store";

/** The signed-in owner, local storage use and the optional Drive mirror state. */
export const GET = api(async (_req, _p, { session }) => {
  const u = session!.user;
  const connected = isDriveConnected();
  const usedBytes = (getDb().prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM documents").get() as { n: number }).n;
  return json(
    {
      id: u.id,
      username: u.username ?? "",
      name: u.name,
      email: u.email,
      image: u.image,
      storage: { usedBytes },
      drive: {
        connected,
        needsReconnect: !connected && getSetting(DRIVE_KEYS.needsReconnect) === "1",
        email: getSetting(DRIVE_KEYS.email),
      },
    } satisfies Me,
    200,
    { "Cache-Control": "private, no-store" },
  );
});
