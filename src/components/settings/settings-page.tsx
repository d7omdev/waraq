"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

/** Frame for a settings sub-page: back link to /settings, compact title. */
export function SettingsPage({
  title,
  description,
  children,
  action,
  wide,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`pb-dock mx-auto w-full ${wide ? "max-w-2xl xl:max-w-3xl" : "max-w-2xl"} min-w-0 px-4 pt-[calc(var(--sat)+12px)] sm:px-6 lg:pt-10`}>
      <Link
        href="/settings"
        className="focus-ring -ml-2 inline-flex h-11 items-center gap-1 rounded-xl pr-3 pl-1 text-[14px] text-muted hover:text-ink lg:hidden"
      >
        <ChevronLeft className="size-5" /> Settings
      </Link>
      <Link href="/settings" className="focus-ring hidden rounded text-[13px] text-muted hover:text-ink lg:inline-block">
        Settings
      </Link>
      <div className="mt-1 mb-6 flex min-w-0 items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="display truncate text-[26px] leading-[1.1] sm:text-[32px]">{title}</h1>
          {description && <p className="mt-1.5 text-[14px] leading-snug text-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="space-y-7">{children}</div>
    </div>
  );
}

export function FieldBlock({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 px-3.5 py-3">
      <p className="mb-2 text-[14px] text-ink">{label}</p>
      {children}
      {hint && <p className="mt-2 text-[12.5px] leading-snug text-faint">{hint}</p>}
    </div>
  );
}
