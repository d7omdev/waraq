import { toNextJsHandler } from "better-auth/next-js";
import { authReady } from "@/lib/server/auth";
import { ensureBoot } from "@/lib/server/boot";
import { buildTimeBailout } from "@/lib/server/http";

// Better Auth: /sign-in/username (owner password), /sign-in/social + /callback/google (only for a Google account the
// owner already linked), /link-social, /unlink-account, /list-accounts, /update-user, /change-password, /sign-out,
// /get-session. Account creation and email-based flows are refused here, before Better Auth sees them: the one owner
// is created by /setup, and a forgotten password is reset on the host (npm run reset-password).
const BLOCKED = [/^\/sign-up\//, /^\/(request-password-reset|forget-password|reset-password)/, /^\/(change-email|delete-user|send-verification-email|verify-email)/];

async function handler(req: Request): Promise<Response> {
  await buildTimeBailout(); // never at build time (opens the DB)
  const path = new URL(req.url).pathname.replace(/^\/api\/auth/, "");
  if (BLOCKED.some((re) => re.test(path))) return Response.json({ error: "Not available on this server", code: "setup_closed" }, { status: 403 });
  ensureBoot();
  const auth = await authReady();
  const h = toNextJsHandler(auth);
  return req.method === "GET" ? h.GET(req) : h.POST(req);
}

export const GET = handler;
export const POST = handler;
