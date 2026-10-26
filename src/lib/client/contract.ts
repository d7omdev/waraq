/**
 * UI-side helpers for the v4 shared contract (docs/PLAN-v4.md). The shapes
 * themselves live in src/lib/types.ts; this file adds defaults and aliases.
 */
import type {
  BrowseMode,
  DeepPartial,
  DocProcessing,
  OcrStatusInfo,
  Prefs,
  SessionInfo,
  ShareLinkWithDoc,
  VersionInfo,
} from "@/lib/types";

export type { BrowseMode, DeepPartial, Prefs, SessionInfo, ShareLinkWithDoc, VersionInfo };
export type OcrQueueStatus = OcrStatusInfo;
export type ProcessingInfo = DocProcessing;

export type LibraryView = Prefs["library"]["view"];
export type GridColumnsMobile = Prefs["library"]["gridColumnsMobile"];
export type GridColumnsDesktop = Prefs["library"]["gridColumnsDesktop"];
export type SortKeyPref = Prefs["library"]["sort"];
export type ScanFilter = Prefs["scanner"]["defaultFilter"];
export type ShareExpiryPref = Prefs["sharing"]["defaultExpiry"];
export type ShareStatus = ShareLinkWithDoc["status"];

export const DEFAULT_PREFS: Prefs = {
  library: {
    browseMode: "all",
    view: "grid",
    gridColumnsMobile: 2,
    gridColumnsDesktop: "auto",
    sort: "updated",
    dir: "desc",
    showFolderTiles: true,
  },
  scanner: { defaultFilter: "magic", autoCapture: false, batchMode: true, autoCrop: true, jpegQuality: 0.85, haptics: true },
  ocr: { useDriveOcr: true, languages: ["ara", "eng"] },
  sharing: { defaultExpiry: "7d", defaultAllowDownload: true },
  trash: { retentionDays: 30 },
};

