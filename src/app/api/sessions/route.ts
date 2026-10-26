import { api, json } from "@/lib/server/http";
import { listSessions } from "@/lib/server/auth";

export const GET = api(async (_req, _p, { session }) =>
  json(listSessions(session!.userId, session!.id), 200, { "Cache-Control": "private, no-store" }),
);
