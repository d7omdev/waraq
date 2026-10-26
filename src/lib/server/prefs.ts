// Owner preferences shared by every signed-in device, stored as one JSON row in `settings` (key "prefs").
import { z } from "zod";
import type { Prefs } from "@/lib/types";
import { getAppSetting, setAppSetting } from "./settings";

const KEY = "prefs";

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

const languages = z
  .array(z.enum(["ara", "eng"]))
  .min(1)
  .max(4)
  .transform((a) => [...new Set(a)]);

const SECTION_SCHEMAS = {
  library: z.object({
    browseMode: z.enum(["folders", "all"]),
    view: z.enum(["grid", "list"]),
    gridColumnsMobile: z.literal([2, 3, 4]),
    gridColumnsDesktop: z.union([z.literal("auto"), z.literal([3, 4, 5, 6])]),
    sort: z.enum(["updated", "created", "title", "size"]),
    dir: z.enum(["asc", "desc"]),
    showFolderTiles: z.boolean(),
  }),
  scanner: z.object({
    defaultFilter: z.enum(["original", "magic", "grayscale", "bw", "lighten"]),
    autoCapture: z.boolean(),
    batchMode: z.boolean(),
    autoCrop: z.boolean(),
    jpegQuality: z.number().min(0.6).max(0.95),
    haptics: z.boolean(),
  }),
  ocr: z.object({ useDriveOcr: z.boolean(), languages }),
  sharing: z.object({ defaultExpiry: z.enum(["1h", "1d", "7d", "30d", "never"]), defaultAllowDownload: z.boolean() }),
  trash: z.object({ retentionDays: z.literal([7, 14, 30, 60, 90]) }),
} satisfies Record<keyof Prefs, z.ZodObject>;

type Section = keyof Prefs;
const SECTIONS = Object.keys(SECTION_SCHEMAS) as Section[];

/** Retired keys that older clients may still send: accepted (no 400) and dropped. */
const LEGACY_SCANNER_KEYS = { engine: z.unknown().optional() };

/** Deep-partial PATCH body: unknown keys are rejected so typos surface as 400s. */
export const prefsPatchSchema = z
  .object({
    library: SECTION_SCHEMAS.library.partial().strict(),
    scanner: SECTION_SCHEMAS.scanner.partial().extend(LEGACY_SCANNER_KEYS).strict(),
    ocr: SECTION_SCHEMAS.ocr.partial().strict(),
    sharing: SECTION_SCHEMAS.sharing.partial().strict(),
    trash: SECTION_SCHEMAS.trash.partial().strict(),
  })
  .partial()
  .strict();

/** Merge `patch` onto `base` leaf by leaf, keeping only leaves that validate (stored data may be from an older build). */
function merge(base: Prefs, patch: unknown): Prefs {
  const out = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
  if (!patch || typeof patch !== "object") return out as unknown as Prefs;
  for (const sec of SECTIONS) {
    const val = (patch as Record<string, unknown>)[sec];
    if (!val || typeof val !== "object") continue;
    const shape = SECTION_SCHEMAS[sec].shape as Record<string, z.ZodType>;
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const leaf = shape[k];
      if (!leaf || v === undefined) continue;
      const r = leaf.safeParse(v);
      if (r.success) out[sec][k] = r.data;
    }
  }
  return out as unknown as Prefs;
}

export function getPrefs(): Prefs {
  const raw = getAppSetting(KEY);
  if (!raw) return structuredClone(DEFAULT_PREFS);
  try {
    return merge(DEFAULT_PREFS, JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_PREFS);
  }
}

/** Validates (throws ZodError → 400) then deep-merges and stores. */
export function updatePrefs(patch: unknown): Prefs {
  const parsed = prefsPatchSchema.parse(patch);
  const next = merge(getPrefs(), parsed);
  setAppSetting(KEY, JSON.stringify(next));
  return next;
}

export function trashRetentionMs(): number {
  return getPrefs().trash.retentionDays * 24 * 3600 * 1000;
}

/** Tesseract language string in owner-preferred order, e.g. "ara+eng". `WARAQ_OCR_LANGS` overrides (tests/ops). */
export function tesseractLanguages(): string {
  if (process.env.WARAQ_OCR_LANGS) return process.env.WARAQ_OCR_LANGS;
  return getPrefs().ocr.languages.join("+");
}
