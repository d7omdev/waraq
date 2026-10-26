import { api, json, readJson } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { mergeBody } from "@/lib/server/validation";
import { cleanTitle, createDocument, getDocDetail, normalizeTags, requireReadyDoc, trashDoc } from "@/lib/server/docs";
import { readDocBytes } from "@/lib/server/doc-storage";
import { mergePdfs } from "@/lib/server/pdf";
import { LIMITS } from "@/lib/server/config";

export const POST = api(async (req) => {
  const body = await readJson(req, mergeBody);
  if (new Set(body.ids).size !== body.ids.length) throw new HttpError(400, "validation_error", "ids must be unique");
  const rows = body.ids.map((id) => requireReadyDoc(id));
  const total = rows.reduce((n, r) => n + r.page_count, 0);
  if (total > LIMITS.maxPagesPerDoc) throw new HttpError(413, "too_many_pages", "Merged document would be too large");
  const pdf = await mergePdfs(await Promise.all(rows.map((r) => readDocBytes(r.id))));
  const id = await createDocument({
    pdf,
    title: cleanTitle(body.title, `${rows[0].title} (merged)`),
    folderId: rows[0].folder_id,
    tags: normalizeTags(rows.flatMap((r) => JSON.parse(r.tags) as string[])),
    source: "merge",
  });
  if (body.trashSources) rows.forEach((r) => trashDoc(r.id));
  return json(getDocDetail(id), 201);
});
