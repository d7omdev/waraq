import { api, ok } from "@/lib/server/http";
import { requireReadyDoc } from "@/lib/server/docs";
import { enqueueOcr } from "@/lib/server/jobs";

/** Manual re-run: Tesseract --redo-ocr, then a fresh Drive OCR pass when enabled. */
export const POST = api<{ id: string }>(async (_req, { id }) => {
  requireReadyDoc(id);
  enqueueOcr(id, { redo: true, force: true });
  return ok();
});
