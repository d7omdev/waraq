"use client";

import { useRef } from "react";
import { vibrate } from "@/lib/client/device";

/**
 * Long-press detection for touch + mouse. Returns handlers to spread and a
 * function that tells a click handler whether the press was "consumed".
 */
export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        vibrate(18, "select");
        onLongPress();
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current;
      if (!s || !timer.current) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (e: React.MouseEvent) => {
      // Android fires contextmenu on long-press; desktop right-click selects.
      e.preventDefault();
      if (!fired.current) {
        fired.current = true;
        clear();
        onLongPress();
      }
    },
  };

  /** True if the last press triggered a long-press (and resets the flag). */
  const consumed = () => {
    const f = fired.current;
    fired.current = false;
    return f;
  };

  return { handlers, consumed };
}
