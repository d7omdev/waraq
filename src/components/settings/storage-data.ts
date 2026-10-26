"use client";

import { api, type DocListResult } from "@/lib/client/api";
import { useQuery } from "@/lib/client/query";

async function sumAll(trash: boolean) {
  let cursor: string | null = null;
  let bytes = 0;
  let count = 0;
  let pages = 0;
  const ids: string[] = [];
  for (let i = 0; i < 200; i++) {
    const r: DocListResult = await api.docs({ trash, limit: 200, cursor });
    for (const d of r.items) {
      bytes += d.sizeBytes;
      pages += d.pageCount;
      count++;
      ids.push(d.id);
    }
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return { bytes, count, pages, ids };
}

export const STORAGE_KEY = "settings:storage";

export function useStorageUsage() {
  return useQuery(STORAGE_KEY, async () => {
    const [live, trash] = await Promise.all([sumAll(false), sumAll(true)]);
    return { live, trash };
  });
}
