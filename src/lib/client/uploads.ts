"use client";

import { useSyncExternalStore } from "react";
import { api, errorMessage, type UploadHandle } from "./api";
import type { DocDetail } from "@/lib/types";

/** Global upload queue so progress survives navigation and is shown in one tray. */

export interface UploadJob {
  id: string;
  label: string;
  bytes: number;
  fraction: number;
  status: "uploading" | "done" | "error";
  error?: string;
  result?: DocDetail;
  abort?: () => void;
}

let jobs: UploadJob[] = [];
const listeners = new Set<() => void>();
let seq = 0;
const emit = () => listeners.forEach((l) => l());

function patch(id: string, p: Partial<UploadJob>) {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...p } : j));
  emit();
}

export function clearFinished() {
  jobs = jobs.filter((j) => j.status === "uploading");
  emit();
}

const NO_JOBS: UploadJob[] = [];

export function useUploads(): UploadJob[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => jobs,
    () => NO_JOBS,
  );
}

function track(label: string, bytes: number, start: (onP: (f: number) => void) => UploadHandle<DocDetail>) {
  const id = `u${++seq}`;
  const job: UploadJob = { id, label, bytes, fraction: 0, status: "uploading" };
  jobs = [...jobs, job];
  emit();
  const handle = start((f) => patch(id, { fraction: f }));
  patch(id, { abort: handle.abort });
  return handle.promise.then(
    (doc) => {
      patch(id, { status: "done", fraction: 1, result: doc, abort: undefined });
      window.setTimeout(() => {
        jobs = jobs.filter((j) => j.id !== id);
        emit();
      }, 2500);
      return doc;
    },
    (err: unknown) => {
      patch(id, { status: "error", error: errorMessage(err, "Upload failed"), abort: undefined });
      throw err;
    },
  );
}

const stem = (name: string) => name.replace(/\.[^.]+$/, "").trim() || name;

export function uploadNewDoc(
  files: (File | Blob)[],
  opts: { title?: string; folderId?: string | null; source?: "scan" | "import" | "share-target" },
  label?: string,
): Promise<DocDetail> {
  const bytes = files.reduce((s, f) => s + f.size, 0);
  const first = files[0];
  const title = opts.title ?? (first instanceof File && files.length === 1 ? stem(first.name) : undefined);
  return track(label ?? title ?? "Upload", bytes, (onP) =>
    api.createDoc(files, { ...opts, title }, (p) => onP(p.fraction)),
  );
}

export function uploadPages(docId: string, files: (File | Blob)[], label = "Adding pages", at?: number) {
  const bytes = files.reduce((s, f) => s + f.size, 0);
  return track(label, bytes, (onP) => api.addPages(docId, files, at, (p) => onP(p.fraction)));
}

export function uploadReplacement(docId: string, index: number, file: Blob) {
  return track(`Page ${index + 1}`, file.size, (onP) =>
    api.replacePage(docId, index, file, (p) => onP(p.fraction)),
  );
}

export const ACCEPT_IMPORT = "application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif";

export function isAcceptedFile(f: File) {
  return f.type === "application/pdf" || f.type.startsWith("image/") || /\.(pdf|jpe?g|png|webp)$/i.test(f.name);
}
