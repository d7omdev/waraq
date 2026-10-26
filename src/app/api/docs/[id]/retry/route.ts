import { api, json } from "@/lib/server/http";
import { getDocDetail } from "@/lib/server/docs";
import { retryProcessing } from "@/lib/server/ingest";

/** Re-run a failed background build from the kept originals. 409 nothing_to_retry, 410 originals_missing. */
export const POST = api<{ id: string }>(async (_req, { id }) => {
  await retryProcessing(id);
  const d = getDocDetail(id);
  return json(d);
});
