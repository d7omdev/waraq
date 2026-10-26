"use client";

import { useSyncExternalStore } from "react";
import { api, ApiRequestError } from "@/lib/client/api";
import { DEFAULT_PREFS, type DeepPartial, type Prefs } from "@/lib/client/contract";

/**
 * App preferences shared by every device (GET/PATCH /api/prefs), cached in
 * localStorage so the first paint already uses them. Updates are optimistic.
 * When the server has no prefs endpoint (404) they stay local-only.
 */

const LS_KEY = "waraq:prefs";
type Source = "default" | "local" | "server" | "local-only";

let prefs: Prefs = DEFAULT_PREFS;
let source: Source = "default";
let hydrated = false;
let loadStarted = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge `patch` onto `base` (arrays and scalars replace). */
export function mergePrefs<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : (patch as T)) ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isObj(out[k]) && isObj(v) ? mergePrefs(out[k], v) : v;
  }
  return out as T;
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (raw) {
      prefs = mergePrefs(DEFAULT_PREFS, JSON.parse(raw));
      source = "local";
    } else {
      // carry over v3 localStorage prefs (view/sort/dir)
      const view = window.localStorage.getItem("waraq:view");
      const sort = window.localStorage.getItem("waraq:sort");
      const dir = window.localStorage.getItem("waraq:dir");
      const lib: Record<string, string> = {};
      if (view === "grid" || view === "list") lib.view = view;
      if (sort && ["updated", "created", "title", "size"].includes(sort)) lib.sort = sort;
      if (dir === "asc" || dir === "desc") lib.dir = dir;
      if (Object.keys(lib).length) prefs = mergePrefs(DEFAULT_PREFS, { library: lib });
    }
  } catch {
    /* corrupt cache or private mode */
  }
}

function persist() {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
}

export function loadPrefs(force = false) {
  if (typeof window === "undefined") return;
  hydrate();
  if (loadStarted && !force) return;
  loadStarted = true;
  api
    .prefs()
    .then((p) => {
      prefs = mergePrefs(DEFAULT_PREFS, p);
      source = "server";
      persist();
      emit();
    })
    .catch((e) => {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        source = "local-only";
        emit();
      }
    });
}

let pending: DeepPartial<Prefs> = {};
let flushTimer: number | undefined;

/** Optimistic deep-partial update; PATCHed to the server (debounced, merged). */
export function updatePrefs(patch: DeepPartial<Prefs>) {
  hydrate();
  const prev = prefs;
  prefs = mergePrefs(prefs, patch);
  persist();
  emit();
  if (source === "local-only") return;
  pending = mergePrefs(pending, patch);
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    const body = pending;
    pending = {};
    api
      .patchPrefs(body)
      .then((p) => {
        // server is the source of truth, but keep edits made while the request was in flight
        prefs = mergePrefs(mergePrefs(DEFAULT_PREFS, p), pending);
        source = "server";
        persist();
        emit();
      })
      .catch((e) => {
        if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
          source = "local-only";
          emit();
          return;
        }
        // network/validation error: roll this change back
        prefs = mergePrefs(prev, pending);
        persist();
        emit();
      });
  }, 250);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  loadPrefs();
  const onStorage = (e: StorageEvent) => {
    if (e.key !== LS_KEY || !e.newValue) return;
    try {
      prefs = mergePrefs(DEFAULT_PREFS, JSON.parse(e.newValue));
      emit();
    } catch {
      /* ignore */
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function snapshot() {
  hydrate();
  return prefs;
}
function sourceSnapshot() {
  hydrate();
  return source;
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_PREFS);
}

/** Where prefs currently come from (for the settings footnote). */
export function usePrefsSource(): Source {
  return useSyncExternalStore(subscribe, sourceSnapshot, () => "default" as Source);
}
