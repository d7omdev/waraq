import QRCode from "qrcode";
import { api, bytesResponse } from "@/lib/server/http";
import { assertId } from "@/lib/server/ids";
import { getShareById } from "@/lib/server/shares";
import { shareUrl } from "@/lib/server/share-model";
import { HttpError } from "@/lib/server/errors";

export const GET = api<{ id: string }>(async (req, { id }) => {
  const s = getShareById(assertId(id));
  if (!s) throw new HttpError(404, "not_found", "Share not found");
  const size = Math.min(Math.max(Number(req.nextUrl.searchParams.get("size")) || 512, 128), 1024);
  const png = await QRCode.toBuffer(shareUrl(s.token), { type: "png", width: size, margin: 2, errorCorrectionLevel: "M" });
  return bytesResponse(png, { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" });
});
