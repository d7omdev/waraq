import { NextResponse } from "next/server";
import { api, isHttps } from "@/lib/server/http";
import { assertUnlocked } from "@/lib/server/public-share";
import { incrementViews, resolveShare, viewCookieName } from "@/lib/server/shares";
import { SHARE_UNLOCK_TTL_MS } from "@/lib/server/config";

export const GET = api<{ token: string }>(
  async (req, { token }) => {
    let resolved: ReturnType<typeof resolveShare>;
    try {
      resolved = resolveShare(token);
    } catch (e) {
      throw e;
    }
    const { share, doc } = resolved;
    assertUnlocked(req, share);
    const pages = Array.from({ length: doc.page_count }, (_, i) => ({
      thumbUrl: `/api/public/s/${token}/pages/${i}/thumb?v=${doc.version}`,
      imageUrl: `/api/public/s/${token}/pages/${i}/image?v=${doc.version}`,
    }));
    const res = NextResponse.json({ title: doc.title, pageCount: doc.page_count, allowDownload: !!share.allow_download, pages });
    const vc = viewCookieName(share.id);
    if (!req.cookies.get(vc)) {
      incrementViews(share.id);
      res.cookies.set(vc, "1", {
        httpOnly: true,
        sameSite: "lax",
        secure: isHttps(req),
        path: "/",
        maxAge: Math.floor(SHARE_UNLOCK_TTL_MS / 1000),
      });
    }
    return res;
  },
  { auth: false, public: true },
);
