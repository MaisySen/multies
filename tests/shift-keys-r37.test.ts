import { describe, expect, it } from "vitest";
import { idleKeys, readKeys } from "@/web/lib/commands/registry";

// R37: Shift plus a letter reaches page commands (lanes, date clashes); the plain letter still runs its own command.
describe("Shift plus a letter", () => {
  it("runs Shift+L and Shift+D on the task pages, and L alone stays the label picker", () => {
    const scopes = ["task", "tasks-list", "global"] as const;
    const run = (e: { key: string; shiftKey?: boolean }) => readKeys(idleKeys(), e, 0, [...scopes]).result;
    const lanes = run({ key: "L", shiftKey: true });
    expect(lanes.kind === "run" && lanes.command.id).toBe("board-lanes-collapse");
    const clashes = run({ key: "D", shiftKey: true });
    expect(clashes.kind === "run" && clashes.command.id).toBe("timeline-clashes");
    const label = run({ key: "l" });
    expect(label.kind === "run" && label.command.id).toBe("task-label");
  });
  it("leaves ? and # alone (they need Shift on most keyboards)", () => {
    const r = readKeys(idleKeys(), { key: "?", shiftKey: true }, 0, ["global"]).result;
    expect(r.kind === "run" && r.command.id).toBe("sheet");
  });
});
