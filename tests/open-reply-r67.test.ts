import { describe, it, expect, beforeEach } from "vitest";
import { forgetOpenReply, openReplyDraft, rememberOpenReply } from "@/web/lib/draft-autosave";

// Node has no localStorage: a tiny in-memory one.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k),
};

describe("R67 open reply survives a reload (MB-244)", () => {
  beforeEach(() => store.clear());
  it("remembers the latest draft per thread and forgets it on close or send", () => {
    const now = Date.now();
    rememberOpenReply("thr_1", "d1", now - 2000);
    rememberOpenReply("thr_1", "d2", now - 1000);
    rememberOpenReply("thr_2", "d9", now - 1000);
    expect(openReplyDraft("thr_1", now)).toBe("d2");
    forgetOpenReply("thr_1");
    expect(openReplyDraft("thr_1")).toBeUndefined();
    expect(openReplyDraft("thr_2")).toBe("d9");
    forgetOpenReply("thr_2");
    expect(store.size).toBe(0);
  });
  it("drops entries older than three days and survives bad storage", () => {
    rememberOpenReply("thr_1", "d1", 0);
    expect(openReplyDraft("thr_1", 3 * 24 * 3600_000 + 1)).toBeUndefined();
    store.set("mm-open-reply-drafts", "not json");
    expect(openReplyDraft("thr_1")).toBeUndefined();
    expect(openReplyDraft(undefined)).toBeUndefined();
  });
});
