import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";

// One id per build: written to .next/BUILD_ID (served by GET /api/version) and inlined into the client bundle as
// NEXT_PUBLIC_WARAQ_BUILD_ID, so the PWA can tell when the server runs a newer release than the page it loaded.
function makeBuildId(): string {
  if (process.env.WARAQ_BUILD_ID) return process.env.WARAQ_BUILD_ID;
  // A per-process timestamp would change on every dev config reload and loop the update prompt.
  if (process.env.NODE_ENV !== "production") return "dev";
  let sha = "nogit";
  try {
    sha = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || sha;
  } catch {
    /* release dirs may not carry .git */
  }
  return `${sha}-${Date.now().toString(36)}`;
}
const buildId = makeBuildId();

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  generateBuildId: async () => buildId,
  env: { NEXT_PUBLIC_WARAQ_BUILD_ID: buildId },
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["better-sqlite3", "sharp"],
  // Scanner assets. public/ files get "max-age=0" by default, so clients would re-validate OpenCV on every load.
  // Versioned names / ?v=<build> make a year-long immutable cache safe.
  async headers() {
    const year = [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), payment=()" },
        ],
      },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
      { source: "/vendor/opencv-:version.:ext(js|wasm)", headers: year },
      { source: "/scan-worker.js", has: [{ type: "query", key: "v" }], headers: year },
    ];
  },
  experimental: {
    // proxy.ts buffers request bodies; uploads are capped at 300 MB per request in the route handlers
    proxyClientMaxBodySize: "310mb",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
