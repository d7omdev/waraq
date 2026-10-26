// Build identity of the running release, read once at startup (a deploy swaps the release dir and restarts).
import fs from "node:fs";
import path from "node:path";
import type { VersionInfo } from "@/lib/types";

const g = globalThis as unknown as { __waraqVersion?: VersionInfo };

/** `.next/BUILD_ID` of the server's working directory; builtAt = its mtime. Dev servers have no BUILD_ID. */
export function readVersionInfo(dir = process.cwd()): VersionInfo {
  const file = path.join(dir, ".next", "BUILD_ID");
  try {
    const buildId = fs.readFileSync(file, "utf8").trim();
    if (buildId) return { buildId, builtAt: fs.statSync(file).mtime.toISOString() };
  } catch {
    /* fall through */
  }
  return { buildId: process.env.NEXT_PUBLIC_WARAQ_BUILD_ID || "development", builtAt: new Date().toISOString() }; // dev: process start
}

export function loadVersionInfo(): VersionInfo {
  return (g.__waraqVersion ??= readVersionInfo());
}

/** Tests only. */
export function resetVersionInfo(): void {
  g.__waraqVersion = undefined;
}
