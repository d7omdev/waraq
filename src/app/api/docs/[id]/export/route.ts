import { api, bytesResponse, parseQuery, readJson } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { requireReadyDoc } from "@/lib/server/docs";
import { buildExport, contentDisposition } from "@/lib/server/export";
import { exportBody, exportQuery } from "@/lib/server/validation";
import type { ExportFormat } from "@/lib/types";

async function respond(id: string, format: ExportFormat, pages?: number[], password?: string) {
  const row = requireReadyDoc(id, { allowTrashed: true });
  const out = await buildExport(row, { format, pages, password: password || undefined });
  return bytesResponse(out.body, {
    "Content-Type": out.contentType,
    "Content-Disposition": contentDisposition(out.filename),
    "Cache-Control": "private, no-store",
  });
}

export const GET = api<{ id: string }>(async (req, { id }) => {
  const q = parseQuery(req, exportQuery);
  if (q.password) throw new HttpError(400, "use_post", "Send passwords with POST /export, not in the URL");
  return respond(id, q.format, q.pages);
});

export const POST = api<{ id: string }>(async (req, { id }) => {
  const b = await readJson(req, exportBody);
  return respond(id, b.format, b.pages, b.password);
});
