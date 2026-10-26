"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "@/lib/client/format";
import type { Pt, Quad } from "@/lib/client/scanner/engine";

function isConvex(q: Quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function quadIsValid(q: Quad) {
  return isConvex(q);
}

const LOUPE = 116;
const ZOOM = 2.6;

/**
 * Corner editor over the source image. Coordinates are normalised (0..1).
 * Handles: 4 corners + 4 edge midpoints (drag an edge). Shows a magnifier
 * loupe while dragging so the corner can be placed precisely under a finger.
 */
export function CropEditor({
  src,
  width,
  height,
  quad,
  onChange,
}: {
  src: string;
  width: number;
  height: number;
  quad: Quad;
  onChange: (q: Quad) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<{ handle: number; x: number; y: number } | null>(null);
  const quadRef = useRef(quad);
  useEffect(() => {
    quadRef.current = quad;
  });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // contain-fit of the image in the box, with padding so handles stay reachable
  const pad = 26; // >= half the 48px handle, so hit areas never leave the screen
  const availW = Math.max(1, size.w - pad * 2);
  const availH = Math.max(1, size.h - pad * 2);
  const s = Math.min(availW / width, availH / height);
  const dw = width * s;
  const dh = height * s;
  const ox = (size.w - dw) / 2;
  const oy = (size.h - dh) / 2;
  const toPx = (p: Pt): Pt => [ox + p[0] * dw, oy + p[1] * dh];
  const pts = quad.map(toPx) as [Pt, Pt, Pt, Pt];
  const valid = isConvex(quad);

  const handles: { idx: number; at: Pt; corner: boolean }[] = [
    ...pts.map((p, i) => ({ idx: i, at: p, corner: true })),
    ...pts.map((p, i) => {
      const n = pts[(i + 1) % 4];
      return { idx: 4 + i, at: [(p[0] + n[0]) / 2, (p[1] + n[1]) / 2] as Pt, corner: false };
    }),
  ];

  const startRef = useRef<{ q: Quad; px: number; py: number } | null>(null);

  const onDown = (handle: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const r = box.current!.getBoundingClientRect();
    startRef.current = { q: quadRef.current, px: e.clientX, py: e.clientY };
    setDrag({ handle, x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag || !startRef.current) return;
    const r = box.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const q0 = startRef.current.q;
    const next = q0.map((p) => [...p]) as Quad;
    if (drag.handle < 4) {
      next[drag.handle] = [clamp((x - ox) / dw), clamp((y - oy) / dh)];
    } else {
      const i = drag.handle - 4;
      const j = (i + 1) % 4;
      const dx = (e.clientX - startRef.current.px) / dw;
      const dy = (e.clientY - startRef.current.py) / dh;
      next[i] = [clamp(q0[i][0] + dx), clamp(q0[i][1] + dy)];
      next[j] = [clamp(q0[j][0] + dx), clamp(q0[j][1] + dy)];
    }
    setDrag({ handle: drag.handle, x, y });
    onChange(next);
  };

  const onUp = () => {
    setDrag(null);
    startRef.current = null;
  };

  // loupe focus point (image-space px) for corners only
  const focus = drag && drag.handle < 4 ? pts[drag.handle] : null;
  const loupeLeft = focus ? Math.min(size.w - LOUPE - 8, Math.max(8, focus[0] - LOUPE / 2)) : 0;
  const loupeAbove = focus ? focus[1] - LOUPE - 48 : 0;
  const loupeTop = focus ? (loupeAbove > 8 ? loupeAbove : Math.min(size.h - LOUPE - 8, focus[1] + 48)) : 0;

  const outline = `M0 0H${size.w}V${size.h}H0Z M${pts.map((p) => p.join(" ")).join(" L")} Z`;

  return (
    <div
      ref={box}
      className="relative h-full w-full touch-none select-none"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {size.w > 0 && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt="Captured page"
            draggable={false}
            className="pointer-events-none absolute max-w-none"
            style={{ left: ox, top: oy, width: dw, height: dh }}
          />
          <svg className="pointer-events-none absolute inset-0" width={size.w} height={size.h}>
            <path d={outline} fill="rgb(0 0 0 / 0.5)" fillRule="evenodd" />
            <polygon
              points={pts.map((p) => p.join(",")).join(" ")}
              fill={valid ? "rgb(124 77 255 / 0.14)" : "rgb(248 113 113 / 0.12)"}
              stroke={valid ? "#b9a6ff" : "#ff8080"}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          </svg>
          {handles.map((h) => (
            <button
              key={h.idx}
              type="button"
              aria-label={h.corner ? `Corner ${h.idx + 1}` : `Edge ${h.idx - 3}`}
              onPointerDown={onDown(h.idx)}
              className="absolute flex size-12 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center"
              style={{ left: h.at[0], top: h.at[1] }}
            >
              <span
                className={cx(
                  "block border-2 shadow-[0_2px_10px_rgb(0_0_0/0.6)] transition-transform",
                  h.corner ? "size-6 rounded-full" : "h-2.5 w-7 rounded-full",
                  valid ? "border-white bg-accent-strong" : "border-white bg-danger",
                  drag?.handle === h.idx && "scale-125",
                )}
                style={
                  !h.corner
                    ? {
                        transform: `rotate(${Math.atan2(
                          pts[(h.idx - 3) % 4][1] - pts[h.idx - 4][1],
                          pts[(h.idx - 3) % 4][0] - pts[h.idx - 4][0],
                        )}rad)`,
                      }
                    : undefined
                }
              />
            </button>
          ))}
          {focus && (
            <div
              className="pointer-events-none absolute overflow-hidden rounded-full border-2 border-white shadow-2xl"
              style={{
                left: loupeLeft,
                top: loupeTop,
                width: LOUPE,
                height: LOUPE,
                backgroundImage: `url(${src})`,
                backgroundRepeat: "no-repeat",
                backgroundColor: "#000",
                backgroundSize: `${dw * ZOOM}px ${dh * ZOOM}px`,
                backgroundPosition: `${LOUPE / 2 - (focus[0] - ox) * ZOOM}px ${LOUPE / 2 - (focus[1] - oy) * ZOOM}px`,
              }}
            >
              <span className="absolute top-1/2 left-1/2 h-px w-6 -translate-x-1/2 bg-accent" />
              <span className="absolute top-1/2 left-1/2 h-6 w-px -translate-y-1/2 bg-accent" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
