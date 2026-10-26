import { api, json, readJson } from "@/lib/server/http";
import { splitBody } from "@/lib/server/validation";
import { createDocument, getDocRow, requireReadyDoc, rowToSummary } from "@/lib/server/docs";
import { splitPdf, splitRanges } from "@/lib/server/pdf";
import { readDocBytes } from "@/lib/server/doc-storage";

export const POST = api<{ id: string }>(async (req, { id }) => {
  const body = await readJson(req, splitBody);
  const row = requireReadyDoc(id);
  const ranges = splitRanges(row.page_count, body);
  const parts = await splitPdf(await readDocBytes(id), ranges);
  const docs = [];
  for (let i = 0; i < parts.length; i++) {
    const newId = await createDocument({
      pdf: parts[i],
      title: `${row.title} (${i + 1})`.slice(0, 200),
      folderId: row.folder_id,
      tags: JSON.parse(row.tags),
      source: "split",
    });
    docs.push(rowToSummary(getDocRow(newId)!));
  }
  return json({ docs }, 201);
});
