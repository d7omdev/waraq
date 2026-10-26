"use client";
// Google Drive group for /settings. Self-contained: setup (when no env credentials), connect, status, sync, disconnect.
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Cloud, CloudOff, Copy, ExternalLink, KeyRound, LogOut, RefreshCw, RotateCcw } from "lucide-react";
import type { DriveStatus } from "@/lib/types";
import { errorMessage } from "@/lib/client/api";
import { mutate } from "@/lib/client/query";
import { formatDateTime, plural } from "@/lib/client/format";
import { Button, Group, ProgressBar, Row, Skeleton, TextField, Toggle } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { DRIVE_STATUS_KEY, driveApi, refreshDriveStatus, useDriveStatusQuery } from "./save-to-drive-action";

const LINKS = {
  consent: "https://console.cloud.google.com/auth/overview",
  driveApi: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
  client: "https://console.cloud.google.com/auth/clients/create",
};

const CALLBACK_ERRORS: Record<string, string> = {
  invalid_state: "The sign-in link expired or was opened in another browser. Try Connect again.",
  access_denied: "Google access was not granted.",
  exchange_failed: "Google did not accept the sign-in. Check the client ID, secret and redirect URI.",
  missing_code: "Google returned no authorization code. Try again.",
  google_error: "Google reported an error. Try again.",
};

function useCallbackToast() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("drive");
    if (!result) return;
    if (result === "connected") toast.success("Google Drive connected");
    else toast.error(CALLBACK_ERRORS[url.searchParams.get("reason") ?? ""] ?? "Could not connect Google Drive");
    url.searchParams.delete("drive");
    url.searchParams.delete("reason");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    void refreshDriveStatus();
  }, []);
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="focus-ring inline-flex items-center gap-1 rounded text-accent underline-offset-2 hover:underline"
    >
      {children}
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 rounded-xl border border-line bg-black/25 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 font-mono text-[13px] leading-snug break-all text-ink select-all">{value}</code>
      <Button
        size="sm"
        variant="ghost"
        className="h-11 min-w-11"
        aria-label="Copy redirect URI"
        icon={copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
          } catch {
            toast.error("Copy failed. Select the text and copy it manually.");
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function SetupForm({ status }: { status: DriveStatus }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const st = await driveApi.saveConfig(clientId.trim(), secret.trim());
      mutate(DRIVE_STATUS_KEY, st);
      setSecret("");
      toast.success("OAuth client saved. Now connect your Google account.");
    } catch (e) {
      setError(errorMessage(e, "Could not save the credentials"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Group
      title="Google Drive"
      footer="Waraq only gets access to files it creates (drive.file scope). The secret is stored encrypted on your server and never sent back to the browser."
    >
      <div className="px-4 py-4">
        <p className="text-[15px] text-ink">Set up a Google OAuth client</p>
        <p className="mt-1 text-[13px] text-muted">One-time setup in Google Cloud Console, about five minutes.</p>
        <ol className="mt-4 space-y-3 text-[14px] leading-relaxed text-muted">
          <li>
            <span className="text-ink">1. Create a project and the consent screen.</span> Choose External, add your email as a test user, then click Publish app
            so sign-in does not expire after 7 days. drive.file is non-sensitive, so publishing needs no Google review.
            <span className="mt-1 block">
              <ExtLink href={LINKS.consent}>Open consent screen</ExtLink>
            </span>
          </li>
          <li>
            <span className="text-ink">2. Enable the Google Drive API.</span>
            <span className="mt-1 block">
              <ExtLink href={LINKS.driveApi}>Open Drive API</ExtLink>
            </span>
          </li>
          <li>
            <span className="text-ink">3. Create an OAuth client</span> of type Web application, with this Authorized redirect URI:
            <CopyField value={status.redirectUri} />
            <span className="mt-2 block">
              <ExtLink href={LINKS.client}>Open Create OAuth client</ExtLink>
            </span>
          </li>
          <li>
            <span className="text-ink">4. Paste the client ID and secret below.</span>
          </li>
        </ol>
        <form method="post"
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextField
            label="Client ID"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="1234567890-abc.apps.googleusercontent.com"
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
          />
          <TextField
            label="Client secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="GOCSPX-…"
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            error={error}
          />
          <Button type="submit" variant="primary" loading={saving} disabled={!clientId.trim() || !secret.trim()} block>
            Save client
          </Button>
        </form>
      </div>
    </Group>
  );
}

function ConnectButton({ label = "Connect" }: { label?: string }) {
  // Full-page navigation: the server answers with a 302 to Google's consent screen.
  return (
    <a
      href="/api/drive/connect"
      className="focus-ring inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-accent-strong bg-[linear-gradient(180deg,rgb(255_255_255/0.14),rgb(255_255_255/0))] px-4 text-sm font-semibold text-white shadow-accent transition-colors hover:bg-accent-hover active:bg-accent-deep"
    >
      {label}
    </a>
  );
}

function ResetCredentialsRow({ status, onDone }: { status: DriveStatus; onDone: (s: DriveStatus) => void }) {
  const [busy, setBusy] = useState(false);
  if (status.credentialsSource !== "settings") return null;
  return (
    <Row
      icon={<RotateCcw />}
      label="Replace OAuth client"
      detail={status.clientIdMasked ?? undefined}
      disabled={busy}
      onClick={async () => {
        if (!window.confirm("Remove the saved OAuth client? Google Drive will be disconnected. Files already in Drive stay there.")) return;
        setBusy(true);
        try {
          onDone(await driveApi.resetConfig());
          toast.success("OAuth client removed");
        } catch (e) {
          toast.error(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

export function DriveSettings() {
  useCallbackToast();
  const { data: status, error, loading } = useDriveStatusQuery();
  const [busy, setBusy] = useState<"auto" | "sync" | "disconnect" | null>(null);
  const set = (s: DriveStatus) => mutate(DRIVE_STATUS_KEY, s);

  if (!status) {
    return (
      <Group title="Google Drive">
        {loading ? (
          <div className="px-4 py-3.5">
            <Skeleton className="h-5 w-40" />
          </div>
        ) : (
          <Row icon={<AlertTriangle />} tone="danger" label="Could not load Drive status" detail={errorMessage(error)} />
        )}
      </Group>
    );
  }

  if (!status.configured) return <SetupForm status={status} />;

  if (!status.connected) {
    return (
      <Group
        title="Google Drive"
        footer={
          "Optional backup: mirror every document as a PDF into a Waraq folder in your Drive, keeping your folders. Your documents always stay on this server. Waraq only sees files it creates."
        }
      >
        <Row
          icon={status.needsReconnect ? <AlertTriangle /> : <CloudOff />}
          tone={status.needsReconnect ? "danger" : "default"}
          label={status.needsReconnect ? "Reconnect Google Drive" : "Google Drive"}
          detail={
            status.needsReconnect
              ? (status.lastError ?? "Google access expired. Pending uploads resume after reconnecting.")
              : status.credentialsSource === "env"
                ? "Not connected"
                : "Not connected · OAuth client saved"
          }
          trailing={<ConnectButton label={status.needsReconnect ? "Reconnect" : "Connect"} />}
        />
        <ResetCredentialsRow status={status} onDone={set} />
      </Group>
    );
  }

  const { pending, failed } = status.queue;
  const { total, synced } = status.docs;
  const notMirrored = Math.max(0, total - synced);

  const toggleAuto = async (on: boolean) => {
    setBusy("auto");
    set({ ...status, autoSync: on });
    try {
      set(await driveApi.settings({ autoSync: on }));
    } catch (e) {
      set({ ...status });
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const syncAll = async () => {
    setBusy("sync");
    try {
      const { queued } = await driveApi.sync({ all: true });
      toast.success(queued ? `Syncing ${plural(queued, "document")}` : "No documents to sync");
      await refreshDriveStatus();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    const msg = "Disconnect Google Drive? Files already in Drive stay there; Waraq stops updating them.";
    if (!window.confirm(msg)) return;
    setBusy("disconnect");
    try {
      set(await driveApi.disconnect());
      toast.success("Google Drive disconnected");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const progressDetail =
    pending > 0 ? `Uploading · ${plural(pending, "item")} left` : status.lastSyncAt ? `Last synced ${formatDateTime(status.lastSyncAt)}` : "Nothing synced yet";

  return (
    <Group
      title="Google Drive"
      footer={
        status.autoSync
            ? "New and edited documents are uploaded about 10 seconds after the last change. Trashed documents move to Waraq/Trash in Drive; deleting them for good moves them to Drive's trash."
            : "Auto mirror is off. Only documents you save to Drive are uploaded, and those stay up to date."
      }
    >
      <Row
        icon={<Cloud />}
        tone="accent"
        label={status.email ?? "Connected"}
        detail="Google Drive · Waraq folder"
        trailing={
          status.rootFolderUrl ? (
            <a
              href={status.rootFolderUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-accent hover:bg-white/6"
            >
              Open <ExternalLink className="size-4" aria-hidden />
            </a>
          ) : null
        }
      />
      {(

        <>
          <Row
            label="Auto mirror"
            detail="Upload every new or changed document"
            trailing={
              <span className={busy === "auto" ? "pointer-events-none opacity-60" : undefined}>
                <Toggle checked={status.autoSync} onChange={(v) => void toggleAuto(v)} label="Auto mirror" />
              </span>
            }
          />
          <div className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[15px] text-ink">
                {synced} of {plural(total, "document")} in Drive
              </span>
              <span className="text-[13px] text-muted">{progressDetail}</span>
            </div>
            <ProgressBar className="mt-2.5" value={total ? synced / total : 0} />
          </div>
          {(failed > 0 || status.lastError) && (
            <Row
              icon={<AlertTriangle />}
              tone="danger"
              label={failed > 0 ? `${plural(failed, "upload")} failed` : "Last sync error"}
              detail={status.lastError ?? "Retrying with backoff"}
            />
          )}
          <Row
            icon={<RefreshCw className={busy === "sync" || pending > 0 ? "animate-spin" : undefined} />}
            label={failed > 0 ? "Retry and sync everything now" : "Sync everything now"}
            detail={notMirrored > 0 ? `${plural(notMirrored, "document")} not in Drive yet` : "Re-check every document"}
            onClick={() => void syncAll()}
            disabled={busy === "sync"}
          />
        </>
      )}
      <Row
        icon={<LogOut />}
        tone="danger"
        label="Disconnect"
        detail="Revokes access. Files already in Drive are kept."
        onClick={() => void disconnect()}
        disabled={busy === "disconnect"}
      />
      {status.credentialsSource === "settings" ? (
        <ResetCredentialsRow status={status} onDone={set} />
      ) : (
        <Row icon={<KeyRound />} label="OAuth client" detail={`Set on the server · ${status.clientIdMasked ?? ""}`} />
      )}
    </Group>
  );
}
