import { hkdfSync } from "node:crypto";

/**
 * Better Auth secret: BETTER_AUTH_SECRET, or (so an upgrade without the new env var keeps working) a key derived
 * from SESSION_SECRET with HKDF. Changing it signs everyone out.
 */
export function authSecret(): string {
  const explicit = process.env.BETTER_AUTH_SECRET || "";
  if (explicit.length >= 32) return explicit;
  const base = process.env.SESSION_SECRET || "";
  if (base.length < 32) throw new Error("BETTER_AUTH_SECRET (or SESSION_SECRET) is missing or shorter than 32 characters");
  return Buffer.from(hkdfSync("sha256", base, "waraq-better-auth-salt", "waraq better-auth secret v1", 32)).toString("base64url");
}
