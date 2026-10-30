/**
 * Live mail (round 19): the live window, the daily budget, passes that write nothing when nothing
 * is new, the heartbeat route and the app's beat logic. The live test against a real IMAP server
 * (with the measured delay) is tests/live-mail.live.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer, rawMail } from "./fake-mail-servers";
import { mailConnections, messages, users } from "@/server/db/schema";
import { syncConnection } from "@/server/services/connect/sync";
import { LiveBudget, LiveMail, localLiveMail, CHECK_EVERY_MS } from "@/server/services/connect/live";
import { liveBeat } from "@/web/lib/live-mail";

const GMAIL = "ada.lovelace@gmail.com";
const PW = "abcd efgh ijkl mnop";

async function setup(env: Record<string, string> = {}) {
  const ctx = await makeTestApp({ MAIL_SYNC_BATCH: "5", ...env });
  const imap = new FakeImapServer().addAccount(GMAIL, PW, { sentPath: "[Gmail]/Sent Mail" });
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(GMAIL, PW);
  ctx.deps.imap = imap.connector;
  ctx.deps.imapWatcher = imap.watcher;
  ctx.deps.openSocket = smtp.opener;
  const c = new Client(ctx.app);
  const email = await c.signup(undefined, "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  const made = await c.post("/api/connections", { email: GMAIL, password: PW });
  expect(made.status).toBe(201);
  const conn = (await ctx.db.select().from(mailConnections).get())!;
  return { ctx, imap, c, conn };
}

let n = 0;
const mail = (subject: string) => rawMail({ to: GMAIL, subject, id: `<live-${++n}-${Date.now()}@navy.mil>` });

const count = async (ctx: Awaited<ReturnType<typeof makeTestApp>>, mailboxId: string) => (await ctx.db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length;

describe("live mail budget", () => {
  it("grants leases until the day's minutes are used, then refuses until the next day", async () => {
    let t = Date.parse("2026-10-25T10:00:00Z");
    const saved: { day: string; used: number }[] = [];
    const b = new LiveBudget(10, () => t, { get: async () => undefined, put: async (v) => { saved.push({ ...v }); } });
    expect(await b.lease(300)).toBe(true);
    expect(await b.lease(300)).toBe(true);
    expect(await b.lease(1)).toBe(false);
    expect(b.usage()).toMatchObject({ usedSeconds: 600, allowanceSeconds: 600 });
    expect(saved.at(-1)).toEqual({ day: "2026-10-25", used: 600 });
    t += 86_400_000;
    expect(await b.lease(300)).toBe(true);
    expect(b.usage().usedSeconds).toBe(300);
  });

  it("picks up what an earlier instance used today", async () => {
    const t = Date.parse("2026-10-25T10:00:00Z");
    const b = new LiveBudget(10, () => t, { get: async () => ({ day: "2026-10-25", used: 590 }), put: async () => {} });
    expect(await b.lease(60)).toBe(false);
    expect(await b.lease(10)).toBe(true);
  });
});

describe("a pass that only looks for new mail", () => {
  it("writes nothing when nothing is new, and copies mail when there is", async () => {
    const { ctx, imap, conn } = await setup();
    const before = (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, conn.id)).get())!;
    const spy = vi.spyOn(ctx.db, "update");
    const r = await syncConnection(ctx.deps, conn.id, { onlyIfNew: true });
    expect(r.skipped).toBe("unchanged");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const after = (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, conn.id)).get())!;
    expect(after.lastSyncAt?.getTime()).toBe(before.lastSyncAt?.getTime());
    imap.deliver(GMAIL, mail("Fresh one"));
    const r2 = await syncConnection(ctx.deps, conn.id, { onlyIfNew: true });
    expect(r2.stored).toBe(1);
    expect(await count(ctx, conn.mailboxId)).toBe(1);
  });

  it("still runs when a change made in Multies waits for the provider", async () => {
    const { ctx, imap, c, conn } = await setup();
    imap.deliver(GMAIL, mail("Read me"));
    await syncConnection(ctx.deps, conn.id);
    const msg = (await ctx.db.select().from(messages).where(eq(messages.mailboxId, conn.mailboxId)).get())!;
    await c.post("/api/mail/messages/bulk", { ids: [msg.id], action: "read" });
    const r = await syncConnection(ctx.deps, conn.id, { onlyIfNew: true });
    expect(r.skipped).toBeUndefined();
    expect(r.pushed).toBe(1);
    expect(imap.actions.some((a) => a.startsWith("+\\Seen"))).toBe(true);
  });
});

describe("live window", () => {
  it("holds a push watch, copies new mail the moment it lands, and ends with the window", async () => {
    const { ctx, imap, conn } = await setup();
    let t = Date.now();
    const live = new LiveMail(async () => ctx.deps, { lease: async () => true, now: () => t, tickMs: 5 });
    const touch = await live.touch(conn.id);
    expect(touch.mode).toBe("push");
    expect(imap.watches).toHaveLength(1);
    await live.settle();
    imap.deliver(GMAIL, mail("Instant"));
    await live.settle();
    expect(await count(ctx, conn.mailboxId)).toBe(1);
    expect(live.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["start", "new", "stored"]));
    // A second heartbeat extends the same watch, it doesn't open another.
    await live.touch(conn.id);
    expect(imap.watches).toHaveLength(1);
    t += 200_000;
    await new Promise((r) => setTimeout(r, 30));
    expect(imap.watches).toHaveLength(0);
    expect(live.mode(conn.id)).toBe("off");
  });

  it("asks servers without IDLE every few seconds (poll mode)", async () => {
    const { ctx, imap, conn } = await setup();
    imap.idle = false;
    const live = new LiveMail(async () => ctx.deps, { lease: async () => true });
    expect((await live.touch(conn.id)).mode).toBe("poll");
    await live.stopAll();
  });

  it("falls back to at most one check a minute when the day's live budget is used", async () => {
    const { ctx, imap, conn } = await setup();
    let t = Date.now();
    const sync = vi.fn(async () => ({ stored: 0, duplicates: 0, flagsUpdated: 0, pushed: 0, more: false, skipped: "unchanged" as const }));
    const live = new LiveMail(async () => ctx.deps, { lease: async () => false, now: () => t, sync });
    expect((await live.touch(conn.id)).mode).toBe("check");
    await live.settle();
    await live.touch(conn.id);
    await live.settle();
    expect(sync).toHaveBeenCalledTimes(1);
    t += CHECK_EVERY_MS;
    await live.touch(conn.id);
    await live.settle();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(imap.watches).toHaveLength(0);
  });

  it("stops the watch when a lease renewal is refused", async () => {
    const { ctx, imap, conn } = await setup();
    let t = Date.now();
    let grant = true;
    const live = new LiveMail(async () => ctx.deps, { lease: async () => grant, now: () => t, tickMs: 5 });
    await live.touch(conn.id, 120);
    grant = false;
    t += 295_000;
    await live.touch(conn.id, 120);
    await new Promise((r) => setTimeout(r, 30));
    expect(imap.watches).toHaveLength(0);
    expect(live.events.at(-1)).toMatchObject({ kind: "stop", detail: "live budget used up" });
  });

  it("checks instead of watching when the password stopped working", async () => {
    const { ctx, imap, conn } = await setup();
    imap.accounts.get(GMAIL)!.password = "changed";
    const live = new LiveMail(async () => ctx.deps, { lease: async () => true });
    const r = await live.touch(conn.id);
    expect(r.mode).toBe("check");
    await live.settle();
    expect(imap.watches).toHaveLength(0);
  });

  it("runs one more pass when mail lands during a pass, never two at once", async () => {
    const { ctx, imap, conn } = await setup();
    let running = 0, most = 0, calls = 0;
    const sync = async () => { running++; most = Math.max(most, running); calls++; await new Promise((r) => setTimeout(r, 20)); running--; return { stored: 0, duplicates: 0, flagsUpdated: 0, pushed: 0, more: false }; };
    const live = new LiveMail(async () => ctx.deps, { lease: async () => true, sync });
    await live.touch(conn.id);
    imap.deliver(GMAIL, mail("a"));
    imap.deliver(GMAIL, mail("b"));
    imap.deliver(GMAIL, mail("c"));
    await live.settle();
    expect(most).toBe(1);
    expect(calls).toBeLessThanOrEqual(3);
    await live.stopAll();
  });
});

describe("POST /api/connections/live", () => {
  it("answers each connection's synced count; a poke opens its live window", async () => {
    const { ctx, imap, c, conn } = await setup();
    const quiet = await c.post("/api/connections/live", {});
    expect(quiet.status).toBe(200);
    expect(quiet.body.connections).toEqual([expect.objectContaining({ id: conn.id, mode: null })]);
    const poked = await c.post("/api/connections/live", { poke: true });
    expect(poked.body.connections[0].mode).toBe("push");
    const stamp = poked.body.stamp;
    imap.deliver(GMAIL, mail("Landed while open"));
    await localLiveMail(ctx.deps).settle();
    const after = await c.post("/api/connections/live", {});
    expect(after.body.stamp).toBe(stamp + 1);
    await localLiveMail(ctx.deps).stopAll();
  });

  it("a waiting heartbeat answers the moment new mail is stored (long poll), or after the wait", async () => {
    const { ctx, imap, c } = await setup();
    const first = await c.post("/api/connections/live", { poke: true });
    const t0 = Date.now();
    const waiting = c.post("/api/connections/live", { wait: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    imap.deliver(GMAIL, mail("Long poll"));
    const answered = await waiting;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(answered.body.stamp).toBe(first.body.stamp + 1);
    // Mail that came in between two heartbeats: the count the app last saw is older, so no wait.
    const t2 = Date.now();
    const behind = await c.post("/api/connections/live", { wait: 5000, since: first.body.stamp });
    expect(Date.now() - t2).toBeLessThan(1000);
    expect(behind.body.stamp).toBe(answered.body.stamp);
    const t1 = Date.now();
    const quiet = await c.post("/api/connections/live", { wait: 300, since: answered.body.stamp });
    expect(Date.now() - t1).toBeGreaterThanOrEqual(250);
    expect(quiet.body.stamp).toBe(answered.body.stamp);
    await localLiveMail(ctx.deps).stopAll();
  });

  it("uses the host's dispatcher (the Durable Object on Workers) when there is one", async () => {
    const { ctx, c, conn } = await setup();
    const seen: string[] = [];
    ctx.deps.liveMail = async (id) => { seen.push(id); return { mode: "push", until: 0 }; };
    const r = await c.post("/api/connections/live", { poke: true });
    expect(seen).toEqual([conn.id]);
    expect(r.body.connections[0].mode).toBe("push");
  });

  it("does nothing live when MAIL_LIVE is off, and needs a signed in person", async () => {
    const { c, imap } = await setup({ MAIL_LIVE: "off" });
    const r = await c.post("/api/connections/live", { poke: true });
    expect(r.body.live).toBe(false);
    expect(r.body.connections[0].mode).toBeNull();
    expect(imap.watches).toHaveLength(0);
    const stranger = new Client((await makeTestApp()).app);
    expect((await stranger.post("/api/connections/live", {})).status).toBe(401);
  });

  it("the overview marks connected mailboxes", async () => {
    const { c, conn } = await setup();
    const o = await c.get("/api/mail/overview");
    expect(o.body.mailboxes.find((m: { id: string }) => m.id === conn.mailboxId).connected).toBe(true);
  });
});

describe("the app's beat", () => {
  it("pokes on the first beat and once a minute, and refreshes when synced mail changes", async () => {
    let t = 0;
    let stamp = 3;
    const bodies: boolean[] = [];
    const onChange = vi.fn();
    const b = liveBeat({ now: () => t, onChange, post: async (body) => { bodies.push(body.poke); return { live: true, stamp, connections: [{ id: "c", lastSyncAt: null, messagesSynced: stamp, mode: null }] }; } });
    await b.beat(); t += 10_000; await b.beat(); t += 10_000; await b.beat();
    expect(bodies).toEqual([true, false, false]);
    expect(onChange).not.toHaveBeenCalled();
    stamp = 4; t += 41_000;
    await b.beat();
    expect(bodies.at(-1)).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("asks the server to hold the beat when waitMs is set", async () => {
    const bodies: { poke: boolean; wait?: number }[] = [];
    const b = liveBeat({ waitMs: 25_000, onChange: () => {}, post: async (body) => { bodies.push(body); return { live: true, stamp: 1, connections: [{ id: "c", lastSyncAt: null, messagesSynced: 1, mode: null }] }; } });
    await b.beat();
    await b.beat();
    // The first beat takes the baseline without waiting, so a change during it isn't missed.
    expect(bodies[0]).toEqual({ poke: true });
    expect(bodies[1]).toEqual({ poke: false, wait: 25_000, since: 1 });
  });

  it("stops beating when there is nothing connected", async () => {
    const post = vi.fn(async () => ({ live: true, stamp: 0, connections: [] }));
    const b = liveBeat({ post, onChange: () => {} });
    expect(await b.beat()).toBe(false);
    expect(await b.beat()).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
