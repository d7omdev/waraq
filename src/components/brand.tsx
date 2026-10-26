import { useId } from "react";
import { cx } from "@/lib/client/format";

/** Purple tile with a folded paper page. Same artwork as public/icons. */
export function LogoMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 100 100" className={cx("shrink-0 drop-shadow-[0_2px_6px_rgb(124_77_255/0.35)]", className ?? "size-7")} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8f66ff" />
          <stop offset="1" stopColor="#5b2fd9" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="24" fill={`url(#${id})`} />
      <path d="M33 22 H58 L72 36 V74 a4 4 0 0 1 -4 4 H33 a4 4 0 0 1 -4 -4 V26 a4 4 0 0 1 4 -4 Z" fill="#f6f3ec" />
      <path d="M58 22 V32 a4 4 0 0 0 4 4 H72 Z" fill="#c9b8ff" />
      <rect x="38" y="48" width="25" height="4.5" rx="2.25" fill="#6236e0" />
      <rect x="38" y="58" width="18" height="4.5" rx="2.25" fill="#6236e0" opacity="0.55" />
    </svg>
  );
}

/** Logo + serif "Waraq" wordmark (English only). */
export function Wordmark({ className, size = "md" }: { className?: string; size?: "md" | "lg" }) {
  return (
    <span className={cx("flex items-center", size === "lg" ? "gap-3" : "gap-2.5", className)}>
      <LogoMark className={size === "lg" ? "size-10" : "size-8"} />
      <span className={cx("display leading-none text-ink", size === "lg" ? "text-[30px]" : "text-[23px]")}>Waraq</span>
    </span>
  );
}
