import { api, clientIp, json, readJson } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { hit } from "@/lib/server/ratelimit";
import { SETUP_RATE } from "@/lib/server/config";
import { createOwner, setupInput, setupOpen } from "@/lib/server/setup";

// First-run setup: creates the single owner once. Afterwards it answers 409 forever (see createOwner).
export const GET = api(async () => json({ open: await setupOpen() }), { auth: false });
export const POST = api(async (request) => {
  const retry = hit(`setup:${clientIp(request)}`, SETUP_RATE.max, SETUP_RATE.windowMs);
  if (retry) throw new HttpError(429, "rate_limited", "Too many attempts, try again later", { "Retry-After": String(retry) });
  await createOwner(await readJson(request, setupInput));
  return json({ ok: true }, 201);
}, { auth: false });
