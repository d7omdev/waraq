"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useRef, useState, type ReactNode } from "react";
import { Folder as FolderIcon, FolderPlus, Library, ScanLine, Settings, Star, Trash2 } from "lucide-react";
import { cx } from "@/lib/client/format";
import { flattenFolders, useFolders, type FolderNode } from "@/hooks/data";
import { useFolderDrop } from "@/lib/client/dnd";
import { FolderEditSheet } from "@/components/library/folder-sheets";
import { Wordmark } from "@/components/brand";
import { UploadTray } from "@/components/ui/media";
import { useDock } from "@/hooks/use-dock";
import { DriveCallbackToast } from "@/components/drive/drive-common";

const NAV = [
  { href: "/", label: "Library", icon: Library },
  { href: "/starred", label: "Starred", icon: Star },
  { href: "/trash", label: "Trash", icon: Trash2 },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname.startsWith("/f/");
  if (href === "/settings") return pathname.startsWith("/settings");
  return pathname.startsWith(href);
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh lg:pl-[260px]">
      <Suspense fallback={<SidebarFrame pathname="" />}>
        <Sidebar />
      </Suspense>
      <main className="min-h-dvh">
        <DriveCallbackToast />
        {children}
      </main>
      <Suspense fallback={null}>
        <BottomNav />
      </Suspense>
      <UploadTray />
    </div>
  );
}

function Sidebar() {
  const pathname = usePathname();
  return <SidebarFrame pathname={pathname} />;
}

function SidebarFrame({ pathname }: { pathname: string }) {
  const { data: folders } = useFolders();
  const [creating, setCreating] = useState(false);
  const flat = flattenFolders(folders);
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[260px] flex-col border-r border-line bg-[linear-gradient(180deg,rgb(124_77_255/0.07),rgb(124_77_255/0)_260px)] bg-s1 px-3.5 pt-6 pb-4 lg:flex">
      <Link href="/" className="focus-ring mb-6 flex h-10 items-center rounded-xl px-2">
        <Wordmark />
      </Link>
      <Link
        href="/scan"
        className="focus-ring mb-6 flex h-11 items-center justify-center gap-2 rounded-xl bg-accent-strong bg-[linear-gradient(180deg,rgb(255_255_255/0.14),rgb(255_255_255/0))] text-sm font-semibold text-white shadow-glow transition-colors hover:bg-accent-hover active:bg-accent-deep"
      >
        <ScanLine className="size-[18px]" /> Scan document
      </Link>
      <nav className="space-y-0.5">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              className={cx(
                "focus-ring relative flex h-10 items-center gap-3 rounded-xl px-3 text-sm transition-colors",
                active
                  ? "bg-accent-tint font-medium text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] before:absolute before:top-2.5 before:bottom-2.5 before:-left-3.5 before:w-[3px] before:rounded-r-full before:bg-accent"
                  : "text-muted hover:bg-white/4 hover:text-ink",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className={cx("size-[18px]", active ? "text-accent" : "text-faint")} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-6 mb-1 flex items-center justify-between pr-1 pl-2.5">
        <span className="text-[12px] font-medium tracking-[0.08em] text-faint uppercase">Folders</span>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="focus-ring inline-flex size-8 items-center justify-center rounded-lg text-faint hover:bg-white/6 hover:text-ink"
          aria-label="New folder"
        >
          <FolderPlus className="size-4" />
        </button>
      </div>
      <div className="thin-scroll -mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1">
        {flat.length === 0 && <p className="px-2.5 text-[13px] text-faint">No folders yet</p>}
        {flat.map((f) => (
          <SidebarFolder key={f.id} folder={f} active={pathname === `/f/${f.id}`} />
        ))}
      </div>
      <FolderEditSheet open={creating} onClose={() => setCreating(false)} />
    </aside>
  );
}

function SidebarFolder({ folder: f, active }: { folder: FolderNode; active: boolean }) {
  const { over, handlers } = useFolderDrop(f.id, f.name);
  return (
    <Link
      href={`/f/${f.id}`}
      {...handlers}
      className={cx(
        "focus-ring flex h-9 items-center gap-2.5 rounded-xl pr-2.5 text-sm transition-colors",
        active ? "bg-accent-tint font-medium text-ink" : "text-muted hover:bg-white/4 hover:text-ink",
        over && "bg-accent-tint text-ink ring-2 ring-accent/50",
      )}
      style={{ paddingLeft: 10 + Math.min(f.depth, 4) * 14 }}
    >
      <FolderIcon className="size-4 shrink-0 text-faint" style={f.color ? { color: f.color } : undefined} />
      <span className="min-w-0 flex-1 truncate" dir="auto">
        {f.name}
      </span>
      <span className="text-[12px] text-faint tabular-nums">{f.docCount}</span>
    </Link>
  );
}

function BottomNav() {
  const pathname = usePathname();
  const hidden = pathname.startsWith("/d/");
  const ref = useRef<HTMLElement>(null);
  useDock(ref, !hidden);
  if (hidden) return null;
  const items = [NAV[0], NAV[1], null, NAV[2], NAV[3]];
  return (
    <nav
      ref={ref}
      className="bar fixed inset-x-0 bottom-0 z-30 border-t border-line pb-[var(--sab)] lg:hidden"
      aria-label="Primary"
    >
      <div className="mx-auto grid h-16 max-w-lg grid-cols-5 items-stretch px-1.5">
        {items.map((item) => {
          if (!item)
            return (
              <Link
                key="scan"
                href="/scan"
                aria-label="Scan document"
                title="Scan document"
                className="focus-ring group flex min-w-0 items-center justify-center rounded-2xl"
              >
                <span className="flex h-12 w-14 items-center justify-center rounded-2xl bg-accent-strong bg-[linear-gradient(180deg,rgb(255_255_255/0.16),rgb(255_255_255/0))] text-white shadow-glow transition-[transform,background-color] group-hover:bg-accent-hover group-active:scale-95 group-active:bg-accent-deep">
                  <ScanLine className="size-6" />
                </span>
              </Link>
            );
          const { href, label, icon: Icon } = item;
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cx(
                "focus-ring flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl text-[11px] transition-colors",
                active ? "font-semibold text-ink" : "font-medium text-faint hover:text-muted",
              )}
            >
              <span
                className={cx(
                  "flex h-8 w-14 max-w-full items-center justify-center rounded-full transition-colors",
                  active && "bg-accent-tint text-accent",
                )}
              >
                <Icon className="size-5" strokeWidth={active ? 2.25 : 1.75} />
              </span>
              <span className="max-w-full truncate">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
