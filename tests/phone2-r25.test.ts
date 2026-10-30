import { describe, expect, it } from "vitest";
import { LONG_PRESS_MS, createLongPress, messageActions, type MessageActionInput } from "@/web/lib/message-actions";

const base: MessageActionInput = { deleted: false, inThread: false, mine: false, role: "member", canPin: true, isReply: false, pinned: false, canTriage: true, hasText: true };
const ids = (i: Partial<MessageActionInput>) => messageActions({ ...base, ...i }).map((a) => a.id);

describe("messageActions (R25 wave 2 phone sheet)", () => {
  it("lists react, thread, copy, triage, task and pin for someone else's message, without edit or delete for a member", () => {
    expect(ids({})).toEqual(["react", "thread", "copy", "triage", "task", "pin"]);
  });
  it("offers edit and delete on my own message", () => {
    expect(ids({ mine: true })).toEqual(["react", "thread", "copy", "triage", "task", "pin", "edit", "delete"]);
    expect(messageActions({ ...base, mine: true }).find((a) => a.id === "delete")?.danger).toBe(true);
  });
  it("lets an owner or admin delete anyone's message, but only the author edit (the server rule)", () => {
    for (const role of ["owner", "admin"]) {
      expect(ids({ role })).toContain("delete");
      expect(ids({ role })).not.toContain("edit");
    }
    expect(ids({ role: "guest" })).not.toContain("delete");
    expect(ids({ role: null })).not.toContain("delete");
  });
  it("has no reply in thread inside a thread, and no pin for replies or direct messages", () => {
    expect(ids({ inThread: true })).not.toContain("thread");
    expect(ids({ isReply: true })).not.toContain("pin");
    expect(ids({ canPin: false })).not.toContain("pin");
  });
  it("says unpin for a pinned message", () => {
    expect(ids({ pinned: true })).toContain("unpin");
    expect(ids({ pinned: true })).not.toContain("pin");
  });
  it("drops copy for a message with no text and triage where triage is not offered", () => {
    expect(ids({ hasText: false })).not.toContain("copy");
    expect(ids({ canTriage: false })).not.toContain("triage");
  });
  it("offers nothing on a deleted message", () => {
    expect(ids({ deleted: true, mine: true })).toEqual([]);
  });
});

/** Fake timers the recogniser can be driven with. */
function clock() {
  let now = 0; let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: { set: (fn: () => void, ms: number) => { const id = ++seq; due.set(id, { at: now + ms, fn }); return id; }, clear: (h: unknown) => { due.delete(h as number); } },
    advance(ms: number) { now += ms; for (const [id, t] of [...due]) if (t.at <= now) { due.delete(id); t.fn(); } },
    get pending() { return due.size; },
  };
}

describe("createLongPress", () => {
  it("fires once after a resting press and swallows the click that follows", () => {
    const c = clock(); let fired = 0;
    const lp = createLongPress(() => fired++, { timers: c.timers });
    lp.start(100, 100);
    c.advance(LONG_PRESS_MS - 1);
    expect(fired).toBe(0);
    c.advance(1);
    expect(fired).toBe(1);
    lp.end();
    expect(lp.consumeClick()).toBe(true);
    expect(lp.consumeClick()).toBe(false);
  });
  it("a short tap is not a long press and its click goes through", () => {
    const c = clock(); let fired = 0;
    const lp = createLongPress(() => fired++, { timers: c.timers });
    lp.start(10, 10); c.advance(200); lp.end(); c.advance(1000);
    expect(fired).toBe(0);
    expect(lp.consumeClick()).toBe(false);
    expect(c.pending).toBe(0);
  });
  it("moving past the slop (a scroll) cancels; a small wobble does not", () => {
    const c = clock(); let fired = 0;
    const lp = createLongPress(() => fired++, { timers: c.timers, slop: 10 });
    lp.start(0, 0); lp.move(6, 6); c.advance(LONG_PRESS_MS);
    expect(fired).toBe(1);
    lp.start(0, 0); lp.move(0, 11); c.advance(LONG_PRESS_MS);
    expect(fired).toBe(1);
    expect(lp.pending).toBe(false);
  });
  it("two fingers (a pinch) and a cancel do not fire", () => {
    const c = clock(); let fired = 0;
    const lp = createLongPress(() => fired++, { timers: c.timers });
    lp.start(0, 0, 2); c.advance(LONG_PRESS_MS * 2);
    lp.start(0, 0); lp.cancel(); c.advance(LONG_PRESS_MS * 2);
    expect(fired).toBe(0);
  });
  it("a new press clears an earlier long press's click flag", () => {
    const c = clock();
    const lp = createLongPress(() => {}, { timers: c.timers });
    lp.start(0, 0); c.advance(LONG_PRESS_MS); lp.end();
    lp.start(0, 0); lp.end();
    expect(lp.consumeClick()).toBe(false);
  });
});
