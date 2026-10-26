import { api, json, readJson } from "@/lib/server/http";
import { getPrefs, prefsPatchSchema, updatePrefs } from "@/lib/server/prefs";

const noStore = { "Cache-Control": "private, no-store" };

export const GET = api(async () => json(getPrefs(), 200, noStore));

/** Deep-partial update; unknown keys / invalid values → 400. Returns the full merged prefs. */
export const PATCH = api(async (req) => {
  const patch = await readJson(req, prefsPatchSchema);
  const out = updatePrefs(patch);
  return json(out, 200, noStore);
});
