import { api, json } from "@/lib/server/http";
import { listTags } from "@/lib/server/docs";

export const GET = api(async () => json(listTags()));
