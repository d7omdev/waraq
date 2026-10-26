import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, getPrefs, tesseractLanguages, trashRetentionMs, updatePrefs } from "@/lib/server/prefs";
import { createDocument, getDocRow, purgeTrash, trashDoc } from "@/lib/server/docs";
import { getDb } from "@/lib/server/db";
import { getAppSetting, setAppSetting } from "@/lib/server/settings";
import { makePdf } from "./helpers";

describe("prefs", () => {
  it("returns defaults, deep-merges partial patches and persists", () => {
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
    const p = updatePrefs({ library: { gridColumnsMobile: 3, browseMode: "folders" }, trash: { retentionDays: 7 } });
    expect(p.library).toMatchObject({ gridColumnsMobile: 3, browseMode: "folders", view: "grid", sort: "updated" });
    expect(p.scanner).toEqual(DEFAULT_PREFS.scanner);
    expect(getPrefs().trash.retentionDays).toBe(7);
    expect(trashRetentionMs()).toBe(7 * 86400_000);
    updatePrefs({ library: { view: "list" } });
    expect(getPrefs().library).toMatchObject({ gridColumnsMobile: 3, view: "list" });
  });

  it("scanner haptics: additive, default on, validated; retired engine key tolerated and dropped", () => {
    expect(getPrefs().scanner).toMatchObject({ haptics: true });
    expect(getPrefs().scanner).not.toHaveProperty("engine");
    // prefs stored by an older build (no haptics) still get the defaults
    setAppSetting("prefs", JSON.stringify({ scanner: { defaultFilter: "bw", autoCapture: true, batchMode: true, autoCrop: true, jpegQuality: 0.85 } }));
    expect(getPrefs().scanner).toMatchObject({ defaultFilter: "bw", haptics: true });
    // stored by app 1.0.1 (Google scanner engine): read without the key, no error
    setAppSetting("prefs", JSON.stringify({ scanner: { defaultFilter: "bw", engine: "google", haptics: false } }));
    expect(getPrefs().scanner).toEqual({ ...DEFAULT_PREFS.scanner, defaultFilter: "bw", haptics: false });
    // an old client still PATCHing engine: accepted, ignored, and the stored copy loses the key
    expect(updatePrefs({ scanner: { engine: "google", haptics: true } }).scanner).toEqual({ ...DEFAULT_PREFS.scanner, defaultFilter: "bw" });
    expect(JSON.parse(getAppSetting("prefs")!).scanner).not.toHaveProperty("engine");
    expect(() => updatePrefs({ scanner: { haptics: "yes" } })).toThrow();
    expect(() => updatePrefs({ scanner: { bogus: 1 } })).toThrow();
    updatePrefs({ scanner: { haptics: true, defaultFilter: "magic", autoCapture: false } });
  });

  it("rejects invalid values and unknown keys", () => {
    expect(() => updatePrefs({ library: { gridColumnsMobile: 5 } })).toThrow();
    expect(() => updatePrefs({ trash: { retentionDays: 1 } })).toThrow();
    expect(() => updatePrefs({ scanner: { jpegQuality: 1.5 } })).toThrow();
    expect(() => updatePrefs({ nope: true })).toThrow();
    expect(() => updatePrefs({ library: { bogus: 1 } })).toThrow();
    expect(() => updatePrefs({ ocr: { languages: [] } })).toThrow();
  });

  it("ignores corrupt stored leaves instead of failing", () => {
    getDb()
      .prepare("UPDATE settings SET value = ? WHERE key = 'prefs'")
      .run(JSON.stringify({ library: { gridColumnsMobile: 9, view: "list" }, trash: "x" }));
    const p = getPrefs();
    expect(p.library.gridColumnsMobile).toBe(DEFAULT_PREFS.library.gridColumnsMobile);
    expect(p.library.view).toBe("list");
    expect(p.trash).toEqual(DEFAULT_PREFS.trash);
  });

  it("orders Tesseract languages from prefs (env override wins)", () => {
    updatePrefs({ ocr: { languages: ["eng", "ara"] } });
    expect(tesseractLanguages()).toBe("eng+ara");
    updatePrefs({ ocr: { languages: ["ara", "ara", "eng"] as ("ara" | "eng")[] } });
    expect(getPrefs().ocr.languages).toEqual(["ara", "eng"]);
    process.env.WARAQ_OCR_LANGS = "eng";
    expect(tesseractLanguages()).toBe("eng");
    delete process.env.WARAQ_OCR_LANGS;
  });

  it("trash retention from prefs drives the purge", async () => {
    updatePrefs({ trash: { retentionDays: 14 } });
    const mk = async () => createDocument({ pdf: await makePdf(1), title: "Old", source: "import", ocr: false });
    const a = await mk();
    const b = await mk();
    trashDoc(a);
    trashDoc(b);
    const set = getDb().prepare("UPDATE documents SET trashed_at = ? WHERE id = ?");
    set.run(new Date(Date.now() - 15 * 86400_000).toISOString(), a); // older than 14 days
    set.run(new Date(Date.now() - 10 * 86400_000).toISOString(), b);
    await purgeTrash();
    expect(getDocRow(a)).toBeUndefined();
    expect(getDocRow(b)).toBeDefined();
    updatePrefs({ trash: { retentionDays: 7 } });
    await purgeTrash();
    expect(getDocRow(b)).toBeUndefined();
  });
});
