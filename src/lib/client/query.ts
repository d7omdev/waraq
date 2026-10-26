"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Tiny stale-while-revalidate cache. Keys are strings (usually API URLs).
 * Data survives client navigations so going back to the library is instant.
 */

interface EntryState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
}

interface Entry<T> {
  state: EntryState<T>;
  listeners: Set<() => void>;
  fetcher?: () => Promise<T>;
  inflight?: Promise<T>;
  /** when the in-flight request started (a request older than STALE_INFLIGHT_MS is not waited for again) */
  inflightAt?: number;
  seq: number;
}

/**
 * A request that hangs (for example a dead keep-alive socket after the phone slept) must not freeze a key forever: every later revalidate would just return that same
 * promise and a polling page (doc processing -> ready) would never update. After this long a new request replaces it.
 */
export const STALE_INFLIGHT_MS = 12_000;

const store = new Map<string, Entry<unknown>>();
const EMPTY: EntryState<never> = { data: undefined, error: undefined, loading: false };

function getEntry<T>(key: string): Entry<T> {
  let e = store.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { state: { data: undefined, error: undefined, loading: false }, listeners: new Set(), seq: 0 };
    store.set(key, e as Entry<unknown>);
  }
  return e;
}

function setState<T>(key: string, patch: Partial<EntryState<T>>) {
  const e = getEntry<T>(key);
  e.state = { ...e.state, ...patch };
  e.listeners.forEach((l) => l());
}

export function revalidate<T>(key: string, fetcher?: () => Promise<T>): Promise<T | undefined> {
  const e = getEntry<T>(key);
  if (fetcher) e.fetcher = fetcher;
  const f = e.fetcher;
  if (!f) return Promise.resolve(e.state.data);
  if (e.inflight && Date.now() - (e.inflightAt ?? 0) < STALE_INFLIGHT_MS) return e.inflight;
  const seq = ++e.seq;
  setState<T>(key, { loading: true });
  const p = f()
    .then((data) => {
      if (seq === e.seq) setState<T>(key, { data, error: undefined, loading: false });
      return data;
    })
    .catch((error: unknown) => {
      if (seq === e.seq) setState<T>(key, { error, loading: false });
      return undefined as T;
    })
    .finally(() => {
      if (e.inflight === p) e.inflight = undefined;
    });
  e.inflight = p as Promise<T>;
  e.inflightAt = Date.now();
  return p;
}

/** Overwrite cached data locally (optimistic updates). */
export function mutate<T>(key: string, updater: T | ((prev: T | undefined) => T | undefined)) {
  const e = getEntry<T>(key);
  const next =
    typeof updater === "function"
      ? (updater as (prev: T | undefined) => T | undefined)(e.state.data)
      : updater;
  e.seq++;
  e.inflight = undefined;
  setState<T>(key, { data: next, error: undefined, loading: false });
}

/** Refetch every cached key that matches the predicate/prefix. */
export function invalidate(match: string | ((key: string) => boolean)) {
  const test = typeof match === "string" ? (k: string) => k.startsWith(match) : match;
  for (const [key, e] of store) {
    if (!test(key)) continue;
    if (e.listeners.size > 0) void revalidate(key);
    else store.delete(key);
  }
}

export function peek<T>(key: string): T | undefined {
  return (store.get(key) as Entry<T> | undefined)?.state.data;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  refresh: () => Promise<T | undefined>;
}

export function useQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  opts: { refreshInterval?: number } = {},
): QueryResult<T> {
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const subscribe = useCallback(
    (cb: () => void) => {
      if (!key) return () => {};
      const e = getEntry<T>(key);
      e.listeners.add(cb);
      return () => {
        e.listeners.delete(cb);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(
    () => (key ? getEntry<T>(key).state : (EMPTY as EntryState<T>)),
    [key],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY as EntryState<T>);

  useEffect(() => {
    if (!key) return;
    void revalidate<T>(key, () => fetcherRef.current());
  }, [key]);

  const interval = opts.refreshInterval ?? 0;
  useEffect(() => {
    if (!key || !interval) return;
    let last = Date.now();
    const tick = (force = false) => {
      // hidden tabs poll rarely; the Android WebView can report "hidden" for a while after returning from
      // another activity, so never stop completely
      const hidden = document.visibilityState !== "visible";
      if (!force && hidden && Date.now() - last < Math.max(interval, 30_000)) return;
      last = Date.now();
      void revalidate<T>(key);
    };
    const t = window.setInterval(() => tick(), interval);
    // coming back (tab shown, window focused, app resumed, network back): refresh at once
    const now = () => tick(true);
    const onVis = () => {
      if (document.visibilityState === "visible") now();
    };
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("resume", now); // Page Lifecycle resume (frozen tab woken up)
    window.addEventListener("focus", now);
    window.addEventListener("pageshow", now);
    window.addEventListener("online", now);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("resume", now);
      window.removeEventListener("focus", now);
      window.removeEventListener("pageshow", now);
      window.removeEventListener("online", now);
    };
  }, [key, interval]);

  const refresh = useCallback(
    () => (key ? revalidate<T>(key, () => fetcherRef.current()) : Promise.resolve(undefined)),
    [key],
  );

  return {
    data: state.data,
    error: state.error,
    loading: state.loading || (state.data === undefined && state.error === undefined && !!key),
    refresh,
  };
}
