"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cx } from "@/lib/client/format";

export interface ViewerPage {
  imageUrl: string;
  thumbUrl: string;
}

/**
 * Full-screen page viewer: swipe between pages (scroll-snap), pinch / wheel /
 * double-tap zoom with pan. Swiping is disabled while zoomed in.
 */
export function PageViewer({
  pages,
  startIndex,
  onClose,
  title,
  actions,
}: {
  pages: ViewerPage[];
  startIndex: number;
  onClose: () => void;
  title?: string;
  actions?: (index: number) => ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(startIndex);
  const [zoomed, setZoomed] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [attached, setAttached] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAttached(true);
    return () => setAttached(false);
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = startIndex * el.clientWidth;
  }, [startIndex, attached]);

  useEffect(() => {
    if (!attached) return;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, [attached]);

  const go = useCallback((i: number) => {
    const el = scroller.current;
    if (!el) return;
    const n = Math.max(0, Math.min(pages.length - 1, i));
    el.scrollTo({ left: n * el.clientWidth, behavior: "smooth" });
  }, [pages.length]);

  useEffect(() => {
    if (!attached) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      else if (e.key === "ArrowRight") go(index + 1);
      else if (e.key === "ArrowLeft") go(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [attached, go, index]);

  if (!attached) return null;

  return createPortal(
    <div className="fixed inset-0 z-[65] flex animate-fade-in flex-col bg-black" role="dialog" aria-modal="true" aria-label="Page viewer">
      <div
        className={cx(
          "absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-black/80 to-transparent px-2 pt-[calc(var(--sat)+6px)] pb-6 transition-opacity duration-200",
          chrome ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <button
          type="button"
          onClick={() => onCloseRef.current()}
          aria-label="Close viewer"
          className="focus-ring inline-flex size-11 items-center justify-center rounded-2xl text-white hover:bg-white/10"
        >
          <X className="size-6" />
        </button>
        <div className="min-w-0 flex-1">
          {title && (
            <p dir="auto" className="truncate text-sm font-medium text-white">
              {title}
            </p>
          )}
          <p className="font-mono text-xs text-white/60">
            {index + 1} / {pages.length}
          </p>
        </div>
        {actions?.(index)}
      </div>

      <div
        ref={scroller}
        className={cx(
          "no-scrollbar flex h-full w-full snap-x snap-mandatory",
          zoomed ? "overflow-hidden" : "overflow-x-auto",
        )}
        onScroll={(e) => {
          const el = e.currentTarget;
          const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
          if (i !== index) setIndex(i);
        }}
      >
        {pages.map((p, i) => (
          <div key={`${p.imageUrl}-${i}`} className="relative h-full w-full shrink-0 snap-center snap-always overflow-hidden">
            {Math.abs(i - index) <= 2 ? (
              <ZoomImage
                src={p.imageUrl}
                placeholder={p.thumbUrl}
                active={i === index}
                onZoomChange={i === index ? setZoomed : undefined}
                onTap={() => setChrome((c) => !c)}
              />
            ) : null}
          </div>
        ))}
      </div>

      {pages.length > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous page"
            onClick={() => go(index - 1)}
            disabled={index === 0}
            className="focus-ring absolute top-1/2 left-4 hidden size-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur hover:bg-white/20 disabled:opacity-0 md:inline-flex"
          >
            <ChevronLeft />
          </button>
          <button
            type="button"
            aria-label="Next page"
            onClick={() => go(index + 1)}
            disabled={index === pages.length - 1}
            className="focus-ring absolute top-1/2 right-4 hidden size-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur hover:bg-white/20 disabled:opacity-0 md:inline-flex"
          >
            <ChevronRight />
          </button>
          <div
            className={cx(
              "absolute inset-x-0 bottom-0 flex justify-center gap-1.5 pt-6 pb-[calc(var(--sab)+16px)] transition-opacity",
              chrome && !zoomed ? "opacity-100" : "opacity-0",
            )}
          >
            {pages.length <= 24 &&
              pages.map((_, i) => (
                <span
                  key={i}
                  className={cx("h-1.5 rounded-full transition-all", i === index ? "w-5 bg-white" : "w-1.5 bg-white/35")}
                />
              ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

function ZoomImage({
  src,
  placeholder,
  active,
  onZoomChange,
  onTap,
}: {
  src: string;
  placeholder: string;
  active: boolean;
  onZoomChange?: (z: boolean) => void;
  onTap: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const t = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number; cx: number; cy: number; x: number; y: number } | null>(null);
  const pan = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const lastTap = useRef(0);
  const moved = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const zoomCb = useRef(onZoomChange);
  useEffect(() => {
    zoomCb.current = onZoomChange;
  });

  const apply = (animate = false) => {
    const el = img.current;
    if (!el) return;
    el.style.transition = animate ? "transform 220ms cubic-bezier(0.22,1,0.36,1)" : "none";
    el.style.transform = `translate3d(${t.current.x}px, ${t.current.y}px, 0) scale(${t.current.scale})`;
    if (box.current) box.current.style.touchAction = t.current.scale > 1.01 ? "none" : "pan-x";
  };

  const clamp = () => {
    const b = box.current;
    if (!b) return;
    const s = t.current.scale;
    if (s <= 1.01) {
      t.current = { scale: 1, x: 0, y: 0 };
    } else {
      const maxX = (b.clientWidth * (s - 1)) / 2;
      const maxY = (b.clientHeight * (s - 1)) / 2;
      t.current.x = Math.max(-maxX, Math.min(maxX, t.current.x));
      t.current.y = Math.max(-maxY, Math.min(maxY, t.current.y));
    }
    zoomCb.current?.(t.current.scale > 1.01);
  };

  const zoomAt = (scale: number, px: number, py: number) => {
    const b = box.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const cx = px - r.left - r.width / 2;
    const cy = py - r.top - r.height / 2;
    const { scale: s0, x, y } = t.current;
    const s = Math.max(1, Math.min(6, scale));
    t.current = { scale: s, x: cx - ((cx - x) * s) / s0, y: cy - ((cy - y) * s) / s0 };
    clamp();
    apply(true);
  };

  useEffect(() => {
    if (active) return;
    t.current = { scale: 1, x: 0, y: 0 };
    apply();
  }, [active]);

  return (
    <div
      ref={box}
      className="flex h-full w-full touch-pan-x items-center justify-center"
      onWheel={(e) => {
        if (!e.ctrlKey && Math.abs(e.deltaY) < 1) return;
        zoomAt(t.current.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved.current = false;
        if (pointers.current.size === 2) {
          const [a, b] = [...pointers.current.values()];
          gesture.current = {
            dist: Math.hypot(a.x - b.x, a.y - b.y),
            scale: t.current.scale,
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
            x: t.current.x,
            y: t.current.y,
          };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } else if (t.current.scale > 1) {
          pan.current = { x: e.clientX, y: e.clientY, ox: t.current.x, oy: t.current.y };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = gesture.current;
        if (g && pointers.current.size >= 2) {
          moved.current = true;
          const [a, b] = [...pointers.current.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          const s = Math.max(0.8, Math.min(6, (g.scale * dist) / g.dist));
          const r = box.current!.getBoundingClientRect();
          const cx = g.cx - r.left - r.width / 2;
          const cy = g.cy - r.top - r.height / 2;
          const mx = (a.x + b.x) / 2 - g.cx;
          const my = (a.y + b.y) / 2 - g.cy;
          t.current = {
            scale: s,
            x: cx - ((cx - g.x) * s) / g.scale + mx,
            y: cy - ((cy - g.y) * s) / g.scale + my,
          };
          apply();
          return;
        }
        const p = pan.current;
        if (p) {
          if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) moved.current = true;
          t.current.x = p.ox + (e.clientX - p.x);
          t.current.y = p.oy + (e.clientY - p.y);
          apply();
        }
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId);
        if (pointers.current.size < 2 && gesture.current) {
          gesture.current = null;
          clamp();
          apply(true);
          return;
        }
        if (pan.current) {
          pan.current = null;
          clamp();
          apply(true);
        }
        if (!moved.current) {
          const now = Date.now();
          if (now - lastTap.current < 280) {
            lastTap.current = 0;
            if (t.current.scale > 1) {
              t.current = { scale: 1, x: 0, y: 0 };
              zoomCb.current?.(false);
              apply(true);
            } else zoomAt(2.5, e.clientX, e.clientY);
          } else {
            lastTap.current = now;
            const at = now;
            window.setTimeout(() => {
              if (lastTap.current === at) onTap();
            }, 290);
          }
        }
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        gesture.current = null;
        pan.current = null;
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={loaded ? src : placeholder}
        alt=""
        draggable={false}
        className="max-h-full max-w-full object-contain select-none will-change-transform"
        style={{ transformOrigin: "center center" }}
        ref={img}
      />
      {/* Preload the full image, then swap from the thumb */}
      {!loaded && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="hidden" onLoad={() => setLoaded(true)} />
      )}
    </div>
  );
}
