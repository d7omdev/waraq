import { api } from "@/lib/server/http";
import { parseIndex } from "@/lib/server/ids";
import { renderResponse } from "@/lib/server/actions";
import { assertUnlocked } from "@/lib/server/public-share";
import { resolveShare } from "@/lib/server/shares";

export const GET = api<{ token: string; index: string }>(
  async (req, p) => {
    const index = parseIndex(p.index);
    const { share, doc } = resolveShare(p.token);
    assertUnlocked(req, share);
    return renderResponse(req, doc, index, "thumb", { cache: "none" });
  },
  { auth: false, public: true },
);
