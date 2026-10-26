"use client";

import { Suspense } from "react";
import { RefreshCw, WifiOff, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { Toaster } from "@/components/ui/toast";
import { startInstallCapture, useOnline, useServiceWorker } from "@/hooks/runtime";
import { applyUpdate, dismissUpdate, useUpdateState } from "@/lib/client/app-update";
import { Spinner } from "@/components/ui/primitives";
import { cx } from "@/lib/client/format";

startInstallCapture();

export function AppRuntime() {
  useServiceWorker();
  return (
    <>
      <Toaster />
      {/* usePathname needs a Suspense boundary under Cache Components */}
      <Suspense fallback={null}>
        <TopBanners />
      </Suspense>
    </>
  );
}

function TopBanners() {
  const online = useOnline();
  const update = useUpdateState();
  const pathname = usePathname() ?? "";
  // never prompt visitors of public share links
  const showUpdate = update.available && !update.dismissed && !pathname.startsWith("/s/") && !pathname.startsWith("/scan");
  return (
    <>
      {(!online || (showUpdate && update.inline === 0)) && (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[90] flex animate-fade-in flex-col items-center gap-2 px-3 pt-[calc(var(--sat)+8px)]">
          {!online && (
            <div role="status" className="flex items-center gap-2 rounded-lg border border-line-strong bg-s2 px-3 py-1.5 text-[13px] font-medium text-ink shadow-lg">
              <WifiOff className="size-3.5" />
              Offline. Showing what is cached.
            </div>
          )}
          {showUpdate && update.inline === 0 && <UpdatePill />}
        </div>
      )}
    </>
  );
}

/** "Update available · Update · ×" pill. */
export function UpdatePill({ className }: { className?: string }) {
  const update = useUpdateState();
  return (
    <div
      role="status"
      aria-live="polite"
      data-update-pill
      className={cx(
        "surface-raised pointer-events-auto flex max-w-full min-w-0 animate-toast-in items-center gap-0.5 rounded-full py-0.5 pr-0.5 pl-3.5 text-[13px]",
        className,
      )}
    >
      <span className="flex size-2 shrink-0 rounded-full bg-accent shadow-[0_0_10px_rgb(185_166_255/0.9)]" />
      <span className="ml-1.5 min-w-0 flex-1 truncate font-medium text-ink">Update available</span>
      <button
        type="button"
        onClick={() => void applyUpdate()}
        disabled={update.applying}
        className="focus-ring ml-2 inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-accent-strong px-4 text-[13px] font-semibold text-white shadow-accent hover:bg-accent-hover disabled:opacity-70"
      >
        {update.applying ? <Spinner className="size-3.5 text-white" /> : <RefreshCw className="size-3.5" />}
        Update
      </button>
      <button
        type="button"
        aria-label="Later"
        title="Later"
        onClick={dismissUpdate}
        className="focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-white/6 hover:text-ink"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Bottom-stack variant used inside the app shell (see UploadTray). */
export function useShowUpdate() {
  const update = useUpdateState();
  const pathname = usePathname() ?? "";
  return update.available && !update.dismissed && !pathname.startsWith("/s/") && !pathname.startsWith("/scan");
}
