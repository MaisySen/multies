import { describe, it, expect } from "vitest";
import { stepSplit } from "@/shared/mail-splits";
import { canRunMailAction, registerMailActions, runMailAction } from "@/web/lib/mail-actions";

/** R31: Tab / Shift+Tab between Inbox splits, and mail actions by name for the command registry. */
describe("stepSplit", () => {
  const tabs = [{ id: "important" }, { id: "other" }, { id: "spl_a" }];
  it("moves forward and back, wrapping, and starts from the first tab when the current one is gone", () => {
    expect(stepSplit(tabs, "important", 1)).toBe("other");
    expect(stepSplit(tabs, "spl_a", 1)).toBe("important");
    expect(stepSplit(tabs, "important", -1)).toBe("spl_a");
    expect(stepSplit(tabs, "spl_gone", 1)).toBe("other");
    expect(stepSplit([], "important", 1)).toBe("important");
  });
});

describe("mail actions", () => {
  it("runs the newest layer that has the action and reports when nothing can", () => {
    const calls: string[] = [];
    expect(runMailAction("archive")).toBe(false);
    const offList = registerMailActions({ archive: () => calls.push("list archive"), reply: () => calls.push("list reply") });
    const offReader = registerMailActions({ reply: () => calls.push("reader reply") });
    expect(runMailAction("reply")).toBe(true);
    expect(runMailAction("archive")).toBe(true);
    expect(canRunMailAction("forward")).toBe(false);
    offReader();
    expect(runMailAction("reply")).toBe(true);
    offList();
    expect(runMailAction("reply")).toBe(false);
    expect(calls).toEqual(["reader reply", "list archive", "list reply"]);
  });
});
