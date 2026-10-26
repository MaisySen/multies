import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GO_TO, SHORTCUTS, SHORTCUT_GROUPS, displayKeys, filterShortcuts, goToTarget, groupShortcuts, isTypingTarget } from "@/web/lib/shortcuts";
import { SEQUENCE_MS, idleKeys, readKeys } from "@/web/lib/commands";

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

  it("the mail keys in the sheet are the keys webmail.tsx binds (no drift; R31: bound through the registry)", () => {
    const src = readFileSync("src/web/pages/app/webmail.tsx", "utf8");
    const mail = SHORTCUTS.filter((s) => s.group === "Mail" && s.id !== "mail-task" && !s.id.startsWith("mail-split-")); // R31: split keys live in webmail's own Tab handler
    for (const s of mail) expect(src, s.id).toContain(`"${s.id}": () =>`);
    expect(readFileSync("src/web/pages/app/work/make-task.tsx", "utf8")).toContain('e.key !== "t"');
  });

  it("R31: page keys (triage, Inbox splits, pre-join, docs slash) are listed in the sheet", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    for (const id of ["triage-done", "triage-snooze", "mail-split-next", "prejoin-join", "doc-slash"]) expect(ids).toContain(id);
    expect(SHORTCUTS.filter((s) => s.group === "Notifications").length).toBeGreaterThanOrEqual(6);
    // The sheet's triage keys are the keys the page reads (src/web/lib/triage.ts TRIAGE_KEYS).
    const src = readFileSync("src/web/lib/triage.ts", "utf8");
    for (const s of SHORTCUTS.filter((x) => x.group === "Notifications")) expect(src, s.id).toMatch(new RegExp(`key: "[^"]*\\b${s.keys[s.keys.length - 1]}"`));
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

  it("G then a letter goes there within the window, and not after it (R31: read from the registry)", () => {
    let r = readKeys(idleKeys(), { key: "g" }, 1000, ["global"]);
    expect(r.result).toEqual({ kind: "pending", keys: ["G"] });
    r = readKeys(r.state, { key: "t" }, 1500, ["global"]);
    expect(r.result.kind === "run" && r.result.command.to).toBe("/app/tasks");
    expect(r.state.pending).toEqual([]);
    const late = readKeys({ pending: ["G"], at: 1000 }, { key: "t" }, 1000 + SEQUENCE_MS + 1, ["global"]);
    expect(late.result.kind).toBe("none");
    expect(readKeys({ pending: ["G"], at: 1000 }, { key: "x" }, 1100, ["global"]).result.kind).toBe("none");
    expect(goToTarget("I")).toBe("/app/mail");
    expect(goToTarget("?")).toBeNull();
  });

  it("? opens the sheet; modifiers cancel", () => {
    const r = readKeys(idleKeys(), { key: "?" }, 0, ["global"]);
    expect(r.result.kind === "run" && r.result.command.id).toBe("sheet");
    expect(readKeys({ pending: ["G"], at: 5 }, { key: "t", metaKey: true }, 6, ["global"])).toEqual({ state: idleKeys(), result: { kind: "none" } });
    expect(readKeys(idleKeys(), { key: "g", ctrlKey: true }, 0, ["global"]).result.kind).toBe("none");
  });

  it("typing in a field is not a shortcut", () => {
    expect(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
