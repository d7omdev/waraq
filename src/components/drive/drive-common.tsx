"use client";

import { useEffect } from "react";
import { api } from "@/lib/client/api";
import { revalidate, useQuery } from "@/lib/client/query";
import { toast } from "@/components/ui/toast";
import type { Me } from "@/lib/types";

const ME_KEY = "/api/auth/me";

export const DRIVE_CALLBACK_ERRORS: Record<string, string> = {
  invalid_state: "The sign-in link expired or was opened in another browser. Try Connect again.",
  access_denied: "Google access was not granted.",
  exchange_failed: "Google did not accept the sign-in. Try again in a moment.",
  missing_code: "Google returned no authorization code. Try again.",
  google_error: "Google reported an error. Try again.",
};

export function useMe() {
  return useQuery<Me>(ME_KEY, api.me);
}

/** Toast the result of the Drive OAuth round trip (?drive=connected|error&reason=...) outside Settings. */
export function DriveCallbackToast() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("drive");
    if (!result || url.pathname.startsWith("/settings")) return; // the Drive settings page reports it itself
    if (result === "connected") toast.success("Google Drive connected");
    else toast.error(DRIVE_CALLBACK_ERRORS[url.searchParams.get("reason") ?? ""] ?? "Could not connect Google Drive");
    url.searchParams.delete("drive");
    url.searchParams.delete("reason");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    void revalidate(ME_KEY);
  }, []);
  return null;
}
