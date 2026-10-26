import { api, json } from "@/lib/server/http";
import { loadVersionInfo } from "@/lib/server/version";

/** Public: the PWA compares this with the build it loaded to offer an "Update" button. */
export const GET = api(
  async (req) => {
    void req.headers.get("accept"); // reading the request keeps this handler dynamic (never prerendered)
    return json(loadVersionInfo(), 200, { "Cache-Control": "no-store" });
  },
  { auth: false },
);
