import { api, json } from "@/lib/server/http";
import { revokeOtherSessions } from "@/lib/server/auth";

export const POST = api(async (_req, _p, { session }) => {
  const revoked = revokeOtherSessions(session!.userId, session!.id);
  return json({ revoked });
});
