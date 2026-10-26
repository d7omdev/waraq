"use client";

import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { AlertCircle, CheckCircle2, FileText, Loader2, X } from "lucide-react";
import { clearFinished, useUploads } from "@/lib/client/uploads";
import { UploadIndicator, useQueueVisible } from "@/components/shell/upload-indicator";
import { UpdatePill, useShowUpdate } from "@/components/app-runtime";
import { registerInlinePrompt } from "@/lib/client/app-update";
import { cx } from "@/lib/client/format";
import type { OcrStatus } from "@/lib/types";
import { Badge, clampPercent, ProgressBar } from "./primitives";

/**
 * Lazy image with a paper placeholder and graceful error fallback. Page
 * renders that are still being built answer 202 {code:"processing"}; the
 * thumb then keeps its skeleton and retries until the image exists.
 */
export function Thumb({
  src,
  alt = "",
  className,
  imgClassName,
  fit = "cover",
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & {
  src?: string;
  imgClassName?: string;
  fit?: "cover" | "contain";
}) {
  const [state, setState] = useState<{ src?: string; status: "loading" | "ok" | "error" | "pending"; attempt: number }>({
    src,
    status: "loading",
    attempt: 0,
  });
  const cur = state.src === src ? state : { src, status: "loading" as const, attempt: 0 };
  const status = cur.status;
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onError = () => {
    if (!src) return;
    const attempt = cur.attempt;
    // find out whether the page is still processing (202) before giving up
    fetch(src, { credentials: "same-origin", cache: "no-store" })
      .then((r) => {
        if (r.status === 202 && attempt < 90) {
          setState({ src, status: "pending", attempt });
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(
            () => setState({ src, status: "loading", attempt: attempt + 1 }),
            Math.min(6000, 1500 + attempt * 250),
          );
        } else setState({ src, status: "error", attempt });
      })
      .catch(() => setState({ src, status: "error", attempt }));
  };
  const url = src && cur.attempt ? `${src}${src.includes("?") ? "&" : "?"}r=${cur.attempt}` : src;
  return (
    <div className={cx("overflow-hidden", !/(^|\s)(absolute|fixed)(\s|$)/.test(className ?? "") && "relative", !/(^|\s)bg-/.test(className ?? "") && "bg-paper", className)}>
      {status !== "error" && status !== "pending" && url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={url}
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setState({ src, status: "ok", attempt: cur.attempt })}
          onError={onError}
          className={cx(
            "absolute inset-0 size-full transition-opacity duration-300",
            fit === "cover" ? "object-cover object-top" : "object-contain",
            status === "ok" ? "opacity-100" : "opacity-0",
            imgClassName,
          )}
          {...rest}
        />
      ) : null}
      {status !== "ok" && (
        <div className="absolute inset-0 flex items-center justify-center text-paper-ink/35">
          {status === "error" ? (
            <FileText className="size-7" />
          ) : (
            <div className={cx("skeleton absolute inset-0", status === "pending" ? "opacity-25" : "opacity-10")} />
          )}
          {status === "pending" && <Loader2 className="relative size-5 animate-spin text-paper-ink/45" aria-label="Processing" />}
        </div>
      )}
    </div>
  );
}

export function OcrBadge({ status, compact }: { status: OcrStatus; compact?: boolean }) {
  if (status === "queued" || status === "running")
    return (
      <Badge tone="accent">
        <Loader2 className="animate-spin" />
        {compact ? "OCR" : status === "queued" ? "OCR queued" : "Reading text"}
      </Badge>
    );
  if (status === "error")
    return (
      <Badge tone="danger">
        <AlertCircle />
        OCR failed
      </Badge>
    );
  if (status === "done" && !compact)
    return (
      <Badge tone="default">
        <CheckCircle2 />
        Text searchable
      </Badge>
    );
  return null;
}

/**
 * Bottom-docked stack for upload progress: the scan queue indicator (scanner
 * stream) above the classic import tray. Publishes its height as --tray-h so
 * toasts stack above it.
 */
export function UploadTray() {
  // usePathname (queue/update visibility) needs a Suspense boundary under Cache Components
  return (
    <Suspense fallback={null}>
      <UploadTrayInner />
    </Suspense>
  );
}

function UploadTrayInner() {
  const jobs = useUploads();
  const queue = useQueueVisible();
  const update = useShowUpdate();
  useEffect(() => registerInlinePrompt(), []);
  if (jobs.length === 0 && !queue && !update) return null;
  return (
    <TrayStack>
      {update && <UpdatePill className="self-center lg:self-end" />}
      <UploadIndicator />
      {jobs.length > 0 && <UploadTrayPanel jobs={jobs} />}
    </TrayStack>
  );
}

function TrayStack({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const set = () => root.style.setProperty("--tray-h", el.offsetHeight ? `${el.offsetHeight + 8}px` : "0px");
    const ro = new ResizeObserver(set);
    ro.observe(el);
    set();
    return () => {
      ro.disconnect();
      root.style.removeProperty("--tray-h");
    };
  }, []);
  return (
    <div
      ref={ref}
      className="pointer-events-none fixed inset-x-3 bottom-[calc(max(var(--dock-h),var(--sab))+12px)] z-[70] mx-auto flex max-w-md flex-col gap-2 [&>*]:pointer-events-auto lg:right-6 lg:bottom-[calc(var(--dock-h)+24px)] lg:left-auto lg:w-[380px]"
      data-upload-tray
    >
      {children}
    </div>
  );
}

export function UploadTrayPanel({ jobs }: { jobs: ReturnType<typeof useUploads> }) {
  const active = jobs.filter((j) => j.status === "uploading");
  const total = jobs.reduce((s, j) => s + j.bytes, 0) || 1;
  const done = jobs.reduce((s, j) => s + j.bytes * (j.status === "uploading" ? j.fraction : 1), 0);
  const failed = jobs.filter((j) => j.status === "error");
  return (
    <div className="surface-raised box-border w-full max-w-full min-w-0 animate-toast-in overflow-hidden rounded-2xl p-3">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        {active.length > 0 ? (
          <Loader2 className="size-4 animate-spin text-accent" />
        ) : failed.length ? (
          <AlertCircle className="size-4 text-danger" />
        ) : (
          <CheckCircle2 className="size-4 text-ok" />
        )}
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {active.length > 0
            ? `Uploading ${active.length} ${active.length === 1 ? "item" : "items"}`
            : failed.length
              ? `${failed.length} upload${failed.length === 1 ? "" : "s"} failed`
              : "Upload complete"}
        </p>
        <span className="shrink-0 font-mono text-xs text-muted">{Math.round(clampPercent(done / total))}%</span>
        {active.length === 0 && (
          <button
            type="button"
            onClick={clearFinished}
            aria-label="Dismiss"
            className="focus-ring -my-1 -mr-1 inline-flex size-9 items-center justify-center rounded-xl text-muted hover:text-ink"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <ProgressBar value={done / total} />
      {jobs.length > 1 || failed.length ? (
        <ul className="thin-scroll mt-2 max-h-32 space-y-1 overflow-y-auto">
          {jobs.map((j) => (
            <li key={j.id} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-muted" dir="auto">
                {j.label}
              </span>
              {j.status === "uploading" && (
                <button type="button" onClick={j.abort} className="text-faint hover:text-ink">
                  Cancel
                </button>
              )}
              {j.status === "error" && <span className="max-w-[50%] min-w-0 truncate text-danger">{j.error}</span>}
              {j.status === "done" && <CheckCircle2 className="size-3.5 text-ok" />}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
