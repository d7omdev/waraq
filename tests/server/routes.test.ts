// Route-handler level checks for the v4 endpoints (auth, CSRF, status codes, shapes).
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { beforeAll } from "vitest";
import { signInOwner } from "./auth-helpers";
import { waitForBuildIdle } from "@/lib/server/ingest";
import { createDocument } from "@/lib/server/docs";
import { createShare } from "@/lib/server/shares";
import { isPublicPath } from "@/lib/server/gate";
import * as version from "@/app/api/version/route";
import * as prefs from "@/app/api/prefs/route";
import * as shares from "@/app/api/shares/route";
import * as share from "@/app/api/shares/[id]/route";
import * as revokeAll from "@/app/api/shares/revoke-all/route";
import * as sessions from "@/app/api/sessions/route";
import * as session from "@/app/api/sessions/[id]/route";
import * as revokeOthers from "@/app/api/sessions/revoke-others/route";
import * as ocrRerun from "@/app/api/ocr/rerun/route";
import * as ocrStatus from "@/app/api/ocr/status/route";
import * as docs from "@/app/api/docs/route";
import * as pages from "@/app/api/docs/[id]/pages/route";
import * as docRoute from "@/app/api/docs/[id]/route";
import * as thumb from "@/app/api/docs/[id]/pages/[index]/thumb/route";
import * as retry from "@/app/api/docs/[id]/retry/route";
import * as folders from "@/app/api/folders/route";
import * as shareTarget from "@/app/share-target/route";
import { makePdf, solidImage } from "./helpers";

const BASE = "https://scan.example.test";
let authCookie = "";
beforeAll(async () => {
  authCookie = await signInOwner("vitest-routes");
});

function rq(path: string, init: { method?: string; body?: unknown; cookie?: string | null; form?: FormData; origin?: string | null } = {}) {
  const headers = new Headers();
  if (init.cookie !== null) headers.set("cookie", init.cookie ?? authCookie);
  if (init.origin !== null && init.method && init.method !== "GET") headers.set("origin", init.origin ?? BASE);
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers.set("content-type", "application/json");
  }
  return new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", headers, body });
}
const ctx = <P,>(p: P) => ({ params: Promise.resolve(p) });
const none = ctx({} as Record<string, never>);

describe("v4 routes", () => {
  it("GET /api/version is public and uncached", async () => {
    expect(isPublicPath("/api/version")).toBe(true);
    const r = await version.GET(rq("/api/version", { cookie: null }), none);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const v = await r.json();
    expect(typeof v.buildId).toBe("string");
    expect(Number.isNaN(Date.parse(v.builtAt))).toBe(false);
  });

  it("prefs: GET defaults, PATCH deep-partial, 400 on bad input, 401 / 403 guards", async () => {
    expect((await prefs.GET(rq("/api/prefs", { cookie: null }), none)).status).toBe(401);
    const g = await (await prefs.GET(rq("/api/prefs"), none)).json();
    expect(g.library.browseMode).toBe("all");
    const p = await prefs.PATCH(rq("/api/prefs", { method: "PATCH", body: { library: { gridColumnsMobile: 4 } } }), none);
    expect(p.status).toBe(200);
    expect((await p.json()).library.gridColumnsMobile).toBe(4);
    const bad = await prefs.PATCH(rq("/api/prefs", { method: "PATCH", body: { library: { gridColumnsMobile: 7 } } }), none);
    expect(bad.status).toBe(400);
    const csrf = await prefs.PATCH(rq("/api/prefs", { method: "PATCH", body: {}, origin: "https://evil.example" }), none);
    expect(csrf.status).toBe(403);
  });

  it("shares: list, patch, purge, revoke-all", async () => {
    const doc = await createDocument({ pdf: await makePdf(1), title: "Shared", source: "import", ocr: false });
    const s = await createShare(doc, { expiresIn: "1d", allowDownload: false });
    const list = await (await shares.GET(rq("/api/shares?status=active"), none)).json();
    expect(list.find((x: { id: string }) => x.id === s.id)).toMatchObject({ docTitle: "Shared", status: "active" });
    expect((await shares.GET(rq("/api/shares?status=bogus"), none)).status).toBe(400);
    const patched = await share.PATCH(rq(`/api/shares/${s.id}`, { method: "PATCH", body: { allowDownload: true, password: "pw" } }), ctx({ id: s.id }));
    expect(await patched.json()).toMatchObject({ allowDownload: true, hasPassword: true, status: "active" });
    const purgeActive = await share.DELETE(rq(`/api/shares/${s.id}?purge=1`, { method: "DELETE" }), ctx({ id: s.id }));
    expect(purgeActive.status).toBe(409);
    const ra = await revokeAll.POST(rq("/api/shares/revoke-all", { method: "POST", body: { docId: doc } }), none);
    expect(await ra.json()).toEqual({ revoked: 1 });
    expect((await share.DELETE(rq(`/api/shares/${s.id}?purge=1`, { method: "DELETE" }), ctx({ id: s.id }))).status).toBe(200);
    expect((await share.GET(rq(`/api/shares/${s.id}`), ctx({ id: s.id }))).status).toBe(404);
  });

  it("sessions: list marks current, revoke-others, revoke current clears cookie", async () => {
    const other = { cookie: await signInOwner("other-device") };
    const list = await (await sessions.GET(rq("/api/sessions"), none)).json();
    expect(list.filter((x: { current: boolean }) => x.current)).toHaveLength(1);
    const ro = await revokeOthers.POST(rq("/api/sessions/revoke-others", { method: "POST" }), none);
    expect((await ro.json()).revoked).toBeGreaterThanOrEqual(1);
    expect((await sessions.GET(rq("/api/sessions", { cookie: other.cookie }), none)).status).toBe(401);
    const mine = { cookie: await signInOwner("me-again") };
    const l2 = await (await sessions.GET(rq("/api/sessions", { cookie: mine.cookie }), none)).json();
    const cur = l2.find((x: { current: boolean }) => x.current);
    expect((await session.DELETE(rq(`/api/sessions/nope-nope-nope`, { method: "DELETE", cookie: mine.cookie }), ctx({ id: "nope-nope-nope" }))).status).toBe(404);
    const del = await session.DELETE(rq(`/api/sessions/${cur.id}`, { method: "DELETE", cookie: mine.cookie }), ctx({ id: cur.id }));
    expect(await del.json()).toEqual({ ok: true, current: true });
    expect(del.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("async POST /api/docs → processing doc, 202 thumbs, then ready; pages insert; retry 409", async () => {
    const fd = new FormData();
    fd.append("files[]", new Blob([new Uint8Array(await solidImage(600, 800))], { type: "image/png" }), "a.png");
    fd.append("files[]", new Blob([new Uint8Array(await solidImage(600, 800))], { type: "image/png" }), "b.png");
    fd.append("title", "Route async");
    const t0 = Date.now();
    const res = await docs.POST(rq("/api/docs", { method: "POST", form: fd }), none);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(res.status).toBe(201);
    const d = await res.json();
    expect(d).toMatchObject({ status: "processing", pageCount: 2, title: "Route async" });
    expect(d.processing.pagesTotal).toBe(2);
    // ensureBoot started the build worker; thumbs may still be pending
    const t = await thumb.GET(rq(`/api/docs/${d.id}/pages/1/thumb`), ctx({ id: d.id, index: "1" }));
    expect([200, 202]).toContain(t.status);
    if (t.status === 202) expect(t.headers.get("cache-control")).toBe("no-store");
    // live state: never reusable from an HTTP cache (the Android WebView has no service worker in front)
    const live = await docRoute.GET(rq(`/api/docs/${d.id}`), ctx({ id: d.id }));
    expect(live.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    await waitForBuildIdle();
    const ready = await docRoute.GET(rq(`/api/docs/${d.id}`), ctx({ id: d.id }));
    expect(ready.headers.get("cache-control")).toBe("private, no-store");
    expect((await ready.json()).status).toBe("ready");
    const t2 = await thumb.GET(rq(`/api/docs/${d.id}/pages/1/thumb?v=1`), ctx({ id: d.id, index: "1" }));
    expect(t2.status).toBe(200);
    expect(t2.headers.get("content-type")).toBe("image/webp");

    const fd2 = new FormData();
    fd2.append("files[]", new Blob([new Uint8Array(await solidImage(300, 300))], { type: "image/png" }), "c.png");
    fd2.append("at", "0");
    const ins = await pages.POST(rq(`/api/docs/${d.id}/pages`, { method: "POST", form: fd2 }), ctx({ id: d.id }));
    expect(ins.status).toBe(200);
    const after = await ins.json();
    expect(after).toMatchObject({ status: "processing", pageCount: 3 });
    expect(after.pages[0].status).toBe("processing");
    await waitForBuildIdle();
    expect((await retry.POST(rq(`/api/docs/${d.id}/retry`, { method: "POST" }), ctx({ id: d.id }))).status).toBe(409);

    const list = await (await docs.GET(rq(`/api/docs?includeSubfolders=1&folderId=root`), none)).json();
    expect(list.items.find((x: { id: string }) => x.id === d.id)).toMatchObject({ status: "ready", pageCount: 3, processing: null });
  });

  it("share-target creates a processing doc and redirects to it", async () => {
    const fd = new FormData();
    fd.append("files", new Blob([new Uint8Array(await solidImage(200, 300))], { type: "image/png" }), "shared.png");
    const r = await shareTarget.POST(rq("/share-target", { method: "POST", form: fd }));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toMatch(/\/d\/[A-Za-z0-9_-]+$/);
    await waitForBuildIdle();
  });

  it("ocr rerun/status and folders shape", async () => {
    expect((await ocrRerun.POST(rq("/api/ocr/rerun", { method: "POST", body: {} }), none)).status).toBe(400);
    const r = await ocrRerun.POST(rq("/api/ocr/rerun", { method: "POST", body: { ids: ["unknownunknown1"] } }), none);
    expect(await r.json()).toEqual({ queued: 0 });
    const st = await (await ocrStatus.GET(rq("/api/ocr/status"), none)).json();
    expect(st).toMatchObject({ engineAvailable: { drive: false, tesseract: true } });
    expect(typeof st.pending).toBe("number");
    const f = await folders.POST(rq("/api/folders", { method: "POST", body: { name: "R" } }), none);
    expect(await f.json()).toMatchObject({ childCount: 0, previewThumbs: [] });
  });
});
