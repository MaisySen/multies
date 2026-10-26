import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GO_TO, SEQUENCE_MS, SHORTCUTS, SHORTCUT_GROUPS, displayKeys, filterShortcuts, goToTarget, groupShortcuts, isTypingTarget, readKey } from "@/web/lib/shortcuts";

describe("R30 shortcuts registry", () => {
  it("has unique ids and every group is known", () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
    for (const s of SHORTCUTS) expect(SHORTCUT_GROUPS).toContain(s.group);
  });

  it("go to keys are unique letters and every target is an app page", () => {
    expect(new Set(GO_TO.map((g) => g.key)).size).toBe(GO_TO.length);
    const router = readFileSync("src/web/router.tsx", "utf8");
    for (const g of GO_TO) {
      expect(g.key).toMatch(/^[a-z]$/);
      const sub = g.to.replace(/^\/app\/?/, "");
      if (sub) expect(router).toContain(`path: "${sub}"`);
    }
  });

  it("the mail keys in the sheet are the keys webmail.tsx handles (no drift)", () => {
    const src = readFileSync("src/web/pages/app/webmail.tsx", "utf8");
    const mail = SHORTCUTS.filter((s) => s.group === "Mail" && s.id !== "mail-task");
    for (const s of mail) expect(src, s.id).toContain(`e.key === "${s.keys[0].toLowerCase()}"`);
    expect(readFileSync("src/web/pages/app/work/make-task.tsx", "utf8")).toContain('e.key !== "t"');
  });

  it("shows Cmd on a Mac and Ctrl elsewhere", () => {
    const palette = SHORTCUTS.find((s) => s.id === "palette")!;
    expect(displayKeys(palette, true)).toEqual(["⌘", "K"]);
    expect(displayKeys(palette, false)).toEqual(["Ctrl", "K"]);
    expect(displayKeys({ keys: ["Alt", "Shift", "X"] }, true)).toEqual(["⌥", "⇧", "X"]);
  });

  it("search matches label, group, keys and keywords; all words must match", () => {
    expect(filterShortcuts(SHORTCUTS, "").length).toBe(SHORTCUTS.length);
    expect(filterShortcuts(SHORTCUTS, "archive").map((s) => s.id)).toEqual(["mail-archive"]);
    expect(filterShortcuts(SHORTCUTS, "go tasks").map((s) => s.id)).toEqual(["go-t"]);
    expect(filterShortcuts(SHORTCUTS, "checklist").every((s) => s.group === "Tasks")).toBe(true);
    expect(filterShortcuts(SHORTCUTS, "zzzz")).toEqual([]);
  });

  it("groups in sheet order and drops empty groups", () => {
    const g = groupShortcuts(filterShortcuts(SHORTCUTS, "mail"));
    expect(g.map((x) => x.group)[0]).toBe("Go to");
    expect(groupShortcuts([]).length).toBe(0);
    expect(groupShortcuts(SHORTCUTS).map((x) => x.group)).toEqual(SHORTCUT_GROUPS);
  });

  it("G then a letter goes there within the window, and not after it", () => {
    let r = readKey({ pendingG: null }, { key: "g" }, 1000);
    expect(r.action.kind).toBe("arm");
    r = readKey(r.state, { key: "t" }, 1500);
    expect(r.action).toEqual({ kind: "go", to: "/app/tasks" });
    expect(r.state.pendingG).toBeNull();
    const late = readKey({ pendingG: 1000 }, { key: "t" }, 1000 + SEQUENCE_MS + 1);
    expect(late.action.kind).toBe("none");
    expect(readKey({ pendingG: 1000 }, { key: "x" }, 1100).action.kind).toBe("none");
    expect(goToTarget("I")).toBe("/app/mail");
    expect(goToTarget("?")).toBeNull();
  });

  it("? opens the sheet; modifiers cancel", () => {
    expect(readKey({ pendingG: null }, { key: "?" }, 0).action.kind).toBe("sheet");
    expect(readKey({ pendingG: 5 }, { key: "t", metaKey: true }, 6)).toEqual({ state: { pendingG: null }, action: { kind: "none" } });
    expect(readKey({ pendingG: null }, { key: "g", ctrlKey: true }, 0).action.kind).toBe("none");
  });

  it("typing in a field is not a shortcut", () => {
    expect(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
