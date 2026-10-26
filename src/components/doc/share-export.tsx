"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  CloudUpload,
  Copy,
  Download,
  FileArchive,
  FileText,
  Images,
  Link2,
  Lock,
  Plus,
  Printer,
  QrCode,
  Send,
  Settings2,
  Trash2,
} from "lucide-react";
import { api, errorMessage, fetchBlob, type ShareExpiry } from "@/lib/client/api";
import { useQuery } from "@/lib/client/query";
import { cx, formatBytes, plural } from "@/lib/client/format";
import {
  appShareUrl,
  canShareFiles,
  copyText,
  docPdfFile,
  downloadUrl,
  openShareApp,
  pageImageFile,
  pdfFileFromBlob,
  printDoc,
  saveBlob,
  shareFiles,
  shareLink,
  vibrate,
} from "@/lib/client/device";
import { usePrefs } from "@/lib/client/prefs";
import type { CompressLevel, DocDetail, ShareLink } from "@/lib/types";
import { Button, ListAction, Segmented, Spinner, Switch, TextField } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/sheet";
import { Thumb } from "@/components/ui/media";
import { toast } from "@/components/ui/toast";
import { saveToDrive, useDriveStatus } from "@/components/drive/save-to-drive-action";
import {
  AppButton,
  EXPIRY_OPTIONS,
  QrPanel,
  SHARE_APPS,
  ShareLinkCard,
  qrDataUrl,
  shareStatus,
  type AnyShare,
} from "@/components/share/share-link-card";

export function sharesKey(docId: string) {
  return `/api/docs/${docId}/shares`;
}

type Scope = "all" | "selected" | "custom";

/** Small section heading used inside the share sheet. */
function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("mt-5 first:mt-1", className)}>
      <div className="mb-2 flex min-h-9 items-center justify-between gap-2 px-2">
        <h3 className="text-[12px] font-semibold tracking-[0.08em] text-faint uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function SendTile({
  icon,
  title,
  sub,
  onClick,
  busy,
  primary,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
  busy?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={cx(
        "focus-ring flex min-h-[86px] min-w-0 flex-col justify-between gap-2.5 rounded-2xl p-3 text-left transition-colors disabled:opacity-60 [&_svg]:size-5",
        primary
          ? "bg-accent-strong bg-[linear-gradient(160deg,rgb(255_255_255/0.14),rgb(255_255_255/0)_60%)] text-white shadow-accent hover:bg-accent-hover"
          : "surface hover:border-line-strong",
      )}
    >
      {busy ? <Spinner className={cx("size-5", primary && "text-white")} /> : <span className={primary ? "" : "text-accent"}>{icon}</span>}
      <span className="min-w-0">
        <span className="block truncate text-[15px] leading-tight font-semibold">{title}</span>
        <span className={cx("mt-0.5 block truncate text-[12.5px]", primary ? "text-white/80" : "text-muted")}>{sub}</span>
      </span>
    </button>
  );
}

export function ShareSheet({
  open,
  onClose,
  doc,
  selectedPages,
  onOpenExport,
}: {
  open: boolean;
  onClose: () => void;
  doc: DocDetail;
  selectedPages: number[];
  onOpenExport?: () => void;
}) {
  const prefs = usePrefs();
  const drive = useDriveStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [compressOpen, setCompressOpen] = useState(false);
  const [qr, setQr] = useState<{ src: string; url: string } | null>(null);
  const [scope, setScope] = useState<Scope>(selectedPages.length ? "selected" : "all");
  const [custom, setCustom] = useState<number[]>([]);
  const shares = useQuery<ShareLink[]>(open ? sharesKey(doc.id) : null, () => api.shares(doc.id));
  const list: AnyShare[] = shares.data ?? doc.shares ?? [];
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!open) return;
    const tick = () => setNow(Date.now());
    const t0 = window.setTimeout(tick, 0);
    const t = window.setInterval(tick, 60_000);
    return () => {
      window.clearTimeout(t0);
      window.clearInterval(t);
    };
  }, [open]);
  const ref = now || Date.parse(doc.updatedAt);
  const active = list.filter((s) => shareStatus(s, ref) === "active");
  const old = list.filter((s) => shareStatus(s, ref) !== "active");
  const fileShare = canShareFiles();

  // page scope
  const effectiveScope: Scope = scope === "selected" && !selectedPages.length ? "all" : scope;
  const scopePages =
    effectiveScope === "selected" ? selectedPages : effectiveScope === "custom" ? [...custom].sort((a, b) => a - b) : null;
  const pagesArg = scopePages && scopePages.length && scopePages.length < doc.pageCount ? scopePages : undefined;
  const pageCount = pagesArg ? pagesArg.length : doc.pageCount;
  const emptyCustom = effectiveScope === "custom" && custom.length === 0;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const pdfFile = async () => {
    if (!pagesArg) return docPdfFile(doc.id, doc.title);
    const { blob } = await fetchBlob(api.exportUrl(doc.id, "pdf", pagesArg));
    return pdfFileFromBlob(blob, `${doc.title} (${plural(pagesArg.length, "page")})`);
  };

  const sendPdf = () =>
    run("pdf", async () => {
      if (!fileShare) {
        downloadUrl(pagesArg ? api.exportUrl(doc.id, "pdf", pagesArg) : api.fileUrl(doc.id, true));
        toast("This browser cannot send files, so the PDF was downloaded.");
        return;
      }
      const res = await shareFiles([await pdfFile()], doc.title);
      if (res === "unsupported") {
        downloadUrl(pagesArg ? api.exportUrl(doc.id, "pdf", pagesArg) : api.fileUrl(doc.id, true));
        toast("This browser cannot share PDFs, so it was downloaded.");
      }
    });

  const sendCompressed = (level: CompressLevel) =>
    run("compressed", async () => {
      const { blob } = await api.exportCompressed(doc.id, level, pagesArg);
      const file = pdfFileFromBlob(blob, `${doc.title} (small)`);
      const res = fileShare ? await shareFiles([file], doc.title) : "unsupported";
      if (res === "unsupported") {
        saveBlob(blob, file.name);
        toast(`Compressed copy downloaded (${formatBytes(blob.size)}).`);
      } else if (res === "shared") toast.success(`Sent ${formatBytes(blob.size)} copy`);
      setCompressOpen(false);
    });

  const sendImages = () =>
    run("img", async () => {
      const idx = pagesArg ?? doc.pages.map((p) => p.index);
      const files = await Promise.all(idx.map((i) => pageImageFile(doc.pages[i].imageUrl, doc.title, i)));
      const res = fileShare ? await shareFiles(files, doc.title) : "unsupported";
      if (res === "unsupported") {
        downloadUrl(api.exportUrl(doc.id, "jpg-zip", pagesArg));
        toast("Image sharing is not supported here. Downloading a zip instead.");
      }
    });

  /** Newest active link, or a fresh one with the default settings. */
  const ensureLink = async (): Promise<ShareLink> => {
    const newest = [...active].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (newest) return newest;
    const s = await api.createShare(doc.id, {
      expiresIn: prefs.sharing.defaultExpiry,
      allowDownload: prefs.sharing.defaultAllowDownload,
    });
    void shares.refresh();
    toast.success("Link created");
    return s;
  };

  const sendLink = () =>
    run("link", async () => {
      const s = await ensureLink();
      const r = await shareLink(s.url, doc.title);
      if (r === "unsupported" && (await copyText(s.url))) toast.success("Link copied");
    });

  const linkHint = active.length
    ? "Uses your newest link"
    : `Creates a ${EXPIRY_OPTIONS.find((x) => x.value === prefs.sharing.defaultExpiry)?.label === "Never" ? "permanent" : `${prefs.sharing.defaultExpiry}`} link${prefs.sharing.defaultAllowDownload ? "" : ", view only"}`;

  return (
    <Sheet open={open} onClose={onClose} title="Share" description={`${doc.title} · ${plural(doc.pageCount, "page")} · ${formatBytes(doc.sizeBytes)}`} size="lg">
      <div className="px-1 pb-2" data-share-sheet>
        {/* Page scope */}
        {doc.pageCount > 1 && (
          <div className="mb-1 px-1">
            <Segmented
              size="sm"
              value={effectiveScope}
              onChange={setScope}
              options={[
                { value: "all", label: `All ${doc.pageCount}` },
                ...(selectedPages.length ? [{ value: "selected" as const, label: `Selected ${selectedPages.length}` }] : []),
                { value: "custom", label: effectiveScope === "custom" && custom.length ? `Pick (${custom.length})` : "Pick pages" },
              ]}
            />
            {effectiveScope === "custom" && (
              <div className="no-scrollbar -mx-1 mt-2 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Pages to send">
                {doc.pages.map((p) => {
                  const on = custom.includes(p.index);
                  return (
                    <button
                      key={p.index}
                      type="button"
                      aria-pressed={on}
                      aria-label={`Page ${p.index + 1}`}
                      onClick={() => setCustom((c) => (on ? c.filter((x) => x !== p.index) : [...c, p.index]))}
                      className={cx(
                        "focus-ring relative h-[76px] w-[56px] shrink-0 overflow-hidden rounded-lg border-2 transition-colors",
                        on ? "border-accent" : "border-transparent opacity-70",
                      )}
                    >
                      <Thumb src={p.thumbUrl} className="absolute inset-0" />
                      <span
                        className={cx(
                          "absolute right-1 bottom-1 flex size-5 items-center justify-center rounded-full text-[11px] font-semibold",
                          on ? "bg-accent-strong text-white" : "bg-black/60 text-white",
                        )}
                      >
                        {on ? <Check className="size-3" strokeWidth={3} /> : p.index + 1}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <Section title="Send">
          <div className="grid grid-cols-2 gap-2 px-1">
            <SendTile
              primary
              icon={<Send />}
              title="Send PDF"
              sub={fileShare ? `${plural(pageCount, "page")} · WhatsApp, Gmail…` : "Downloads the PDF"}
              busy={busy === "pdf"}
              disabled={emptyCustom}
              onClick={sendPdf}
            />
            <SendTile
              icon={<Images />}
              title="As images"
              sub={`${plural(pageCount, "JPG", "JPGs")}`}
              busy={busy === "img"}
              disabled={emptyCustom}
              onClick={sendImages}
            />
            <SendTile
              icon={<FileArchive />}
              title="Smaller PDF"
              sub="Compressed copy"
              busy={busy === "compressed"}
              disabled={emptyCustom}
              onClick={() => setCompressOpen((v) => !v)}
            />
            <SendTile icon={<Link2 />} title="Send link" sub={linkHint} busy={busy === "link"} onClick={sendLink} />
          </div>
          {compressOpen && (
            <div className="mx-1 mt-2 animate-pop-in rounded-2xl border border-line bg-black/20 p-2.5">
              <p className="px-1 pb-2 text-[13px] text-muted">Compression level. Your stored document stays as it is.</p>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    ["low", "Light"],
                    ["medium", "Balanced"],
                    ["high", "Smallest"],
                  ] as const
                ).map(([lvl, label]) => (
                  <Button key={lvl} size="sm" block variant={lvl === "medium" ? "primary" : "secondary"} disabled={!!busy} onClick={() => sendCompressed(lvl)}>
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </Section>

        <Section title="Send link via">
          <div className="grid grid-cols-3 gap-y-1 px-0.5 min-[400px]:grid-cols-6">
            {SHARE_APPS.map((a) => (
              <AppButton
                key={a.app}
                label={a.label}
                icon={a.icon}
                tint={a.tint}
                disabled={!!busy}
                onClick={() => {
                  const link = ensureLink();
                  void openShareApp(
                    a.app,
                    link.then((s) => appShareUrl(a.app, s.url, doc.title)),
                  ).catch((e) => toast.error(errorMessage(e, "Could not create a link")));
                }}
              />
            ))}
            <AppButton
              label="Copy"
              icon={<Copy />}
              tint="#ada7c0"
              disabled={!!busy}
              onClick={() =>
                run("copy", async () => {
                  const s = await ensureLink();
                  if (await copyText(s.url)) {
                    vibrate(8);
                    toast.success("Link copied");
                  } else toast.error("Copy failed");
                })
              }
            />
            <AppButton
              label="QR code"
              icon={<QrCode />}
              tint="#ada7c0"
              disabled={!!busy}
              onClick={() =>
                run("qr", async () => {
                  if (qr) return setQr(null);
                  const s = await ensureLink();
                  setQr({ src: await qrDataUrl(s.url), url: s.url });
                })
              }
            />
          </div>
          {qr && (
            <div className="px-1">
              <QrPanel src={qr.src} url={qr.url} title={doc.title} />
            </div>
          )}
        </Section>

        <Section
          title={`Links${active.length ? ` · ${active.length} active` : ""}`}
          action={
            !creating && (
              <Button size="sm" variant="ghost" className="-mr-1 text-accent" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New link
              </Button>
            )
          }
        >
          {creating && (
            <CreateLinkForm
              docId={doc.id}
              defaults={prefs.sharing}
              onCancel={() => setCreating(false)}
              onCreated={async (s) => {
                setCreating(false);
                await shares.refresh();
                const ok = await copyText(s.url);
                vibrate(10);
                toast.success(ok ? "Link created and copied" : "Link created");
              }}
            />
          )}
          {shares.loading && !shares.data && list.length === 0 ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : active.length === 0 && !creating ? (
            <p className="mx-1 rounded-2xl border border-line px-4 py-4 text-center text-[13px] text-muted">
              No active links. Anyone with a link can view the document without signing in.
            </p>
          ) : (
            <ul className="space-y-2 px-1">
              {active.map((s) => (
                <ShareLinkCard key={s.id} share={s} now={now} title={doc.title} onChanged={() => void shares.refresh()} />
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-1 px-1">
            {old.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowOld((v) => !v)}
                className="focus-ring flex h-10 items-center gap-1 rounded-lg px-2 text-[13px] text-muted hover:text-ink"
              >
                <ChevronDown className={cx("size-4 transition-transform", showOld && "rotate-180")} />
                {plural(old.length, "expired or revoked link", "expired or revoked links")}
              </button>
            ) : (
              <span />
            )}
            {active.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                icon={<Trash2 className="size-4" />}
                loading={busy === "revokeAll"}
                onClick={() =>
                  run("revokeAll", async () => {
                    try {
                      await api.revokeAllShares(doc.id);
                    } catch {
                      await Promise.all(active.map((s) => api.revokeShare(s.id)));
                    }
                    await shares.refresh();
                    toast.success("All links revoked");
                  })
                }
              >
                Revoke all
              </Button>
            )}
          </div>
          {showOld && old.length > 0 && (
            <ul className="mt-1 space-y-2 px-1">
              {old.map((s) => (
                <ShareLinkCard key={s.id} share={s} now={now} title={doc.title} onChanged={() => void shares.refresh()} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Save and print">
          <div className="space-y-0.5">
            <ListAction
              icon={<Download />}
              label="Download PDF"
              description={pagesArg ? plural(pagesArg.length, "page") : formatBytes(doc.sizeBytes)}
              disabled={emptyCustom}
              onClick={() => downloadUrl(pagesArg ? api.exportUrl(doc.id, "pdf", pagesArg) : api.fileUrl(doc.id, true))}
            />
            <ListAction icon={<Printer />} label="Print" description={plural(pageCount, "page")} disabled={emptyCustom} onClick={() => printDoc(doc.id, pagesArg)} />
            {drive.connected ? (
              <ListAction
                icon={<CloudUpload />}
                label="Save to Google Drive"
                description="Mirrors the PDF into your Waraq folder"
                onClick={() => void saveToDrive([doc.id])}
              />
            ) : (
              <Link
                href="/settings/drive"
                onClick={onClose}
                className="focus-ring flex min-h-13 w-full items-center gap-3.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/5"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-s2 text-muted [&_svg]:size-[18px]">
                  <CloudUpload />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] leading-tight">Save to Google Drive</span>
                  <span className="mt-0.5 block truncate text-[13px] text-muted">Connect Drive in Settings</span>
                </span>
              </Link>
            )}
            {onOpenExport && (
              <ListAction
                icon={<Settings2 />}
                label="More export options"
                description="Password PDF, JPG/PNG zip, text"
                onClick={onOpenExport}
              />
            )}
          </div>
        </Section>
      </div>
    </Sheet>
  );
}

function CreateLinkForm({
  docId,
  defaults,
  onCancel,
  onCreated,
}: {
  docId: string;
  defaults: { defaultExpiry: ShareExpiry; defaultAllowDownload: boolean };
  onCancel: () => void;
  onCreated: (s: ShareLink) => void;
}) {
  const [expiresIn, setExpiresIn] = useState<ShareExpiry>(defaults.defaultExpiry);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [allowDownload, setAllowDownload] = useState(defaults.defaultAllowDownload);
  const [busy, setBusy] = useState(false);
  return (
    <form method="post"
      className="surface mx-1 mb-3 animate-pop-in space-y-3 rounded-2xl p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (usePassword && password.length < 4) {
          toast.error("Use at least 4 characters for the password");
          return;
        }
        setBusy(true);
        try {
          const s = await api.createShare(docId, {
            expiresIn,
            allowDownload,
            password: usePassword ? password : undefined,
          });
          onCreated(s);
        } catch (err) {
          toast.error(errorMessage(err, "Could not create link"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <p className="mb-1.5 px-1 text-[13px] text-muted">Expires after</p>
        <Segmented value={expiresIn} onChange={setExpiresIn} options={EXPIRY_OPTIONS} />
      </div>
      <div className="px-1">
        <Switch checked={allowDownload} onChange={setAllowDownload} label="Allow download" description="Viewers can save the PDF" />
        <Switch checked={usePassword} onChange={setUsePassword} label="Require password" />
      </div>
      {usePassword && (
        <TextField
          type="text"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password for viewers"
          data-autofocus
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" block variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" block variant="primary" loading={busy} icon={<Link2 className="size-4" />}>
          Create link
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export function ExportSheet({
  open,
  onClose,
  doc,
  selectedPages,
  onDocChange,
}: {
  open: boolean;
  onClose: () => void;
  doc: DocDetail;
  selectedPages: number[];
  onDocChange: (d: DocDetail) => void;
}) {
  const [onlySelected, setOnlySelected] = useState(true);
  const [pw, setPw] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [level, setLevel] = useState<"low" | "medium" | "high">("medium");
  const pages = selectedPages.length && onlySelected ? selectedPages : undefined;
  const drive = useDriveStatus();

  const protectedPdf = async () => {
    if (!pw || pw.length < 4) {
      toast.error("Use at least 4 characters");
      return;
    }
    setBusy("pw");
    try {
      const { blob, filename } = await api.exportPost(doc.id, { format: "pdf", password: pw, pages });
      saveBlob(blob, filename === "download" ? `${doc.title}.pdf` : filename);
      toast.success("Protected PDF downloaded");
      setPw(null);
    } catch (e) {
      toast.error(errorMessage(e, "Export failed"));
    } finally {
      setBusy(null);
    }
  };

  const compress = async () => {
    setBusy("compress");
    try {
      const before = doc.sizeBytes;
      const { doc: next, savedBytes } = await api.compress(doc.id, level);
      onDocChange(next);
      if (savedBytes > 0)
        toast.success(`Saved ${formatBytes(savedBytes)} (${formatBytes(before)} to ${formatBytes(next.sizeBytes)})`);
      else toast("Already as small as this level allows. Nothing changed.");
    } catch (e) {
      toast.error(errorMessage(e, "Compression failed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Export" description={`${doc.title} · ${formatBytes(doc.sizeBytes)}`}>
      {selectedPages.length > 0 && (
        <div className="surface mx-1 mb-2 rounded-2xl px-3">
          <Switch
            checked={onlySelected}
            onChange={setOnlySelected}
            label={`Only ${plural(selectedPages.length, "selected page")}`}
          />
        </div>
      )}
      <ListAction
        icon={<FileText />}
        tone="accent"
        label="PDF"
        description={pages ? "Selected pages" : "The original document"}
        onClick={() => {
          downloadUrl(pages ? api.exportUrl(doc.id, "pdf", pages) : api.fileUrl(doc.id, true));
          onClose();
        }}
      />
      {drive.connected && (
        <ListAction
          icon={<CloudUpload />}
          label="Save to Google Drive"
          description="Uploads the PDF to your Drive"
          onClick={() => {
            onClose();
            void saveToDrive([doc.id]);
          }}
        />
      )}
      <ListAction
        icon={<Lock />}
        label="Password-protected PDF"
        description="AES-256, asks for the password to open"
        onClick={() => setPw(pw === null ? "" : null)}
      />
      {pw !== null && (
        <form method="post"
          className="mx-2 mb-2 flex animate-pop-in gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void protectedPdf();
          }}
        >
          <div className="flex-1">
            <TextField
              type="password"
              autoComplete="new-password"
              placeholder="Password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              data-autofocus
            />
          </div>
          <Button type="submit" variant="primary" loading={busy === "pw"}>
            Export
          </Button>
        </form>
      )}
      <ListAction
        icon={<Images />}
        label="JPG images (zip)"
        description="One image per page"
        onClick={() => downloadUrl(api.exportUrl(doc.id, "jpg-zip", pages))}
      />
      <ListAction
        icon={<Images />}
        label="PNG images (zip)"
        description="Lossless, larger files"
        onClick={() => downloadUrl(api.exportUrl(doc.id, "png-zip", pages))}
      />
      <ListAction
        icon={<FileText />}
        label="Text (.txt)"
        description={doc.ocrStatus === "done" ? "Text read by OCR" : "Available after OCR finishes"}
        disabled={doc.ocrStatus !== "done"}
        onClick={() => downloadUrl(api.exportUrl(doc.id, "txt", pages))}
      />
      <div className="surface mx-1 mt-3 rounded-2xl p-3">
        <p className="px-1 text-sm font-medium">Compress this document</p>
        <p className="px-1 pb-3 text-[13px] text-muted">Replaces the stored PDF only if the result is smaller.</p>
        <Segmented
          value={level}
          onChange={setLevel}
          options={[
            { value: "low", label: "Light" },
            { value: "medium", label: "Balanced" },
            { value: "high", label: "Smallest" },
          ]}
        />
        <Button className="mt-3" block loading={busy === "compress"} onClick={compress}>
          Compress
        </Button>
      </div>
    </Sheet>
  );
}
