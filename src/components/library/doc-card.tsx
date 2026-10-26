"use client";

import Link from "next/link";
import { AlertCircle, Check, Loader2, Star } from "lucide-react";
import type { DocSummary } from "@/lib/types";
import { startDocDrag } from "@/lib/client/dnd";
import { cx, daysAgo, formatBytes, formatDate, plural } from "@/lib/client/format";
import { useLongPress } from "@/hooks/use-long-press";
import { OcrBadge, Thumb } from "@/components/ui/media";

/**
 * Search snippet. The backend marks hits as [[term]] (FTS snippet()); older
 * responses may use <b>/<mark>. Render hits as <mark> without innerHTML.
 */
export function Snippet({ text, className }: { text: string; className?: string }) {
  const clean = text.replace(/\s+/g, " ").trim();
  const parts = clean.split(/(\[\[|\]\]|<\/?(?:b|mark|em|strong)>)/gi);
  let on = false;
  const out: { t: string; on: boolean }[] = [];
  for (const p of parts) {
    if (p === "[[" || /^<(b|mark|em|strong)>$/i.test(p)) on = true;
    else if (p === "]]" || /^<\/(b|mark|em|strong)>$/i.test(p)) on = false;
    else if (p) out.push({ t: p.replace(/<[^>]+>/g, ""), on });
  }
  return (
    <p dir="auto" className={cx("ocr-text line-clamp-2 text-[13px] leading-snug text-muted", className)}>
      {out.map((s, i) => (s.on ? <mark key={i}>{s.t}</mark> : <span key={i}>{s.t}</span>))}
    </p>
  );
}

export function DocCard({
  doc,
  view,
  selecting,
  selected,
  onToggle,
  onLongPress,
  trash,
  dragIds,
}: {
  doc: DocSummary;
  view: "grid" | "list";
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onLongPress: () => void;
  trash?: boolean;
  /** ids moved when this card is dragged onto a folder (desktop) */
  dragIds?: () => string[];
}) {
  const { handlers, consumed } = useLongPress(onLongPress);
  const href = trash ? "#" : `/d/${doc.id}`;
  const ago = doc.trashedAt ? daysAgo(doc.trashedAt) : 0;
  const date =
    trash && doc.trashedAt
      ? `Deleted ${ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`}`
      : formatDate(doc.updatedAt);
  const pages = plural(doc.pageCount, "page");
  const processing = doc.status === "processing";
  const failed = doc.status === "error";
  const prog = doc.processing;
  const progLabel = prog && prog.pagesTotal ? `${Math.min(prog.pagesDone, prog.pagesTotal)}/${prog.pagesTotal}` : null;
  const drag = !trash && dragIds
    ? {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          const ids = dragIds();
          startDocDrag(e, ids, ids.length > 1 ? plural(ids.length, "document") : doc.title);
        },
      }
    : { draggable: false };

  const onClick = (e: React.MouseEvent) => {
    if (consumed()) {
      e.preventDefault();
      return;
    }
    if (selecting || trash || e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      onToggle();
    }
  };

  const check = (
    <span
      className={cx(
        "flex size-6 items-center justify-center rounded-full border-[1.5px] shadow-[0_1px_4px_rgb(0_0_0/0.5)] transition-colors",
        selected ? "border-accent-strong bg-accent-strong text-white" : "border-white/85 bg-black/40 text-transparent",
      )}
    >
      <Check className="size-3.5" strokeWidth={3} />
    </span>
  );

  if (view === "list") {
    return (
      <Link
        href={href}
        prefetch={false}
        onClick={onClick}
        {...handlers}
        {...drag}
        aria-selected={selecting ? selected : undefined}
        data-doc-card
        className={cx(
          "surface focus-ring group flex min-h-[76px] min-w-0 items-center gap-3 rounded-2xl py-2.5 pr-3 pl-2.5 transition-colors [-webkit-touch-callout:none]",
          selected ? "border-accent/60 bg-accent-tint" : "hover:border-line-strong",
        )}
      >
        <div className="relative shrink-0">
          <div className="flex h-14 w-11 items-center justify-center rounded-lg bg-s3 p-1">
            {processing ? (
              <div className="skeleton size-full rounded-[3px]" />
            ) : (
              <Thumb src={doc.thumbUrl} className="size-full rounded-[3px] shadow-paper" />
            )}
          </div>
          {selecting && <span className="absolute -top-1.5 -left-1.5">{check}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <p dir="auto" className="truncate text-[15px] font-medium text-ink">
            {doc.title}
          </p>
          <p className="mt-0.5 truncate text-[13px] text-muted">
            {processing ? (
              <span className="text-accent">Processing{progLabel ? ` ${progLabel}` : "…"}</span>
            ) : failed ? (
              <span className="text-danger">Processing failed</span>
            ) : (
              <>
                {date} · {pages} · {formatBytes(doc.sizeBytes)}
              </>
            )}
          </p>
          {doc.snippet && <Snippet text={doc.snippet} className="mt-1" />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <OcrBadge status={doc.ocrStatus} compact />
          {doc.starred && <Star className="size-4 fill-warn text-warn" aria-label="Starred" />}
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={href}
      prefetch={false}
      onClick={onClick}
      {...handlers}
      {...drag}
      aria-selected={selecting ? selected : undefined}
      data-doc-card
      className="focus-ring group @container block min-w-0 rounded-2xl [-webkit-touch-callout:none]"
    >
      <div
        className={cx(
          "surface relative aspect-[3/4] overflow-hidden rounded-2xl transition-[border-color,transform] duration-200 group-active:scale-[0.98] @max-[120px]:rounded-xl",
          selected ? "border-accent ring-2 ring-accent/60" : "group-hover:border-line-strong",
        )}
      >
        <div className="absolute inset-x-[11%] top-[9%] bottom-0 overflow-hidden rounded-t-[5px] shadow-paper transition-transform duration-300 group-hover:-translate-y-0.5">
          {processing ? <div className="skeleton absolute inset-0 opacity-60" /> : <Thumb src={doc.thumbUrl} className="absolute inset-0" />}
        </div>
        {processing && (
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 pt-6 pb-2 text-[12px] font-medium text-white @max-[120px]:text-[11px]">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span className="truncate">{progLabel ?? "Processing"}</span>
          </span>
        )}
        {failed && (
          <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-danger/90 px-2 py-0.5 text-[11px] font-semibold text-black">
            <AlertCircle className="size-3" /> Failed
          </span>
        )}
        {doc.starred && (
          <span
            className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-black/55 text-warn shadow-[0_1px_4px_rgb(0_0_0/0.4)] @max-[120px]:top-1 @max-[120px]:right-1 @max-[120px]:size-5"
            aria-label="Starred"
          >
            <Star className="size-3.5 fill-current" />
          </span>
        )}
        {!processing && !failed && (doc.ocrStatus === "queued" || doc.ocrStatus === "running" || doc.ocrStatus === "error") && (
          <span className="absolute bottom-2 left-2 @max-[120px]:hidden">
            <OcrBadge status={doc.ocrStatus} compact />
          </span>
        )}
        {selecting && <span className="absolute top-2 left-2 @max-[120px]:top-1 @max-[120px]:left-1">{check}</span>}
      </div>
      <div className="min-w-0 px-1 pt-2.5 @max-[120px]:px-0.5 @max-[120px]:pt-1.5">
        <p
          dir="auto"
          className="line-clamp-2 text-sm leading-snug font-medium break-words text-ink @max-[160px]:text-[13px] @max-[120px]:line-clamp-1 @max-[120px]:text-[12px]"
        >
          {doc.title}
        </p>
        <p className="mt-0.5 truncate text-[13px] text-muted @max-[160px]:text-[12px] @max-[120px]:hidden">
          {date}
          <span className="@max-[160px]:hidden"> · {pages}</span>
        </p>
        {doc.snippet && <Snippet text={doc.snippet} className="mt-1 @max-[120px]:hidden" />}
      </div>
    </Link>
  );
}

export function DocCardSkeleton({ view }: { view: "grid" | "list" }) {
  if (view === "list")
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-line px-2.5 py-2.5">
        <div className="skeleton h-14 w-11 rounded-lg" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-4 w-2/3 rounded-md" />
          <div className="skeleton h-3 w-1/3 rounded-md" />
        </div>
      </div>
    );
  return (
    <div>
      <div className="skeleton aspect-[3/4] rounded-2xl" />
      <div className="skeleton mt-2.5 h-4 w-4/5 rounded-md" />
      <div className="skeleton mt-1.5 h-3 w-1/2 rounded-md" />
    </div>
  );
}
