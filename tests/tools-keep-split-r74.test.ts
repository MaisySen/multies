/**
 * R74: Split without typing (presets with a live preview) and the Tools leave guard and reload keep.
 */
import { describe, expect, it } from "vitest";
import { everyN, halves, parseRanges, partLabel, presetFits, presetOf, presetParts, rangesOf } from "@/shared/split-presets";
import { shouldAsk } from "@/web/components/tools/leave-guard";
import { KEEP_MAX_AGE_MS, tabId, usable } from "@/web/lib/kept-files";

describe("split presets (R74)", () => {
  it("every page, every N pages and halves give the ranges the tool always sent", () => {
    expect(rangesOf(everyN(4, 1))).toBe("1, 2, 3, 4");
    expect(rangesOf(everyN(7, 3))).toBe("1-3, 4-6, 7");
    expect(rangesOf(halves(9))).toBe("1-5, 6-9");
    expect(rangesOf(halves(2))).toBe("1, 2");
    expect(presetParts("halves", 1)).toEqual([]);
  });
  it("a preset that would not fit the 200 character field is not offered", () => {
    expect(presetFits("each", 30)).toBe(true);
    expect(presetFits("each", 120)).toBe(false);
    expect(presetFits("every", 120, 10)).toBe(true);
    expect(presetFits("each", 1)).toBe(false);
  });
  it("reads back which preset a ranges text came from (R73's default included)", () => {
    expect(presetOf("1, 2, 3", 3)).toEqual({ preset: "each", n: 2 });
    expect(presetOf("1-10, 11-20, 21-25", 25)).toEqual({ preset: "every", n: 10 });
    expect(presetOf("1-5, 6-9", 9).preset).toBe("halves");
    expect(presetOf("2-4", 9).preset).toBe("custom");
    expect(presetOf("", 40)).toEqual({ preset: "every", n: 10 });
  });
  it("previews typed ranges and explains a mistake in plain words", () => {
    expect(parseRanges("1-3, 5", 9).parts).toEqual([{ from: 1, to: 3 }, { from: 5, to: 5 }]);
    expect(parseRanges("1-3,", 9).parts.length).toBe(1);
    expect(parseRanges("4-2", 9).error).toMatch(/backwards/);
    expect(parseRanges("1-12", 9).error).toMatch(/9 pages/);
    expect(parseRanges("one", 9).error).toMatch(/like 1-3, 5/);
    expect(parseRanges("", 9)).toEqual({ parts: [], error: null });
    expect(partLabel({ from: 1, to: 3 })).toBe("pages 1 to 3");
    expect(partLabel({ from: 4, to: 4 })).toBe("page 4");
  });
  it("copy has no dashes", () => {
    for (const s of [parseRanges("4-2", 9).error, parseRanges("1-12", 9).error, partLabel({ from: 1, to: 3 })]) expect(s).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("leave guard (R74)", () => {
  it("asks only when a file would be lost by moving to another page", () => {
    expect(shouldAsk(true, { pathname: "/app/tools/pages" }, { pathname: "/app/tasks" }, 0)).toBe(true);
    expect(shouldAsk(false, { pathname: "/app/tools/pages" }, { pathname: "/app/tasks" }, 0)).toBe(false);
    // Same page with other search words (switching tools) or the file handed to the next tool: no question.
    expect(shouldAsk(true, { pathname: "/app/tools" }, { pathname: "/app/tools" }, 0)).toBe(false);
    expect(shouldAsk(true, { pathname: "/app/tools" }, { pathname: "/app/tools/pages" }, 1)).toBe(false);
  });
});

describe("kept files (R74)", () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
  it("one id per tab, the same across reloads", () => {
    const s = mem();
    const a = tabId(s);
    expect(tabId(s)).toBe(a);
    expect(tabId(mem())).not.toBe(a);
  });
  it("restores only in the same tab and within the hour", () => {
    const now = 1_000_000;
    expect(usable({ tab: "t1", at: now - 1000 }, "t1", now)).toBe(true);
    expect(usable({ tab: "t1", at: now - 1000 }, "t2", now)).toBe(false);
    expect(usable({ tab: "t1", at: now - KEEP_MAX_AGE_MS }, "t1", now)).toBe(false);
    expect(usable(undefined, "t1", now)).toBe(false);
    expect(usable({ tab: "none", at: now }, "none", now)).toBe(false);
  });
});
