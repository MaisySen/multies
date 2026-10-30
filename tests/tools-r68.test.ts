import { describe, expect, it } from "vitest";
import { catalogueFor, HEAVY_OCR_MAX_PAGES, ocrPageCap, OCR_SLOW_NOTE } from "../src/shared/tools";

describe("R68 OCR page cap for non Latin languages", () => {
  it("caps Nepali, Hindi and the other heavy languages at 10 pages and leaves the rest at 30", () => {
    expect(HEAVY_OCR_MAX_PAGES).toBe(10);
    for (const l of ["nep", "hin", "eng+nep", "eng+hin", "chi_sim", "jpn", "kor", "ara", "tha"]) expect(ocrPageCap(l)).toBe(10);
    for (const l of ["eng", "spa", "fra", "deu", "vie", "ind", "fil", undefined]) expect(ocrPageCap(l)).toBe(30);
  });

  it("tells people about the cap on the OCR and scan screens when other languages are offered, with no dashes", () => {
    expect(OCR_SLOW_NOTE).toMatch(/Nepali.*10 pages a run/);
    expect(OCR_SLOW_NOTE).not.toMatch(/[\u2013\u2014]/);
    const on = catalogueFor(["ocr_langs", "scan"]);
    for (const op of ["ocr", "scan-clean"]) expect(on.find((t) => t.op === op)!.options.find((o) => o.name === "language")!.help).toBe(OCR_SLOW_NOTE);
    expect(catalogueFor([]).find((t) => t.op === "ocr")!.options.find((o) => o.name === "language")!.help).toBeUndefined();
  });
});
