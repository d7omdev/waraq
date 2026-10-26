"use client";

import { useState, type ReactNode } from "react";
import QRCode from "qrcode";
import Link from "next/link";
import {
  Check,
  ExternalLink,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Lock,
  Mail,
  MessageCircle,
  MessageSquare,
  Pencil,
  QrCode,
  Send,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { api, ApiRequestError, errorMessage, type ShareExpiry } from "@/lib/client/api";
import { cx, formatDate, plural, relativeFuture } from "@/lib/client/format";
import { appShareUrl, copyText, openShareApp, shareLink, vibrate, type ShareApp } from "@/lib/client/device";
import type { ShareLink } from "@/lib/types";
import type { ShareStatus } from "@/lib/client/contract";
import { Badge, Button, Segmented, Switch, TextField } from "@/components/ui/primitives";
import { Thumb } from "@/components/ui/media";
import { toast } from "@/components/ui/toast";

export const EXPIRY_OPTIONS: { value: ShareExpiry; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "1d", label: "1d" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "never", label: "Never" },
];

export type AnyShare = ShareLink & { docTitle?: string; docThumbUrl?: string; status?: ShareStatus };

export function shareStatus(s: AnyShare, now: number): ShareStatus {
  if (s.status) return s.status;
  if (s.revokedAt) return "revoked";
  if (s.expiresAt && new Date(s.expiresAt).getTime() <= now) return "expired";
  return "active";
}

export const SHARE_APPS: { app: ShareApp; label: string; icon: ReactNode; tint: string }[] = [
  { app: "whatsapp", label: "WhatsApp", icon: <MessageCircle />, tint: "#25d366" },
  { app: "telegram", label: "Telegram", icon: <Send />, tint: "#2aabee" },
  { app: "email", label: "Email", icon: <Mail />, tint: "#b9a6ff" },
  { app: "sms", label: "SMS", icon: <MessageSquare />, tint: "#ada7c0" },
];

/** Round brand-tinted app button used for "Send link via" rows. */
export function AppButton({
  label,
  icon,
  tint,
  onClick,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  tint: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="focus-ring flex min-w-0 flex-col items-center gap-1.5 rounded-xl py-1.5 text-[12px] font-medium text-muted transition-colors hover:text-ink disabled:opacity-40"
    >
      <span
        className="flex size-11 items-center justify-center rounded-full border border-white/8 shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] [&_svg]:size-5"
        style={{ color: tint, background: `color-mix(in srgb, ${tint} 15%, transparent)` }}
      >
        {icon}
      </span>
      <span className="max-w-full truncate">{label}</span>
    </button>
  );
}

export async function qrDataUrl(url: string) {
  return QRCode.toDataURL(url, {
    margin: 1,
    width: 480,
    color: { dark: "#14121a", light: "#ffffff" },
    errorCorrectionLevel: "M",
  });
}

export function QrPanel({ src, url, title }: { src: string; url: string; title: string }) {
  return (
    <div className="mt-3 flex animate-pop-in flex-col items-center gap-2 rounded-xl bg-white p-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="QR code for the share link" className="size-52 max-w-full [image-rendering:pixelated]" />
      <p className="text-center text-[13px] text-stone-600">Scan to open on another phone</p>
      <a
        href={src}
        download={`${title.slice(0, 60) || "link"} QR.png`}
        className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-stone-700 hover:bg-stone-100"
        title={url}
      >
        <Download className="size-4" /> Save QR image
      </a>
    </div>
  );
}

/**
 * One share link with every action: copy, share, QR, send via apps, edit
 * (expiry, password, download), revoke, remove from list.
 */
export function ShareLinkCard({
  share,
  title,
  now,
  onChanged,
  showDoc,
}: {
  share: AnyShare;
  title: string;
  now: number;
  onChanged: (updated?: AnyShare | null) => void;
  showDoc?: boolean;
}) {
  const [panel, setPanel] = useState<null | "qr" | "edit" | "revoke" | "apps">(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = shareStatus(share, now || Date.parse(share.createdAt));
  const active = status === "active";

  const toggle = (p: typeof panel) => setPanel((cur) => (cur === p ? null : p));

  const showQr = async () => {
    if (panel === "qr") return setPanel(null);
    try {
      setQr(await qrDataUrl(share.url));
    } catch {
      setQr(api.shareQrUrl(share.id));
    }
    setPanel("qr");
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await api.revokeShare(share.id);
      vibrate(10);
      toast.success("Link revoked");
      setPanel(null);
      onChanged({ ...share, revokedAt: new Date().toISOString(), status: "revoked" });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const purge = async () => {
    setBusy(true);
    try {
      await api.purgeShare(share.id);
      toast.success("Removed from the list");
      onChanged(null);
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 404) toast.error("This server cannot remove old links yet");
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={cx("surface min-w-0 list-none rounded-2xl p-3", !active && "opacity-80")} data-share-card>
      <div className="flex min-w-0 items-start gap-3">
        {showDoc && share.docThumbUrl ? (
          <div className="flex h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-s3 p-0.5">
            <Thumb src={share.docThumbUrl} className="size-full rounded-[3px]" />
          </div>
        ) : (
          <div
            className={cx(
              "flex size-9 shrink-0 items-center justify-center rounded-[10px]",
              active ? "bg-accent-tint text-accent" : "bg-white/6 text-faint",
            )}
          >
            {share.hasPassword ? <Lock className="size-[18px]" /> : <Link2 className="size-[18px]" />}
          </div>
        )}
        <div className="min-w-0 flex-1">
          {showDoc && (
            <Link href={`/d/${share.docId}`} dir="auto" className="focus-ring block truncate rounded text-[15px] font-medium text-ink hover:underline">
              {share.docTitle ?? title}
            </Link>
          )}
          <p className={cx("truncate font-mono text-[12.5px]", showDoc ? "text-muted" : "text-ink")}>{share.url.replace(/^https?:\/\//, "")}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {status !== "active" && <Badge tone={status === "revoked" ? "danger" : "default"}>{status === "revoked" ? "Revoked" : "Expired"}</Badge>}
            <Badge>
              <Eye />
              {plural(share.views, "view")}
            </Badge>
            {active && <Badge>{now ? relativeFuture(share.expiresAt, now) : "…"}</Badge>}
            {share.hasPassword && (
              <Badge>
                <KeyRound />
                Password
              </Badge>
            )}
            <Badge>
              {share.allowDownload ? <Download /> : <EyeOff />}
              {share.allowDownload ? "Download on" : "View only"}
            </Badge>
            {!active && <span className="text-[12px] text-faint">Created {formatDate(share.createdAt)}</span>}
          </div>
        </div>
      </div>

      {active ? (
        <div className="mt-3 grid grid-cols-5 gap-0.5">
          <RowBtn
            icon={copied ? <Check /> : <Copy />}
            label={copied ? "Copied" : "Copy"}
            onClick={async () => {
              if (await copyText(share.url)) {
                setCopied(true);
                vibrate(8, "success");
                window.setTimeout(() => setCopied(false), 1600);
              } else toast.error("Copy failed");
            }}
          />
          <RowBtn icon={<Share2 />} label="Send" active={panel === "apps"} onClick={() => toggle("apps")} />
          <RowBtn icon={<QrCode />} label="QR" active={panel === "qr"} onClick={showQr} />
          <RowBtn icon={<Pencil />} label="Edit" active={panel === "edit"} onClick={() => toggle("edit")} />
          <RowBtn icon={<Trash2 />} label="Revoke" tone="danger" onClick={() => toggle("revoke")} />
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="sm" block icon={<Copy className="size-4" />} onClick={() => void copyText(share.url).then((ok) => ok && toast("Copied (the link no longer works)"))}>
            Copy URL
          </Button>
          <Button size="sm" block variant="danger" loading={busy} icon={<X className="size-4" />} onClick={purge}>
            Remove
          </Button>
        </div>
      )}

      {active && panel === "apps" && (
        <div className="mt-2 grid animate-pop-in grid-cols-3 gap-0.5 rounded-xl border border-line bg-black/20 px-0.5 py-1.5 min-[400px]:grid-cols-6">
          <AppButton
            label="Open"
            icon={<ExternalLink />}
            tint="#ada7c0"
            onClick={() => window.open(share.url, "_blank", "noopener")}
          />
          <AppButton
            label="More…"
            icon={<Share2 />}
            tint="#b9a6ff"
            onClick={async () => {
              try {
                const r = await shareLink(share.url, title);
                if (r === "unsupported" && (await copyText(share.url))) toast.success("Link copied");
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          />
          {SHARE_APPS.map((a) => (
            <AppButton
              key={a.app}
              label={a.label}
              icon={a.icon}
              tint={a.tint}
              onClick={() => void openShareApp(a.app, appShareUrl(a.app, share.url, title))}
            />
          ))}
        </div>
      )}
      {panel === "qr" && qr && <QrPanel src={qr} url={share.url} title={title} />}
      {panel === "edit" && <EditLink share={share} onDone={(s) => { setPanel(null); if (s) onChanged(s); }} />}
      {panel === "revoke" && (
        <div className="mt-3 flex min-w-0 animate-pop-in flex-wrap items-center gap-2 rounded-xl border border-danger/20 bg-danger/8 p-2 pl-3">
          <p className="min-w-0 flex-1 text-[13px] text-danger">Revoke? The link stops working immediately.</p>
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)} data-autofocus>
              Keep
            </Button>
            <Button size="sm" variant="danger" loading={busy} onClick={revoke}>
              Revoke
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function EditLink({ share, onDone }: { share: AnyShare; onDone: (s: AnyShare | null) => void }) {
  const [expiresIn, setExpiresIn] = useState<ShareExpiry | "">("");
  const [allowDownload, setAllowDownload] = useState(share.allowDownload);
  const [pwMode, setPwMode] = useState<"keep" | "set" | "remove">("keep");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const body: { expiresIn?: ShareExpiry; password?: string | null; allowDownload?: boolean } = {};
    if (expiresIn) body.expiresIn = expiresIn;
    if (allowDownload !== share.allowDownload) body.allowDownload = allowDownload;
    if (pwMode === "set") {
      if (password.length < 4) return toast.error("Use at least 4 characters for the password");
      body.password = password;
    }
    if (pwMode === "remove") body.password = null;
    if (!Object.keys(body).length) return onDone(null);
    setBusy(true);
    try {
      const updated = await api.updateShare(share.id, body);
      toast.success("Link updated");
      onDone({ ...share, ...updated });
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405))
        toast.error("This server cannot edit links yet. Create a new link instead.");
      else toast.error(errorMessage(e, "Could not update the link"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 animate-pop-in space-y-3 rounded-xl border border-line bg-black/20 p-3">
      <div>
        <p className="mb-1.5 px-1 text-[13px] text-muted">{expiresIn ? "New expiry, counted from now" : "Change expiry (from now)"}</p>
        <Segmented size="sm" value={expiresIn} onChange={setExpiresIn} options={EXPIRY_OPTIONS} />
      </div>
      <Switch checked={allowDownload} onChange={setAllowDownload} label="Allow download" description="Viewers can save the PDF" />
      <div>
        <p className="mb-1.5 px-1 text-[13px] text-muted">Password</p>
        <Segmented
          size="sm"
          value={pwMode}
          onChange={setPwMode}
          options={[
            { value: "keep", label: share.hasPassword ? "Keep" : "None" },
            { value: "set", label: share.hasPassword ? "Change" : "Add" },
            ...(share.hasPassword ? [{ value: "remove" as const, label: "Remove" }] : []),
          ]}
        />
        {pwMode === "set" && (
          <div className="mt-2">
            <TextField
              type="text"
              autoComplete="off"
              placeholder="New password for viewers"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-autofocus
            />
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" block variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button size="sm" block variant="primary" loading={busy} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

export function RowBtn({
  icon,
  label,
  onClick,
  tone,
  active,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone?: "danger";
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "focus-ring flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-0.5 text-[12px] font-medium transition-colors hover:bg-white/5 active:bg-white/10 disabled:opacity-40 [&_svg]:size-[18px]",
        tone === "danger" ? "text-danger" : active ? "bg-white/5 text-accent" : "text-ink",
      )}
    >
      {icon}
      <span className="max-w-full truncate">{label}</span>
    </button>
  );
}
