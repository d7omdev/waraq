import { api, serveFile } from "@/lib/server/http";
import { requireReadyDoc } from "@/lib/server/docs";
import { docPdfFile } from "@/lib/server/doc-storage";
import { contentDisposition, safeBaseName } from "@/lib/server/export";

export const GET = api<{ id: string }>(async (req, { id }) => {
  const row = requireReadyDoc(id, { allowTrashed: true });
  const download = req.nextUrl.searchParams.get("download") === "1";
  return serveFile(req, await docPdfFile(id), {
    contentType: "application/pdf",
    disposition: contentDisposition(`${safeBaseName(row.title)}.pdf`, download ? "attachment" : "inline"),
    cacheControl: "private, no-cache",
    extraHeaders: { ETag: `"${row.id}-${row.version}"` },
  });
});
