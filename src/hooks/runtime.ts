"use client";

import { useEffect, useSyncExternalStore } from "react";
import { startUpdateWatcher } from "@/lib/client/app-update";

/* ----------------------------- install prompt ----------------------------- */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const installListeners = new Set<() => void>();
const emitInstall = () => installListeners.forEach((l) => l());

let captureStarted = false;
/** Called as early as possible (root client component module scope + effect). */
export function startInstallCapture() {
  if (captureStarted || typeof window === "undefined") return;
  captureStarted = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    const first = !deferred;
    deferred = e as BeforeInstallPromptEvent;
    void first;
    emitInstall();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    emitInstall();
  });
}
if (typeof window !== "undefined") startInstallCapture();

export interface InstallState {
  /** A captured beforeinstallprompt event is waiting. */
  canPrompt: boolean;
  /** Running as an installed app (display-mode standalone or iOS navigator.standalone). */
  standalone: boolean;
  /** appinstalled fired during this session. */
  installed: boolean;
  ios: boolean;
  android: boolean;
  /** Phone or tablet (touch-first UA). */
  mobile: boolean;
}

let cachedInstall: InstallState | null = null;
function computeInstall(): InstallState {
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    false;
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const android = /android/i.test(ua);
  const mobile = ios || android || /mobi/i.test(ua);
  const next: InstallState = { canPrompt: !!deferred, standalone, installed, ios, android, mobile };
  if (cachedInstall && (Object.keys(next) as (keyof InstallState)[]).every((k) => cachedInstall![k] === next[k]))
    return cachedInstall;
  cachedInstall = next;
  return next;
}
const serverInstall: InstallState = {
  canPrompt: false,
  standalone: false,
  installed: false,
  ios: false,
  android: false,
  mobile: false,
};

function subscribeInstall(cb: () => void) {
  installListeners.add(cb);
  const mq = window.matchMedia?.("(display-mode: standalone)");
  mq?.addEventListener?.("change", cb);
  return () => {
    installListeners.delete(cb);
    mq?.removeEventListener?.("change", cb);
  };
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribeInstall, computeInstall, () => serverInstall);
}

/* ---------------------------- install banner ---------------------------- */

const DISMISS_KEY = "waraq:install-dismissed";
const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;

function readDismissed(): boolean {
  try {
    const at = Number(window.localStorage.getItem(DISMISS_KEY) || 0);
    return !!at && Date.now() - at < DISMISS_MS;
  } catch {
    return false;
  }
}

/** Hide the install banner for 14 days. */
export function dismissInstallBanner() {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* private mode */
  }
  emitInstall();
}

/** True when the compact install banner should show: mobile, in a browser tab, not dismissed recently. */
export function useInstallBanner(): { show: boolean; state: InstallState } {
  const state = useInstallState();
  const dismissed = useSyncExternalStore(
    (cb) => {
      installListeners.add(cb);
      window.addEventListener("storage", cb);
      return () => {
        installListeners.delete(cb);
        window.removeEventListener("storage", cb);
      };
    },
    readDismissed,
    () => true,
  );
  const show = state.mobile && !state.standalone && !state.installed && !dismissed;
  return { show, state };
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferred) return "unavailable";
  const ev = deferred;
  deferred = null;
  emitInstall();
  await ev.prompt();
  const choice = await ev.userChoice;
  return choice.outcome;
}

/* --------------------------------- online --------------------------------- */

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/* ----------------------------- service worker ----------------------------- */

/** Registers the service worker and starts update checks (see lib/client/app-update). */
export function useServiceWorker() {
  useEffect(() => {
    startUpdateWatcher();
  }, []);
}

/* ------------------------------ media queries ----------------------------- */

export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}
