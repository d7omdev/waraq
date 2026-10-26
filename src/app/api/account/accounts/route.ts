import { api, json } from "@/lib/server/http";
import { googleCredentials } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { toIso } from "@/lib/server/auth";
import type { LinkedAccount } from "@/lib/types";

export const GET = api(async (_req, _p, { session }) => {
  const rows = getDb().prepare(
    `SELECT id, "providerId", "accountId", "createdAt" FROM account WHERE "userId" = ? ORDER BY "createdAt"`,
  ).all(session!.userId) as { id: string; providerId: string; accountId: string; createdAt: unknown }[];
  const accounts: LinkedAccount[] = rows.map((row) => ({
    id: row.id,
    providerId: row.providerId,
    accountId: row.accountId,
    email: null,
    createdAt: toIso(row.createdAt),
  }));
  return json({ accounts, googleAvailable: !!googleCredentials() }, 200, { "Cache-Control": "private, no-store" });
});
