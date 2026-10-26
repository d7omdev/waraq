import { api, json } from "@/lib/server/http";
import { copyOcrPages, createDocument, getDocDetail, requireReadyDoc } from "@/lib/server/docs";
import { readDocBytes } from "@/lib/server/doc-storage";
import { enqueueOcr } from "@/lib/server/jobs";

export const POST = api<{ id: string }>(async (_req, { id }) => {
  const row = requireReadyDoc(id);
  const pdf = await readDocBytes(id);
  const ocrDone = row.ocr_status === "done";
  const newId = await createDocument({
    pdf,
    title: `${row.title} (copy)`.slice(0, 200),
    folderId: row.folder_id,
    tags: JSON.parse(row.tags),
    source: row.source,
    ocrText: row.ocr_text,
    ocrLayerText: row.ocr_layer_text,
    ocrEngine: row.ocr_engine,
    ocrStatus: ocrDone ? "done" : row.ocr_status === "error" ? "error" : "none",
    ocr: false,
  });
  copyOcrPages(id, newId);
  if (row.ocr_status === "queued" || row.ocr_status === "running") enqueueOcr(newId);
  return json(getDocDetail(newId), 201);
});
