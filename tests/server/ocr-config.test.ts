import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ocrmypdfArgs, tessdataDir, cleanText } from "@/lib/server/ocr";

describe("tesseract config", () => {
  it("uses --skip-text first and --redo-ocr on manual re-runs", () => {
    const a = ocrmypdfArgs({ redo: false, langs: "ara+eng", osd: true }, "in", "out");
    expect(a[0]).toBe("--skip-text");
    expect(a).not.toContain("--rotate-pages");
    expect(a.slice(a.indexOf("-l"), a.indexOf("-l") + 2)).toEqual(["-l", "ara+eng"]);
    expect(a.slice(-2)).toEqual(["in", "out"]);
    expect(ocrmypdfArgs({ redo: true, langs: "eng", osd: false }, "i", "o")[0]).toBe("--redo-ocr");
    process.env.WARAQ_OCR_ROTATE = "1";
    expect(ocrmypdfArgs({ redo: false, langs: "eng", osd: true }, "i", "o")).toContain("--rotate-pages");
    expect(ocrmypdfArgs({ redo: false, langs: "eng", osd: false }, "i", "o")).not.toContain("--rotate-pages");
    delete process.env.WARAQ_OCR_ROTATE;
    process.env.WARAQ_OCR_JOBS = "1";
    const j = ocrmypdfArgs({ redo: false, langs: "eng", osd: false }, "i", "o");
    expect(j[j.indexOf("--jobs") + 1]).toBe("1");
    delete process.env.WARAQ_OCR_JOBS;
  });

  it("only uses WARAQ_TESSDATA_DIR when it has every language", () => {
    expect(tessdataDir(["ara", "eng"])).toBeNull();
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tess-"));
    fs.writeFileSync(path.join(d, "eng.traineddata"), "x");
    process.env.WARAQ_TESSDATA_DIR = d;
    expect(tessdataDir(["eng"])).toBe(d);
    expect(tessdataDir(["ara", "eng"])).toBeNull();
    process.env.WARAQ_TESSDATA_DIR = "system";
    expect(tessdataDir(["eng"])).toBeNull();
    delete process.env.WARAQ_TESSDATA_DIR;
    fs.rmSync(d, { recursive: true });
  });

  it("cleans whitespace", () => {
    expect(cleanText("a  \n\n\n\n\nb \t\n")).toBe("a\n\n\nb");
  });
});
