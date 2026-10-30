import { describe, expect, it } from "vitest";
import { HEAVY_OCR_MAX_PAGES, ocrPageCap, TOOLS } from "../src/shared/tools";

describe("R68 OCR page cap for non Latin languages", () => {
  it("caps Nepali, Hindi and the other heavy languages at 10 pages and leaves the rest at 30", () => {
    expect(HEAVY_OCR_MAX_PAGES).toBe(10);
    for (const l of ["nep", "hin", "eng+nep", "eng+hin", "chi_sim", "jpn", "kor", "ara", "tha"]) expect(ocrPageCap(l)).toBe(10);
    for (const l of ["eng", "spa", "fra", "deu", "vie", "ind", "fil", undefined]) expect(ocrPageCap(l)).toBe(30);
  });

  it("tells people about the cap on the OCR and scan screens, with no dashes", () => {
    const ocr = TOOLS.find((t) => t.op === "ocr")!;
    const lang = ocr.options.find((o) => o.name === "language")!;
    expect(lang.help).toMatch(/Nepali.*10 pages/);
    expect(ocr.note).toMatch(/10 in Nepali/);
    const scan = TOOLS.find((t) => t.op === "scan-clean")!;
    expect(scan.options.find((o) => o.name === "language")!.help).toMatch(/10 photos/);
    for (const s of [lang.help, ocr.note]) expect(s).not.toMatch(/[\u2013\u2014]/);
  });
});
