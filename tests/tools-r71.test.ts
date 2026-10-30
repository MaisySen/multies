/**
 * R71 (QA pass 6 fixes): unchanged compress runs are not counted (MB-263), page limits are known before Run (MB-264),
 * the board Move menu survives the focus scroll (MB-261) and the resting demo says so (MB-262).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compressUnchanged, emptyResult, notCountedLine, toolDef, ocrPageCap } from "@/shared/tools";
import { pagesLine, savedLine } from "@/web/components/tools/tool-directory";

describe("R71 MB-263: runs that change nothing", () => {
  it("knows a compress run that gave the file back", () => {
    expect(emptyResult("compress", { already_optimised: true, in_bytes: 10, out_bytes: 10 })).toBe(true);
    expect(emptyResult("compress", { in_bytes: 963_000, out_bytes: 962_000 })).toBe(true);
    expect(emptyResult("compress", { in_bytes: 963_000, out_bytes: 276_000 })).toBe(false);
    expect(emptyResult("compress", { in_bytes: 4300, out_bytes: 2900 })).toBe(false);
    expect(emptyResult("compress", {})).toBe(false);
    expect(compressUnchanged(0, 10)).toBe(false);
    expect(emptyResult("pii-find", { matches: 0 })).toBe(true);
  });
  it("says why the run was not counted, and Balanced never suggests Smallest", () => {
    expect(notCountedLine("compress")).toBe("The file did not get smaller, so this run was not counted.");
    expect(notCountedLine("pdf-tables")).toBe("Nothing was found, so this run was not counted.");
    expect(savedLine(4 * 1024, 4 * 1024, "medium")).not.toMatch(/Smallest/);
    expect(savedLine(4 * 1024, 4 * 1024, "strong")).not.toMatch(/Try/);
  });
});

describe("R71 MB-264: page limits before Run", () => {
  it("names the language and its limit", () => {
    const ocr = toolDef("ocr");
    expect(ocrPageCap("nep")).toBe(10);
    expect(pagesLine(ocr, "nep", 12, 10)).toMatch(/^This PDF has 12 pages\. .+ reads up to 10 pages a run, so split it into parts of 10 pages first\.$/);
    expect(pagesLine(ocr, "eng", 40, 30)).toBe("This PDF has 40 pages. Make searchable (OCR) takes up to 30 pages a run, so split it into smaller parts first.");
    expect(ocr.note).toContain("10 pages for Nepali");
  });
  it("blocks Run and offers Split PDF on the tool screen", () => {
    const src = readFileSync("src/web/pages/app/tools.tsx", "utf8");
    expect(src).toContain("!tooManyPages");
    expect(src).toContain('data-testid="tools-split-instead"');
    expect(src).toContain("countPdfPages(firstPdf)");
  });
});

describe("R71 MB-261 and MB-262", () => {
  it("the move menu ignores scrolls that do not move the card and never scrolls on focus", () => {
    const src = readFileSync("src/web/pages/app/work/board-card-edit.tsx", "utf8");
    expect(src).toContain("focus({ preventScroll: true })");
    expect(src).toContain("target.contains?.(b)");
    const board = readFileSync("src/web/pages/app/work/board.tsx", "utf8");
    expect(board).toContain("overflow-x-hidden");
    expect(board).toContain("flex-wrap items-center gap-x-2.5");
  });
  it("a resting demo shows a note with a sign up link where the button is", () => {
    const demo = readFileSync("src/web/lib/demo.ts", "utf8");
    expect(demo).toContain('err.code === "demo_paused"');
    for (const f of ["landing", "auth", "trust"]) expect(readFileSync(`src/web/pages/${f}.tsx`, "utf8")).toContain("<DemoPausedNote");
    expect(readFileSync("src/web/components/demo-paused.tsx", "utf8")).toContain('to="/signup"');
  });
});
