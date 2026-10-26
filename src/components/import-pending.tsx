"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { del, get } from "idb-keyval";
import { CheckCircle2, CloudUpload, FileText, Image as ImageIcon, Inbox, Loader2, Trash2, WifiOff } from "lucide-react";
import { api, ApiRequestError, errorMessage } from "@/lib/client/api";
import { formatBytes, plural } from "@/lib/client/format";
import { PENDING_SHARE_KEY, type PendingShare } from "@/lib/client/device";
import { useOnline } from "@/hooks/runtime";
import { Button, ProgressBar } from "@/components/ui/primitives";
import { LogoMark } from "@/components/brand";

type Phase =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "ready"; share: PendingShare }
  | { kind: "uploading"; share: PendingShare; fraction: number }
  | { kind: "error"; share: PendingShare; message: string; needsDrive?: boolean };

/**
 * Files shared to the installed app while offline or signed out are stashed in
 * IndexedDB by public/sw.js. This page uploads them once possible.
 */
export function ImportPending() {
  const router = useRouter();
  const online = useOnline();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const started = useRef(false);

  useEffect(() => {
    let alive = true;
    get<PendingShare>(PENDING_SHARE_KEY)
      .then((share) => {
        if (!alive) return;
        if (!share || !share.files?.length) setPhase({ kind: "empty" });
        else setPhase({ kind: "ready", share });
      })
      .catch(() => alive && setPhase({ kind: "empty" }));
    return () => {
      alive = false;
    };
  }, []);

  const upload = async (share: PendingShare) => {
    setPhase({ kind: "uploading", share, fraction: 0 });
    try {
      // make sure we are signed in first; 401 redirects to /login?next=/import-pending
      await api.me().catch((e: unknown) => {
        if (e instanceof ApiRequestError && e.status === 401) {
          window.location.replace("/login?next=%2Fimport-pending");
        }
        throw e;
      });
      const files = share.files.map((f) => new File([f.blob], f.name || "shared", { type: f.type || f.blob.type }));
      const title = share.title?.trim() || (files.length === 1 ? files[0].name.replace(/\.[^.]+$/, "") : undefined);
      const doc = await api.createDoc(files, { title, source: "share-target" }, (p) =>
        setPhase({ kind: "uploading", share, fraction: p.fraction }),
      ).promise;
      await del(PENDING_SHARE_KEY);
      router.replace(`/d/${doc.id}`);
    } catch (e) {
      // drive_required: the files stay queued on this device until Google Drive is connected
      const needsDrive = e instanceof ApiRequestError && e.code === "drive_required";
      setPhase({ kind: "error", share, message: errorMessage(e, "Upload failed"), needsDrive });
      started.current = false;
    }
  };

  // auto-start when online
  useEffect(() => {
    if (phase.kind !== "ready" || !online || started.current) return;
    started.current = true;
    void upload(phase.share);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, online]);

  const share = "share" in phase ? phase.share : null;
  const size = share?.files.reduce((s, f) => s + (f.blob?.size ?? 0), 0) ?? 0;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-6 pt-[calc(var(--sat)+28px)] pb-[calc(var(--sab)+24px)]">
      <LogoMark className="size-8" />
      <div className="flex flex-1 flex-col justify-center">
        {phase.kind === "loading" ? (
          <Loader2 className="mx-auto size-7 animate-spin text-accent" />
        ) : phase.kind === "empty" ? (
          <>
            <Inbox className="mb-4 size-7 text-muted" />
            <h1 className="display text-[28px] leading-[1.1]">Nothing waiting</h1>
            <p className="mt-2 text-sm text-muted">There are no shared files left to import.</p>
            <Button className="mt-6 self-start" onClick={() => router.replace("/")}>
              Go to Library
            </Button>
          </>
        ) : (
          <>
            <h1 className="display text-[28px] leading-[1.1]">
              {phase.kind === "uploading" ? "Importing…" : "Shared files waiting"}
            </h1>
            <p className="mt-2 text-sm text-muted">
              {plural(share!.files.length, "file")} · {formatBytes(size)}
            </p>
            <ul className="mt-6 space-y-2">
              {share!.files.map((f, i) => (
                <li key={i} className="surface flex min-w-0 items-center gap-3 rounded-2xl px-3 py-2.5">
                  {f.type === "application/pdf" ? (
                    <FileText className="size-5 shrink-0 text-muted" />
                  ) : (
                    <ImageIcon className="size-5 shrink-0 text-muted" />
                  )}
                  <span dir="auto" className="min-w-0 flex-1 truncate text-sm">
                    {f.name}
                  </span>
                  <span className="shrink-0 text-[13px] text-faint tabular-nums">{formatBytes(f.blob?.size ?? 0)}</span>
                </li>
              ))}
            </ul>
            {phase.kind === "uploading" && <ProgressBar className="mt-6" value={phase.fraction} label="Import progress" />}
            {!online && (
              <p className="mt-6 flex items-center gap-2 text-sm text-muted">
                <WifiOff className="size-4" /> Waiting for a connection. This uploads automatically.
              </p>
            )}
            {phase.kind === "error" && <p className="mt-6 text-sm text-danger">{phase.message}</p>}
            {phase.kind === "error" && phase.needsDrive && (
              <a
                href="/api/drive/connect?return=%2Fimport-pending"
                className="focus-ring mt-4 inline-flex h-11 items-center justify-center gap-2 self-start rounded-xl bg-accent-strong px-4 text-sm font-semibold text-white hover:bg-accent-hover"
              >
                <CloudUpload className="size-4" /> Connect Google Drive
              </a>
            )}
            <div className="mt-6 flex flex-wrap gap-2">
              {(phase.kind === "error" || (phase.kind === "ready" && online)) && (
                <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => upload(share!)}>
                  Import now
                </Button>
              )}
              {phase.kind !== "uploading" && (
                <Button
                  variant="ghost"
                  icon={<Trash2 className="size-4" />}
                  onClick={async () => {
                    await del(PENDING_SHARE_KEY);
                    setPhase({ kind: "empty" });
                  }}
                >
                  Discard
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
