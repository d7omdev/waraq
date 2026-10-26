import { getDb } from "./db";
import { startOcrWorker } from "./ocr";
import { startDriveOcrWorker } from "./ocr-drive";
import { startBuildWorker } from "./ingest";
import { pruneFinishedJobs } from "./jobs";
import { loadVersionInfo } from "./version";
import { startDriveWorker } from "./drive-sync";
import { purgeTrash } from "./docs";
import { purgeExpiredSessions } from "./auth";
import { cleanTmp } from "./storage";
import { authReady } from "./auth";

const g = globalThis as unknown as { __waraqBooted?: boolean };

async function housekeeping() {
  try {
    const n = await purgeTrash();
    if (n) console.log(`[waraq] purged ${n} trashed document(s)`);
    purgeExpiredSessions();
    pruneFinishedJobs();
    await cleanTmp();
  } catch (e) {
    console.error("[waraq] housekeeping failed:", (e as Error).message);
  }
}

/** Idempotent process start: DB + migrations, OCR worker (re-queues interrupted jobs), trash purge timer. */
export function ensureBoot(): void {
  getDb();
  if (g.__waraqBooted) return;
  g.__waraqBooted = true;
  bootWorkers();
}

function bootWorkers(): void {
  loadVersionInfo();
  // Better Auth tables + owner seed (idempotent); request paths await the same promise
  authReady().catch((e) => console.error("[waraq] auth setup failed:", (e as Error).message));
  startBuildWorker();
  startOcrWorker();
  try {
    startDriveOcrWorker();
  } catch (e) {
    console.error("[waraq] drive OCR worker failed to start:", (e as Error).message);
  }
  try {
    startDriveWorker();
  } catch (e) {
    console.error("[waraq] drive worker failed to start:", (e as Error).message);
  }
  void housekeeping();
  setInterval(() => void housekeeping(), 6 * 3600 * 1000).unref();
}
