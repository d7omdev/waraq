// Higher-level helpers shared by route handlers.
import type { DocDetail } from "@/lib/types";
import { HttpError } from "./errors";
import { createDocumentAsync } from "./ingest";
import { cleanTitle, defaultTitle, getDocDetail, getDocRow, pagePending, parseProcessing, sourcePageIndex, type DocRow, type DocSource } from "./docs";
import { getRender, type RenderKind } from "./render";
import { json, serveFile } from "./http";
import { parseUpload, titleFromFilename } from "./upload";

export async function createDocFromRequest(req: Request, forcedSource?: DocSource): Promise<DocDetail> {
  const { files, fields } = await parseUpload(req);
  const source: DocSource =
    forcedSource ?? (fields.source === "scan" ? "scan" : fields.source === "import" ? "import" : files.every((f) => f.kind !== "pdf") ? "scan" : "import");
  const firstPdf = files.find((f) => f.kind === "pdf" && f.name);
  const fallback =
    source === "import" && firstPdf ? cleanTitle(titleFromFilename(firstPdf.name), defaultTitle("Import")) : defaultTitle(source === "import" ? "Import" : "Scan");
  const id = await createDocumentAsync({
    files,
    title: cleanTitle(fields.title, fallback),
    folderId: fields.folderId || null,
    source,
  });
  return getDocDetail(id);
}

/** Serve a lazily-rendered page image; validates index against the current version. */
export async function renderResponse(
  req: Request,
  row: DocRow,
  index: number,
  kind: RenderKind,
  opts: { cache: "private" | "none" },
): Promise<Response> {
  if (index < 0 || index >= row.page_count) throw new HttpError(404, "invalid_page", "Page not found");
  if (pagePending(row, index)) {
    // not built yet: the client shows a skeleton and polls the document
    return json({ error: "Page is still processing", code: "processing" }, 202, { "Cache-Control": "no-store", "Retry-After": "2" });
  }
  if (row.status === "error" && parseProcessing(row.processing_json)?.kind === "create") {
    throw new HttpError(409, "processing_failed", row.processing_error || "Document processing failed");
  }
  const file = await getRender(
    row.id,
    row.version,
    index,
    kind,
    () => getDocRow(row.id)?.version === row.version,
    sourcePageIndex(row, index),
  );
  const v = new URL(req.url).searchParams.get("v");
  const cacheControl =
    opts.cache === "none"
      ? "private, no-store"
      : v === String(row.version)
        ? "private, max-age=31536000, immutable"
        : "private, no-cache";
  return serveFile(req, file, {
    contentType: kind === "thumb" ? "image/webp" : "image/jpeg",
    cacheControl,
    extraHeaders: { ETag: `"${row.id}-${row.version}-${index}-${kind}"` },
  });
}
