"use client";

import { useState, type ReactNode } from "react";
import { CloudUpload, Copy, Download, FileArchive, Images, Link2, Send, Share2 } from "lucide-react";
import { api, errorMessage } from "@/lib/client/api";
import { cx, formatBytes, plural } from "@/lib/client/format";
import {
  appShareText,
  canShareFiles,
  copyText,
  docPdfFile,
  downloadUrl,
  openShareApp,
  pageImageFile,
  pdfFileFromBlob,
  shareFiles,
  shareText,
  vibrate,
} from "@/lib/client/device";
import { usePrefs } from "@/lib/client/prefs";
import type { DocSummary } from "@/lib/types";
import { ListAction, Spinner } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";
import { saveToDrive, useDriveStatus } from "@/components/drive/save-to-drive-action";
import { AppButton, SHARE_APPS, shareStatus } from "./share-link-card";

function Tile({ icon, title, sub, onClick, busy, primary }: { icon: ReactNode; title: string; sub: string; onClick: () => void; busy?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cx(
        "focus-ring flex min-h-[84px] min-w-0 flex-col justify-between gap-2 rounded-2xl p-3 text-left transition-colors disabled:opacity-60 [&_svg]:size-5",
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

/** Share several documents from the library selection. */
export function BulkShareSheet({ open, onClose, docs }: { open: boolean; onClose: () => void; docs: DocSummary[] }) {
  const prefs = usePrefs();
  const drive = useDriveStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const total = docs.reduce((s, d) => s + d.sizeBytes, 0);
  const pages = docs.reduce((s, d) => s + d.pageCount, 0);
  const fileShare = canShareFiles();
  const subject = docs.length === 1 ? docs[0].title : plural(docs.length, "document");

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

  const downloadAll = () => docs.forEach((d, i) => window.setTimeout(() => downloadUrl(api.fileUrl(d.id, true)), i * 400));

  const sendPdfs = () =>
    run("pdf", async () => {
      if (!fileShare) {
        toast("This browser cannot send files. Downloading instead.");
        downloadAll();
        return;
      }
      const files = await Promise.all(docs.map((d) => docPdfFile(d.id, d.title)));
      const r = await shareFiles(files, docs.length === 1 ? docs[0].title : undefined);
      if (r === "unsupported") {
        toast("The share menu refused these files. Downloading instead.");
        downloadAll();
      }
    });

  const sendCompressed = () =>
    run("small", async () => {
      const blobs = await Promise.all(docs.map((d) => api.exportCompressed(d.id, "medium").then((r) => ({ d, blob: r.blob }))));
      const files = blobs.map(({ d, blob }) => pdfFileFromBlob(blob, `${d.title} (small)`));
      const size = blobs.reduce((s, b) => s + b.blob.size, 0);
      const r = fileShare ? await shareFiles(files) : "unsupported";
      if (r === "unsupported") {
        files.forEach((f, i) => window.setTimeout(() => downloadUrl(URL.createObjectURL(f), f.name), i * 400));
        toast(`Downloaded ${formatBytes(size)} of compressed PDFs.`);
      }
    });

  const sendImages = () =>
    run("img", async () => {
      if (pages > 60) {
        toast.error(`That is ${pages} pages. Pick fewer documents to send as images.`);
        return;
      }
      const details = await Promise.all(docs.map((d) => api.doc(d.id)));
      const files = (
        await Promise.all(details.flatMap((d) => d.pages.map((p) => pageImageFile(p.imageUrl, d.title, p.index))))
      ).flat();
      const r = fileShare ? await shareFiles(files) : "unsupported";
      if (r === "unsupported") {
        docs.forEach((d, i) => window.setTimeout(() => downloadUrl(api.exportUrl(d.id, "jpg-zip")), i * 400));
        toast("Image sharing is not supported here. Downloading zips instead.");
      }
    });

  /** One link per document (reusing an active link when there is one). */
  const linksText = async () => {
    const lines = await Promise.all(
      docs.map(async (d) => {
        const existing = (await api.shares(d.id).catch(() => [])).filter((s) => shareStatus(s, Date.now()) === "active");
        const s =
          existing.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
          (await api.createShare(d.id, { expiresIn: prefs.sharing.defaultExpiry, allowDownload: prefs.sharing.defaultAllowDownload }));
        return docs.length === 1 ? `${d.title}\n${s.url}` : `${d.title}: ${s.url}`;
      }),
    );
    return lines.join("\n");
  };

  return (
    <Sheet open={open} onClose={onClose} title={`Share ${subject}`} description={`${plural(pages, "page")} · ${formatBytes(total)}`} size="md">
      <div className="px-1 pb-2" data-share-sheet>
        <h3 className="px-2 pb-2 text-[12px] font-semibold tracking-[0.08em] text-faint uppercase">Send</h3>
        <div className="grid grid-cols-2 gap-2 px-1">
          <Tile primary icon={<Send />} title="Send PDFs" sub={fileShare ? plural(docs.length, "file") : "Downloads them"} busy={busy === "pdf"} onClick={sendPdfs} />
          <Tile icon={<Images />} title="As images" sub={plural(pages, "JPG", "JPGs")} busy={busy === "img"} onClick={sendImages} />
          <Tile icon={<FileArchive />} title="Smaller PDFs" sub="Compressed copies" busy={busy === "small"} onClick={sendCompressed} />
          <Tile
            icon={<Link2 />}
            title="Send links"
            sub="One link per document"
            busy={busy === "links"}
            onClick={() =>
              run("links", async () => {
                const text = await linksText();
                const r = await shareText(text, subject);
                if (r === "unsupported" && (await copyText(text))) toast.success("Links copied");
              })
            }
          />
        </div>

        <h3 className="mt-5 px-2 pb-2 text-[12px] font-semibold tracking-[0.08em] text-faint uppercase">Send links via</h3>
        <div className="grid grid-cols-5 gap-0 px-0.5">
          {SHARE_APPS.map((a) => (
            <AppButton
              key={a.app}
              label={a.label}
              icon={a.icon}
              tint={a.tint}
              disabled={!!busy}
              onClick={() =>
                void openShareApp(a.app, linksText().then((t) => appShareText(a.app, t, subject))).catch((e) =>
                  toast.error(errorMessage(e, "Could not create links")),
                )
              }
            />
          ))}
          <AppButton
            label="Copy"
            icon={<Copy />}
            tint="#ada7c0"
            disabled={!!busy}
            onClick={() =>
              run("copy", async () => {
                const t = await linksText();
                if (await copyText(t)) {
                  vibrate(8);
                  toast.success(docs.length === 1 ? "Link copied" : "Links copied");
                }
              })
            }
          />
        </div>

        <h3 className="mt-5 px-2 pb-1 text-[12px] font-semibold tracking-[0.08em] text-faint uppercase">Save</h3>
        <ListAction icon={<Download />} label="Download PDFs" description={formatBytes(total)} onClick={downloadAll} />
        {drive.connected && (
          <ListAction icon={<CloudUpload />} label="Save to Google Drive" onClick={() => void saveToDrive(docs.map((d) => d.id))} />
        )}
        {!fileShare && (
          <p className="flex items-center gap-2 px-3 pt-2 text-[13px] text-faint">
            <Share2 className="size-4" /> Sending files needs Chrome on Android or Safari.
          </p>
        )}
      </div>
    </Sheet>
  );
}
