// R36 (web premium round 3): command menu recents, inline task edit helpers, empty copy per folder.
import { beforeEach, describe, expect, it } from "vitest";
import { RECENT_LIMIT, clearRecents, hintForUrl, pushRecent, readRecents, recordRecent, type Recent } from "../src/web/lib/palette-recents";
import { applyToLists, cleanTitle, dueInputValue } from "../src/web/lib/inline-task-edit";
import { folderEmpty } from "../src/web/lib/empty-copy-r36";
import type { Task } from "../src/web/pages/app/work/data";

class MemStorage { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } clear() { this.m.clear(); } key() { return null; } get length() { return this.m.size; } }

describe("palette recents", () => {
  beforeEach(() => { (globalThis as { localStorage?: unknown }).localStorage = new MemStorage(); });

  it("puts the newest first, drops duplicates and keeps each kind to the limit", () => {
    let list: Recent[] = [];
    for (let i = 0; i < RECENT_LIMIT + 3; i++) list = pushRecent(list, { kind: "item", id: `/app/docs/${i}`, label: `Doc ${i}` }, 1000 + i);
    list = pushRecent(list, { kind: "command", id: "go-mail", label: "Go to Mail" }, 5000);
    list = pushRecent(list, { kind: "item", id: "/app/docs/3", label: "Doc 3" }, 6000);
    const items = list.filter((r) => r.kind === "item");
    expect(items).toHaveLength(RECENT_LIMIT);
    expect(items[0].id).toBe("/app/docs/3");
    expect(new Set(items.map((r) => r.id)).size).toBe(items.length);
    expect(list.filter((r) => r.kind === "command").map((r) => r.id)).toEqual(["go-mail"]);
  });

  it("reads and writes through localStorage and survives junk", () => {
    recordRecent({ kind: "command", id: "action-theme", label: "Switch theme" });
    recordRecent({ kind: "item", id: "/app/tasks?task=1", label: "Fix login", url: "/app/tasks?task=1", hint: "Task" });
    expect(readRecents("command").map((r) => r.id)).toEqual(["action-theme"]);
    expect(readRecents("item")[0].label).toBe("Fix login");
    localStorage.setItem("multies-palette-recents", "{not json");
    expect(readRecents("item")).toEqual([]);
    localStorage.setItem("multies-palette-recents", JSON.stringify([{ kind: "other", id: "x", label: "y" }, 4, null]));
    expect(readRecents("item")).toEqual([]);
    recordRecent({ kind: "item", id: "a", label: "A" });
    clearRecents();
    expect(readRecents("item")).toEqual([]);
  });

  it("names a content link by its area", () => {
    expect(hintForUrl("/app/docs/abc")).toBe("Doc");
    expect(hintForUrl("/app/tasks?task=MB-1")).toBe("Task");
    expect(hintForUrl("/app/somewhere")).toBe("Page");
  });
});

describe("inline task edit helpers", () => {
  const t = (id: string, title: string) => ({ id, title }) as unknown as Task;
  it("applies a change to the task in every loaded list and leaves the rest", () => {
    const lists: [readonly unknown[], Task[] | undefined][] = [[["tasks", "a"], [t("1", "One"), t("2", "Two")]], [["tasks", "b"], undefined], [["tasks", "c"], [t("2", "Two")]]];
    const next = applyToLists(lists, "2", (x) => ({ ...x, title: "Second" }));
    expect(next[0][1]!.map((x) => x.title)).toEqual(["One", "Second"]);
    expect(next[1][1]).toBeUndefined();
    expect(next[2][1]![0].title).toBe("Second");
    expect(lists[0][1]![1].title).toBe("Two");
  });
  it("saves only a real, changed title", () => {
    expect(cleanTitle("  New   name ", "Old")).toBe("New name");
    expect(cleanTitle("Old", "Old")).toBeNull();
    expect(cleanTitle("   ", "Old")).toBeNull();
    expect(cleanTitle("x".repeat(600), "Old")).toHaveLength(500);
  });
  it("gives a date input value from an ISO due date", () => {
    expect(dueInputValue("2026-11-03T00:00:00.000Z")).toBe("2026-11-03");
    expect(dueInputValue(null)).toBe("");
  });
});

describe("empty copy per mail folder", () => {
  it("has short copy for each folder and a fallback", () => {
    for (const f of ["sent", "drafts", "spam", "trash", "archive", "snoozed", "starred"]) {
      const c = folderEmpty(f);
      expect(c.title.split(" ").length).toBeLessThanOrEqual(4);
      expect(c.body).not.toMatch(/[\u2013\u2014]/);
    }
    expect(folderEmpty("custom").title).toBe("Nothing here");
  });
});
