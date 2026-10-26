import { describe, expect, it } from "vitest";
import { resolveClientIp } from "@/lib/server/client-ip";

const h = (o: Record<string, string>) => new Headers(o);

describe("client IP behind a reverse proxy", () => {
  it("takes the rightmost untrusted X-Forwarded-For hop", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "198.51.100.7, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.9, 127.0.0.1" }))).toBe("203.0.113.9");
  });
  it("ignores CF-Connecting-IP unless Cloudflare is trusted", () => {
    expect(resolveClientIp(h({ "cf-connecting-ip": "198.51.100.7" }))).toBeNull();
  });
  it("returns null without a usable header", () => {
    expect(resolveClientIp(h({}))).toBeNull();
    expect(resolveClientIp(h({ "x-forwarded-for": "not-an-ip" }))).toBeNull();
  });
});
