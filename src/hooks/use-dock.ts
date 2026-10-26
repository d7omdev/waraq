"use client";

import { useLayoutEffect, type RefObject } from "react";

/*
 * Every bar fixed to the bottom edge registers here. The tallest one sets
 * --dock-h on <html>, which scroll content (.pb-dock), toasts and the upload
 * tray use to stay clear of it. Bars that are display:none (e.g. the phone
 * nav on desktop) count as zero.
 */
const docks = new Set<HTMLElement>();
let frame = 0;

function measure() {
  frame = 0;
  let h = 0;
  docks.forEach((el) => {
    if (!el.isConnected || el.offsetHeight === 0) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const bottom = parseFloat(cs.bottom) || 0;
    h = Math.max(h, el.offsetHeight + bottom);
  });
  document.documentElement.style.setProperty("--dock-h", `${Math.ceil(h)}px`);
}

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(measure);
}

let resizeBound = false;
const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;

export function useDock(ref: RefObject<HTMLElement | null>, active = true) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    if (!resizeBound) {
      window.addEventListener("resize", schedule);
      resizeBound = true;
    }
    docks.add(el);
    ro?.observe(el);
    measure();
    return () => {
      docks.delete(el);
      ro?.unobserve(el);
      measure();
    };
  }, [ref, active]);
}
