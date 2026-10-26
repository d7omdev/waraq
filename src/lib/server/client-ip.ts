// Real client IP behind a reverse proxy (Caddy, nginx, Traefik, Cloudflare...). The proxy appends the address it saw to
// X-Forwarded-For ("client, proxy1, ..."), so XFF is read right to left, skipping hops we trust. Only loopback is
// trusted by default; add your proxy networks with TRUSTED_PROXY_CIDRS (comma separated CIDRs, or the keyword
// "cloudflare" for Cloudflare's published ranges, which also enables CF-Connecting-IP).
// Used by Better Auth's rate limiter (advanced.ipAddress) and by our own limiter (clientIp in http.ts).
// Without a proxy in front, X-Forwarded-For can be forged by clients: put Waraq behind a reverse proxy.
import { isIP } from "node:net";

/** https://www.cloudflare.com/ips/ */
const CLOUDFLARE = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32",
  "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];

function configured(): { cidrs: string[]; cloudflare: boolean } {
  const items = (process.env.TRUSTED_PROXY_CIDRS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const cloudflare = items.some((s) => s.toLowerCase() === "cloudflare");
  const cidrs = items.filter((s) => s.toLowerCase() !== "cloudflare" && /^[0-9a-fA-F:.]+\/\d{1,3}$/.test(s));
  return { cidrs: [...(cloudflare ? CLOUDFLARE : []), ...cidrs], cloudflare };
}

const conf = configured();
export const TRUSTED_PROXIES = [...conf.cidrs, "127.0.0.0/8", "::1/128"];

/** Header order: CF-Connecting-IP (only with "cloudflare" trusted), then X-Forwarded-For. */
export const CLIENT_IP_HEADERS = conf.cloudflare ? ["cf-connecting-ip", "x-forwarded-for"] : ["x-forwarded-for"];

/** Better Auth `advanced.ipAddress`. */
export const AUTH_IP_OPTIONS = { ipAddressHeaders: CLIENT_IP_HEADERS, trustedProxies: TRUSTED_PROXIES };

function toBytes(ip: string): number[] | null {
  const v = isIP(ip);
  if (v === 4) return ip.split(".").map(Number);
  if (v !== 6) return null;
  const s = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return mapped[1].split(".").map(Number); // IPv4-mapped: compare as IPv4
  if (s.includes(".")) return null; // other embedded-IPv4 forms: not used by proxies here
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest ? rest.split(":") : [];
  const mid = rest !== undefined ? Array(8 - h.length - r.length).fill("0") : [];
  const all = [...h, ...mid, ...r];
  if (all.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of all) {
    const n = parseInt(g || "0", 16);
    bytes.push((n >> 8) & 255, n & 255);
  }
  return bytes;
}

function inCidr(ip: number[], cidr: string): boolean {
  const [net, bitsS] = cidr.split("/");
  const nb = toBytes(net);
  if (!nb || nb.length !== ip.length) return false;
  let bits = Number(bitsS);
  for (let i = 0; i < nb.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 255 : (255 << (8 - bits)) & 255;
    if ((nb[i] & mask) !== (ip[i] & mask)) return false;
  }
  return true;
}

export function isTrustedProxy(ip: string): boolean {
  const b = toBytes(ip);
  return !!b && TRUSTED_PROXIES.some((c) => inCidr(b, c));
}

/** Client address, or null when no trustworthy one is present. */
export function resolveClientIp(headers: Headers): string | null {
  const cf = conf.cloudflare ? headers.get("cf-connecting-ip")?.trim() : undefined;
  if (cf && isIP(cf) && !isTrustedProxy(cf)) return cf;
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isIP(hops[i])) return null;
      if (!isTrustedProxy(hops[i])) return hops[i];
    }
  }
  return null;
}
