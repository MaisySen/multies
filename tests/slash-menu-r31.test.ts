import { describe, it, expect } from "vitest";
import { filterSlash, fuzzyScore, groupSlash, moveSel, SLASH_ITEMS, slashQuery, todayText } from "@/web/lib/slash-commands";

/** R31: the docs "/" menu as data. */
describe("slash menu", () => {
  it("opens after a slash at the start of a line or after a space, and not inside a word or a path", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/head")).toBe("head");
    expect(slashQuery("Notes for today /to")).toBe("to");
    expect(slashQuery("and/or")).toBeNull();
    expect(slashQuery("https://x")).toBeNull();
    expect(slashQuery("/two words")).toBeNull();
    expect(slashQuery("/" + "x".repeat(25))).toBeNull();
    expect(slashQuery("")).toBeNull();
  });

  it("lists every supported block, with unique ids and an action each", () => {
    expect(SLASH_ITEMS.map((i) => i.id)).toEqual(["text", "h1", "h2", "h3", "quote", "code", "divider", "bullets", "numbers", "todo", "link", "date"]);
    expect(new Set(SLASH_ITEMS.map((i) => i.id)).size).toBe(SLASH_ITEMS.length);
    expect(SLASH_ITEMS.find((i) => i.id === "h2")!.action).toEqual({ kind: "heading", level: 2 });
    expect(SLASH_ITEMS.find((i) => i.id === "todo")!.action).toEqual({ kind: "taskList" });
  });

  it("filters fuzzily, best match first", () => {
    expect(filterSlash("head").slice(0, 3).map((i) => i.id)).toEqual(["h1", "h2", "h3"]);
    expect(filterSlash("to")[0].id).toBe("todo");
    expect(filterSlash("bul")[0].id).toBe("bullets");
    expect(filterSlash("hr")[0].id).toBe("divider");
    expect(filterSlash("checklist")[0].id).toBe("todo");
    expect(filterSlash("mention")[0].id).toBe("link");
    expect(filterSlash("cdblk")[0].id).toBe("code");
    expect(filterSlash("##")[0].id).toBe("h2");
    expect(filterSlash("zzzz")).toEqual([]);
    expect(filterSlash("")).toBe(SLASH_ITEMS);
    expect(fuzzyScore("hd1", "heading 1")).toBeGreaterThan(0);
    expect(fuzzyScore("x", "heading")).toBe(0);
  });

  it("groups the full list and ranks a filtered one, with flat indexes for the keyboard", () => {
    const g = groupSlash(SLASH_ITEMS, false);
    expect(g.map((x) => x.group)).toEqual(["Basic", "Lists", "Embeds"]);
    expect(g.flatMap((x) => x.items.map((i) => i.index))).toEqual(SLASH_ITEMS.map((_, i) => i));
    expect(groupSlash(filterSlash("list"), true)).toHaveLength(1);
    expect(groupSlash([], true)).toEqual([]);
  });

  it("wraps the highlight and formats the date", () => {
    expect(moveSel(0, -1, 5)).toBe(4);
    expect(moveSel(4, 1, 5)).toBe(0);
    expect(moveSel(0, 1, 0)).toBe(0);
    expect(todayText(new Date("2026-10-26T03:00:00Z"), "en-AU")).toMatch(/26 Oct 2026/);
  });
});
