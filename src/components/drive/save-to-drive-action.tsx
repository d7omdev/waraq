"use client";
// Contract: call saveToDrive(ids) from any action sheet / bulk bar. It shows its own toasts.
// useDriveStatus() tells the UI whether to offer the action.
import type { DriveStatus } from "@/lib/types";
import { errorMessage, request } from "@/lib/client/api";
import { invalidate, revalidate, useQuery } from "@/lib/client/query";
import { toast } from "@/components/ui/toast";

export const DRIVE_STATUS_KEY = "/api/drive/status";

export const driveApi = {
  status: () => request<DriveStatus>(DRIVE_STATUS_KEY),
  saveConfig: (clientId: string, clientSecret: string) =>
    request<DriveStatus>("/api/drive/config", { method: "POST", json: { clientId, clientSecret } }),
  resetConfig: () => request<DriveStatus>("/api/drive/config", { method: "DELETE" }),
  disconnect: () => request<DriveStatus>("/api/drive/disconnect", { method: "POST" }),
  settings: (patch: { autoSync?: boolean }) =>
    request<DriveStatus>("/api/drive/settings", { method: "PATCH", json: patch }),
  sync: (body: { ids?: string[]; all?: boolean }) =>
    request<{ queued: number }>("/api/drive/sync", { method: "POST", json: body }),
};

/** Shared, cached Drive status. Polls every 2.5 s while uploads are pending, otherwise every 30 s. */
export function useDriveStatusQuery() {
  const q = useQuery<DriveStatus>(DRIVE_STATUS_KEY, driveApi.status, { refreshInterval: 30_000 });
  const busy = (q.data?.queue.pending ?? 0) > 0;
  useQuery<DriveStatus>(busy ? DRIVE_STATUS_KEY : null, driveApi.status, { refreshInterval: 2_500 });
  return q;
}

export function useDriveStatus(): { connected: boolean } {
  const { data } = useQuery<DriveStatus>(DRIVE_STATUS_KEY, driveApi.status, { refreshInterval: 60_000 });
  return { connected: !!data?.connected };
}

export function refreshDriveStatus() {
  return revalidate<DriveStatus>(DRIVE_STATUS_KEY, driveApi.status);
}

export async function saveToDrive(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const tid = toast({
    message: ids.length === 1 ? "Saving to Google Drive…" : `Saving ${ids.length} documents to Google Drive…`,
    duration: 0,
  });
  try {
    const { queued } = await driveApi.sync({ ids });
    void refreshDriveStatus();
    invalidate("/api/docs"); // refresh driveSync badges
    if (!queued) {
      toast.error("Nothing to save. Documents in the trash are not uploaded.", { id: tid });
      return;
    }
    toast.success(queued === 1 ? "Uploading to Google Drive" : `Uploading ${queued} documents to Google Drive`, { id: tid });
  } catch (e) {
    toast.error(errorMessage(e, "Could not save to Google Drive"), { id: tid });
  }
}
