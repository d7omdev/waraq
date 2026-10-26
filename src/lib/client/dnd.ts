"use client";

import { useState, type DragEvent } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { plural } from "@/lib/client/format";
import { vibrate } from "@/lib/client/device";
import { refreshLibrary } from "@/hooks/data";
import { toast } from "@/components/ui/toast";

/** Desktop drag and drop of documents onto folders. */
export const DOC_DRAG_TYPE = "application/x-waraq-docs";

export function startDocDrag(e: DragEvent, ids: string[], label: string) {
  e.dataTransfer.setData(DOC_DRAG_TYPE, JSON.stringify(ids));
  e.dataTransfer.setData("text/plain", label);
  e.dataTransfer.effectAllowed = "move";
}

function isDocDrag(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes(DOC_DRAG_TYPE);
}

function readIds(e: DragEvent): string[] {
  try {
    const v = JSON.parse(e.dataTransfer.getData(DOC_DRAG_TYPE) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function moveDocs(ids: string[], folderId: string | null, folderName: string, previous?: Map<string, string | null>) {
  if (!ids.length) return;
  try {
    await Promise.all(ids.map((id) => api.updateDoc(id, { folderId })));
    vibrate(10);
    refreshLibrary();
    toast.success(`Moved ${plural(ids.length, "document")} to ${folderName}`, previous
      ? {
          action: {
            label: "Undo",
            onClick: async () => {
              await Promise.all(ids.map((id) => api.updateDoc(id, { folderId: previous.get(id) ?? null })));
              refreshLibrary();
            },
          },
        }
      : undefined);
  } catch (e) {
    toast.error(errorMessage(e, "Could not move"));
  }
}

/**
 * Handlers that make an element a drop target for dragged documents.
 * `previous` lets the toast offer Undo (folder of each doc before the move).
 */
export function useFolderDrop(folderId: string | null, folderName: string, previous?: () => Map<string, string | null>) {
  const [over, setOver] = useState(false);
  const handlers = {
    onDragOver: (e: DragEvent) => {
      if (!isDocDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!over) setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      if (!isDocDrag(e)) return;
      e.preventDefault();
      setOver(false);
      void moveDocs(readIds(e), folderId, folderName, previous?.());
    },
  };
  return { over, handlers };
}
