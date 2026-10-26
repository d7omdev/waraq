import { api, serveFile } from "@/lib/server/http";
import { HttpError } from "@/lib/server/errors";
import { assertUnlocked } from "@/lib/server/public-share";
import { resolveShare } from "@/lib/server/shares";
import { assertReady } from "@/lib/server/docs";
import { docPdfFile } from "@/lib/server/doc-storage";
import { contentDisposition, safeBaseName } from "@/lib/server/export";

export const GET = api<{ token: string }>(
  async (req, { token }) => {
    const { share, doc } = resolveShare(token);
    assertReady(doc);
    assertUnlocked(req, share);
    if (!share.allow_download) throw new HttpError(403, "download_not_allowed", "Downloads are disabled for this link");
    const inline = req.nextUrl.searchParams.get("download") === "0";
    return serveFile(req, await docPdfFile(doc.id), {
      contentType: "application/pdf",
      disposition: contentDisposition(`${safeBaseName(doc.title)}.pdf`, inline ? "inline" : "attachment"),
    });
  },
  { auth: false, public: true },
);
