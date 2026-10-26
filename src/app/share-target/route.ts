import type { NextRequest } from "next/server";
import { ensureBoot } from "@/lib/server/boot";
import { originAllowed, requestOrigin, sessionFromRequest } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { parseUpload, titleFromFilename } from "@/lib/server/upload";
import { cleanTitle, defaultTitle } from "@/lib/server/docs";
import { createDocumentAsync } from "@/lib/server/ingest";

function redirect(req: NextRequest, path: string): Response {
  return new Response(null, { status: 303, headers: { Location: new URL(path, requestOrigin(req)).toString() } });
}

/** PWA Web Share Target: create a (processing) doc from shared files and 303 to its page. */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    ensureBoot();
    if (!originAllowed(req, true)) return redirect(req, "/?share_error=forbidden_origin");
    const session = await sessionFromRequest(req);
    if (!session) return redirect(req, "/login?next=%2F");
    return await handle(req);
  } catch (e) {
    return fail(req, e);
  }
}

async function handle(req: NextRequest): Promise<Response> {
  try {
    const { files, fields } = await parseUpload(req, {
      fileFields: ["files", "files[]", "file"],
      skipUnsupported: true,
      allowEmpty: true,
    });
    if (files.length === 0) return redirect(req, "/?share_error=no_files");
    const named = files.find((f) => f.name);
    const fallback = named ? cleanTitle(titleFromFilename(named.name), defaultTitle("Shared")) : defaultTitle("Shared");
    const title = cleanTitle(fields.title || (fields.text && fields.text.length <= 120 ? fields.text : ""), fallback);
    // async like POST /api/docs: the doc page shows processing progress while the PDF is assembled
    const id = await createDocumentAsync({ files, title, source: "share-target" });
    return redirect(req, `/d/${id}`);
  } catch (e) {
    return fail(req, e);
  }
}

function fail(req: NextRequest, e: unknown): Response {
  const code = e instanceof HttpError ? e.code : "internal_error";
  if (!(e instanceof HttpError)) console.error("[waraq] share-target failed:", (e as Error).message);
  return redirect(req, `/?share_error=${encodeURIComponent(code)}`);
}
