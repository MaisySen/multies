import { describe, it, expect, vi, beforeEach } from "vitest";

// A plain in memory localStorage for the node test run.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const mod = await import("@/web/lib/undo-send");
const { keepaliveExit, KEEPALIVE_MAX_BYTES, rescueAdd, rescueRemove, rescueDecision, recoverHeldSends, HELD_RESCUE_KEY, RESCUE_GRACE_MS, RESCUE_PENDING_MAX_MS } = mod;

/** R111 extra 1: the web side of undo send surviving a closed tab. */
describe("keepalive hand over", () => {
  it("is not ready until the request is built, then posts the same body with keepalive and the same key", () => {
    const box: { body?: unknown } = {};
    const f = vi.fn(async () => new Response("{}"));
    const x = keepaliveExit("/mail/send", "send_abc12345", () => box.body, f as unknown as typeof fetch);
    expect(x.ready()).toBe(false);
    x.fire();
    expect(f).not.toHaveBeenCalled();
    box.body = { to: ["a@b.co"], text: "hi" };
    expect(x.ready()).toBe(true);
    x.fire();
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mail/send");
    expect(init.keepalive).toBe(true);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("send_abc12345");
    expect(init.body).toBe(JSON.stringify(box.body));
  });

  it("refuses a body over the keepalive cap (big attachments), so the page asks before leaving instead", () => {
    const x = keepaliveExit("/mail/send", "send_big12345", () => ({ data: "x".repeat(KEEPALIVE_MAX_BYTES) }), vi.fn() as unknown as typeof fetch);
    expect(x.ready()).toBe(false);
  });
});

describe("rescue copy and the next visit", () => {
  beforeEach(() => store.clear());
  const now = 10_000_000;

  it("decides sent, wait or reopen", () => {
    const r = { key: "k_12345678", dueAt: now - 60_000, label: "to a@b.co", draft: {}, hadFiles: false };
    expect(rescueDecision(r, "sent", now)).toBe("sent");
    expect(rescueDecision(r, "pending", now)).toBe("wait");
    expect(rescueDecision({ ...r, dueAt: now - RESCUE_PENDING_MAX_MS - 1 }, "pending", now)).toBe("reopen");
    expect(rescueDecision(r, "failed", now)).toBe("reopen");
    expect(rescueDecision(r, "unknown", now)).toBe("reopen");
  });

  it("stores no files, and a sent hold removes its copy", () => {
    rescueAdd({ key: "k_files001", dueAt: now, label: "", draft: { to: "a@b.co", files: [{ name: "big.pdf" }] }, hadFiles: true });
    const saved = JSON.parse(store.get(HELD_RESCUE_KEY)!);
    expect(saved[0].draft.files).toEqual([]);
    expect(saved[0].hadFiles).toBe(true);
    rescueRemove("k_files001");
    expect(store.has(HELD_RESCUE_KEY)).toBe(false);
  });

  it("confirms a handed over send, reopens one that never arrived, waits on one in flight, and never sends", async () => {
    const old = now - RESCUE_GRACE_MS - 1000;
    rescueAdd({ key: "k_sent0001", dueAt: old, label: "to a@b.co", draft: { to: "a@b.co" }, hadFiles: false });
    rescueAdd({ key: "k_lost0001", dueAt: old, label: "to c@d.co", draft: { to: "c@d.co" }, hadFiles: false });
    rescueAdd({ key: "k_flig0001", dueAt: old, label: "to e@f.co", draft: { to: "e@f.co" }, hadFiles: false });
    rescueAdd({ key: "k_live0001", dueAt: now, label: "to g@h.co", draft: { to: "g@h.co" }, hadFiles: false }); // another tab, still holding
    const answers: Record<string, "sent" | "unknown" | "pending"> = { k_sent0001: "sent", k_lost0001: "unknown", k_flig0001: "pending" };
    const status = vi.fn(async (k: string) => answers[k] ?? "unknown");
    const reopen = vi.fn();
    const notify = vi.fn();
    await recoverHeldSends({ now, status, reopen, notify });
    expect(status).toHaveBeenCalledTimes(3); // the live one is not asked about
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledWith({ to: "c@d.co", files: [] });
    expect(notify.mock.calls.map((x) => [x[0], x[1].key])).toEqual([["sent", "k_sent0001"], ["reopen", "k_lost0001"]]);
    const left = JSON.parse(store.get(HELD_RESCUE_KEY)!).map((r: { key: string }) => r.key).sort();
    expect(left).toEqual(["k_flig0001", "k_live0001"]);
    // A second visit with the same answers does not reopen it again.
    await recoverHeldSends({ now, status, reopen, notify });
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it("offline on the next visit keeps the copy for later", async () => {
    rescueAdd({ key: "k_offl0001", dueAt: now - RESCUE_GRACE_MS - 1, label: "", draft: {}, hadFiles: false });
    const reopen = vi.fn();
    await recoverHeldSends({ now, status: async () => { throw new Error("offline"); }, reopen, notify: vi.fn() });
    expect(reopen).not.toHaveBeenCalled();
    expect(store.has(HELD_RESCUE_KEY)).toBe(true);
  });
});
