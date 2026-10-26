"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cx } from "@/lib/client/format";

let openCount = 0;

/**
 * Bottom sheet on phones, centered dialog on >= sm screens.
 * Drag the handle/header down to dismiss. Escape and backdrop close it.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  bare,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  bare?: boolean;
}) {
  // Rendered only while this component is "visible" (Next keeps hidden routes
  // mounted inside <Activity>; effects are torn down when hidden).
  const [attached, setAttached] = useState(false);
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAttached(true);
    return () => setAttached(false);
  }, []);

  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; dy: number; pointerId: number } | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const visible = open && attached;

  useEffect(() => {
    if (!visible) return;
    openCount++;
    document.documentElement.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    const prevFocus = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>("[data-autofocus]");
      if (el) el.focus();
      else panelRef.current?.focus();
    }, 60);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      openCount--;
      if (openCount <= 0) {
        openCount = 0;
        document.documentElement.style.overflow = "";
      }
      prevFocus?.focus?.({ preventScroll: true });
    };
  }, [visible]);

  if (!visible) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    if (window.matchMedia("(min-width: 640px)").matches) return;
    drag.current = { startY: e.clientY, dy: 0, pointerId: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !panelRef.current) return;
    d.dy = Math.max(0, e.clientY - d.startY);
    panelRef.current.style.transition = "none";
    panelRef.current.style.transform = `translateY(${d.dy}px)`;
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    const panel = panelRef.current;
    if (!d || !panel) return;
    panel.style.transition = "transform 220ms cubic-bezier(0.22,1,0.36,1)";
    if (d.dy > 110) {
      panel.style.transform = "translateY(100%)";
      window.setTimeout(() => onCloseRef.current(), 180);
    } else {
      panel.style.transform = "";
    }
  };

  const widths = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl" };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6">
      <div
        className="absolute inset-0 animate-fade-in bg-[#06050a]/70"
        onClick={() => onCloseRef.current()}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={cx(
          "relative flex max-h-[calc(100dvh-var(--sat)-12px)] w-full max-w-full min-w-0 flex-col overflow-hidden rounded-t-3xl border border-b-0 border-line-strong bg-s1 bg-[linear-gradient(180deg,rgb(255_255_255/0.035),rgb(255_255_255/0)_120px)] shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_-20px_60px_-20px_rgb(0_0_0/0.9)] outline-none",
          "animate-sheet-in sm:max-h-[86dvh] sm:animate-pop-in sm:rounded-3xl sm:border-b",
          widths[size],
        )}
      >
        <div
          className="shrink-0 touch-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="flex justify-center pt-2.5 pb-1 sm:hidden">
            <span className="h-1 w-10 rounded-full bg-white/22" />
          </div>
          {!bare && (title || description) && (
            <div className="flex items-start gap-3 pt-2 pr-3 pb-3 pl-5 sm:pt-5">
              <div className="min-w-0 flex-1">
                {title && <h2 className="truncate text-[18px] leading-snug font-semibold tracking-[-0.01em] text-ink" dir="auto">{title}</h2>}
                {description && <p className="mt-0.5 line-clamp-2 text-[13px] break-words text-muted" dir="auto">{description}</p>}
              </div>
              <button
                type="button"
                onClick={() => onCloseRef.current()}
                aria-label="Close"
                className="focus-ring -mt-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-white/6 hover:text-ink"
              >
                <X className="size-5" />
              </button>
            </div>
          )}
        </div>
        <div className={cx("thin-scroll min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain", !bare && "px-3 pb-3")}>
          {children}
        </div>
        {footer && <div className="min-w-0 shrink-0 border-t border-line px-4 pt-3 pb-[calc(12px+var(--sab))] sm:pb-4">{footer}</div>}
        {!footer && <div className="h-[var(--sab)] shrink-0 sm:hidden" />}
      </div>
    </div>,
    document.body,
  );
}

/** Reset transient UI (open sheets, selections) when Next hides the route. */
export function useResetOnHide(reset: () => void) {
  const ref = useRef(reset);
  useEffect(() => {
    ref.current = reset;
  });
  useLayoutEffect(() => () => ref.current(), []);
}
