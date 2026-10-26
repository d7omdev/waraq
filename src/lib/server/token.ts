// Pure HMAC helpers (node:crypto only), safe to import from proxy.ts.
import { createHmac, timingSafeEqual } from "node:crypto";

function mac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Returns `${payload}.${hmac}`. Payload must not contain characters outside [A-Za-z0-9_.:-]. */
export function signValue(payload: string, secret: string, context = "session"): string {
  return `${payload}.${mac(`${context}|${payload}`, secret)}`;
}

/** Verifies a value created by signValue; returns the payload or null. */
export function verifyValue(value: string | undefined | null, secret: string, context = "session"): string | null {
  if (!value || value.length > 512) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = mac(`${context}|${payload}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return payload;
}
