"use client";

import { RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/primitives";

export function OfflineView() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-8 pt-[var(--sat)] pb-[var(--sab)] text-center">
      <div className="surface mb-6 flex size-14 items-center justify-center rounded-2xl text-accent">
        <WifiOff className="size-6" />
      </div>
      <h1 className="display text-[28px] leading-[1.1]">You are offline</h1>
      <p className="mt-2 max-w-xs text-sm text-muted">
        Waraq needs a connection to open documents. Files shared to Waraq while offline are saved and uploaded
        when you are back.
      </p>
      <Button className="mt-7" variant="primary" icon={<RefreshCw className="size-4" />} onClick={() => window.location.reload()}>
        Try again
      </Button>
    </div>
  );
}
