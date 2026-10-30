import { describe, expect, it } from "vitest";
import { applyMailAction, destination, type MailListData } from "@/web/lib/optimistic-mail";
import type { MessageListItem } from "@/web/lib/types";

const msg = (id: string, over: Partial<MessageListItem> = {}): MessageListItem => ({
  id, mailboxId: "mb", folder: "inbox" as MessageListItem["folder"], threadId: `t-${id}`, from: { address: "a@x.co", name: "A" } as MessageListItem["from"], to: [],
  subject: id, snippet: "", date: "2026-10-26T00:00:00Z", isRead: false, isStarred: false, hasAttachments: false, ...over,
});
const data = (): MailListData => ({ pages: [{ messages: [msg("a"), msg("b")], nextCursor: "c" }, { messages: [msg("c")], nextCursor: null }], pageParams: ["", "c"] });
const ids = (d?: MailListData) => d!.pages.flatMap((p) => p.messages.map((m) => m.id));

describe("R30 optimistic mail actions", () => {
  it("star and unstar flip only the named messages", () => {
    const d = applyMailAction(data(), ["b"], "star", "inbox")!;
    expect(d.pages[0].messages.map((m) => m.isStarred)).toEqual([false, true]);
    expect(applyMailAction(d, ["b"], "unstar", "inbox")!.pages[0].messages[1].isStarred).toBe(false);
  });

  it("read and unread across pages", () => {
    const d = applyMailAction(data(), ["a", "c"], "read", "inbox")!;
    expect(d.pages[0].messages[0].isRead).toBe(true);
    expect(d.pages[1].messages[0].isRead).toBe(true);
    expect(d.pages[0].messages[1].isRead).toBe(false);
    expect(applyMailAction(d, ["c"], "unread", "inbox")!.pages[1].messages[0].isRead).toBe(false);
  });

  it("archive, trash, spam and move take the message out of the folder on screen", () => {
    for (const a of ["archive", "trash", "spam", "move", "delete"] as const) expect(ids(applyMailAction(data(), ["a"], a, "inbox"))).toEqual(["b", "c"]);
  });

  it("moving to the folder already on screen keeps it", () => {
    expect(ids(applyMailAction(data(), ["a"], "inbox", "inbox"))).toEqual(["a", "b", "c"]);
    expect(ids(applyMailAction(data(), ["a"], "inbox", "archive"))).toEqual(["b", "c"]);
  });

  it("search results keep a moved message and show its new folder; delete still removes", () => {
    const d = applyMailAction(data(), ["a"], "archive", "inbox", true)!;
    expect(ids(d)).toEqual(["a", "b", "c"]);
    expect(d.pages[0].messages[0].folder).toBe("archive");
    expect(ids(applyMailAction(data(), ["a"], "move", "inbox", true))).toEqual(["a", "b", "c"]);
    expect(ids(applyMailAction(data(), ["a"], "delete", "inbox", true))).toEqual(["b", "c"]);
  });

  it("leaves the original untouched (so it can be put back) and keeps page params", () => {
    const before = data();
    const after = applyMailAction(before, ["a"], "archive", "inbox")!;
    expect(ids(before)).toEqual(["a", "b", "c"]);
    expect(after.pageParams).toEqual(["", "c"]);
    expect(after.pages[0].nextCursor).toBe("c");
  });

  it("no data or no ids is a no-op", () => {
    expect(applyMailAction(undefined, ["a"], "star", "inbox")).toBeUndefined();
    const d = data();
    expect(applyMailAction(d, [], "star", "inbox")).toBe(d);
  });

  it("destination per action", () => {
    expect(destination("archive")).toBe("archive");
    expect(destination("delete")).toBe("gone");
    expect(destination("move")).toBe("elsewhere");
    expect(destination("star")).toBeNull();
  });
});
