"use client";

export type Pt = [number, number];
/** Quad corners normalised to 0..1 of the source image: [tl, tr, br, bl]. */
export type Quad = [Pt, Pt, Pt, Pt];
export type FilterName = "original" | "magic" | "grayscale" | "bw" | "lighten";
export type Rotation = 0 | 90 | 180 | 270;

export const FULL_QUAD: Quad = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export const FILTERS: { value: FilterName; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "magic", label: "Magic" },
  { value: "grayscale", label: "Grayscale" },
  { value: "bw", label: "B&W" },
  { value: "lighten", label: "Lighten" },
];

export interface DetectResult {
  quad: Quad;
  score: number;
  /** Still photos only: suggested clockwise rotation to make text upright (set when confident). */
  rotation?: Rotation;
}

import { diag, type EngineTimings } from "./diagnostics";

/** Per build, so the worker can be cached for a year (next.config.ts headers) and still update on deploy. */
const WORKER_URL = `/scan-worker.js?v=${encodeURIComponent(process.env.NEXT_PUBLIC_WARAQ_BUILD_ID || "dev")}`;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

type Status = { state: "idle" | "loading" | "ready" | "error"; loaded: number; total: number; error?: string };

/**
 * Singleton wrapper around public/scan-worker.js. OpenCV is downloaded and
 * initialised inside the worker so the UI thread never blocks on it.
 */
class ScanEngine {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private readyPromise: Promise<void> | null = null;
  status: Status = { state: "idle", loaded: 0, total: 0 };
  /** Start-up timings of the running worker (scanner diagnostics). */
  timings: EngineTimings | null = null;
  private listeners = new Set<() => void>();

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getStatus = () => this.status;
  private setStatus(s: Partial<Status>) {
    this.status = { ...this.status, ...s };
    this.listeners.forEach((l) => l());
  }

  init(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
      this.setStatus({ state: "error", error: "This browser cannot run the scanner engine (needs Web Workers and OffscreenCanvas)." });
      return Promise.reject(new Error(this.status.error));
    }
    this.setStatus({ state: "loading" });
    const t0 = performance.now();
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const w = new Worker(WORKER_URL);
      this.worker = w;
      w.onmessage = (e: MessageEvent) => {
        const m = e.data as {
          type?: string;
          id?: number;
          ok?: boolean;
          error?: string;
          loaded?: number;
          total?: number;
          timings?: { cached?: boolean; jsMs?: number; wasmMs?: number; streaming?: boolean; readyMs?: number } | null;
        };
        if (m.type === "progress") {
          this.setStatus({ loaded: m.loaded ?? 0, total: m.total ?? 0 });
          return;
        }
        if (m.type === "ready") {
          const t = m.timings ?? {};
          this.timings = { ms: Math.round(performance.now() - t0), cached: t.cached, jsMs: t.jsMs, wasmMs: t.wasmMs, streaming: t.streaming, workerMs: t.readyMs };
          diag.engineReady(this.timings);
          this.setStatus({ state: "ready" });
          resolve();
          return;
        }
        if (m.type === "error") {
          this.setStatus({ state: "error", error: m.error });
          this.readyPromise = null;
          this.worker?.terminate();
          this.worker = null;
          reject(new Error(m.error));
          return;
        }
        if (typeof m.id === "number") {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.ok) p.resolve(m);
          else p.reject(new Error(m.error || "Scanner error"));
        }
      };
      w.onerror = (e) => {
        const msg = e.message || "Scanner worker crashed";
        this.setStatus({ state: "error", error: msg });
        this.pending.forEach((p) => p.reject(new Error(msg)));
        this.pending.clear();
        this.readyPromise = null;
        this.worker = null;
        reject(new Error(msg));
      };
      w.postMessage({ type: "init" });
    });
    return this.readyPromise;
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    return this.init().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const id = ++this.seq;
          this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
          this.worker!.postMessage({ ...msg, id }, transfer);
        }),
    );
  }

  get ready() {
    return this.status.state === "ready";
  }

  /** Detect on a small RGBA frame (e.g. a downscaled video frame). `ms` = worker compute time. */
  detectFrame(img: ImageData): Promise<{ result: DetectResult | null; ms: number }> {
    const buf = img.data.buffer as ArrayBuffer;
    return this.call<{ result: DetectResult | null; ms?: number }>(
      { type: "detect", width: img.width, height: img.height, buffer: buf },
      [buf],
    ).then((r) => ({ result: r.result, ms: r.ms ?? 0 }));
  }

  async detectBlob(blob: Blob): Promise<DetectResult | null> {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const r = await this.call<{ result: DetectResult | null }>({ type: "detectBitmap", bitmap }, [bitmap]);
    return r.result;
  }

  async process(
    blob: Blob,
    opts: {
      quad: Quad | null;
      rotation: Rotation;
      filter: FilterName;
      maxEdge: number;
      quality: number;
      /** Remove a small residual skew (< 5 deg) found from text lines after the warp. */
      deskew?: boolean;
    },
    where: "review" | "save" = "review",
  ): Promise<{ blob: Blob; width: number; height: number; skew?: number }> {
    const t0 = performance.now();
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const r = await this.call<{ blob: Blob; width: number; height: number; skew?: number }>({ type: "process", bitmap, ...opts }, [bitmap]);
    // thumbnails and filter previews are small; only full pages are worth a diagnostics entry
    if (opts.maxEdge >= 1000) diag.processed({ ms: Math.round(performance.now() - t0), width: r.width, height: r.height, filter: opts.filter, where });
    return r;
  }
}

let engine: ScanEngine | null = null;
export function getEngine(): ScanEngine {
  if (!engine) engine = new ScanEngine();
  return engine;
}

/** Natural size of an image blob (EXIF-oriented). */
export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const b = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const s = { width: b.width, height: b.height };
  b.close();
  return s;
}
