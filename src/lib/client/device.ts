"use client";

import { api, fetchBlob } from "./api";
import { safeFilename } from "./format";
export type HapticKind = "light" | "medium" | "heavy" | "select" | "success" | "warning" | "error";

/**
 * Short vibration cue in browsers that support it (for example Chrome on Android). `kind` names the intent for callers;
 * the web only has a vibration pattern.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function vibrate(pattern: number | number[] = 12, _kind?: HapticKind) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
  } catch {
    /* best effort */
  }
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Trigger a browser download for a same-origin URL (server sets Content-Disposition). */
export function downloadUrl(url: string, filename?: string) {
  const a = document.createElement("a");
  a.href = url;
  if (filename) a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function canShareFiles(): boolean {
  if (typeof navigator === "undefined" || !navigator.canShare) return false;
  try {
    const probe = new File([new Blob(["x"], { type: "application/pdf" })], "probe.pdf", {
      type: "application/pdf",
    });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export function canShareLinks(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

export type ShareOutcome = "shared" | "cancelled" | "unsupported";

export async function shareFiles(files: File[], title?: string): Promise<ShareOutcome> {
  return shareFilesInner(files, title);
}

async function shareFilesInner(files: File[], title?: string): Promise<ShareOutcome> {
  if (!navigator.canShare || !navigator.canShare({ files })) return "unsupported";
  try {
    await navigator.share({ files, title });
    return "shared";
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    throw e;
  }
}

export async function shareLink(url: string, title?: string): Promise<ShareOutcome> {
  return shareLinkInner(url, title);
}

async function shareLinkInner(url: string, title?: string): Promise<ShareOutcome> {
  if (!canShareLinks()) return "unsupported";
  try {
    await navigator.share({ url, title });
    return "shared";
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    throw e;
  }
}

export async function docPdfFile(id: string, title: string): Promise<File> {
  const { blob } = await fetchBlob(api.fileUrl(id));
  return new File([blob], safeFilename(title, "pdf"), { type: "application/pdf" });
}

export async function pageImageFile(url: string, title: string, index: number): Promise<File> {
  const { blob } = await fetchBlob(url);
  return new File([blob], safeFilename(`${title} p${index + 1}`, "jpg"), {
    type: blob.type || "image/jpeg",
  });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** IndexedDB key used by public/sw.js to stash share-target files (idb-keyval default store). */
export const PENDING_SHARE_KEY = "waraq-pending-share";

export interface PendingShare {
  createdAt: number;
  title?: string;
  text?: string;
  files: { name: string; type: string; blob: Blob }[];
}

/* ------------------------------------------------------------------ */
/* Sending links to apps                                               */
/* ------------------------------------------------------------------ */

export type ShareApp = "whatsapp" | "telegram" | "email" | "sms";

export function appShareUrl(app: ShareApp, url: string, title: string): string {
  const e = encodeURIComponent;
  switch (app) {
    case "whatsapp":
      return `https://wa.me/?text=${e(`${title}\n${url}`)}`;
    case "telegram":
      return `https://t.me/share/url?url=${e(url)}&text=${e(title)}`;
    case "email":
      return `mailto:?subject=${e(title)}&body=${e(`${title}\n\n${url}`)}`;
    case "sms":
      return `sms:?&body=${e(`${title} ${url}`)}`;
  }
}

/**
 * Open a share target. Popup blockers only allow window.open() during the tap,
 * so when the URL needs async work first, call with a promise: a blank tab is
 * opened synchronously and pointed at the URL once it resolves.
 */
export function openShareApp(app: ShareApp, target: string | Promise<string>) {
  const sameTab = app === "email" || app === "sms";
  if (typeof target === "string") {
    if (sameTab) window.location.href = target;
    else window.open(target, "_blank", "noopener");
    return Promise.resolve();
  }
  const w = sameTab ? null : window.open("", "_blank");
  return target.then(
    (url) => {
      if (sameTab) window.location.href = url;
      else if (w) w.location.href = url;
      else window.open(url, "_blank", "noopener");
    },
    (err) => {
      w?.close();
      throw err;
    },
  );
}

/** Print a document through the dedicated print page (page images, one per sheet). */
export function printDoc(id: string, pages?: number[]) {
  const q = pages?.length ? `?pages=${pages.join(",")}` : "";
  window.open(`/d/${encodeURIComponent(id)}/print${q}`, "_blank");
}

export function pdfFileFromBlob(blob: Blob, title: string): File {
  return new File([blob], safeFilename(title, "pdf"), { type: "application/pdf" });
}

/** Same as appShareUrl for free text (several links at once). */
export function appShareText(app: ShareApp, text: string, subject: string): string {
  const e = encodeURIComponent;
  switch (app) {
    case "whatsapp":
      return `https://wa.me/?text=${e(text)}`;
    case "telegram": {
      const firstUrl = /https?:\/\/\S+/.exec(text)?.[0] ?? "";
      return `https://t.me/share/url?url=${e(firstUrl)}&text=${e(text.replace(firstUrl, "").trim())}`;
    }
    case "email":
      return `mailto:?subject=${e(subject)}&body=${e(text)}`;
    case "sms":
      return `sms:?&body=${e(text)}`;
  }
}

export async function shareText(text: string, title?: string): Promise<ShareOutcome> {
  return shareTextInner(text, title);
}

async function shareTextInner(text: string, title?: string): Promise<ShareOutcome> {
  if (!canShareLinks()) return "unsupported";
  try {
    await navigator.share({ text, title });
    return "shared";
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    throw e;
  }
}
