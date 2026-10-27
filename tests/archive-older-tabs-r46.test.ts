import { describe, it, expect } from "vitest";
import { archiveOlderOffered, emptyInboxTitle, olderCountWords } from "@/web/pages/app/mail/archive-older-offer";

/**
 * R46: "Archive older mail" was hidden on an empty Inbox tab (Important empty, Other with mail) because the button
 * looked only at the rows of the open tab. The job covers the whole Inbox, so the offer follows the mailbox Inbox
 * total, and the words say the count covers every tab.
 */
describe("Archive older on split tabs (R46)", () => {
  it("is offered on an empty tab when the Inbox has mail", () => {
    expect(archiveOlderOffered({ folder: "inbox", q: "", loaded: 0, inboxTotal: 12 })).toBe(true);
  });
  it("is still offered when the tab has rows, and not when the whole Inbox is empty", () => {
    expect(archiveOlderOffered({ folder: "inbox", q: "", loaded: 3, inboxTotal: 3 })).toBe(true);
    expect(archiveOlderOffered({ folder: "inbox", q: "", loaded: 0, inboxTotal: 0 })).toBe(false);
  });
  it("is never offered outside Inbox or while searching", () => {
    expect(archiveOlderOffered({ folder: "archive", q: "", loaded: 5, inboxTotal: 9 })).toBe(false);
    expect(archiveOlderOffered({ folder: "inbox", q: "invoice", loaded: 5, inboxTotal: 9 })).toBe(false);
  });
  it("an empty Important tab with mail in other tabs is not called Inbox zero", () => {
    expect(emptyInboxTitle({ split: "important", defaultSplit: "important", tabs: 2, inboxTotal: 4 })).toBe("Nothing in this tab");
    expect(emptyInboxTitle({ split: "important", defaultSplit: "important", tabs: 2, inboxTotal: 0 })).toBe("Inbox zero");
    expect(emptyInboxTitle({ split: "", defaultSplit: "important", tabs: 0, inboxTotal: 4 })).toBe("Inbox zero");
    expect(emptyInboxTitle({ split: "other", defaultSplit: "important", tabs: 2, inboxTotal: 0 })).toBe("Nothing in this tab");
  });
  it("the count says it covers every tab when tabs are on, and keeps the old words otherwise", () => {
    expect(olderCountWords(6, 5000, true)).toBe("6 emails move to Archive, counted across every Inbox tab.");
    expect(olderCountWords(1, 5000, true)).toBe("1 email moves to Archive, counted across every Inbox tab.");
    expect(olderCountWords(6, 5000, false)).toBe("6 emails move to Archive.");
    expect(olderCountWords(0, 5000, false)).toBe("Nothing in your Inbox is that old.");
    expect(olderCountWords(0, 5000, true)).toBe("Nothing in your Inbox is that old, in any tab.");
    expect(olderCountWords(7000, 5000, true)).toBe("7,000 emails across every Inbox tab. The oldest 5,000 move now; run it again for the rest.");
  });
});
