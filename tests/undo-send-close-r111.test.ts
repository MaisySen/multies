import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { mailSchedules, messages } from "@/server/db/schema";
import { resetWriteBudgetCache } from "@/server/services/write-budget";
import { heldState } from "@/server/routes/mail";
import { createSendHold, type Clock } from "../src/shared/undo-send";

/**
 * R111 extra 1 (verifier v8 MEDIUM): a message held by Undo send is never lost when the tab closes during the
 * countdown, never sent twice, and Undo still cancels.
 */

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
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { clock, advance };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("hold core: leaving the page during the hold", () => {
  it("hands the message over once when the page goes, and the timer never posts it again", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    const send = vi.fn(async () => "ok");
    const fire = vi.fn();
    const h = q.hold({ seconds: 10, send, exit: { ready: () => true, fire } });
    await advance(3000);
    expect(q.leave()).toBe(1);
    expect(q.leave()).toBe(0); // a second pagehide does nothing
    expect(fire).toHaveBeenCalledTimes(1);
    expect(h.state()).toBe("sending");
    expect(h.undo()).toBe(false); // gone from the page, can't be taken back
    await advance(20_000);
    expect(send).not.toHaveBeenCalled();
    expect(q.busy()).toBe(true);
  });

  it("if the page comes back (back/forward cache) it confirms under the same request and settles as sent", async () => {
    const { clock } = fakeClock();
    const q = createSendHold(clock);
    const send = vi.fn(async () => "ok");
    const onSent = vi.fn();
    const h = q.hold({ seconds: 10, send, onSent, exit: { ready: () => true, fire: () => {} } });
    q.leave();
    q.resume();
    q.resume(); // twice is still one post
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith("ok");
    expect(await h.done).toBe("sent");
    expect(q.busy()).toBe(false);
  });

  it("Undo still cancels: an undone message is never handed over", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    const send = vi.fn(async () => "ok");
    const fire = vi.fn();
    const h = q.hold({ seconds: 10, send, exit: { ready: () => true, fire } });
    expect(q.undo()).toBe(true);
    expect(q.leave()).toBe(0);
    await advance(20_000);
    expect(fire).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await h.done).toBe("undone");
  });

  it("a message that can't be handed over yet stays held and makes the page ask before leaving", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    let ready = false;
    const send = vi.fn(async () => "ok");
    q.hold({ seconds: 10, send, exit: { ready: () => ready, fire: () => {} } });
    expect(q.atRisk()).toBe(true);
    expect(q.leave()).toBe(0);
    ready = true;
    expect(q.atRisk()).toBe(false);
    await advance(10_000); // the page stayed: the normal send runs
    expect(send).toHaveBeenCalledTimes(1);
    expect(q.atRisk()).toBe(false);
  });

  it("holds with no hand over (other screens) keep the old prompt and are not touched by leave", async () => {
    const { clock } = fakeClock();
    const q = createSendHold(clock);
    const h = q.hold({ seconds: 5, send: async () => 1 });
    expect(q.atRisk()).toBe(true);
    expect(q.leave()).toBe(0);
    expect(h.state()).toBe("holding");
  });

  it("a hand over that throws still leaves the hold settled as handed over, never sent by the timer", async () => {
    const { clock, advance } = fakeClock();
    const q = createSendHold(clock);
    const send = vi.fn(async () => 1);
    q.hold({ seconds: 5, send, exit: { ready: () => true, fire: () => { throw new Error("blocked"); } } });
    expect(q.leave()).toBe(1);
    await advance(10_000);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("held-status answer", () => {
  it("maps the idempotency row to sent, failed, pending or unknown", () => {
    expect(heldState(undefined)).toBe("unknown");
    expect(heldState({ state: "done", status: 201 })).toBe("sent");
    expect(heldState({ state: "done", status: 422 })).toBe("failed");
    expect(heldState({ state: "running", status: null })).toBe("pending");
    expect(heldState({ state: "running", status: 503 })).toBe("failed");
  });
});

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let hello: { id: string; address: string };
let sales: { id: string; address: string };
async function verifiedDomain(name = "acme.io") {
  const domainId = (await c.post("/api/domains", { name })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
  return domainId;
}

describe("server: hand over plus resume sends once", () => {
  beforeEach(async () => {
    resetWriteBudgetCache();
    ctx = await makeTestApp();
    c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const domainId = await verifiedDomain();
    hello = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Acme Hello" })).body.mailbox;
    sales = (await c.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Acme Sales" })).body.mailbox;
  });

  it("the keepalive send and the resumed send with the same key deliver one message, and held-status says sent", async () => {
    const key = { "idempotency-key": "send_r111_closetab_1" };
    expect((await c.get("/api/mail/held-status?key=send_r111_closetab_1")).body.state).toBe("unknown");
    const body = { mailboxId: sales.id, to: [hello.address], subject: "Closed the tab", text: "Held, then the tab closed." };
    const first = await c.call("POST", "/api/mail/send", body, key);
    expect(first.status).toBe(201);
    const again = await c.call("POST", "/api/mail/send", body, key);
    expect(again.status).toBe(201);
    const got = await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, hello.id), eq(messages.subject, "Closed the tab"))).all();
    expect(got).toHaveLength(1);
    expect((await c.get("/api/mail/held-status?key=send_r111_closetab_1")).body.state).toBe("sent");
  });

  it("send later is keyed too: the same key schedules once", async () => {
    const key = { "idempotency-key": "later_r111_closetab_1" };
    const body = { message: { mailboxId: sales.id, to: [hello.address], subject: "Later", text: "Tomorrow" }, preset: "tomorrow" };
    const a = await c.call("POST", "/api/mail-schedules/send", body, key);
    const b = await c.call("POST", "/api/mail-schedules/send", body, key);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await ctx.db.select().from(mailSchedules).where(eq(mailSchedules.kind, "send")).all()).toHaveLength(1);
    expect((await c.get("/api/mail/held-status?key=later_r111_closetab_1")).body.state).toBe("sent");
  });

  it("held-status only reads the caller's own keys and rejects a bad key", async () => {
    const body = { mailboxId: sales.id, to: [hello.address], subject: "Mine", text: "x" };
    await c.call("POST", "/api/mail/send", body, { "idempotency-key": "send_r111_mine_0001" });
    const other = new Client(ctx.app);
    await other.signup("someone@else.io");
    expect((await other.get("/api/mail/held-status?key=send_r111_mine_0001")).body.state).toBe("unknown");
    expect((await c.get("/api/mail/held-status?key=x")).status).toBe(400);
    expect((await new Client(ctx.app).get("/api/mail/held-status?key=send_r111_mine_0001")).status).toBe(401);
  });
});
