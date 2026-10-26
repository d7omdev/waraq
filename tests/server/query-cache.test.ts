// Client SWR cache (src/lib/client/query.ts): a polling page must pick up a status flip even when an earlier request
// hangs (the doc page stuck on "Building the PDF 0 of 1" although the server was done).
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutate, peek, revalidate, STALE_INFLIGHT_MS } from "@/lib/client/query";

type Doc = { id: string; status: "processing" | "ready" };

afterEach(() => vi.useRealTimers());

describe("query cache", () => {
  it("replaces a hung in-flight request once it is stale, and the fresh answer wins", async () => {
    vi.useFakeTimers();
    const key = "/api/docs/hung";
    mutate<Doc>(key, { id: "hung", status: "processing" });
    let calls = 0;
    const fetcher = () => {
      calls++;
      // first poll never settles (dead socket); later polls answer "ready"
      return calls === 1 ? new Promise<Doc>(() => {}) : Promise.resolve<Doc>({ id: "hung", status: "ready" });
    };
    void revalidate<Doc>(key, fetcher);
    void revalidate<Doc>(key); // within the window: shares the in-flight request
    expect(calls).toBe(1);
    vi.advanceTimersByTime(STALE_INFLIGHT_MS + 1);
    await revalidate<Doc>(key);
    expect(calls).toBe(2);
    expect(peek<Doc>(key)?.status).toBe("ready");
  });

  it("ignores a late answer from a replaced request", async () => {
    vi.useFakeTimers();
    const key = "/api/docs/late";
    let resolveOld: (d: Doc) => void = () => {};
    let calls = 0;
    const fetcher = () => {
      calls++;
      if (calls === 1) return new Promise<Doc>((r) => (resolveOld = r));
      return Promise.resolve<Doc>({ id: "late", status: "ready" });
    };
    void revalidate<Doc>(key, fetcher);
    vi.advanceTimersByTime(STALE_INFLIGHT_MS + 1);
    await revalidate<Doc>(key);
    resolveOld({ id: "late", status: "processing" });
    await Promise.resolve();
    await Promise.resolve();
    expect(peek<Doc>(key)?.status).toBe("ready");
  });
});
