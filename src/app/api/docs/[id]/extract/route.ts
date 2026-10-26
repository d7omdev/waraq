import { api, json, readJson } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { extractBody } from "@/lib/server/validation";
import { cleanTitle, createDocument, getDocDetail, mutateContent, requireReadyDoc } from "@/lib/server/docs";
import { applyPageOps, extractPages } from "@/lib/server/pdf";
import { readDocBytes } from "@/lib/server/doc-storage";

export const POST = api<{ id: string }>(async (req, { id }) => {
  const body = await readJson(req, extractBody);
  const row = requireReadyDoc(id);
  if (body.removeFromSource && new Set(body.pages).size >= row.page_count) {
    throw new HttpError(400, "empty_document", "Cannot remove every page from the source document");
  }
  const pdf = await extractPages(await readDocBytes(id), body.pages);
  const newId = await createDocument({
    pdf,
    title: cleanTitle(body.title, `${row.title} (extract)`),
    folderId: row.folder_id,
    tags: JSON.parse(row.tags),
    source: "split",
  });
  if (body.removeFromSource) {
    await mutateContent(id, (cur) => applyPageOps(cur, [{ op: "delete", pages: body.pages }]));
  }
  return json(getDocDetail(newId), 201);
});
