"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AlertCircle, CheckCircle2, ChevronUp, Loader2 } from "lucide-react";
import { cx } from "@/lib/client/format";
import { useUploadQueue } from "./upload-queue-shim";
import { clampPercent, ProgressBar } from "@/components/ui/primitives";

/**
 * Global indicator for the background scan/upload queue (owned by the
 * scanner stream: useUploadQueue). A compact pill at the top of the screen
 * that expands into a list; each finished item links to its document.
 */
export function useQueueVisible() {
  const { items } = useUploadQueue();
  const pathname = usePathname() ?? "";
  return !pathname.startsWith("/scan") && items.some((i) => i.state !== "done");
}

export function UploadIndicator() {
  const { items } = useUploadQueue();
  const visible = useQueueVisible();
  if (!visible) return null;
  return <UploadIndicatorView items={items} />;
}

/** Presentational part (also rendered with fixed items by layout QA). */
export function UploadIndicatorView({ items, defaultOpen = false }: { items: ReturnType<typeof useUploadQueue>["items"]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const active = items.filter((i) => i.state === "uploading" || i.state === "processing");
  const failed = items.filter((i) => i.state === "error");
  const progress = active.length ? active.reduce((s, i) => s + (Number.isFinite(i.progress) ? Math.max(0, Math.min(1, i.progress)) : 0), 0) / active.length : 1;
  const label = active.length
    ? `${active.some((i) => i.state === "uploading") ? "Uploading" : "Processing"} ${active.length === 1 ? active[0].title : `${active.length} scans`}`
    : `${failed.length} ${failed.length === 1 ? "upload" : "uploads"} failed`;
  return (
    <div className="surface-raised box-border flex w-full max-w-full min-w-0 animate-toast-in flex-col overflow-hidden rounded-2xl" data-upload-indicator>
      <div className="order-2 min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="focus-ring flex h-11 w-full min-w-0 items-center gap-2.5 rounded-2xl px-3 text-left"
        >
          {active.length ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
          ) : (
            <AlertCircle className="size-4 shrink-0 text-danger" />
          )}
          <span dir="auto" className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
            {label}
          </span>
          {active.length > 0 && <span className="shrink-0 text-[12px] text-muted tabular-nums">{Math.round(clampPercent(progress))}%</span>}
          <ChevronUp className={cx("size-4 shrink-0 text-faint transition-transform", open && "rotate-180")} />
        </button>
        {active.length > 0 && (
          // padding on a wrapper: a w-full bar with horizontal margins is 24px wider than the card
          <div className="box-border w-full min-w-0 px-3 pb-2">
            <ProgressBar value={progress} label="Upload progress" />
          </div>
        )}
      </div>
      <div className="order-1 min-w-0">
        {open && (
          <ul className="thin-scroll max-h-56 space-y-0.5 overflow-y-auto border-b border-line p-1.5">
            {items.map((i) => {
              const body = (
                <>
                  {i.state === "done" ? (
                    <CheckCircle2 className="size-4 shrink-0 text-ok" />
                  ) : i.state === "error" ? (
                    <AlertCircle className="size-4 shrink-0 text-danger" />
                  ) : (
                    <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
                  )}
                  <span dir="auto" className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {i.title}
                  </span>
                  <span className="shrink-0 text-[12px] text-muted">
                    {i.state === "uploading"
                      ? `${Math.round(clampPercent(i.progress))}%`
                      : i.state === "processing"
                        ? "Processing"
                        : i.state === "error"
                          ? "Failed"
                          : "Done"}
                  </span>
                </>
              );
              return (
                <li key={i.localId}>
                  {i.docId || i.state !== "done" ? (
                    <Link href={i.docId ? `/d/${i.docId}` : `/p/${encodeURIComponent(i.localId)}`} className="focus-ring flex h-11 min-w-0 items-center gap-2.5 rounded-xl px-2 hover:bg-white/5">
                      {body}
                    </Link>
                  ) : (
                    <div className="flex h-11 min-w-0 items-center gap-2.5 px-2">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
