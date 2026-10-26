// Shared contract between backend (src/lib/server/**, src/app/api/**) and frontend (UI).
// Owned by the parent agent. Do NOT change shapes without updating docs/API.md.

export type DocStatus = "ready" | "processing" | "error";
export type OcrStatus = "none" | "queued" | "running" | "done" | "error";

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null; // css color token, optional
  docCount: number;
  createdAt: string; // ISO
  updatedAt: string;
  childCount?: number; // direct subfolders
  previewThumbs?: string[]; // up to 3 doc thumb URLs (direct docs first, then from subfolders)
}

export interface PageInfo {
  index: number; // 0-based position in the PDF
  width: number; // points
  height: number;
  rotation: number; // 0/90/180/270 as stored in PDF
  thumbUrl: string; // /api/docs/:id/pages/:index/thumb?v=<version>
  imageUrl: string; // /api/docs/:id/pages/:index/image?v=<version> (full-res JPEG render)
  status?: "ready" | "processing"; // "processing": thumb/image return 202 {code:"processing"} until built
}

export interface DocSummary {
  id: string;
  title: string;
  folderId: string | null;
  tags: string[];
  starred: boolean;
  pageCount: number;
  sizeBytes: number;
  status: DocStatus;
  ocrStatus: OcrStatus;
  version: number; // bumps on every content change; use in URLs for cache-busting
  thumbUrl: string; // first page thumb
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  source: "scan" | "import" | "merge" | "split" | "share-target";
  snippet?: string; // search hit context when ?q= used
  driveSync?: DriveSyncInfo | null; // present only when Google Drive is connected; null = not mirrored
  processing?: DocProcessing | null; // non-null while status === "processing"
  processingError?: string | null; // set when status === "error" (POST /api/docs/:id/retry)
  ocrEngine?: OcrEngine | null; // engine that produced ocrText
}

export type OcrEngine = "drive" | "tesseract";

export interface DocProcessing {
  stage: "queued" | "assembling" | "rendering";
  pagesDone: number;
  pagesTotal: number;
}

export interface DocDetail extends DocSummary {
  pages: PageInfo[];
  ocrText: string | null; // full extracted text (may be large)
  hasPassword: false; // stored docs are never encrypted at rest; protection is applied at export
  shares: ShareLink[];
}

export interface ShareLink {
  id: string;
  token: string;
  docId: string;
  url: string; // absolute public share URL
  expiresAt: string | null;
  hasPassword: boolean;
  allowDownload: boolean;
  views: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface Me {
  id: string;
  username: string;
  name: string;
  email: string;
  image: string | null;
  storage: { usedBytes: number };
  drive: { connected: boolean; needsReconnect: boolean; email: string | null };
}

/** Settings → Account: a sign-in method (Better Auth account). */
export interface LinkedAccount {
  /** Better Auth account row id (what /api/auth/unlink-account takes) */
  id: string;
  providerId: "credential" | "google" | string;
  accountId: string;
  email: string | null;
  createdAt: string;
}

export interface ApiError {
  error: string; // human-readable
  code?: string;
}

// Page operations applied atomically by POST /api/docs/:id/pages/ops
export type PageOp =
  | { op: "rotate"; pages: number[]; degrees: 90 | 180 | 270 } // clockwise, relative
  | { op: "delete"; pages: number[] }
  | { op: "reorder"; order: number[] } // full permutation of current indexes
  | { op: "duplicate"; pages: number[] };

export type ExportFormat = "pdf" | "jpg-zip" | "png-zip" | "txt";
export type CompressLevel = "low" | "medium" | "high"; // high = smallest file

// Google Drive mirror (optional; see docs/API.md "Google Drive sync")
export interface DriveSyncInfo {
  status: "synced" | "pending" | "error";
  webViewLink?: string;
  error?: string;
}

export interface DriveStatus {
  configured: boolean; // OAuth client id/secret available (env or saved settings)
  credentialsSource: "env" | "settings" | null;
  clientIdMasked: string | null;
  redirectUri: string; // exact Authorized redirect URI to register in Google Cloud
  connected: boolean;
  needsReconnect: boolean; // Google revoked/expired the grant; queue is kept
  email?: string | null;
  autoSync: boolean;
  rootFolderUrl?: string | null;
  queue: { pending: number; failed: number };
  docs: { total: number; synced: number }; // non-trashed docs / of those, mirrored at current version
  lastSyncAt: string | null;
  lastError: string | null;
}

// ---- v4 (docs/PLAN-v4.md shared contract) ----
export type BrowseMode = "folders" | "all";

export interface Prefs {
  library: {
    browseMode: BrowseMode;
    view: "grid" | "list";
    gridColumnsMobile: 2 | 3 | 4;
    gridColumnsDesktop: "auto" | 3 | 4 | 5 | 6;
    sort: "updated" | "created" | "title" | "size";
    dir: "asc" | "desc";
    showFolderTiles: boolean;
  };
  scanner: {
    defaultFilter: "original" | "magic" | "grayscale" | "bw" | "lighten";
    autoCapture: boolean;
    batchMode: boolean;
    autoCrop: boolean;
    jpegQuality: number; // 0.6-0.95
    /** tactile feedback on capture and results where the browser supports vibration */
    haptics: boolean;
  };
  ocr: { useDriveOcr: boolean; languages: ("ara" | "eng")[] };
  sharing: { defaultExpiry: "1h" | "1d" | "7d" | "30d" | "never"; defaultAllowDownload: boolean };
  trash: { retentionDays: 7 | 14 | 30 | 60 | 90 };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface ShareLinkWithDoc extends ShareLink {
  docTitle: string;
  docThumbUrl: string;
  status: "active" | "expired" | "revoked";
}

export interface SessionInfo {
  id: string;
  current: boolean;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface VersionInfo {
  buildId: string;
  builtAt: string;
}

export interface OcrStatusInfo {
  pending: number;
  running: { docId: string; title: string } | null;
  engineAvailable: { drive: boolean; tesseract: true };
}
