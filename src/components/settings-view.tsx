"use client";

import { useState } from "react";
import {
  Camera,
  CloudUpload,
  Download,
  HardDrive,
  Info,
  LayoutGrid,
  Link2,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
  ScanText,
  Smartphone,
} from "lucide-react";
import { Avatar } from "./settings/account-settings";
import { api } from "@/lib/client/api";
import { useQuery } from "@/lib/client/query";
import { formatBytes, plural } from "@/lib/client/format";
import { useInstallState } from "@/hooks/runtime";
import { usePrefs } from "@/lib/client/prefs";
import { applyUpdate, useUpdateState } from "@/lib/client/app-update";
import { Button, Group, Row } from "@/components/ui/primitives";
import { useInstallAction } from "@/components/install/install-banner";
import { useDriveStatus } from "@/components/drive/save-to-drive-action";
import type { Me, OcrStatusInfo, SessionInfo, ShareLinkWithDoc } from "@/lib/types";
import { useStorageUsage } from "./settings/storage-data";

const count = (n: number | undefined) => <span className="shrink-0 text-[14px] text-muted tabular-nums">{n ?? "…"}</span>;

/** Settings home: an index of sections, each with a live summary. */
export function SettingsView() {
  const me = useQuery<Me>("/api/auth/me", api.me);
  const storage = useStorageUsage();
  const prefs = usePrefs();
  const shares = useQuery<ShareLinkWithDoc[]>("/api/shares?status=active", () => api.allShares("active"));
  const sessions = useQuery<SessionInfo[]>("/api/sessions", api.sessions);
  const ocr = useQuery<OcrStatusInfo>("/api/ocr/status", api.ocrStatus);
  const drive = useDriveStatus();
  const install = useInstallState();
  const installAction = useInstallAction(install);
  const update = useUpdateState();
  const [loggingOut, setLoggingOut] = useState(false);
  const isApp = install.standalone || install.installed;
  const total = (storage.data?.live.bytes ?? 0) + (storage.data?.trash.bytes ?? 0);

  return (
    <div className="pb-dock mx-auto w-full max-w-2xl min-w-0 px-4 pt-[calc(var(--sat)+24px)] sm:px-6 lg:pt-12">
      <h1 className="display mb-6 text-[28px] leading-[1.1] sm:text-[36px]">Settings</h1>

      <div className="space-y-7">
        {update.available && (
          <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-accent/30 bg-accent-tint px-4 py-3">
            <RefreshCw className="size-5 shrink-0 text-accent" />
            <p className="min-w-0 flex-1 text-[14px] text-ink">A new version of Waraq is ready.</p>
            <Button size="sm" variant="primary" loading={update.applying} onClick={() => void applyUpdate()}>
              Update
            </Button>
          </div>
        )}

        <Group title="Documents">
          <Row
            icon={<Link2 />}
            label="Shared links"
            detail={shares.data ? (shares.data.length ? `${plural(shares.data.length, "active link")}` : "No active links") : "Manage every link you shared"}
            href="/settings/sharing"
            chevron
          />
          <Row
            icon={<LayoutGrid />}
            label="Library"
            detail={`${prefs.library.browseMode === "folders" ? "Browse by folder" : "All documents"} · ${prefs.library.view === "grid" ? `${prefs.library.gridColumnsMobile} columns` : "List"}`}
            href="/settings/library"
            chevron
          />
          <Row
            icon={<Camera />}
            label="Scanner"
            detail={`${prefs.scanner.autoCapture ? "Auto capture" : "Manual capture"} · ${prefs.scanner.batchMode ? "Batch" : "Single page"}`}
            href="/settings/scanner"
            chevron
          />
          <Row
            icon={<ScanText />}
            label="Text recognition"
            detail={
              ocr.data
                ? ocr.data.running || ocr.data.pending
                  ? `${ocr.data.pending} waiting${ocr.data.running ? " · 1 running" : ""}`
                  : ocr.data.engineAvailable.drive && prefs.ocr.useDriveOcr
                    ? "Google Drive OCR, Tesseract fallback"
                    : "Tesseract, English and Arabic"
                : "English and Arabic"
            }
            href="/settings/ocr"
            chevron
          />
        </Group>

        <Group title="Storage and sync">
          <Row
            icon={<HardDrive />}
            label="Storage"
            detail={
              storage.data
                ? `${plural(storage.data.live.count, "document")} · ${storage.data.trash.count} in trash`
                : "Usage and trash"
            }
            trailing={<span className="shrink-0 text-[14px] text-muted tabular-nums">{storage.data ? formatBytes(total) : "…"}</span>}
            href="/settings/storage"
            chevron
          />
          <Row
            icon={<CloudUpload />}
            label="Google Drive"
            detail={drive.connected ? "Connected" : "Back up and OCR with Drive"}
            href="/settings/drive"
            chevron
          />
        </Group>

        <Group title="App and account">
          <Row
            icon={<Smartphone />}
            label="Devices"
            detail={sessions.data ? plural(sessions.data.length, "signed-in device") : "Where you are signed in"}
            trailing={sessions.data ? count(sessions.data.length) : undefined}
            href="/settings/devices"
            chevron
          />
          <Row
            icon={<MonitorSmartphone />}
            label={isApp ? "Installed" : "Install Waraq"}
            detail={isApp ? "Running as an app on this device" : install.ios ? "Add to Home Screen from Safari" : "Home screen icon and share menu entry"}
            trailing={
              isApp ? null : (
                <Button size="sm" variant="primary" icon={<Download className="size-4" />} onClick={installAction.run}>
                  Install
                </Button>
              )
            }
          />
          <Row icon={<Info />} label="About" detail={update.current ? `Build ${update.current.slice(0, 10)}` : "Version and updates"} href="/settings/about" chevron />
        </Group>
        {installAction.sheet}

        <Group title="Account">
          <Row
            icon={<Avatar me={me.data} size={32} />}
            label={me.data ? me.data.name || me.data.username : "…"}
            detail={me.data ? (me.data.username ? `@${me.data.username} · ${me.data.email}` : me.data.email) : "Profile and sign-in"}
            href="/settings/account"
            chevron
          />
          <Row
            icon={<LogOut />}
            tone="danger"
            label={loggingOut ? "Signing out…" : "Sign out"}
            disabled={loggingOut}
            onClick={async () => {
              setLoggingOut(true);
              try {
                await api.logout();
              } catch {
                /* still leave */
              }
              window.location.replace("/login");
            }}
          />
        </Group>

        <p className="px-1 text-center text-[13px] text-faint">
          Documents are stored as PDFs on this server.{" "}
          Trash empties after {plural(prefs.trash.retentionDays, "day")}.
        </p>
      </div>
    </div>
  );
}
