"use client";

/**
 * Background scan queue: the scanner hands its pages over on Save and closes
 * at once; this module warps/filters every page in the scan worker, uploads
 * the JPEGs (POST /api/docs, /api/docs/:id/pages or the replace endpoint) and
 * survives navigation (module-level runner) and reloads (jobs + blobs are
 * persisted in IndexedDB and resumed on load).
 *
 * Public API (for the shell indicator, the pending page and the scanner):
 *
 *   useUploadQueue(): { items: UploadQueueItem[] }
 *       Every job that is not yet finished plus recently finished ones
 *       (done items linger ~60 s so the indicator can link to the doc).
 *   useUploadItem(localId): UploadQueueItem | null | undefined
 *       One job; undefined while the persisted queue is still loading.
 *   enqueueScan(input): UploadQueueItem
 *       Start a job (synchronous: the item exists immediately, persistence
 *       happens in the background).
 *   retryUpload(localId) / dismissUpload(localId)
 *   resumeUploadQueue()   Called automatically on import in the browser.
 *
 * Server compatibility: works with the synchronous POST /api/docs (201 with
 * the full DocDetail) and the async variant (fast response with
 * status:"processing"); either way the job is done once the request returns
 * a document id, the doc page then shows the server-side processing state.
 */

import { useSyncExternalStore } from "react";
import { createStore, del, entries, set } from "idb-keyval";
import { api, ApiRequestError, errorMessage } from "./api";
import { getEngine, type FilterName, type Quad, type Rotation } from "./scanner/engine";
import { diag } from "./scanner/diagnostics";
import type { DocDetail } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type UploadState = "processing" | "uploading" | "done" | "error";
export type UploadPageState = "queued" | "processing" | "ready" | "uploading" | "done" | "error";

export type UploadTarget =
  | { kind: "new"; folderId?: string | null }
  | { kind: "append"; docId: string }
  | { kind: "replace"; docId: string; index: number };

export interface UploadQueuePage {
  id: string;
  state: UploadPageState;
  width: number;
  height: number;
  /** Object URL: the processed page once ready, else the raw photo. */
  thumbUrl: string | null;
  rotation: Rotation;
}

export interface UploadQueueItem {
  localId: string;
  title: string;
  /** 0..1 overall (processing counts 60 %, upload 40 %). */
  progress: number;
  state: UploadState;
  /** Server document id once known (always set for append/replace). */
  docId?: string;
  error?: string;
  target: UploadTarget;
  pages: UploadQueuePage[];
  pagesProcessed: number;
  /** 0..1 of the upload request body. */
  uploadFraction: number;
  createdAt: number;
  finishedAt?: number;
  /** Server reported status:"processing" for the new doc. */
  serverProcessing?: boolean;
  /** Pending page route for this job. */
  href: string;
}

export interface ScanInputPage {
  id: string;
  blob: Blob;
  width: number;
  height: number;
  quad: Quad | null;
  rotation: Rotation;
  filter: FilterName;
}

export interface ScanInput {
  target: UploadTarget;
  title: string;
  pages: ScanInputPage[];
  maxEdge?: number;
  quality?: number;
  /** Fold a small residual-skew correction into the warp. */
  deskew?: boolean;
}

/** Persisted job (IndexedDB). */
interface JobRecord {
  v: 1;
  localId: string;
  title: string;
  target: UploadTarget;
  createdAt: number;
  maxEdge: number;
  quality: number;
  deskew: boolean;
  pages: {
    id: string;
    raw: Blob | null;
    processed: Blob | null;
    width: number;
    height: number;
    quad: Quad | null;
    rotation: Rotation;
    filter: FilterName;
  }[];
  state: UploadState;
  docId?: string;
  error?: string;
  finishedAt?: number;
  serverProcessing?: boolean;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

const DONE_LINGER_MS = 60_000;
const DONE_KEEP_MS = 24 * 3600_000;
const MAX_AUTO_RETRIES = 4;

let idbStore: ReturnType<typeof createStore> | null = null;
function store() {
  if (!idbStore) idbStore = createStore("waraq-upload-queue", "jobs");
  return idbStore;
}

const jobs = new Map<string, JobRecord>();
const pageState = new Map<string, Map<string, UploadPageState>>();
const thumbs = new Map<string, string>(); // `${localId}/${pageId}` -> object URL (kind encoded below)
const thumbKind = new Map<string, "raw" | "processed">();
const uploadFrac = new Map<string, number>();
const retries = new Map<string, number>();
let loaded = typeof window === "undefined";
let items: UploadQueueItem[] = [];
const listeners = new Set<() => void>();
let running = false;
let wake: (() => void) | null = null;

function rebuild() {
  const now = Date.now();
  const list: UploadQueueItem[] = [];
  for (const j of jobs.values()) {
    if (j.state === "done" && j.finishedAt && now - j.finishedAt > DONE_LINGER_MS) continue;
    list.push(toItem(j));
  }
  list.sort((a, b) => a.createdAt - b.createdAt);
  items = list;
  listeners.forEach((l) => l());
}

function thumbFor(j: JobRecord, p: JobRecord["pages"][number]): string | null {
  const key = `${j.localId}/${p.id}`;
  const want: "raw" | "processed" | null = p.processed ? "processed" : p.raw ? "raw" : null;
  const have = thumbKind.get(key);
  if (want && have !== want) {
    const old = thumbs.get(key);
    if (old) URL.revokeObjectURL(old);
    thumbs.set(key, URL.createObjectURL((want === "processed" ? p.processed : p.raw)!));
    thumbKind.set(key, want);
  }
  return thumbs.get(key) ?? null;
}

function toItem(j: JobRecord): UploadQueueItem {
  const ps = pageState.get(j.localId);
  const pages: UploadQueuePage[] = j.pages.map((p) => {
    let st: UploadPageState = ps?.get(p.id) ?? (p.processed ? "ready" : "queued");
    if (j.state === "done") st = "done";
    else if (j.state === "uploading" && p.processed) st = "uploading";
    else if (j.state === "error" && st !== "ready") st = p.processed ? "ready" : "error";
    return {
      id: p.id,
      state: st,
      width: p.width,
      height: p.height,
      thumbUrl: thumbFor(j, p),
      rotation: p.processed ? 0 : p.rotation,
    };
  });
  const processed = j.pages.filter((p) => p.processed).length;
  const uf = j.state === "done" ? 1 : (uploadFrac.get(j.localId) ?? 0);
  const progress = j.state === "done" ? 1 : (0.6 * processed) / Math.max(1, j.pages.length) + 0.4 * uf;
  const docId = j.docId ?? (j.target.kind !== "new" ? j.target.docId : undefined);
  return {
    localId: j.localId,
    title: j.title,
    progress,
    state: j.state,
    docId,
    error: j.error,
    target: j.target,
    pages,
    pagesProcessed: processed,
    uploadFraction: uf,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
    serverProcessing: j.serverProcessing,
    href: `/p/${encodeURIComponent(j.localId)}`,
  };
}

function setPageState(localId: string, pageId: string, st: UploadPageState) {
  let m = pageState.get(localId);
  if (!m) pageState.set(localId, (m = new Map()));
  m.set(pageId, st);
}

async function persist(j: JobRecord) {
  try {
    if (j.state === "done") {
      // finished: keep a tiny record (for /p/<id> after a reload), drop the blobs
      await set(j.localId, { ...j, pages: j.pages.map((p) => ({ ...p, raw: null, processed: null })) }, store());
    } else await set(j.localId, j, store());
  } catch {
    /* quota / private mode: the in-memory job still runs */
  }
}

function update(j: JobRecord, patch: Partial<JobRecord>, save = true) {
  Object.assign(j, patch);
  rebuild();
  if (save) void persist(j);
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function nextJob(): JobRecord | null {
  let best: JobRecord | null = null;
  for (const j of jobs.values()) {
    if (j.state !== "processing" && j.state !== "uploading") continue;
    if (!best || j.createdAt < best.createdAt) best = j;
  }
  return best;
}

function kick() {
  if (wake) {
    const w = wake;
    wake = null;
    w();
  }
  if (running || typeof window === "undefined") return;
  running = true;
  void (async () => {
    try {
      for (;;) {
        const j = nextJob();
        if (!j) break;
        await runJob(j);
      }
    } finally {
      running = false;
    }
  })();
}

const fileFor = (b: Blob, i: number) => new File([b], `scan-${String(i + 1).padStart(3, "0")}.jpg`, { type: "image/jpeg" });

async function processPages(j: JobRecord) {
  const engine = getEngine();
  let engineOk = true;
  try {
    await engine.init();
  } catch {
    engineOk = false;
  }
  for (const p of j.pages) {
    if (p.processed) continue;
    if (!p.raw) throw new Error("A page photo is missing; scan it again.");
    setPageState(j.localId, p.id, "processing");
    rebuild();
    let out: Blob;
    if (engineOk) {
      try {
        const r = await engine.process(p.raw, {
          quad: p.quad,
          rotation: p.rotation,
          filter: p.filter,
          maxEdge: j.maxEdge,
          quality: j.quality,
          deskew: j.deskew,
        }, "save");
        out = r.blob;
      } catch (e) {
        // one bad page must not sink the scan: fall back to the photo
        console.warn("[waraq] page processing failed, uploading the original", e);
        out = p.raw;
      }
    } else out = p.raw;
    p.processed = out;
    setPageState(j.localId, p.id, "ready");
    update(j, {}, true);
  }
}

async function upload(j: JobRecord): Promise<DocDetail | null> {
  const files = j.pages.map((p, i) => fileFor(p.processed!, i));
  const onP = (p: { fraction: number }) => {
    uploadFrac.set(j.localId, p.fraction);
    rebuild();
  };
  const t = j.target;
  if (t.kind === "new") return api.createDoc(files, { title: j.title, folderId: t.folderId ?? null, source: "scan" }, onP).promise;
  if (t.kind === "append") return api.addPages(t.docId, files, undefined, onP).promise;
  return api.replacePage(t.docId, t.index, files[0], onP).promise;
}

function retryable(e: unknown) {
  if (e instanceof ApiRequestError) return e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
  return e instanceof TypeError; // fetch network failure
}

/** 409 processing: the target doc is still building (e.g. a scan appended right after creating it). */
const busyDoc = (e: unknown) => e instanceof ApiRequestError && e.status === 409 && e.code === "processing";

async function runJob(j: JobRecord) {
  try {
    if (j.state === "processing") {
      await processPages(j);
      update(j, { state: "uploading" });
    }
    uploadFrac.set(j.localId, 0);
    rebuild();
    const tUp = performance.now();
    const bytes = j.pages.reduce((n, p) => n + (p.processed?.size ?? 0), 0);
    let doc: DocDetail | null;
    try {
      doc = await upload(j);
      diag.uploaded({ ms: Math.round(performance.now() - tUp), bytes, pages: j.pages.length, ok: true });
    } catch (e) {
      diag.uploaded({ ms: Math.round(performance.now() - tUp), bytes, pages: j.pages.length, ok: false });
      throw e;
    }
    const docId = doc?.id ?? (j.target.kind !== "new" ? j.target.docId : undefined);
    if (!docId) throw new Error("The server did not return a document");
    retries.delete(j.localId);
    retries.delete(`${j.localId}:busy`);
    update(j, {
      state: "done",
      docId,
      error: undefined,
      finishedAt: Date.now(),
      serverProcessing: doc?.status === "processing",
    });
    void import("@/hooks/data")
      .then((m) => {
        m.refreshLibrary();
        m.refreshDoc(docId);
      })
      .catch(() => {});
    // linger, then drop from the list and free the photos (the tiny IDB
    // record stays for a day so /p/<id> can still redirect)
    window.setTimeout(() => {
      for (const p of j.pages) {
        p.raw = null;
        p.processed = null;
        const key = `${j.localId}/${p.id}`;
        const u = thumbs.get(key);
        if (u) URL.revokeObjectURL(u);
        thumbs.delete(key);
        thumbKind.delete(key);
      }
      rebuild();
    }, DONE_LINGER_MS + 100);
  } catch (e) {
    if (busyDoc(e)) {
      // not a failure: wait for the server build to finish (up to ~10 min)
      const b = (retries.get(`${j.localId}:busy`) ?? 0) + 1;
      retries.set(`${j.localId}:busy`, b);
      if (b <= 200) {
        update(j, { error: "Waiting for the document to finish processing…" }, false);
        await sleep(3000);
        update(j, { error: undefined }, false);
        return;
      }
    }
    const n = (retries.get(j.localId) ?? 0) + 1;
    retries.set(j.localId, n);
    const msg = errorMessage(e, "Upload failed");
    if (retryable(e) && n <= MAX_AUTO_RETRIES) {
      update(j, { error: `${msg}. Retrying…` }, false);
      // back off; wake early when the network comes back or retry is pressed
      await Promise.race([
        sleep([2000, 5000, 15000, 30000][n - 1] ?? 30000),
        new Promise<void>((r) => {
          wake = r;
        }),
      ]);
      wake = null;
      update(j, { error: undefined }, false);
      return; // still processing/uploading: the loop picks it up again
    }
    update(j, { state: "error", error: msg });
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

let seq = 0;
const newLocalId = () => `s${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Hand pages over to the background queue. Returns the new item at once. */
export function enqueueScan(input: ScanInput): UploadQueueItem {
  const j: JobRecord = {
    v: 1,
    localId: newLocalId(),
    title: input.title,
    target: input.target,
    createdAt: Date.now(),
    maxEdge: input.maxEdge ?? 3000,
    quality: input.quality ?? 0.85,
    deskew: input.deskew ?? true,
    pages: input.pages.map((p) => ({
      id: p.id,
      raw: p.blob,
      processed: null,
      width: p.width,
      height: p.height,
      quad: p.quad,
      rotation: p.rotation,
      filter: p.filter,
    })),
    state: "processing",
  };
  jobs.set(j.localId, j);
  rebuild();
  void persist(j);
  kick();
  return toItem(j);
}

/** Retry a failed (or waiting) job from where it stopped. */
export function retryUpload(localId: string) {
  const j = jobs.get(localId);
  if (!j || j.state === "done") return;
  retries.delete(localId);
  retries.delete(`${localId}:busy`);
  const state: UploadState = j.pages.every((p) => p.processed) ? "uploading" : "processing";
  update(j, { state, error: undefined });
  kick();
}

/** Forget a job (failed ones: the photos are discarded). */
export function dismissUpload(localId: string) {
  const j = jobs.get(localId);
  if (!j || j.state === "processing" || j.state === "uploading") return;
  jobs.delete(localId);
  for (const p of j.pages) {
    const key = `${localId}/${p.id}`;
    const u = thumbs.get(key);
    if (u) URL.revokeObjectURL(u);
    thumbs.delete(key);
    thumbKind.delete(key);
  }
  rebuild();
  void del(localId, store()).catch(() => {});
}

let resumeStarted = false;
/** Load persisted jobs and continue unfinished ones (idempotent). */
export function resumeUploadQueue() {
  if (resumeStarted || typeof window === "undefined" || typeof indexedDB === "undefined") {
    loaded = true;
    return;
  }
  resumeStarted = true;
  void entries<string, JobRecord>(store())
    .then((all) => {
      const now = Date.now();
      for (const [key, j] of all) {
        if (!j || j.v !== 1) continue;
        if (j.state === "done" && (!j.finishedAt || now - j.finishedAt > DONE_KEEP_MS)) {
          void del(key, store()).catch(() => {});
          continue;
        }
        if (jobs.has(j.localId)) continue;
        // an upload interrupted by a reload restarts (processed pages are kept)
        jobs.set(j.localId, j);
      }
    })
    .catch(() => {})
    .finally(() => {
      loaded = true;
      rebuild();
      kick();
    });
  window.addEventListener("online", () => {
    for (const j of jobs.values()) if (j.state === "error" && j.error && /network/i.test(j.error)) retryUpload(j.localId);
    kick();
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  resumeUploadQueue();
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY: UploadQueueItem[] = [];
let snap: { items: UploadQueueItem[] } = { items: EMPTY };
function getSnap() {
  if (snap.items !== items) snap = { items };
  return snap;
}
const SERVER_SNAP = { items: EMPTY };

/** Active + recently finished background scans (stable object between changes). */
export function useUploadQueue(): { items: UploadQueueItem[] } {
  return useSyncExternalStore(subscribe, getSnap, () => SERVER_SNAP);
}

/** One job by local id; undefined while the persisted queue is loading, null if unknown. */
export function useUploadItem(localId: string): UploadQueueItem | null | undefined {
  const { items: list } = useUploadQueue();
  const loadedNow = useSyncExternalStore(
    subscribe,
    () => loaded,
    () => false,
  );
  const hit = list.find((i) => i.localId === localId);
  if (hit) return hit;
  const j = jobs.get(localId);
  if (j) return toItem(j); // finished long ago but still in memory
  return loadedNow ? null : undefined;
}

/** Snapshot without React (e.g. for beforeunload guards). */
export function getUploadQueue(): UploadQueueItem[] {
  return items;
}

if (typeof window !== "undefined") resumeUploadQueue();
