"use client";

import Link from "next/link";
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Loader2, MoreHorizontal } from "lucide-react";
import { cx } from "@/lib/client/format";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "paper";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent-strong bg-[linear-gradient(180deg,rgb(255_255_255/0.12),rgb(255_255_255/0))] text-white shadow-accent hover:bg-accent-hover active:bg-accent-deep",
  secondary:
    "bg-s2 bg-[linear-gradient(180deg,rgb(255_255_255/0.035),rgb(255_255_255/0))] text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] hover:bg-s3 active:bg-s4 border border-line-strong",
  ghost: "text-ink hover:bg-white/6 active:bg-white/10",
  danger: "bg-danger/10 text-danger hover:bg-danger/15 active:bg-danger/20 border border-danger/25",
  paper: "bg-paper text-paper-ink hover:bg-white active:bg-stone-200",
};
const sizes: Record<Size, string> = {
  sm: "h-9 px-3 text-[13px] gap-1.5 rounded-lg",
  md: "h-11 px-4 text-sm gap-2 rounded-xl",
  lg: "h-12 px-5 text-[15px] gap-2 rounded-xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, block, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "focus-ring inline-flex items-center justify-center font-medium transition-[background-color,opacity,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45",
        variants[variant],
        sizes[size],
        // block buttons share a row: full width but allowed to shrink, label truncates
        block ? "w-full min-w-0 shrink" : "shrink-0",
        className,
      )}
      data-haptic={variant === "danger" ? "warning" : undefined}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : icon}
      {block && typeof children === "string" ? <span className="min-w-0 truncate">{children}</span> : children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  tone?: "default" | "solid" | "danger";
}

/** 44px hit area, 20px glyph. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, tone = "default", className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-xl transition-colors duration-150 disabled:opacity-40 [&_svg]:size-5",
        tone === "solid" && "border border-line-strong bg-s2 shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] hover:bg-s3",
        tone === "danger" && "text-danger hover:bg-danger/10",
        tone === "default" && "hover:bg-white/6 active:bg-white/10",
        active ? "text-accent" : tone === "danger" ? "" : "text-ink",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("animate-spin text-muted", className ?? "size-5")} aria-label="Loading" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton rounded-lg", className)} aria-hidden />;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mx-auto flex max-w-sm flex-col items-center px-6 py-16 text-center", className)}>
      {icon && (
        <div className="surface mb-5 flex size-14 items-center justify-center rounded-2xl text-accent [&_svg]:size-6">
          {icon}
        </div>
      )}
      <h3 className="text-[18px] leading-snug font-semibold tracking-[-0.01em] text-ink">{title}</h3>
      {body && <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        "focus-ring relative h-6 w-10 shrink-0 rounded-full transition-colors",
        checked ? "bg-accent-strong" : "bg-s4",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="focus-ring flex min-h-12 w-full items-center gap-3 rounded-lg px-1 text-left"
    >
      <span className="flex-1">
        <span className="block text-[15px] text-ink">{label}</span>
        {description && <span className="block text-[13px] text-muted">{description}</span>}
      </span>
      <span
        className={cx(
          "relative h-6 w-10 shrink-0 rounded-full transition-colors",
          checked ? "bg-accent-strong" : "bg-s4",
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200",
            checked && "translate-x-4",
          )}
        />
      </span>
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode; ariaLabel?: string }[];
  onChange: (v: T) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" className={cx("flex min-w-0 gap-0.5 rounded-xl border border-line bg-black/25 p-[3px]", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.ariaLabel}
          title={o.ariaLabel}
          onClick={() => onChange(o.value)}
          className={cx(
            "focus-ring flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate rounded-[9px] px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors",
            size === "sm" ? "h-9" : "h-10",
            value === o.value
              ? "bg-s4 text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.07),0_1px_3px_rgb(0_0_0/0.4)]"
              : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const TextField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string | null }
>(function TextField({ label, hint, error, className, id, ...rest }, ref) {
  const inputId = id ?? (label ? `f-${label.replace(/\s+/g, "-").toLowerCase()}` : undefined);
  return (
    <label className="block" htmlFor={inputId}>
      {label && <span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span>}
      <input
        ref={ref}
        id={inputId}
        dir="auto"
        className={cx(
          "h-11 w-full rounded-xl border bg-black/25 px-3.5 text-[15px] text-ink shadow-[inset_0_1px_2px_rgb(0_0_0/0.3)] placeholder:text-faint outline-none transition-colors focus:border-accent/70 focus:ring-3 focus:ring-accent/20",
          error ? "border-danger/60" : "border-line-strong",
          className,
        )}
        {...rest}
      />
      {(error || hint) && (
        <span className={cx("mt-1.5 block text-[13px]", error ? "text-danger" : "text-faint")}>{error || hint}</span>
      )}
    </label>
  );
});

export function Badge({
  children,
  tone = "default",
  className,
}: {
  children: ReactNode;
  tone?: "default" | "accent" | "warn" | "danger" | "ok";
  className?: string;
}) {
  const tones = {
    default: "bg-white/6 text-muted",
    accent: "bg-accent-tint text-accent",
    warn: "bg-white/6 text-muted",
    danger: "bg-danger/12 text-danger",
    ok: "bg-white/6 text-muted",
  };
  return (
    <span
      className={cx(
        "inline-flex h-6 items-center gap-1 rounded-full px-2 text-[12px] font-medium whitespace-nowrap [&_svg]:size-3",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 0..1 -> a percentage in [0, 100]; NaN/Infinity/negative inputs can never widen the bar past its track. */
export function clampPercent(value: number): number {
  const pct = Number.isFinite(value) ? value * 100 : 0;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Full-width track (put spacing on a wrapper, not margins on the bar: `w-full` + horizontal margin overflows).
 * The fill is absolutely positioned inside an overflow-hidden, border-box track, so neither the value nor padding,
 * borders or a flex parent can push it past the track's right edge.
 */
export function ProgressBar({ value, className, label }: { value: number; className?: string; label?: string }) {
  const pct = clampPercent(value);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cx("relative box-border block h-1.5 w-full max-w-full min-w-0 shrink overflow-hidden rounded-full bg-white/8", className)}
      data-progress={Math.round(pct)}
    >
      <div
        className="absolute inset-y-0 left-0 box-border max-w-full rounded-full bg-gradient-to-r from-accent-strong to-accent transition-[width] duration-200"
        style={{ width: `${pct > 0 ? Math.max(2, pct) : 0}%` }}
      />
    </div>
  );
}

/** Row inside sheets: plain icon, label, optional description. */
export function ListAction({
  icon,
  label,
  description,
  onClick,
  tone = "default",
  disabled,
  trailing,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  onClick?: () => void;
  tone?: "default" | "danger" | "accent";
  disabled?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "focus-ring flex min-h-13 w-full items-center gap-3.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/5 active:bg-white/8 disabled:opacity-40",
        tone === "danger" && "text-danger",
      )}
    >
      <span
        className={cx(
          "flex size-9 shrink-0 items-center justify-center rounded-[10px] border [&_svg]:size-[18px]",
          tone === "danger"
            ? "border-danger/20 bg-danger/10 text-danger"
            : tone === "accent"
              ? "border-accent/25 bg-accent-tint text-accent"
              : "border-line bg-s2 text-muted",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-tight">{label}</span>
        {description && <span className="mt-0.5 block truncate text-[13px] text-muted" dir="auto">{description}</span>}
      </span>
      {trailing}
    </button>
  );
}

/* --------------------------- grouped list rows --------------------------- */

/** iOS-settings style group: optional caption, hairline-separated rows, optional footnote. */
export function Group({
  title,
  footer,
  children,
  className,
}: {
  title?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      {title && <h2 className="px-1 pb-2 text-[13px] font-medium text-muted">{title}</h2>}
      <div className="surface divide-y divide-line overflow-hidden rounded-2xl">{children}</div>
      {footer && <p className="px-1 pt-2 text-[13px] leading-relaxed text-faint">{footer}</p>}
    </section>
  );
}

export function Row({
  icon,
  label,
  detail,
  trailing,
  onClick,
  href,
  tone = "default",
  chevron,
  disabled,
}: {
  icon?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  href?: string;
  tone?: "default" | "danger" | "accent";
  chevron?: boolean;
  disabled?: boolean;
}) {
  const body = (
    <>
      {icon && (
        <span
          className={cx(
            "flex size-8 shrink-0 items-center justify-center rounded-[9px] [&_svg]:size-[17px]",
            tone === "danger" ? "bg-danger/10 text-danger" : tone === "accent" ? "bg-accent-tint text-accent" : "bg-white/6 text-muted",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className={cx("block text-[15px] leading-snug", tone === "danger" ? "text-danger" : tone === "accent" ? "text-accent" : "text-ink")}>
          {label}
        </span>
        {detail && <span className="mt-0.5 block text-[13px] leading-snug text-muted">{detail}</span>}
      </span>
      {trailing}
      {chevron && <ChevronRight className="size-4 shrink-0 text-faint" />}
    </>
  );
  const cls = cx(
    "flex min-h-13 w-full min-w-0 items-center gap-3 px-3.5 py-2.5 text-left",
    (onClick || href) && "focus-ring transition-colors hover:bg-white/4 active:bg-white/6",
    disabled && "pointer-events-none opacity-45",
  );
  if (href)
    return (
      <Link href={href} className={cls}>
        {body}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cls} disabled={disabled}>
        {body}
      </button>
    );
  return <div className={cls}>{body}</div>;
}

/* --------------------------------- chips -------------------------------- */

export function Chip({
  selected,
  onClick,
  children,
  icon,
  className,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cx(
        "focus-ring inline-flex h-8 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors [&_svg]:size-3.5 [&>span]:truncate",
        selected
          ? "border-accent/50 bg-accent-tint text-ink"
          : "border-line bg-white/[0.03] text-muted hover:border-line-strong hover:text-ink",
        className,
      )}
    >
      {selected ? <Check className="text-accent" /> : icon}
      {children}
    </button>
  );
}

/* --------------------------------- menu --------------------------------- */

export interface MenuItem {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
  checked?: boolean;
  disabled?: boolean;
  divider?: boolean;
}

/** Small dropdown anchored to its trigger. Opens upward when there is no room below. */
export function Menu({
  label,
  trigger,
  items,
  align = "end",
  buttonClassName,
  showLabel,
}: {
  label: string;
  trigger: ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  /** Replaces the default 44px icon-button styling of the trigger. */
  buttonClassName?: string;
  /** Render the label as text under/next to the trigger content. */
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number; maxHeight: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const itemCount = items.length;
  const dividerCount = items.filter((i) => i.divider).length;

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const estimate = itemCount * 44 + dividerCount * 9 + 12;
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    const up = estimate > below && above > below;
    const horizontal =
      align === "end"
        ? { right: Math.max(8, Math.min(vw - r.right, vw - 228)) }
        : { left: Math.max(8, Math.min(r.left, vw - 228)) };
    setPos(
      up
        ? { bottom: vh - r.top + 6, maxHeight: above - 6, ...horizontal }
        : { top: r.bottom + 6, maxHeight: below - 6, ...horizontal },
    );
  }, [open, align, itemCount, dividerCount]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={showLabel ? undefined : label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          buttonClassName ??
            "focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink transition-colors hover:bg-white/6 [&_svg]:size-5",
          open && "bg-white/8",
        )}
      >
        {trigger}
        {showLabel && <span className="max-w-full truncate">{label}</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left, right: pos.right, maxHeight: pos.maxHeight }}
            className="surface-raised thin-scroll fixed z-[75] w-max max-w-[calc(100vw-16px)] min-w-[220px] animate-pop-in overflow-y-auto rounded-2xl p-1.5"
          >
            {items.map((it, i) => (
              <div key={i}>
                {it.divider && <div className="mx-1.5 my-1 h-px bg-line" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onClick();
                  }}
                  className={cx(
                    "flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors hover:bg-white/6 disabled:opacity-40 [&_svg]:size-[18px]",
                    it.tone === "danger" ? "text-danger" : "text-ink",
                  )}
                >
                  {it.icon && <span className={it.tone === "danger" ? "text-danger" : "text-muted"}>{it.icon}</span>}
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.checked && <Check className="text-accent" />}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ------------------------------ action bar ------------------------------ */

export interface BarAction {
  key: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: "danger";
}

const SLOT_MIN = 66;

/**
 * Evenly distributed row of icon+label actions for docked bars. Never
 * overflows: it measures its own width, shows as many actions as fit at
 * >= 66px each (pass them in priority order) and folds the rest into a
 * "More" menu. Order on screen follows the given order.
 */
export function ActionBar({ actions, className, maxSlots }: { actions: BarAction[]; className?: string; maxSlots?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const fit = width ? Math.max(3, Math.floor(width / SLOT_MIN)) : 4;
  const slots = Math.min(fit, maxSlots ?? Infinity);
  const overflow = actions.length > slots;
  const visible = overflow ? actions.slice(0, slots - 1) : actions;
  const rest = overflow ? actions.slice(slots - 1) : [];
  const cols = visible.length + (overflow ? 1 : 0);
  return (
    <div
      ref={ref}
      className={cx("grid w-full min-w-0 gap-0.5", className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {visible.map((a) => (
        <button
          key={a.key}
          type="button"
          onClick={a.onClick}
          disabled={a.disabled || a.busy}
          className={cx(
            "focus-ring flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium transition-colors hover:bg-white/5 active:bg-white/10 disabled:opacity-35 [&_svg]:size-5",
            a.tone === "danger" ? "text-danger" : "text-ink",
          )}
        >
          {a.busy ? <Loader2 className="animate-spin text-muted" /> : a.icon}
          <span className="max-w-full truncate">{a.label}</span>
        </button>
      ))}
      {overflow && (
        <Menu
          label="More"
          showLabel
          trigger={<MoreHorizontal />}
          buttonClassName="focus-ring flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium text-ink transition-colors hover:bg-white/5 active:bg-white/10 [&_svg]:size-5"
          items={rest.map((a) => ({
            icon: a.icon,
            label: a.label,
            onClick: a.onClick,
            disabled: a.disabled || a.busy,
            tone: a.tone,
          }))}
        />
      )}
    </div>
  );
}
