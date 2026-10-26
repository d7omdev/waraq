"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Cloud,
  Laptop,
  Loader2,
  LogOut,
  RefreshCw,
  ScanText,
  Smartphone,
  Tablet,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { api, errorMessage } from "@/lib/client/api";
import { mutate, useQuery } from "@/lib/client/query";
import { formatBytes, formatDate, formatDateTime, plural } from "@/lib/client/format";
import { updatePrefs, usePrefs, usePrefsSource } from "@/lib/client/prefs";
import { applyUpdate, checkForUpdate, useUpdateState } from "@/lib/client/app-update";
import { ScannerDiagnostics, useDiagnosticsUnlock } from "./scanner-diagnostics";
import type { OcrStatusInfo, Prefs, SessionInfo } from "@/lib/types";
import { Badge, Button, Group, Row, Segmented, Skeleton, Switch } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { ConfirmSheet } from "@/components/library/folder-sheets";
import { LibraryPrefsForm } from "@/components/library/view-options";
import { DriveSettings } from "@/components/drive/drive-settings";
import { useDriveStatus } from "@/components/drive/save-to-drive-action";
import { refreshLibrary } from "@/hooks/data";
import { FieldBlock, SettingsPage } from "./settings-page";
import { STORAGE_KEY, useStorageUsage } from "./storage-data";

function SyncNote() {
  const source = usePrefsSource();
  if (source !== "local-only") return null;
  return (
    <p className="rounded-xl border border-line px-3.5 py-2.5 text-[13px] text-muted">
      This server does not store preferences yet, so they are saved on this device only.
    </p>
  );
}

/* --------------------------------- library -------------------------------- */

export function LibrarySettings() {
  return (
    <SettingsPage title="Library" description="How documents and folders are shown. Synced to all your devices.">
      <SyncNote />
      <div className="surface rounded-2xl p-3.5">
        <LibraryPrefsForm />
      </div>
    </SettingsPage>
  );
}

/* --------------------------------- scanner -------------------------------- */

const FILTERS: { value: Prefs["scanner"]["defaultFilter"]; label: string }[] = [
  { value: "magic", label: "Magic" },
  { value: "original", label: "Original" },
  { value: "grayscale", label: "Gray" },
  { value: "bw", label: "B&W" },
  { value: "lighten", label: "Lighten" },
];

const QUALITY: { value: string; label: string; q: number }[] = [
  { value: "0.7", label: "Smaller", q: 0.7 },
  { value: "0.85", label: "Balanced", q: 0.85 },
  { value: "0.95", label: "Sharpest", q: 0.95 },
];

export function ScannerSettings() {
  const { scanner } = usePrefs();
  const set = (p: Partial<Prefs["scanner"]>) => updatePrefs({ scanner: p });
  const nearest = QUALITY.reduce((a, b) => (Math.abs(b.q - scanner.jpegQuality) < Math.abs(a.q - scanner.jpegQuality) ? b : a));
  return (
    <SettingsPage title="Scanner" description="Defaults for the camera. You can still change them while scanning.">
      <SyncNote />
      <Group title="Capture">
        <div className="px-3.5 py-1">
          <Switch checked={scanner.autoCapture} onChange={(v) => set({ autoCapture: v })} label="Auto capture" description="Shoots when the page is steady and in frame" />
          <Switch checked={scanner.batchMode} onChange={(v) => set({ batchMode: v })} label="Batch mode" description="Keep scanning pages into one document" />
          <Switch checked={scanner.autoCrop} onChange={(v) => set({ autoCrop: v })} label="Auto crop" description="Detect the page edges and flatten the perspective" />
        </div>
      </Group>
      <Group title="Image">
        <FieldBlock label="Default filter">
          <Segmented size="sm" value={scanner.defaultFilter} onChange={(v) => set({ defaultFilter: v })} options={FILTERS} />
        </FieldBlock>
        <FieldBlock label="Quality" hint="Sharper pages make larger PDFs. Balanced suits most documents.">
          <Segmented
            size="sm"
            value={nearest.value}
            onChange={(v) => set({ jpegQuality: Number(v) })}
            options={QUALITY.map(({ value, label }) => ({ value, label }))}
          />
        </FieldBlock>
      </Group>
    </SettingsPage>
  );
}

/* ----------------------------------- OCR ---------------------------------- */

export function OcrSettings() {
  const prefs = usePrefs();
  const status = useQuery<OcrStatusInfo>("/api/ocr/status", api.ocrStatus, { refreshInterval: 4000 });
  const drive = useDriveStatus();
  const [confirm, setConfirm] = useState(false);
  const s = status.data;
  const busy = !!s && (s.pending > 0 || !!s.running);
  return (
    <SettingsPage title="Text recognition" description="Waraq reads the text on every page so you can search and copy it.">
      <Group title="Queue">
        {status.loading && !s ? (
          <div className="px-4 py-3.5">
            <Skeleton className="h-5 w-40" />
          </div>
        ) : s ? (
          <>
            <Row
              icon={busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
              tone={busy ? "accent" : "default"}
              label={busy ? (s.running ? "Reading text" : "Waiting") : "All caught up"}
              detail={
                s.running ? (
                  <Link href={`/d/${s.running.docId}`} className="underline-offset-2 hover:underline" dir="auto">
                    {s.running.title}
                  </Link>
                ) : busy ? undefined : (
                  "Nothing waiting"
                )
              }
              trailing={s.pending ? <Badge tone="accent">{s.pending} waiting</Badge> : null}
            />
          </>
        ) : (
          <Row icon={<ScanText />} label="Status unavailable" detail={errorMessage(status.error)} />
        )}
      </Group>

      <Group title="Engines" footer="Drive OCR is usually better for Arabic. Tesseract runs on your server when Drive is off or fails.">
        <div className="px-3.5 py-1">
          <Switch
            checked={prefs.ocr.useDriveOcr && !!s?.engineAvailable.drive}
            onChange={(v) => updatePrefs({ ocr: { useDriveOcr: v } })}
            label="Use Google Drive OCR"
            description={s && !s.engineAvailable.drive ? (drive.connected ? "Not available right now" : "Connect Google Drive first") : "Sends page images to your Drive"}
          />
        </div>
        <Row icon={<ScanText />} label="Tesseract" detail="On this server" trailing={<Badge>Always on</Badge>} />
        {!drive.connected && <Row icon={<Cloud />} label="Connect Google Drive" href="/settings/drive" chevron />}
      </Group>

      <Group title="Languages">
        <FieldBlock label="Read pages as">
          <Segmented
            size="sm"
            value={prefs.ocr.languages.join("+") as "ara+eng"}
            onChange={(v) => updatePrefs({ ocr: { languages: v.split("+") as Prefs["ocr"]["languages"] } })}
            options={[
              { value: "ara+eng", label: "Arabic + English" },
              { value: "eng" as "ara+eng", label: "English" },
              { value: "ara" as "ara+eng", label: "Arabic" },
            ]}
          />
        </FieldBlock>
      </Group>

      <Group title="Maintenance">
        <Row
          icon={<RefreshCw />}
          label="Re-run OCR on all documents"
          detail="Useful after changing engines or languages"
          onClick={() => setConfirm(true)}
          chevron
        />
      </Group>

      <ConfirmSheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Re-run OCR on everything?"
        body="Every document is queued again. Search keeps working with the old text until each one finishes."
        confirmLabel="Re-run OCR"
        tone="primary"
        onConfirm={async () => {
          const r = await api.ocrRerun({ all: true });
          toast.success(`Queued ${plural(r.queued, "document")}`);
          void status.refresh();
          refreshLibrary();
        }}
      />
    </SettingsPage>
  );
}

/* --------------------------------- devices -------------------------------- */

function describeAgent(ua: string | null): { name: string; icon: React.ReactNode } {
  if (!ua) return { name: "Unknown device", icon: <Laptop /> };
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone/i.test(ua)
      ? "iPhone"
      : /iPad/i.test(ua)
        ? "iPad"
        : /Mac OS X|Macintosh/i.test(ua)
          ? "Mac"
          : /Windows/i.test(ua)
            ? "Windows"
            : /CrOS/i.test(ua)
              ? "ChromeOS"
              : /Linux/i.test(ua)
                ? "Linux"
                : "Device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /SamsungBrowser/.test(ua)
      ? "Samsung Internet"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const icon = /iPad|Tablet/i.test(ua) ? <Tablet /> : /Android|iPhone|Mobile/i.test(ua) ? <Smartphone /> : <Laptop />;
  return { name: `${browser} on ${os}`, icon };
}

export function DevicesSettings() {
  const sessions = useQuery<SessionInfo[]>("/api/sessions", api.sessions);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const list = [...(sessions.data ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt));
  const others = list.filter((s) => !s.current);
  return (
    <SettingsPage title="Devices" description="Browsers signed in to your Waraq.">
      <Group title={sessions.data ? plural(list.length, "session") : "Sessions"}>
        {sessions.loading && !sessions.data ? (
          <div className="space-y-2 px-4 py-3.5">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-40" />
          </div>
        ) : sessions.error && !sessions.data ? (
          <Row icon={<Laptop />} label="Could not load sessions" detail={errorMessage(sessions.error)} />
        ) : (
          list.map((s) => {
            const d = describeAgent(s.userAgent);
            return (
              <Row
                key={s.id}
                icon={d.icon}
                tone={s.current ? "accent" : "default"}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{d.name}</span>
                    {s.current && <Badge tone="accent">This device</Badge>}
                  </span>
                }
                detail={`Active ${formatDate(s.lastSeenAt)} · signed in ${formatDate(s.createdAt)}`}
                trailing={
                  s.current ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      loading={busy === s.id}
                      onClick={async () => {
                        setBusy(s.id);
                        try {
                          await api.revokeSession(s.id);
                          mutate<SessionInfo[]>("/api/sessions", (prev) => prev?.filter((x) => x.id !== s.id));
                          toast.success("Signed out that device");
                        } catch (e) {
                          toast.error(errorMessage(e));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      Sign out
                    </Button>
                  )
                }
              />
            );
          })
        )}
      </Group>
      {others.length > 0 && (
        <Group>
          <Row icon={<LogOut />} tone="danger" label="Sign out all other devices" detail={plural(others.length, "session")} onClick={() => setConfirm(true)} />
        </Group>
      )}
      <ConfirmSheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Sign out other devices?"
        body="They will need your password to sign in again. This device stays signed in."
        confirmLabel="Sign out others"
        onConfirm={async () => {
          await api.revokeOtherSessions();
          await sessions.refresh();
          toast.success("Other devices signed out");
        }}
      />
    </SettingsPage>
  );
}

/* --------------------------------- storage -------------------------------- */

const RETENTION: Prefs["trash"]["retentionDays"][] = [7, 14, 30, 60, 90];


export function StorageSettings() {
  const storage = useStorageUsage();
  const prefs = usePrefs();
  const [confirm, setConfirm] = useState(false);
  const total = (storage.data?.live.bytes ?? 0) + (storage.data?.trash.bytes ?? 0);
  const livePct = total ? ((storage.data?.live.bytes ?? 0) / total) * 100 : 0;
  return (
    <SettingsPage title="Storage" description="Everything is stored as PDFs on your own server.">
      <Group title="Usage">
        <div className="bg-[linear-gradient(160deg,rgb(124_77_255/0.16),rgb(124_77_255/0)_65%)] px-4 py-4">
          {storage.loading && !storage.data ? (
            <div className="space-y-2.5">
              <Skeleton className="h-6 w-28" />
              <Skeleton className="h-1.5 w-full" />
            </div>
          ) : storage.data ? (
            <>
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <p className="display text-[28px] leading-none tabular-nums">{formatBytes(total)}</p>
                <p className="min-w-0 truncate text-right text-[13px] text-muted">
                  {plural(storage.data.live.count, "document")} · {plural(storage.data.live.pages, "page")}
                </p>
              </div>
              <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-black/30 shadow-[inset_0_1px_2px_rgb(0_0_0/0.4)]" aria-hidden>
                <div className="h-full rounded-full bg-gradient-to-r from-accent-strong to-accent" style={{ width: `${livePct}%` }} />
                <div className="h-full bg-white/25" style={{ width: `${100 - livePct}%` }} />
              </div>
            </>
          ) : (
            <p className="text-sm text-danger">{errorMessage(storage.error)}</p>
          )}
        </div>
        <Row label="Library" trailing={<span className="text-[14px] text-muted tabular-nums">{storage.data ? formatBytes(storage.data.live.bytes) : "…"}</span>} />
        <Row
          label="Trash"
          detail={storage.data ? plural(storage.data.trash.count, "document") : undefined}
          href="/trash"
          chevron
          trailing={<span className="text-[14px] text-muted tabular-nums">{storage.data ? formatBytes(storage.data.trash.bytes) : "…"}</span>}
        />
      </Group>

      <Group title="Trash" footer="Documents in Trash are deleted for good after this many days.">
        <FieldBlock label="Keep deleted documents for">
          <Segmented
            size="sm"
            value={String(prefs.trash.retentionDays)}
            onChange={(v) => updatePrefs({ trash: { retentionDays: Number(v) as Prefs["trash"]["retentionDays"] } })}
            options={RETENTION.map((d) => ({
              value: String(d),
              label: `${d}d`,
              ariaLabel: plural(d, "day"),
            }))}
          />
        </FieldBlock>
        <Row
          icon={<Trash2 />}
          tone="danger"
          label="Empty trash now"
          detail={storage.data ? `${plural(storage.data.trash.count, "document")} · ${formatBytes(storage.data.trash.bytes)}` : undefined}
          disabled={!storage.data?.trash.count}
          onClick={() => setConfirm(true)}
        />
      </Group>

      <ConfirmSheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Empty Trash?"
        body={`${plural(storage.data?.trash.count ?? 0, "document")} will be removed from the server for good.`}
        confirmLabel="Empty trash"
        onConfirm={async () => {
          const ids = storage.data?.trash.ids ?? [];
          await Promise.allSettled(ids.map((id) => api.deleteForever(id)));
          mutate(STORAGE_KEY, undefined);
          await storage.refresh();
          refreshLibrary();
          toast.success("Trash emptied");
        }}
      />
    </SettingsPage>
  );
}

/* ---------------------------------- drive --------------------------------- */

export function DrivePage() {
  return (
    <SettingsPage title="Google Drive" description="Mirror PDFs to your Drive and use Drive for better OCR.">
      <DriveSettings />
    </SettingsPage>
  );
}

/* ---------------------------------- about --------------------------------- */

export function AboutSettings() {
  const update = useUpdateState();
  const [checking, setChecking] = useState(false);
  const [checkedOnce, setCheckedOnce] = useState(false);
  // hidden: tap a version row 5 times for "Scanner diagnostics"
  const diagnostics = useDiagnosticsUnlock();
  useEffect(() => {
    void checkForUpdate();
  }, []);
  return (
    <SettingsPage title="About" description="Waraq, a private document scanner on your own server.">
      <Group title="Version">
        <Row
          label="Running build"
          onClick={diagnostics.tap}
          trailing={<code className="truncate text-[13px] text-muted">{update.current ?? "…"}</code>}
        />
        {update.latest && update.latest !== update.current && (
          <Row label="Latest on server" trailing={<code className="truncate text-[13px] text-accent">{update.latest}</code>} />
        )}
        {update.builtAt && <Row label="Built" trailing={<span className="text-[13px] text-muted">{formatDateTime(update.builtAt)}</span>} />}
        <Row label="Offline support" trailing={<span className="text-[13px] text-muted">{update.swActive ? "On" : "Off"}</span>} />
        {update.available ? (
          <Row
            icon={<RefreshCw />}
            tone="accent"
            label="Update available"
            detail="Reloads Waraq with the new version"
            trailing={
              <Button size="sm" variant="primary" loading={update.applying} onClick={() => void applyUpdate()}>
                Update
              </Button>
            }
          />
        ) : (
          <Row
            icon={checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            label="Check for updates"
            detail={
              checkedOnce
                ? "You are on the latest version"
                : update.checkedAt
                  ? `Last checked ${formatDateTime(new Date(update.checkedAt).toISOString())}`
                  : undefined
            }
            onClick={async () => {
              setChecking(true);
              try {
                await checkForUpdate(true);
                setCheckedOnce(true);
              } finally {
                setChecking(false);
              }
            }}
          />
        )}
      </Group>
      {diagnostics.visible && <ScannerDiagnostics onHide={diagnostics.hide} />}
    </SettingsPage>
  );
}
