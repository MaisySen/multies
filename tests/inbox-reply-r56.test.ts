import { describe, it, expect, vi } from "vitest";
import { createAutosaver } from "@/web/lib/draft-autosave";
import { replyDraftFor } from "@/web/pages/app/inbox-reply";

describe("R56 draft autosave (MB-244)", () => {
  it("saves once after typing stops, then replaces the same draft", async () => {
    vi.useFakeTimers();
    const calls: { v: string; id?: string }[] = [];
    let n = 0;
    const a = createAutosaver<string>(async (v, id) => { calls.push({ v, id }); return { id: `d${++n}` }; }, { delayMs: 1000 });
    a.change("h"); a.change("he"); a.change("hel");
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ v: "hel", id: undefined }]);
    a.change("hello");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls[1]).toEqual({ v: "hello", id: "d1" });
    expect(a.stop()).toBe("d2");
    a.change("after stop");
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2);
    vi.useRealTimers();
  });
  it("never runs two saves at once; edits during a save go in the next one with the new id", async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    const calls: { v: string; id?: string }[] = [];
    let n = 0;
    const a = createAutosaver<string>((v, id) => { calls.push({ v, id }); return new Promise((r) => { release = () => r({ id: `d${++n}` }); }); }, { delayMs: 100, firstId: "d0" });
    a.change("one");
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([{ v: "one", id: "d0" }]);
    a.change("two");
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[1]).toEqual({ v: "two", id: "d1" });
    release!();
    await a.flush();
    expect(a.id()).toBe("d2");
    vi.useRealTimers();
  });
  it("flush saves at once when the page is hidden", async () => {
    const calls: string[] = [];
    const a = createAutosaver<string>(async (v) => { calls.push(v); return { id: "x" }; }, { delayMs: 60_000 });
    a.change("typed");
    await a.flush();
    expect(calls).toEqual(["typed"]);
  });
});

describe("R56 reply from the shared inbox (MB-242)", () => {
  const t = {
    id: "thr_1", mailboxId: "mbx_1", subject: "Order 42",
    messages: [
      { id: "m1", from: { address: "ann@customer.test", name: "Ann" }, to: [{ address: "support@acme.test" }, { address: "bob@customer.test" }], cc: [{ address: "cfo@customer.test" }], subject: "Order 42", date: "2026-10-28T10:00:00Z", text: "Where is it?" },
    ],
  };
  it("Reply answers the sender from the thread's mailbox, quoting the last message", () => {
    const d = replyDraftFor(t, ["support@acme.test"], false);
    expect(d).toMatchObject({ mailboxId: "mbx_1", to: "ann@customer.test", cc: "", inReplyToId: "m1", threadId: "thr_1", subject: "Re: Order 42" });
    expect(d.text).toContain("> Where is it?");
  });
  it("Reply all adds everyone else, never our own address", () => {
    const d = replyDraftFor(t, ["SUPPORT@acme.test"], true);
    expect(d.cc).toBe("bob@customer.test, cfo@customer.test");
  });
  it("when the last message is ours, the reply goes to whom it went to", () => {
    const t2 = { ...t, subject: "Re: Order 42", messages: [...t.messages, { id: "m2", from: { address: "support@acme.test" }, to: [{ address: "ann@customer.test" }], subject: "Re: Order 42", date: "2026-10-28T11:00:00Z", text: "Shipped" }] };
    const d = replyDraftFor(t2, ["support@acme.test"], false);
    expect(d).toMatchObject({ to: "ann@customer.test", subject: "Re: Order 42", inReplyToId: "m2" });
  });
});
