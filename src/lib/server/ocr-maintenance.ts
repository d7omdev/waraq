import type { OcrStatusInfo } from "@/lib/types";
import { getDb } from "./db";
import { enqueueOcr } from "./jobs";
import { isDriveConnected } from "./drive-store";

/** Re-run OCR (Tesseract `--redo-ocr`, then a fresh Drive pass) for the given or all live, built documents. */
export function rerunOcr(input: { ids?: string[]; all?: boolean }): { queued: number } {
  const db = getDb();
  let ids: string[];
  if (input.all) {
    ids = (
      db.prepare("SELECT id FROM documents WHERE trashed_at IS NULL AND status = 'ready' ORDER BY updated_at DESC").all() as {
        id: string;
      }[]
    ).map((r) => r.id);
  } else {
    const ok = db.prepare("SELECT 1 FROM documents WHERE id = ? AND trashed_at IS NULL AND status = 'ready'");
    ids = [...new Set(input.ids ?? [])].filter((id) => ok.get(id));
  }
  db.transaction(() => ids.forEach((id) => enqueueOcr(id, { redo: true, force: true })))();
  return { queued: ids.length };
}

export function ocrStatus(): OcrStatusInfo {
  const db = getDb();
  const pending = (
    db.prepare("SELECT COUNT(DISTINCT doc_id) AS n FROM jobs WHERE kind IN ('ocr','ocr_drive') AND status IN ('queued','running')").get() as {
      n: number;
    }
  ).n;
  const running = db
    .prepare(
      `SELECT j.doc_id AS docId, d.title FROM jobs j JOIN documents d ON d.id = j.doc_id
       WHERE j.kind IN ('ocr','ocr_drive') AND j.status = 'running' ORDER BY j.kind = 'ocr' DESC, j.id LIMIT 1`,
    )
    .get() as { docId: string; title: string } | undefined;
  return { pending, running: running ?? null, engineAvailable: { drive: isDriveConnected(), tesseract: true } };
}
