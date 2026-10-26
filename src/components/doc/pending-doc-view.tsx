"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, Check, CloudUpload, Loader2, RotateCw, Trash2 } from "lucide-react";
import { cx } from "@/lib/client/format";
import { dismissUpload, retryUpload, useUploadItem, type UploadQueueItem, type UploadQueuePage } from "@/lib/client/upload-queue";
import { Button, clampPercent, EmptyState, ProgressBar, Skeleton } from "@/components/ui/primitives";

/**
 * A just-saved scan that is still being enhanced/uploaded on this device.
 * Shows the local pages with per-page status, then swaps to /d/<id> as soon
 * as the server has the document (the doc page shows the server-side
 * processing from there).
 */
export function PendingDocView() {
  const router = useRouter();
  const params = useParams<{ localId: string }>();
  const localId = decodeURIComponent(params.localId ?? "");
  const item = useUploadItem(localId);
  const docId = item?.state === "done" ? item.docId : undefined;

  useEffect(() => {
    if (docId) router.replace(`/d/${encodeURIComponent(docId)}`);
  }, [docId, router]);

  if (item === undefined) return <Loading />;
  if (item === null)
    return (
      <div className="pt-[calc(var(--sat)+40px)]">
        <EmptyState
          title="Nothing pending"
          body="This scan has finished or was removed from this device."
          action={
            <Link href="/" className="focus-ring inline-flex h-11 items-center rounded-lg border border-line-strong bg-s2 px-4 text-sm">
              Back to library
            </Link>
          }
        />
      </div>
    );

  return (
    <div className="pb-dock mx-auto w-full max-w-[1500px]">
      <header className="bar sticky top-0 z-20 border-b border-line px-2 pt-[var(--sat)] sm:px-4 lg:px-8">
        <div className="flex h-14 min-w-0 items-center gap-1">
          <Link
            href="/"
            className="focus-ring inline-flex h-11 min-w-0 items-center gap-1.5 rounded-xl pr-3 pl-2.5 text-[15px] text-muted hover:bg-white/6 hover:text-ink"
          >
            <ArrowLeft className="size-5 shrink-0 text-ink" />
            <span className="truncate">Library</span>
          </Link>
          <div className="flex-1" />
        </div>
      </header>

      <section className="min-w-0 overflow-hidden px-4 pt-5 sm:px-6 lg:px-10 lg:pt-8">
        <h1 dir="auto" className="display text-[24px] leading-[1.15] [overflow-wrap:anywhere] text-ink sm:text-[32px]">
          {item.title}
        </h1>
        <StatusLine item={item} />
      </section>

      <div className="px-4 pt-5 sm:px-6 lg:px-10">
        <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6" data-pending-pages>
          {item.pages.map((p, i) => (
            <PendingTile key={p.id} page={p} position={i} />
          ))}
        </div>
        <p className="mt-6 text-[13px] text-faint">You can leave this page. The scan keeps uploading in the background{item.state === "error" ? " once retried" : ""}.</p>
      </div>
    </div>
  );
}

export function StatusLine({ item }: { item: UploadQueueItem }) {
  const n = item.pages.length;
  if (item.state === "error")
    return (
      <div className="surface mt-4 flex min-w-0 flex-wrap items-center gap-3 rounded-2xl py-2.5 pr-2.5 pl-3.5 text-sm" role="alert">
        <AlertCircle className="size-4 shrink-0 text-danger" />
        <span className="min-w-0 flex-1 text-ink">{item.error || "Upload failed"}. Your pages are kept on this device.</span>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => dismissUpload(item.localId)}>
            Discard
          </Button>
          <Button size="sm" variant="primary" icon={<RotateCw className="size-4" />} onClick={() => retryUpload(item.localId)}>
            Retry
          </Button>
        </div>
      </div>
    );
  const label =
    item.state === "processing"
      ? `Enhancing page ${Math.min(n, item.pagesProcessed + 1)} of ${n}`
      : item.state === "uploading"
        ? `Uploading ${n} ${n === 1 ? "page" : "pages"} · ${Math.round(clampPercent(item.uploadFraction))}%`
        : "Opening document…";
  return (
    <div className="mt-3 w-full max-w-md min-w-0" aria-live="polite">
      <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
        {item.state === "uploading" ? <CloudUpload className="size-4 shrink-0 text-accent" /> : <Loader2 className="size-4 shrink-0 animate-spin text-accent" />}
        <span className="min-w-0 truncate tabular-nums">{label}</span>
      </div>
      {item.error && <p className="mt-1 text-[12px] text-warn">{item.error}</p>}
      <ProgressBar value={item.progress} className="mt-2" label="Scan progress" />
    </div>
  );
}

function PendingTile({ page, position }: { page: UploadQueuePage; position: number }) {
  const busy = page.state === "queued" || page.state === "processing";
  const rot = page.rotation;
  const sideways = rot === 90 || rot === 270;
  return (
    <div className="relative" data-pending-page={page.state}>
      <div className="surface relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-2xl">
        <div className="absolute inset-x-3 top-3 bottom-8 flex items-center justify-center">
          {page.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={page.thumbUrl}
              alt=""
              decoding="async"
              className={cx(
                "max-h-full max-w-full object-contain drop-shadow-[0_6px_10px_rgb(0_0_0/0.55)] transition-[opacity,filter] duration-300",
                busy && "opacity-55 blur-[0.5px] saturate-50",
              )}
              style={rot ? { transform: `rotate(${rot}deg)`, ...(sideways ? { maxWidth: "75%", maxHeight: "75%" } : {}) } : undefined}
            />
          ) : (
            <div className="skeleton absolute inset-0 rounded-md opacity-60" />
          )}
        </div>
        {page.state !== "done" && (
          <span className="absolute top-2 left-2 inline-flex h-6 items-center gap-1 rounded-full bg-black/60 px-2 text-[11px] font-medium text-white/90">
            {page.state === "processing" ? (
              <>
                <Loader2 className="size-3 animate-spin" /> Enhancing
              </>
            ) : page.state === "queued" ? (
              "Waiting"
            ) : page.state === "uploading" ? (
              <>
                <CloudUpload className="size-3" /> Uploading
              </>
            ) : page.state === "error" ? (
              <>
                <AlertCircle className="size-3 text-danger" /> Failed
              </>
            ) : (
              <>
                <Check className="size-3 text-ok" strokeWidth={3} /> Ready
              </>
            )}
          </span>
        )}
      </div>
      <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2 text-[12px] leading-5 font-medium text-white/90 tabular-nums">
        {position + 1}
      </span>
    </div>
  );
}

function Loading() {
  return (
    <div className="mx-auto max-w-[1500px] px-4 pt-[calc(var(--sat)+70px)] sm:px-6 lg:px-10">
      <Skeleton className="h-9 w-3/4 max-w-md" />
      <Skeleton className="mt-4 h-4 w-1/2 max-w-xs" />
    </div>
  );
}
