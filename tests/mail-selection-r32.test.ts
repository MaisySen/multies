import { describe, it, expect } from "vitest";
import { bulkLabel, emptySelection, prune, selectAll, selectRange, toggleOne, undoPlan } from "@/web/lib/mail-selection";
import { applyMailAction, type MailListData } from "@/web/lib/optimistic-mail";
import { bindCommand, COMMANDS, runCommand } from "@/web/lib/commands/registry";
import type { MessageListItem } from "@/web/lib/types";

/** R32: mail multi-select, Undo plans, optimistic snooze and the registry keys for selection. */
const rows = ["a", "b", "c", "d", "e"];
const item = (id: string, over: Partial<MessageListItem> = {}) => ({ id, folder: "inbox", isRead: false, isStarred: false, ...over }) as MessageListItem;

describe("selection", () => {
  it("X toggles, Shift+X selects a range from the last toggled row, Cmd+A selects all, rows that leave drop out", () => {
    let s = toggleOne(emptySelection(), "b", rows);
    expect(s.ids).toEqual(["b"]);
    s = selectRange(s, "d", rows);
    expect(s.ids).toEqual(["b", "c", "d"]);
    s = toggleOne(s, "c", rows);
    expect(s.ids).toEqual(["b", "d"]);
    s = selectRange(s, "a", rows); // anchor is c now
    expect(s.ids).toEqual(["a", "b", "c", "d"]);
    expect(selectAll(rows).ids).toEqual(rows);
    expect(prune(s, ["a", "d", "e"]).ids).toEqual(["a", "d"]);
    expect(selectRange(emptySelection(), "c", rows).ids).toEqual(["c"]);
  });
});

describe("undo plans", () => {
  const before = [item("a"), item("b", { isRead: true }), item("c", { folder: "archive" as never, isStarred: true })];
  it("moves go back to each row's own folder", () => {
    expect(undoPlan({ ids: ["a", "b"], action: "archive" }, before)).toEqual([{ ids: ["a", "b"], action: "inbox" }]);
    expect(undoPlan({ ids: ["a", "c"], action: "trash" }, before)).toEqual([{ ids: ["a"], action: "inbox" }, { ids: ["c"], action: "archive" }]);
  });
  it("read, unread and star go back only where they changed; snooze is undone by unsnooze; delete has none", () => {
    expect(undoPlan({ ids: ["a", "b"], action: "read" }, before)).toEqual([{ ids: ["a"], action: "unread" }]);
    expect(undoPlan({ ids: ["a", "b"], action: "unread" }, before)).toEqual([{ ids: ["b"], action: "read" }]);
    expect(undoPlan({ ids: ["a", "c"], action: "star" }, before)).toEqual([{ ids: ["a"], action: "unstar" }]);
    expect(undoPlan({ ids: ["a"], action: "snooze", preset: "tomorrow" }, before)).toEqual([{ ids: ["a"], action: "unsnooze" }]);
    expect(undoPlan({ ids: ["a"], action: "delete" }, before)).toBeNull();
    expect(undoPlan({ ids: ["a"], action: "move", to: "f:Clients" }, before)).toBeNull();
  });
  it("says what happened in plain words", () => {
    expect(bulkLabel({ ids: ["a", "b", "c"], action: "archive" })).toBe("Archived 3 conversations");
    expect(bulkLabel({ ids: ["a"], action: "read" })).toBe("Marked 1 conversation as read");
    expect(bulkLabel({ ids: ["a", "b"], action: "snooze", preset: "tomorrow" })).toBe("Snoozed 2 conversations until tomorrow");
    expect(bulkLabel({ ids: ["a", "b"], action: "move", to: "f:Clients" }, "Clients")).toBe("Moved 2 conversations to Clients");
  });
});

describe("optimistic snooze", () => {
  it("leaves Inbox at once, stays elsewhere and in search", () => {
    const data: MailListData = { pages: [{ messages: [item("a"), item("b")], nextCursor: null }], pageParams: [""] };
    expect(applyMailAction(data, ["a"], "snooze", "inbox")!.pages[0].messages.map((m) => m.id)).toEqual(["b"]);
    expect(applyMailAction(data, ["a"], "snooze", "archive")!.pages[0].messages).toHaveLength(2);
    expect(applyMailAction(data, ["a"], "snooze", "inbox", true)!.pages[0].messages).toHaveLength(2);
    expect(applyMailAction(data, ["a"], "unsnooze", "inbox")!.pages[0].messages).toHaveLength(2);
  });
});

describe("registry", () => {
  it("lists the selection keys in the mail module", () => {
    const keys = (id: string) => COMMANDS.find((c) => c.id === id)?.keys;
    expect(keys("mail-select")).toEqual(["X"]);
    expect(keys("mail-select-range")).toEqual(["Shift", "X"]);
    expect(keys("mail-select-all")).toEqual(["Mod", "A"]);
    expect(keys("mail-undo")).toEqual(["Mod", "Z"]);
    for (const id of ["mail-bulk-archive", "mail-bulk-snooze", "mail-bulk-read", "mail-bulk-unread", "mail-bulk-trash"]) expect(COMMANDS.find((c) => c.id === id)?.palette).toBe(true);
  });
  it("a handler that returns false passes to the one bound before it", () => {
    const c = COMMANDS.find((x) => x.id === "mail-snooze")!;
    const calls: string[] = [];
    const offA = bindCommand("mail-snooze", () => { calls.push("reader"); });
    const offB = bindCommand("mail-snooze", () => { calls.push("page"); return false; });
    expect(runCommand(c, { navigate: () => undefined, openSheet: () => undefined, openPalette: () => undefined })).toBe(true);
    expect(calls).toEqual(["page", "reader"]);
    offB(); offA();
    expect(runCommand(c, { navigate: () => undefined, openSheet: () => undefined, openPalette: () => undefined })).toBe(false);
  });
});
