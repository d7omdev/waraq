import { api, json } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { getDocDetail, requireReadyDoc } from "@/lib/server/docs";
import { parseUpload } from "@/lib/server/upload";
import { insertPagesAsync } from "@/lib/server/ingest";

/** Async insert: responds as soon as the upload is stored; new pages report status "processing" until built. */
export const POST = api<{ id: string }>(async (req, { id }) => {
  requireReadyDoc(id);
  const { files, fields } = await parseUpload(req);
  let at: number | undefined;
  if (fields.at !== undefined && fields.at !== "") {
    if (!/^\d{1,5}$/.test(fields.at)) throw new HttpError(400, "invalid_page", "at must be a page index");
    at = Number(fields.at);
  }
  await insertPagesAsync(id, files, at);
  const d = getDocDetail(id);
  return json(d);
});
