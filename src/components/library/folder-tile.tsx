"use client";

import Link from "next/link";
import { Folder as FolderIcon, MoreHorizontal } from "lucide-react";
import type { Folder } from "@/lib/types";
import { cx, plural } from "@/lib/client/format";
import { useFolderDrop } from "@/lib/client/dnd";
import { Thumb } from "@/components/ui/media";

type F = Folder;

function tint(color: string | null) {
  return color
    ? { color, background: `color-mix(in srgb, ${color} 16%, transparent)` }
    : undefined;
}

/**
 * Folder tile for the folders browse mode: stacked previews of the first
 * documents, name and counts. Drop documents on it to move them (desktop).
 */
export function FolderTile({
  folder,
  subfolders,
  onMenu,
  compact,
}: {
  folder: F;
  subfolders: number;
  onMenu: () => void;
  compact?: boolean;
}) {
  const { over, handlers } = useFolderDrop(folder.id, folder.name);
  const thumbs = (folder.previewThumbs ?? []).slice(0, 3);
  const children = folder.childCount ?? subfolders;
  const meta = [folder.docCount ? plural(folder.docCount, "doc") : "Empty", children ? plural(children, "folder") : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="group relative min-w-0" {...handlers} data-folder-tile>
      <Link
        href={`/f/${folder.id}`}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu();
        }}
        className={cx(
          "surface focus-ring flex min-w-0 flex-col overflow-hidden rounded-2xl transition-[border-color,box-shadow,transform] duration-150 hover:border-line-strong active:scale-[0.985]",
          over && "border-accent ring-2 ring-accent/50",
        )}
      >
        <div
          className={cx("relative overflow-hidden bg-[linear-gradient(160deg,rgb(124_77_255/0.10),rgb(124_77_255/0)_70%)]", compact ? "h-[72px]" : "h-24 sm:h-28")}
          style={folder.color ? { background: `linear-gradient(160deg, color-mix(in srgb, ${folder.color} 18%, transparent), transparent 75%)` } : undefined}
        >
          {thumbs.length > 0 && (
            <span
              className="absolute top-2 left-2 z-[3] flex size-7 items-center justify-center rounded-lg bg-black/45 text-accent backdrop-blur-sm"
              style={folder.color ? { color: folder.color } : undefined}
            >
              <FolderIcon className="size-4" />
            </span>
          )}
          {thumbs.length ? (
            <div className="absolute inset-x-0 -bottom-2 flex h-full items-end justify-center">
              {thumbs.map((t, i) => (
                <div
                  key={t}
                  className="relative -mx-3 h-[86%] w-[36%] max-w-[78px] overflow-hidden rounded-t-[5px] shadow-paper"
                  style={{
                    transform: `rotate(${(i - (thumbs.length - 1) / 2) * 7}deg) translateY(${i === Math.floor(thumbs.length / 2) ? 0 : 4}px)`,
                    zIndex: i === Math.floor(thumbs.length / 2) ? 2 : 1,
                  }}
                >
                  <Thumb src={t} className="absolute inset-0" />
                </div>
              ))}
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-accent-tint text-accent" style={tint(folder.color)}>
                <FolderIcon className="size-5" />
              </span>
            </div>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 border-t border-line px-3 py-2.5">
          <span className="min-w-0 flex-1">
            <span dir="auto" className="block truncate text-[14px] leading-tight font-medium text-ink">
              {folder.name}
            </span>
            <span className="mt-0.5 block truncate text-[12px] text-muted tabular-nums">{meta}</span>
          </span>
        </div>
      </Link>
      <button
        type="button"
        aria-label={`Options for ${folder.name}`}
        onClick={onMenu}
        className="focus-ring absolute top-0 right-0 inline-flex size-11 items-center justify-center rounded-xl text-muted hover:text-ink"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
          <MoreHorizontal className="size-[18px]" />
        </span>
      </button>
    </div>
  );
}

/** Compact chip used in the flat ("all documents") mode. */
export function FolderChip({ folder, onMenu }: { folder: F; onMenu: () => void }) {
  const { over, handlers } = useFolderDrop(folder.id, folder.name);
  return (
    <Link
      href={`/f/${folder.id}`}
      {...handlers}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu();
      }}
      className={cx(
        "surface focus-ring flex h-12 max-w-[240px] shrink-0 items-center gap-2.5 rounded-2xl pr-3.5 pl-2 text-sm text-ink transition-colors hover:border-line-strong",
        over && "border-accent ring-2 ring-accent/50",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-accent-tint text-accent" style={tint(folder.color)}>
        <FolderIcon className="size-4" />
      </span>
      <span dir="auto" className="min-w-0 truncate font-medium">
        {folder.name}
      </span>
      <span className="shrink-0 text-[13px] text-faint tabular-nums">{folder.docCount}</span>
    </Link>
  );
}

/** Breadcrumb link that also accepts dropped documents. */
export function CrumbDrop({ href, folderId, name, children, className }: { href: string; folderId: string | null; name: string; children: React.ReactNode; className?: string }) {
  const { over, handlers } = useFolderDrop(folderId, name);
  return (
    <Link href={href} {...handlers} dir="auto" className={cx(className, over && "bg-accent-tint text-ink ring-2 ring-accent/50")}>
      {children}
    </Link>
  );
}
