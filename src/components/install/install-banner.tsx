"use client";

import { useState } from "react";
import { EllipsisVertical, Share, SquarePlus, X } from "lucide-react";
import { cx } from "@/lib/client/format";
import { dismissInstallBanner, promptInstall, useInstallBanner, type InstallState } from "@/hooks/runtime";
import { Button } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";

/** Runs the native prompt when the browser offers one, otherwise opens manual steps. */
export function useInstallAction(state: InstallState) {
  const [help, setHelp] = useState(false);
  const run = async () => {
    if (state.canPrompt) {
      const r = await promptInstall();
      if (r === "accepted") toast.success("Installing Waraq");
      if (r !== "unavailable") return;
    }
    setHelp(true);
  };
  const sheet = <InstallHelpSheet open={help} onClose={() => setHelp(false)} ios={state.ios} />;
  return { run, sheet };
}

/**
 * Compact, dismissible "Install Waraq" banner. Renders nothing on desktop,
 * inside the installed app, or for 14 days after it was dismissed.
 */
export function InstallBanner({ className }: { className?: string }) {
  const { show, state } = useInstallBanner();
  const { run, sheet } = useInstallAction(state);
  if (!show) return sheet;
  return (
    <>
      <div
        role="region"
        aria-label="Install the app"
        className={cx(
          "flex animate-fade-in items-center gap-2 rounded-xl border border-line bg-s1 py-2.5 pr-1 pl-3.5",
          className,
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-tight font-medium text-ink">Install Waraq</p>
          <p className="mt-0.5 text-[13px] leading-snug text-muted">
            Get the app for full-screen scanning and sharing from any app.
          </p>
        </div>
        <Button size="sm" variant="primary" onClick={run}>
          {state.ios ? "Add" : "Install"}
        </Button>
        <button
          type="button"
          aria-label="Dismiss for now"
          title="Dismiss"
          onClick={dismissInstallBanner}
          className="focus-ring -ml-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-faint hover:bg-white/6 hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>
      {sheet}
    </>
  );
}

export function InstallHelpSheet({ open, onClose, ios }: { open: boolean; onClose: () => void; ios: boolean }) {
  const steps = ios
    ? [
        { icon: <Share />, text: <>Tap <b className="font-medium text-ink">Share</b> in the browser toolbar</> },
        { icon: <SquarePlus />, text: <>Choose <b className="font-medium text-ink">Add to Home Screen</b></> },
        { icon: null, text: <>Tap <b className="font-medium text-ink">Add</b>. Waraq opens full screen from your home screen.</> },
      ]
    : [
        { icon: <EllipsisVertical />, text: <>Open the browser menu <span className="text-faint">(⋮ in Chrome)</span></> },
        { icon: <SquarePlus />, text: <>Choose <b className="font-medium text-ink">Install app</b> or <b className="font-medium text-ink">Add to Home screen</b></> },
        { icon: null, text: <>Confirm. Waraq then appears in your share menu for PDFs and photos.</> },
      ];
  return (
    <Sheet open={open} onClose={onClose} title={ios ? "Add to Home Screen" : "Install Waraq"} size="sm">
      <ol className="space-y-1 px-2 pb-2">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-3 rounded-lg px-1 py-2.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-s3 text-[12px] font-semibold text-ink">
              {i + 1}
            </span>
            <p className="flex-1 pt-0.5 text-[15px] leading-snug text-muted">{s.text}</p>
            {s.icon && <span className="pt-0.5 text-ink [&_svg]:size-5">{s.icon}</span>}
          </li>
        ))}
      </ol>
      <div className="px-2 pt-1 pb-2">
        <Button block onClick={onClose}>
          Done
        </Button>
      </div>
    </Sheet>
  );
}
