import { createSendHold, getUndoSeconds, parseUndoSeconds, recipientsLabel, setUndoSeconds, UNDO_SEND_CHOICES, UNDO_SEND_DEFAULT, type Clock } from "@/lib/undo-send";
import { secureStorage } from "@/lib/storage";

jest.mock("@/lib/storage", () => {
  const m = new Map<string, string>();
  return { secureStorage: { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => { m.set(k, v); }, remove: async (k: string) => { m.delete(k); } } };
});

function fakeClock() {
  let now = 0;
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
  return { clock, advance };
}

describe("undo send on the phone", () => {
  it("offers 5, 10, 20 and 30 seconds and defaults to 10", () => {
    expect(UNDO_SEND_CHOICES).toEqual([5, 10, 20, 30]);
    expect(UNDO_SEND_DEFAULT).toBe(10);
    expect(parseUndoSeconds("20")).toBe(20);
    expect(parseUndoSeconds("15")).toBe(10);
    expect(parseUndoSeconds(null)).toBe(10);
  });

  it("posts once when the hold ends and never when undone", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    const a = jest.fn(async () => "a");
    const b = jest.fn(async () => "b");
    q.hold({ seconds: 10, send: a });
    const hb = q.hold({ seconds: 10, send: b });
    expect(hb.undo()).toBe(true);
    await advance(10_000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(await hb.done).toBe("undone");
  });

  it("send now posts at once and only once", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    const s = jest.fn(async () => 1);
    const h = q.hold({ seconds: 30, send: s });
    await h.sendNow();
    await advance(30_000);
    expect(s).toHaveBeenCalledTimes(1);
    expect(h.undo()).toBe(false);
  });

  it("a failed post settles as failed and calls onError", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    const onError = jest.fn();
    const h = q.hold({ seconds: 5, send: async () => { throw new Error("offline"); }, onError });
    await advance(5_000);
    expect(await h.done).toBe("failed");
    expect(onError).toHaveBeenCalled();
  });

  it("saves the choice on the phone", async () => {
    await setUndoSeconds(30);
    expect(getUndoSeconds()).toBe(30);
    expect(await secureStorage.get("multies-undo-send-seconds")).toBe("30");
  });

  it("labels recipients for the bar", () => {
    expect(recipientsLabel(["ana@example.com"])).toBe("to ana@example.com");
    expect(recipientsLabel(["a@x.com", "b@x.com"])).toBe("to 2 people");
    expect(recipientsLabel([])).toBe("");
  });
});
