import { api, json } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { parseIndex } from "@/lib/server/ids";
import { getDocDetail, mutateContent, requireReadyDoc } from "@/lib/server/docs";
import { parseUpload } from "@/lib/server/upload";
import { buildPdfFromInputs, replacePage } from "@/lib/server/pdf";

export const POST = api<{ id: string; index: string }>(async (req, p) => {
  const index = parseIndex(p.index);
  requireReadyDoc(p.id);
  const { files } = await parseUpload(req, { fileFields: ["file", "files", "files[]"], maxFiles: 1 });
  if (files[0].kind === "pdf") throw new HttpError(415, "unsupported_type", "Replacement must be an image");
  const pagePdf = await buildPdfFromInputs(files);
  await mutateContent(p.id, (cur) => replacePage(cur, index, pagePdf));
  const d = getDocDetail(p.id);
  return json(d);
});
