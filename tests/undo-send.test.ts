import { describe, expect, it, vi } from "vitest";
import { createSendHold, parseUndoSeconds, UNDO_SEND_CHOICES, UNDO_SEND_DEFAULT, type Clock } from "../src/shared/undo-send";

function fakeClock() {
  let now = 1_000_000;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
  };
  const advance = async (ms: number) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    due.forEach((t) => t.fn());
    await Promise.resolve(); await Promise.resolve();
  };
  return { clock, advance, timers: () => timers.length };
}

describe("parseUndoSeconds", () => {
  it("keeps the four choices and defaults to 10", () => {
    expect(UNDO_SEND_CHOICES).toEqual([5, 10, 20, 30]);
    expect(UNDO_SEND_DEFAULT).toBe(10);
    for (const n of UNDO_SEND_CHOICES) { expect(parseUndoSeconds(n)).toBe(n); expect(parseUndoSeconds(String(n))).toBe(n); }
  });
  it("falls back to the default for anything else", () => {
    for (const v of [null, undefined, "", "abc", 0, 7, -5, 3600, "10.5", {}, NaN]) expect(parseUndoSeconds(v)).toBe(10);
  });
});

describe("createSendHold", () => {
  it("posts nothing during the hold and posts once when it ends", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    const send = vi.fn(async () => "ok");
    const onSent = vi.fn();
    const h = q.hold({ seconds: 10, send, onSent });
    expect(h.remaining()).toBe(10);
    await advance(9_999);
    expect(send).not.toHaveBeenCalled();
    expect(h.remaining()).toBe(1);
    expect(q.busy()).toBe(true);
    await advance(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith("ok");
    expect(await h.done).toBe("sent");
    expect(q.busy()).toBe(false);
  });

  it("undo during the hold means the message is never posted", async () => {
    const { clock, advance, timers } = fakeClock();
    const q = createSendHold(clock);
    const send = vi.fn(async () => "ok");
    const onUndo = vi.fn();
    const h = q.hold({ seconds: 5, send, onUndo });
    await advance(4_000);
    expect(h.undo()).toBe(true);
    expect(timers()).toBe(0);
    await advance(60_000);
    expect(send).not.toHaveBeenCalled();
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(await h.done).toBe("undone");
    expect(h.undo()).toBe(false);
  });

  it("undo is refused once the post has started", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    let release!: (v: string) => void;
    const h = q.hold({ seconds: 5, send: () => new Promise<string>((r) => { release = r; }) });
    await advance(5_000);
    expect(h.state()).toBe("sending");
    expect(h.undo()).toBe(false);
    expect(q.busy()).toBe(true);
    release("ok");
    expect(await h.done).toBe("sent");
  });

  it("send now skips the rest of the hold and never posts twice", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    const send = vi.fn(async () => 1);
    const h = q.hold({ seconds: 30, send });
    expect(await h.sendNow()).toBe(1);
    await advance(30_000);
    expect(await h.sendNow()).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a failed post reports the error and settles as failed", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    const onError = vi.fn();
    const h = q.hold({ seconds: 5, send: async () => { throw new Error("offline"); }, onError });
    await advance(5_000);
    expect(await h.done).toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "offline" }));
  });

  it("undo with no id takes back the newest held message only", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    const a = vi.fn(async () => "a");
    const b = vi.fn(async () => "b");
    q.hold({ seconds: 10, send: a });
    await advance(1_000);
    q.hold({ seconds: 10, send: b });
    expect(q.pending()).toHaveLength(2);
    expect(q.undo()).toBe(true);
    expect(q.pending()).toHaveLength(1);
    await advance(20_000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(q.undo()).toBe(false);
  });

  it("undo by id leaves other held messages alone, and listeners hear each change", async () => {
    const { clock } = fakeClock();
    const q = createSendHold(clock);
    const heard = vi.fn();
    const off = q.subscribe(heard);
    const first = q.hold({ seconds: 10, send: async () => 1 });
    q.hold({ seconds: 10, send: async () => 2 });
    expect(q.undo(first.id)).toBe(true);
    expect(q.pending().map((h) => h.id)).not.toContain(first.id);
    expect(heard).toHaveBeenCalledTimes(3);
    off();
    q.undo();
    expect(heard).toHaveBeenCalledTimes(3);
  });
});
