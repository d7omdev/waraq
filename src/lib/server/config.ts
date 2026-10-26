import path from "node:path";

/** Resolved lazily so tests can set DATA_DIR before first use. */
export function dataDir(): string {
  return path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || path.join(process.cwd(), ".data"));
}

export function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET || "";
  if (s.length < 32) throw new Error("SESSION_SECRET is missing or too short");
  return s;
}

const MB = 1024 * 1024;

export const LIMITS = {
  fileBytes: 60 * MB,
  requestBytes: 300 * MB,
  jsonBytes: 1 * MB,
  maxFilesPerRequest: 300,
  maxPagesPerDoc: 3000,
  imageMaxEdge: 3000,
  pageWidthPt: 595,
  thumbWidth: 360,
  imageWidth: 1600,
  exportDpi: 200,
  ocrTextMaxChars: 5_000_000,
};

export const SHARE_UNLOCK_TTL_MS = 12 * 3600 * 1000;
export const SETUP_RATE = { max: 10, windowMs: 15 * 60 * 1000 };
export const UNLOCK_RATE = { max: 20, windowMs: 15 * 60 * 1000 };
