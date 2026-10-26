#!/usr/bin/env node
// Bundles the host CLI (scripts/ops.ts, scripts/reset-password.mjs) into dist/*.mjs so they run with plain `node`
// where tsx and the source tree are not installed (the Docker runtime image). better-sqlite3 stays external: it is a
// native module that the Next standalone output already ships.
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/ops.ts", "scripts/reset-password.mjs"],
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3"],
  banner: { js: "import { createRequire as __waraqCreateRequire } from 'node:module'; const require = __waraqCreateRequire(import.meta.url);" },
  tsconfig: "tsconfig.json",
  logLevel: "warning",
});
console.log("Built dist/ops.mjs and dist/reset-password.mjs");
