"use client";

import { useEffect, useSyncExternalStore } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { cx } from "@/lib/client/format";
import { vibrate } from "@/lib/client/device";

export interface ToastInput {
  message: string;
  tone?: "default" | "success" | "error";
  action?: { label: string; onClick: () => void };
  duration?: number;
  /** Optional stable id so repeated toasts replace each other. */
  id?: string;
}

interface ToastItem extends ToastInput {
  id: string;
  createdAt: number;
}

let items: ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, number>();
let counter = 0;

function emit() {
  listeners.forEach((l) => l());
}

export function dismissToast(id: string) {
  items = items.filter((t) => t.id !== id);
  const t = timers.get(id);
  if (t) window.clearTimeout(t);
  timers.delete(id);
  emit();
}

export function toast(input: ToastInput | string): string {
  const t: ToastInput = typeof input === "string" ? { message: input } : input;
  const id = t.id ?? `t${++counter}`;
  const existing = timers.get(id);
  if (existing) window.clearTimeout(existing);
  const item: ToastItem = { ...t, id, createdAt: Date.now() };
  // results you can feel where the browser supports vibration (saved / copied / failed)
  if (t.tone === "success") vibrate([10, 30, 10], "success");
  else if (t.tone === "error") vibrate([30, 20, 30], "error");
  items = [...items.filter((x) => x.id !== id), item].slice(-3);
  emit();
  const duration = t.duration ?? (t.action ? 6000 : t.tone === "error" ? 5000 : 3200);
  if (duration > 0) timers.set(id, window.setTimeout(() => dismissToast(id), duration));
  return id;
}

toast.success = (message: string, extra?: Partial<ToastInput>) => toast({ message, tone: "success", ...extra });
toast.error = (message: string, extra?: Partial<ToastInput>) => toast({ message, tone: "error", ...extra });

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
const getItems = () => items;
const NO_ITEMS: ToastItem[] = [];
const getServerItems = () => NO_ITEMS;

export function Toaster() {
  const list = useSyncExternalStore(subscribe, getItems, getServerItems);
  useEffect(() => () => timers.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => {
    // QA hook: lets the screenshot harness raise a toast over docked bars.
    if (process.env.NODE_ENV !== "production") (window as unknown as { __waraqToast?: typeof toast }).__waraqToast = toast;
  }, []);
  return (
    <div
      data-toaster
      className="pointer-events-none fixed inset-x-0 bottom-[calc(max(var(--dock-h),var(--sab))+12px+var(--tray-h,0px))] z-[80] flex flex-col items-center gap-2 px-3 lg:right-6 lg:bottom-[calc(var(--dock-h)+24px+var(--tray-h,0px))] lg:left-auto lg:items-end"
      aria-live="polite"
    >
      {list.map((t) => (
        <div
          key={t.id}
          className="surface-raised pointer-events-auto flex w-full max-w-[440px] min-w-0 animate-toast-in items-center gap-3 rounded-2xl py-1.5 pr-1.5 pl-3.5"
          role={t.tone === "error" ? "alert" : "status"}
        >
          <span
            className={cx(
              "shrink-0 [&_svg]:size-[18px]",
              t.tone === "success" ? "text-ok" : t.tone === "error" ? "text-danger" : "text-accent",
            )}
          >
            {t.tone === "success" ? <CheckCircle2 /> : t.tone === "error" ? <AlertTriangle /> : <Info />}
          </span>
          <p className="min-w-0 flex-1 py-1.5 text-sm leading-snug text-ink" dir="auto">
            {t.message}
          </p>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action?.onClick();
                dismissToast(t.id);
              }}
              className="focus-ring h-10 shrink-0 rounded-xl px-3 text-sm font-semibold text-accent hover:bg-accent-tint"
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(t.id)}
            className="focus-ring inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-faint hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
