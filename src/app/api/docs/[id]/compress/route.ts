import { api, json, readJson } from "@/lib/server/http";
import { compressBody } from "@/lib/server/validation";
import { getDocDetail, mutateContent } from "@/lib/server/docs";
import { compressPdf } from "@/lib/server/export";
import { inspectPdf } from "@/lib/server/pdf";

export const POST = api<{ id: string }>(async (req, { id }) => {
  const { level } = await readJson(req, compressBody);
  let saved = 0;
  await mutateContent(
    id,
    async (cur, row) => {
      const out = await compressPdf(cur, level);
      if (!out) return null;
      const info = await inspectPdf(out);
      if (info.pageCount !== row.page_count) return null;
      saved = cur.byteLength - out.byteLength;
      return out;
    },
    { ocr: false },
  );
  const d = getDocDetail(id);
  return json({ ...d, savedBytes: saved }, 200, {
    "x-saved-bytes": String(saved),
    "Access-Control-Expose-Headers": "x-saved-bytes",
  });
});
