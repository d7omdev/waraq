// AES-256-GCM sealing for Drive secrets at rest (client secret, refresh token).
// Key = HKDF-SHA256(SESSION_SECRET). Rotating SESSION_SECRET makes sealed values unreadable (treated as absent).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { sessionSecret } from "./config";

const PREFIX = "v1:";

function key(): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret(), "waraq-drive-salt", "waraq drive secrets v1", 32));
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

/** Returns the plaintext, or null if the value is malformed, tampered with or sealed under another key. */
export function unseal(sealed: string | null | undefined): string | null {
  if (!sealed || !sealed.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(sealed.slice(PREFIX.length), "base64url");
    if (raw.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
