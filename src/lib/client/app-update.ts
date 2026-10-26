"use client";

import { useSyncExternalStore } from "react";
import { api } from "@/lib/client/api";

/**
 * In-app update detection.
 *  1. Service worker: registered as /sw.js?v=<buildId> so every build gets a
 *     new worker (and new cache names). A new worker waits; we show "Update"
 *     and activate it on demand (SKIP_WAITING), then reload on controllerchange.
 *  2. Build id polling: the build id inlined into this bundle
 *     (NEXT_PUBLIC_WARAQ_BUILD_ID, see next.config.ts) is the baseline; falls
 *     back to the first GET /api/version answer. A different buildId from
 *     /api/version means the server runs a newer release.
 * Checks run at boot, every 30 min (worker) / 5 min (version) and whenever
 * the app comes back to the foreground.
 */

export interface UpdateState {
  available: boolean;
  applying: boolean;
  /** build id this page was loaded with (null until known / no endpoint) */
  current: string | null;
  /** newest build id seen on the server */
  latest: string | null;
  builtAt: string | null;
  checkedAt: number | null;
  swActive: boolean;
  /** user pressed "Later" for this latest build id */
  dismissed: boolean;
  /** number of mounted in-layout prompts (the app shell's bottom stack) */
  inline: number;
}

const INITIAL: UpdateState = {
  available: false,
  applying: false,
  current: null,
  latest: null,
  builtAt: null,
  checkedAt: null,
  swActive: false,
  dismissed: false,
  inline: 0,
};
let state: UpdateState = INITIAL;
const listeners = new Set<() => void>();
function set(p: Partial<UpdateState>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

let reg: ServiceWorkerRegistration | null = null;
let started = false;
let versionEndpoint = true;
let lastCheck = 0;

const SW_MIN = 30 * 60_000;
// dev servers have no stable build id (and .next/BUILD_ID may be a stale build)
const PROD = process.env.NODE_ENV === "production";
const VERSION_MIN = 5 * 60_000;

function swEnabled() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    return process.env.NODE_ENV === "production" || window.localStorage.getItem("waraq:sw-dev") === "1";
  } catch {
    return process.env.NODE_ENV === "production";
  }
}

function watchRegistration(r: ServiceWorkerRegistration) {
  reg = r;
  set({ swActive: true });
  const markIfWaiting = () => {
    const w = r.waiting;
    if (!w || !navigator.serviceWorker.controller) return;
    let v: string | null = null;
    try {
      v = new URL(w.scriptURL).searchParams.get("v");
    } catch {
      /* ignore */
    }
    // The waiting worker belongs to the build this page already runs (we were
    // reloaded into a new release): let it take over quietly, no prompt.
    if (v && state.current && v === state.current) w.postMessage({ type: "SKIP_WAITING" });
    // Otherwise a newer release is ready.
    else set({ available: true });
  };
  markIfWaiting();
  r.addEventListener("updatefound", () => {
    const w = r.installing;
    if (!w) return;
    w.addEventListener("statechange", () => {
      if (w.state === "installed") markIfWaiting();
    });
  });
}

async function fetchVersion(): Promise<{ buildId: string; builtAt: string } | null> {
  if (!versionEndpoint) return null;
  try {
    return await api.version();
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404) versionEndpoint = false;
    return null;
  }
}

/** Check both the worker and the server build id. */
export async function checkForUpdate(force = false) {
  const now = Date.now();
  if (!force && now - lastCheck < 60_000) return;
  lastCheck = now;
  try {
    await reg?.update();
  } catch {
    /* offline */
  }
  const v = await fetchVersion();
  if (v) {
    const current = state.current ?? v.buildId;
    set({
      current,
      dismissed: state.dismissed && v.buildId === state.latest,
      latest: v.buildId,
      builtAt: state.builtAt ?? v.builtAt,
      checkedAt: Date.now(),
      available: state.available || (PROD && v.buildId !== current),
    });
  } else set({ checkedAt: Date.now() });
}

export function startUpdateWatcher() {
  if (started || typeof window === "undefined") return;
  started = true;
  // QA hook: lets the screenshot harness show the update prompt.
  if (process.env.NODE_ENV !== "production")
    (window as unknown as { __waraqForceUpdate?: () => void }).__waraqForceUpdate = () => set({ available: true, dismissed: false, latest: "next-build" });

  const boot = async () => {
    const baseline = process.env.NEXT_PUBLIC_WARAQ_BUILD_ID || null;
    const v = await fetchVersion();
    const current = baseline ?? v?.buildId ?? null;
    set({
      current,
      latest: v?.buildId ?? null,
      builtAt: v?.builtAt ?? null,
      checkedAt: Date.now(),
      available: PROD && !!(current && v && v.buildId !== current),
    });
    lastCheck = Date.now();

    if (swEnabled()) {
      const url = current ? `/sw.js?v=${encodeURIComponent(current)}` : "/sw.js";
      try {
        const r = await navigator.serviceWorker.register(url, { scope: "/", updateViaCache: "none" });
        watchRegistration(r);
        void r.update().catch(() => {});
      } catch {
        /* non-fatal */
      }
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (state.applying) window.location.reload();
      });
    }

    window.setInterval(() => void reg?.update().catch(() => {}), SW_MIN);
    window.setInterval(() => {
      if (document.visibilityState === "visible") void checkForUpdate(true);
    }, VERSION_MIN);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void checkForUpdate();
    });
    window.addEventListener("online", () => void checkForUpdate());
  };
  if (document.readyState === "complete") void boot();
  else window.addEventListener("load", () => void boot(), { once: true });
}

/** Activate the waiting worker (if any) and reload into the new build. */
export async function applyUpdate() {
  set({ applying: true });
  const reload = () => window.location.reload();
  try {
    if (reg && !reg.waiting) {
      await reg.update().catch(() => {});
      // give a freshly found worker a moment to install
      for (let i = 0; i < 20 && reg.installing && !reg.waiting; i++) await new Promise((r) => setTimeout(r, 150));
    }
    const waiting = reg?.waiting;
    if (waiting && navigator.serviceWorker.controller) {
      waiting.postMessage({ type: "SKIP_WAITING" });
      // controllerchange reloads; fall back in case it never fires
      window.setTimeout(reload, 4000);
      return;
    }
  } catch {
    /* fall through */
  }
  reload();
}

/** Hide the prompt until a newer build shows up (Settings > About still offers it). */
export function dismissUpdate() {
  set({ dismissed: true });
}

/** The app shell shows the prompt in its bottom stack; elsewhere AppRuntime shows it at the top. */
export function registerInlinePrompt() {
  set({ inline: state.inline + 1 });
  return () => set({ inline: Math.max(0, state.inline - 1) });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}
