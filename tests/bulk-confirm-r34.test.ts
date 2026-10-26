import { describe, it, expect } from "vitest";
import { BIG_JOB, jobActionFor, jobConfirmWords, needsConfirm } from "@/web/lib/bulk-confirm-r34";

/** R34: the confirm before a big select-all job, and how bar actions map to jobs. */
describe("bulk confirm", () => {
  it("asks only over the threshold, or when the total isn't known and there is more", () => {
    expect(needsConfirm(BIG_JOB, true)).toBe(false);
    expect(needsConfirm(BIG_JOB + 1, false)).toBe(true);
    expect(needsConfirm(null, true)).toBe(true);
    expect(needsConfirm(null, false)).toBe(false);
  });
  it("delete over everything is a move to Trash, but not inside Trash", () => {
    expect(jobActionFor("delete", "inbox")).toBe("trash");
    expect(jobActionFor("delete", "trash")).toBeNull();
    expect(jobActionFor("snooze", "inbox")).toBe("snooze");
    expect(jobActionFor("move", "inbox")).toBe("move");
  });
  it("says the count, the place and the action", () => {
    expect(jobConfirmWords("archive", 3100, "Inbox")).toEqual({ title: "Archive 3,100 messages in Inbox?", description: "This might take a minute. You can undo it.", button: "Archive" });
    expect(jobConfirmWords("snooze", 600, "Inbox", "tomorrow").title).toBe("Snooze 600 messages in Inbox until tomorrow?");
    expect(jobConfirmWords("move", null, "“invoice”", "Projects").title).toBe("Move every message matching “invoice” to Projects?");
    expect(jobConfirmWords("move", 900, "Inbox", "Projects").description).toMatch(/can't be undone/);
    expect(jobConfirmWords("trash", 501, "Archive").title).toBe("Delete 501 messages in Archive?");
  });
});
