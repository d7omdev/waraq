"use client";


/**
 * Scanner diagnostics: lightweight timings of the last scanner sessions, kept in localStorage so the owner can compare
 * browser sessions on the same phone (Settings → About: tap the version 5 times → "Scanner
 * diagnostics"). Also mirrored as performance marks/measures named `waraq:*` for DevTools.
 *
 * Collected: scanner open → camera live, camera track settings, scanner engine start (download/compile, cache hit),
 * live detection per frame (main-thread prep, worker compute, round trip), shutter → page captured (ImageCapture
 * still vs video frame), page processing in the worker, upload time. Nothing leaves the device.
 */

const KEY = "waraq:scan-diag";
const MAX_SESSIONS = 3;
const MAX_ITEMS = 8;
const FRAME_WINDOW = 60;

export interface FrameStats {
  n: number;
  prepAvg: number;
  prepP95: number;
  workerAvg: number;
  workerP95: number;
  roundTripAvg: number;
  roundTripP95: number;
  /** detections per second actually achieved */
  fps: number;
}

export interface EngineTimings {
  /** engine init() call → worker ready */
  ms: number;
  /** both OpenCV files came from Cache Storage */
  cached?: boolean;
  /** glue script ready (ms since the worker started loading) */
  jsMs?: number;
  /** wasm compiled + instantiated */
  wasmMs?: number;
  /** compiled with WebAssembly.instantiateStreaming */
  streaming?: boolean;
  /** worker-side total */
  workerMs?: number;
  /** engine was already warm when the scanner opened */
  warm?: boolean;
}

export interface ScanDiagSession {
  id: string;
  at: string;
  env: {
    app: string | null;
    sw: boolean;
    ua: string;
    cores?: number;
    memoryGb?: number;
    screen: string;
  };
  openToCameraMs?: number;
  openToEngineMs?: number;
  camera?: { width?: number; height?: number; fps?: number; resizeMode?: string; label?: string; attempt?: number; openMs?: number };
  engine?: EngineTimings;
  frames?: FrameStats;
  captures: { path: "still" | "frame"; stillMs?: number; stillSkipped?: string; totalMs: number; width: number; height: number }[];
  processed: { ms: number; width: number; height: number; filter: string; where: "review" | "save" }[];
  uploads: { ms: number; bytes: number; pages: number; ok: boolean }[];
}

let current: ScanDiagSession | null = null;
let openedAt = 0;
let frameBuf: { prep: number; worker: number; rt: number; at: number }[] = [];
let saveTimer = 0;
let appVersion: string | null = null;

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function mark(name: string) {
  try {
    performance.mark(`waraq:${name}`);
  } catch {
    /* ignore */
  }
}

function measure(name: string, start: string, end: string) {
  try {
    performance.measure(`waraq:${name}`, `waraq:${start}`, `waraq:${end}`);
  } catch {
    /* ignore */
  }
}

export function readDiagnostics(): ScanDiagSession[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as ScanDiagSession[]) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function clearDiagnostics() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  current = null;
}

function persistSoon() {
  if (typeof window === "undefined" || saveTimer) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    persist();
  }, 600);
}

function persist() {
  if (!current) return;
  if (frameBuf.length) current.frames = frameStats();
  try {
    const all = readDiagnostics().filter((s) => s.id !== current!.id);
    all.unshift(current);
    window.localStorage.setItem(KEY, JSON.stringify(all.slice(0, MAX_SESSIONS)));
  } catch {
    /* storage full / disabled: diagnostics are best effort */
  }
}

function pct(a: number[], p: number) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

function frameStats(): FrameStats {
  const prep = frameBuf.map((f) => f.prep);
  const worker = frameBuf.map((f) => f.worker);
  const rt = frameBuf.map((f) => f.rt);
  const span = frameBuf.length > 1 ? (frameBuf[frameBuf.length - 1].at - frameBuf[0].at) / 1000 : 0;
  return {
    n: frameBuf.length,
    prepAvg: r1(avg(prep)),
    prepP95: r1(pct(prep, 0.95)),
    workerAvg: r1(avg(worker)),
    workerP95: r1(pct(worker, 0.95)),
    roundTripAvg: r1(avg(rt)),
    roundTripP95: r1(pct(rt, 0.95)),
    fps: span > 0 ? r1((frameBuf.length - 1) / span) : 0,
  };
}

/** An embedding shell may report its version once (null in the browser). */
export function setDiagAppVersion(v: string | null) {
  appVersion = v;
}

function session(): ScanDiagSession {
  if (current) return current;
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  current = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    at: new Date().toISOString(),
    env: {
      app: appVersion,
      sw: !!nav?.serviceWorker?.controller,
      ua: nav?.userAgent ?? "",
      cores: nav?.hardwareConcurrency,
      memoryGb: (nav as Navigator & { deviceMemory?: number })?.deviceMemory,
      screen: typeof window !== "undefined" ? `${window.screen.width}x${window.screen.height}@${window.devicePixelRatio}` : "",
    },
    captures: [],
    processed: [],
    uploads: [],
  };
  return current;
}

export const diag = {
  scannerOpened() {
    current = null;
    frameBuf = [];
    openedAt = now();
    session();
    mark("scanner-open");
    persistSoon();
  },
  cameraReady(track: MediaStreamTrack | undefined, info: { attempt?: number; openMs?: number }) {
    const s = session();
    const st = (track?.getSettings?.() ?? {}) as MediaTrackSettings & { resizeMode?: string };
    s.openToCameraMs = Math.round(now() - openedAt);
    s.camera = { width: st.width, height: st.height, fps: st.frameRate ? r1(st.frameRate) : undefined, resizeMode: st.resizeMode, label: track?.label, ...info };
    mark("camera-ready");
    measure("open-to-camera", "scanner-open", "camera-ready");
    persistSoon();
  },
  engineReady(t: EngineTimings) {
    const s = session();
    s.engine = t;
    if (openedAt) s.openToEngineMs = t.warm ? 0 : Math.round(now() - openedAt);
    mark("engine-ready");
    measure("open-to-engine", "scanner-open", "engine-ready");
    persistSoon();
  },
  frame(prepMs: number, workerMs: number, roundTripMs: number) {
    frameBuf.push({ prep: prepMs, worker: workerMs, rt: roundTripMs, at: now() });
    if (frameBuf.length > FRAME_WINDOW) frameBuf.shift();
    if (frameBuf.length % 10 === 0) persistSoon();
  },
  capture(c: ScanDiagSession["captures"][number]) {
    const s = session();
    s.captures = [c, ...s.captures].slice(0, MAX_ITEMS);
    persistSoon();
  },
  processed(p: ScanDiagSession["processed"][number]) {
    const s = session();
    s.processed = [p, ...s.processed].slice(0, MAX_ITEMS);
    persistSoon();
  },
  uploaded(u: ScanDiagSession["uploads"][number]) {
    const s = session();
    s.uploads = [u, ...s.uploads].slice(0, MAX_ITEMS);
    persistSoon();
  },
  flush() {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = 0;
    persist();
  },
};

/** Plain-text report for the clipboard. */
export function diagnosticsText(sessions: ScanDiagSession[]): string {
  return JSON.stringify(sessions, null, 1);
}
