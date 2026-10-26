import type { NextRequest } from "next/server";
import { HttpError } from "./errors";
import type { ShareRow } from "./share-model";
import { unlockCookieName, verifyUnlockCookie } from "./shares";

/** Throws 403 password_required when the share is protected and this viewer hasn't unlocked it. */
export function assertUnlocked(req: NextRequest, share: ShareRow): void {
  if (!share.password_hash) return;
  if (verifyUnlockCookie(share.id, req.cookies.get(unlockCookieName(share.id))?.value, Date.now(), share.password_hash)) return;
  throw new HttpError(403, "password_required", "This link is password-protected");
}
