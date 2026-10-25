import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { mailConnections, mailSchedules, messages, users } from "@/server/db/schema";
import { localToInstant, presetInstant, runMailSchedules, cancelOnReply } from "@/server/services/mail/schedules";
import { resetWriteBudgetCache } from "@/server/services/write-budget";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
const DAY = 86_400_000;

/** Counts D1 style row writes (1 per row plus 1 per index), like tests/write-cost.test.ts. */
function meter(db: unknown) {
  const c = (db as { $client: { prepare: (q: string) => Record<string, (...a: unknown[]) => unknown> } }).$client;
  const idx = new Map<string, number>();
  for (const r of c.prepare("select tbl_name t, count(*) n from sqlite_master where type='index' group by tbl_name").all() as { t: string; n: number }[]) idx.set(r.t, r.n);
  const prepare = c.prepare.bind(c);
  const changes = () => (prepare("select total_changes() n").get() as { n: number }).n;
  const byTable: Record<string, number> = {};
  c.prepare = (q: string) => {
    const st = prepare(q);
    const table = /^\s*(?:insert(?: or \w+)? into|update|delete from)\s+["`]?(\w+)/i.exec(q)?.[1];
    if (!table) return st;
    for (const fn of ["run", "all", "get"]) {
      const orig = st[fn].bind(st);
      st[fn] = (...a: unknown[]) => { const before = changes(); const r = orig(...a); byTable[table] = (byTable[table] ?? 0) + (changes() - before) * (1 + (idx.get(table) ?? 0)); return r; };
    }
    return st;
  };
  return (table?: string) => { const n = table ? byTable[table] ?? 0 : Object.values(byTable).reduce((a, b) => a + b, 0); for (const k of Object.keys(byTable)) delete byTable[k]; return n; };
}

async function verifiedDomain(ctx: Ctx, c: Client, name = "acme.io") {
  const domainId = (await c.post("/api/domains", { name })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
  return domainId;
}

let ctx: Ctx;
let c: Client;
let hello: { id: string; address: string };
let sales: { id: string; address: string };

async function inboxIds(mailboxId: string) {
  return (await c.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox`)).body.messages.map((m: { id: string }) => m.id) as string[];
}
/** Sales writes to hello: an inbound message in hello's inbox. */
async function mailToHello(subject = "Quote request") {
  const r = await c.post("/api/mail/send", { mailboxId: sales.id, to: [hello.address], subject, text: "Can you send a quote?" });
  expect(r.status).toBe(201);
  return (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, hello.id), eq(messages.subject, subject))).get())!;
}

beforeEach(async () => {
  resetWriteBudgetCache();
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  const domainId = await verifiedDomain(ctx, c);
  hello = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Acme Hello" })).body.mailbox;
  sales = (await c.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Acme Sales" })).body.mailbox;
});

describe("snooze times in the person's own zone", () => {
  it("tomorrow and next week land at 8:00 local across daylight saving (Sydney starts, New York ends)", () => {
    // Sydney: clocks go forward at 2:00 on Sunday 4 October 2026 (AEST +10 to AEDT +11).
    const satSydney = new Date("2026-10-03T00:00:00Z"); // Sat 10:00 AEST
    expect(presetInstant("tomorrow", satSydney, "Australia/Sydney").toISOString()).toBe("2026-10-03T21:00:00.000Z"); // Sun 8:00 AEDT
    expect(presetInstant("next_week", satSydney, "Australia/Sydney").toISOString()).toBe("2026-10-04T21:00:00.000Z"); // Mon 8:00 AEDT
    // New York: clocks go back at 2:00 on Sunday 1 November 2026 (EDT -4 to EST -5).
    const satNy = new Date("2026-10-31T14:00:00Z"); // Sat 10:00 EDT
    expect(presetInstant("tomorrow", satNy, "America/New_York").toISOString()).toBe("2026-11-01T13:00:00.000Z"); // Sun 8:00 EST
    expect(presetInstant("next_week", new Date("2026-10-30T14:00:00Z"), "America/New_York").toISOString()).toBe("2026-11-02T13:00:00.000Z"); // Fri to Mon 8:00 EST
    // On a Monday, next week is the Monday after.
    expect(presetInstant("next_week", new Date("2026-11-02T15:00:00Z"), "America/New_York").toISOString()).toBe("2026-11-09T13:00:00.000Z");
  });

  it("later today is three hours on, on the next whole hour, even across the skipped hour", () => {
    // Sunday 4 October 2026, 1:30 AEST in Sydney; 2:00 to 3:00 doesn't exist that night.
    const at = presetInstant("later_today", new Date("2026-10-03T15:30:00Z"), "Australia/Sydney");
    expect(at.toISOString()).toBe("2026-10-03T19:00:00.000Z"); // 6:00 AEDT, three and a half hours of real time later
  });

  it("reads a picked date and time as wall clock time in the zone", () => {
    expect(localToInstant("2026-10-04T09:00", "Australia/Sydney").toISOString()).toBe("2026-10-03T22:00:00.000Z");
    expect(localToInstant("2026-10-03T09:00", "Australia/Sydney").toISOString()).toBe("2026-10-02T23:00:00.000Z");
    expect(localToInstant("2026-11-01T09:00", "America/New_York").toISOString()).toBe("2026-11-01T14:00:00.000Z");
    expect(localToInstant("2026-10-31T09:00", "America/New_York").toISOString()).toBe("2026-10-31T13:00:00.000Z");
  });

  it("uses the person's saved zone for a picked time", async () => {
    await ctx.db.update(users).set({ timezone: "America/New_York" }).where(eq(users.email, "owner@acme.io"));
    const m = await mailToHello();
    const r = await c.post("/api/mail-schedules/snooze", { messageId: m.id, local: "2027-01-15T09:00" });
    expect(r.status).toBe(201);
    expect(r.body.dueAt).toBe("2027-01-15T14:00:00.000Z");
  });
});

describe("snooze a thread", () => {
  it("hides it from Inbox, lists it in Snoozed, and brings it back to the top exactly once when due", async () => {
    const m = await mailToHello();
    await mailToHello("Another one");
    expect(await inboxIds(hello.id)).toContain(m.id);
    const take = meter(ctx.db);
    const s = await c.post("/api/mail-schedules/snooze", { messageId: m.id, preset: "tomorrow" });
    expect(s.status).toBe(201);
    expect(take("mail_schedules")).toBe(2); // the row and its one index
    expect(await inboxIds(hello.id)).not.toContain(m.id);
    const snoozed = (await c.get(`/api/mail-schedules?view=snoozed&mailboxId=${hello.id}`)).body.items;
    expect(snoozed).toHaveLength(1);
    expect(snoozed[0]).toMatchObject({ kind: "snooze", threadId: m.threadId, message: { subject: "Quote request" } });

    // A pass before it is due reads and writes nothing.
    take();
    expect((await runMailSchedules(ctx.deps)).due).toBe(0);
    expect(take()).toBe(0);

    // Due: two passes at once, it comes back once.
    const due = new Date(new Date(s.body.dueAt).getTime() + 1000);
    const [a, b] = await Promise.all([runMailSchedules(ctx.deps, { now: due }), runMailSchedules(ctx.deps, { now: due })]);
    expect(a.returned + b.returned).toBe(1);
    expect(take("mail_schedules")).toBe(2);
    expect(await inboxIds(hello.id)).toContain(m.id);
    const returned = (await c.get(`/api/mail-schedules?view=returned&mailboxId=${hello.id}`)).body.items;
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ kind: "snooze", status: "returned", messageId: m.id });
    expect((await runMailSchedules(ctx.deps, { now: due })).returned).toBe(0);

    // Opening it clears the marker (2 rows); opening again writes nothing.
    take();
    expect((await c.post("/api/mail-schedules/opened", { messageId: m.id })).body.cleared).toBe(1);
    expect(take("mail_schedules")).toBe(2);
    expect((await c.post("/api/mail-schedules/opened", { messageId: m.id })).body.cleared).toBe(0);
    expect(take("mail_schedules")).toBe(0);
  });

  it("shows again in Inbox once its time passes, even before the cron pass runs", async () => {
    const m = await mailToHello();
    const s = await c.post("/api/mail-schedules/snooze", { messageId: m.id, preset: "later_today" });
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(new Date(s.body.dueAt).getTime() + 1000);
    try { expect(await inboxIds(hello.id)).toContain(m.id); } finally { ctx.deps.now = real; }
  });

  it("unsnoozes early, and a new snooze replaces the old one", async () => {
    const m = await mailToHello();
    await c.post("/api/mail-schedules/snooze", { messageId: m.id, preset: "tomorrow" });
    const s2 = await c.post("/api/mail-schedules/snooze", { messageId: m.id, preset: "next_week" });
    expect(await ctx.db.select().from(mailSchedules).all()).toHaveLength(1);
    expect((await c.del(`/api/mail-schedules/${s2.body.id}`)).status).toBe(200);
    expect(await inboxIds(hello.id)).toContain(m.id);
  });

  it("a new reply in the thread wakes it", async () => {
    const m = await mailToHello();
    await c.post("/api/mail-schedules/snooze", { messageId: m.id, preset: "next_week" });
    // Hello answers; sales replies in the same thread.
    await c.post("/api/mail/send", { mailboxId: hello.id, to: [sales.address], subject: "Re: Quote request", text: "Sure", inReplyToId: m.id });
    expect(await inboxIds(hello.id)).not.toContain(m.id);
    const theirs = (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, sales.id), eq(messages.folder, "inbox"))).get())!;
    await c.post("/api/mail/send", { mailboxId: sales.id, to: [hello.address], subject: "Re: Quote request", text: "Thanks", inReplyToId: theirs.id });
    expect(await inboxIds(hello.id)).toContain(m.id);
    expect(await ctx.db.select().from(mailSchedules).all()).toHaveLength(0);
  });

  it("refuses past times and other people's mail", async () => {
    const m = await mailToHello();
    expect((await c.post("/api/mail-schedules/snooze", { messageId: m.id, at: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve", "Evil");
    expect((await other.post("/api/mail-schedules/snooze", { messageId: m.id, preset: "tomorrow" })).status).toBe(404);
    expect((await other.get("/api/mail-schedules?view=snoozed")).body.items).toHaveLength(0);
  });
});

describe("send later", () => {
  const later = () => ({ at: new Date(Date.now() + 2 * 3_600_000).toISOString() });

  it("holds the message in Scheduled, then sends it once through the normal send path", async () => {
    const take = meter(ctx.db);
    const r = await c.post("/api/mail-schedules/send", { message: { mailboxId: hello.id, to: ["bob@example.com"], subject: "Later", text: "Sent later" }, ...later() });
    expect(r.status).toBe(201);
    expect(take("mail_schedules")).toBe(2);
    expect(ctx.outbound.sent.find((m) => m.subject === "Later")).toBeUndefined();
    const items = (await c.get("/api/mail-schedules?view=scheduled")).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "send", status: "pending", send: { to: ["bob@example.com"], subject: "Later" } });

    const due = new Date(new Date(r.body.dueAt).getTime() + 1000);
    const [a, b] = await Promise.all([runMailSchedules(ctx.deps, { now: due }), runMailSchedules(ctx.deps, { now: due })]);
    expect(a.sent + b.sent).toBe(1);
    expect(ctx.outbound.sent.filter((m) => m.subject === "Later")).toHaveLength(1);
    expect(ctx.outbound.sent.find((m) => m.subject === "Later")!.from.address).toBe("hello@acme.io");
    const sent = (await c.get(`/api/mail/messages?mailboxId=${hello.id}&folder=sent`)).body.messages;
    expect(sent.map((m: { subject: string }) => m.subject)).toContain("Later");
    expect((await c.get("/api/mail-schedules?view=scheduled")).body.items).toHaveLength(0);
    expect((await runMailSchedules(ctx.deps, { now: due })).sent).toBe(0);
  });

  it("cancels before it goes, and changes its time", async () => {
    const r = await c.post("/api/mail-schedules/send", { message: { mailboxId: hello.id, to: ["bob@example.com"], subject: "Never", text: "x" }, ...later() });
    const moved = await c.patch(`/api/mail-schedules/${r.body.id}`, { at: new Date(Date.now() + 5 * 3_600_000).toISOString() });
    expect(moved.status).toBe(200);
    const take = meter(ctx.db);
    expect((await c.del(`/api/mail-schedules/${r.body.id}`)).status).toBe(200);
    expect(take("mail_schedules")).toBe(2);
    expect((await runMailSchedules(ctx.deps, { now: new Date(Date.now() + 2 * DAY) })).sent).toBe(0);
    expect(ctx.outbound.sent.find((m) => m.subject === "Never")).toBeUndefined();
    expect((await c.del(`/api/mail-schedules/${r.body.id}`)).status).toBe(404);
  });

  it("takes a scheduled draft out of Drafts", async () => {
    const draft = (await c.post("/api/mail/drafts", { mailboxId: hello.id, to: ["bob@example.com"], subject: "Draft", text: "x" })).body.id;
    await c.post("/api/mail-schedules/send", { message: { mailboxId: hello.id, to: ["bob@example.com"], subject: "Draft", text: "x", draftId: draft }, ...later() });
    expect(await ctx.db.select().from(messages).where(eq(messages.id, draft)).get()).toBeUndefined();
  });

  it("keeps a send that can't go in Scheduled with the reason", async () => {
    const r = await c.post("/api/mail-schedules/send", { message: { mailboxId: hello.id, to: ["bob@example.com"], subject: "Suspended", text: "x" }, ...later() });
    const { mailboxes } = await import("@/server/db/schema");
    await ctx.db.update(mailboxes).set({ status: "suspended" }).where(eq(mailboxes.id, hello.id));
    const res = await runMailSchedules(ctx.deps, { now: new Date(new Date(r.body.dueAt).getTime() + 1000) });
    expect(res.failed).toBe(1);
    const items = (await c.get("/api/mail-schedules?view=scheduled")).body.items;
    expect(items[0]).toMatchObject({ status: "failed", error: "This mailbox is suspended." });
  });

  it("schedules with a reminder, which is added when it goes", async () => {
    const r = await c.post("/api/mail-schedules/send", { message: { mailboxId: hello.id, to: [sales.address], subject: "Ping", text: "x" }, remindDays: 3, ...later() });
    const due = new Date(new Date(r.body.dueAt).getTime() + 1000);
    expect((await runMailSchedules(ctx.deps, { now: due })).sent).toBe(1);
    const items = (await c.get("/api/mail-schedules?view=scheduled")).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "remind", message: { subject: "Ping" } });
  });

  it("members only see their own scheduled sends, and only act in mailboxes they were given", async () => {
    await c.post("/api/org/plan", { plan: "pro" });
    await c.post("/api/mail-schedules/send", { message: { mailboxId: hello.id, to: ["bob@example.com"], subject: "Owner's", text: "x" }, ...later() });
    const m = await mailToHello();
    const inv = await c.post("/api/team/invites", { email: "mia@acme.io", role: "member", mailboxIds: [sales.id] });
    expect(inv.status).toBe(201);
    const mia = new Client(ctx.app);
    await mia.signup("mia@acme.io", "Mia Member");
    expect((await mia.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    expect((await mia.get("/api/account/me")).body.organization).toMatchObject({ role: "member" });
    // Not the owner's send, not hello's threads.
    expect((await mia.get("/api/mail-schedules?view=scheduled")).body.items).toHaveLength(0);
    expect((await mia.post("/api/mail-schedules/send", { message: { mailboxId: hello.id, to: ["x@example.com"], subject: "No", text: "x" }, ...later() })).status).toBe(404);
    expect((await mia.post("/api/mail-schedules/snooze", { messageId: m.id, preset: "tomorrow" })).status).toBe(404);
    const owners = (await ctx.db.select().from(mailSchedules).all())[0];
    expect((await mia.del(`/api/mail-schedules/${owners.id}`)).status).toBe(404);
    // Her own mailbox works, and the owner sees her send too.
    expect((await mia.post("/api/mail-schedules/send", { message: { mailboxId: sales.id, to: ["x@example.com"], subject: "Mine", text: "x" }, ...later() })).status).toBe(201);
    expect((await mia.get("/api/mail-schedules?view=scheduled")).body.items.map((i: { send: { subject: string } }) => i.send.subject)).toEqual(["Mine"]);
    expect((await c.get("/api/mail-schedules?view=scheduled")).body.items).toHaveLength(2);
  });
});

describe("remind me if no reply", () => {
  it("brings the thread back with a mark when nobody answered", async () => {
    const sent = await c.post("/api/mail/send", { mailboxId: hello.id, to: [sales.address], subject: "Following up", text: "Any news?" });
    const take = meter(ctx.db);
    const r = await c.post("/api/mail-schedules/remind", { messageId: sent.body.messageId, days: 2 });
    expect(r.status).toBe(201);
    expect(take("mail_schedules")).toBe(2);
    expect((await runMailSchedules(ctx.deps, { now: new Date(Date.now() + DAY) })).reminded).toBe(0);
    const res = await runMailSchedules(ctx.deps, { now: new Date(Date.now() + 2 * DAY + 60_000) });
    expect(res.reminded).toBe(1);
    expect(take("mail_schedules")).toBe(2);
    const returned = (await c.get(`/api/mail-schedules?view=returned&mailboxId=${hello.id}`)).body.items;
    expect(returned[0]).toMatchObject({ kind: "remind", status: "returned", message: { subject: "Following up" } });
  });

  it("a reply cancels it straight away", async () => {
    const sent = await c.post("/api/mail/send", { mailboxId: hello.id, to: [sales.address], subject: "Lunch?", text: "Free Friday?" });
    await c.post("/api/mail-schedules/remind", { messageId: sent.body.messageId, days: 3 });
    const theirs = (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, sales.id), eq(messages.subject, "Lunch?"))).get())!;
    await c.post("/api/mail/send", { mailboxId: sales.id, to: [hello.address], subject: "Re: Lunch?", text: "Yes", inReplyToId: theirs.id });
    expect(await ctx.db.select().from(mailSchedules).all()).toHaveLength(0);
    expect((await runMailSchedules(ctx.deps, { now: new Date(Date.now() + 4 * DAY) })).reminded).toBe(0);
  });

  it("a reply that arrived without the hook (a connected mailbox sync) still cancels it when due", async () => {
    const sent = await c.post("/api/mail/send", { mailboxId: hello.id, to: ["bob@example.com"], subject: "Contract", text: "Signed?" });
    await c.post("/api/mail-schedules/remind", { messageId: sent.body.messageId, days: 1 });
    const mine = (await ctx.db.select().from(messages).where(eq(messages.id, sent.body.messageId)).get())!;
    await ctx.db.insert(messages).values({ id: "msg_synced", orgId: mine.orgId, mailboxId: hello.id, folder: "inbox", threadId: mine.threadId, fromAddress: "bob@example.com", subject: "Re: Contract", date: new Date(), createdAt: new Date(Date.now() + 1000) });
    const res = await runMailSchedules(ctx.deps, { now: new Date(Date.now() + DAY + 60_000) });
    expect(res).toMatchObject({ replied: 1, reminded: 0 });
    expect(await ctx.db.select().from(mailSchedules).all()).toHaveLength(0);
  });

  it("cancelOnReply writes nothing for a thread without schedules", async () => {
    const take = meter(ctx.db);
    expect(await cancelOnReply(ctx.deps, hello.id, "thr_none")).toBe(0);
    expect(take()).toBe(0);
  });
});

describe("the cron pass and the write budget", () => {
  function analytics(rows: number) {
    return (async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: rows }, dimensions: { databaseId: "prod", date: new Date().toISOString().slice(0, 10) } }] }] } }, errors: null }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  }

  async function seeded(rows: number) {
    resetWriteBudgetCache();
    const x = await makeTestApp({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acc" }, { fetch: analytics(rows) });
    const cl = new Client(x.app);
    await cl.signup("owner@acme.io");
    const domainId = await verifiedDomain(x, cl);
    const mb = (await cl.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox;
    const mb2 = (await cl.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Sales" })).body.mailbox;
    await cl.post("/api/mail/send", { mailboxId: mb2.id, to: [mb.address], subject: "In", text: "x" });
    const msg = (await x.db.select().from(messages).where(and(eq(messages.mailboxId, mb.id), eq(messages.folder, "inbox"))).get())!;
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await cl.post("/api/mail-schedules/snooze", { messageId: msg.id, at });
    await cl.post("/api/mail-schedules/send", { message: { mailboxId: mb.id, to: ["bob@example.com"], subject: "Promised", text: "x" }, at });
    return { x, due: new Date(Date.now() + 2 * 3_600_000) };
  }

  it("at warn, still sends scheduled mail but waits with snoozes", async () => {
    const { x, due } = await seeded(65_000);
    const r = await runMailSchedules(x.deps, { now: due });
    expect(r).toMatchObject({ level: "warn", sent: 1, returned: 0, held: 1 });
    expect(x.outbound.sent.find((m) => m.subject === "Promised")).toBeDefined();
  });

  it("at shed, writes nothing and holds sends for the next pass", async () => {
    const { x, due } = await seeded(85_000);
    const take = meter(x.db);
    const r = await runMailSchedules(x.deps, { now: due });
    expect(r).toMatchObject({ level: "shed", sent: 0, held: 2 });
    expect(take()).toBe(0);
    expect(x.outbound.sent.find((m) => m.subject === "Promised")).toBeUndefined();
  });

  it("takes at most the pass limit and the rest next time", async () => {
    for (let i = 0; i < 4; i++) await c.post("/api/mail-schedules/send", { message: { mailboxId: hello.id, to: ["bob@example.com"], subject: `Batch ${i}`, text: "x" }, at: new Date(Date.now() + 3_600_000).toISOString() });
    const due = new Date(Date.now() + 2 * 3_600_000);
    expect((await runMailSchedules(ctx.deps, { now: due, limit: 3 })).sent).toBe(3);
    expect((await runMailSchedules(ctx.deps, { now: due, limit: 3 })).sent).toBe(1);
  });
});

describe("each mail type sends through its own path", () => {
  it("a connected mailbox sends through its own SMTP and keeps a Sent copy", async () => {
    resetWriteBudgetCache();
    const x = await makeTestApp({ MAIL_SYNC_BATCH: "5", MAIL_SYNC_INITIAL_CAP: "8" });
    const imap = new FakeImapServer().addAccount("me@fastmail.com", "fm-app-pass");
    const smtp = new FakeSmtpServer();
    smtp.accounts.set("me@fastmail.com", "fm-app-pass");
    x.deps.imap = imap.connector;
    x.deps.openSocket = smtp.opener;
    const cl = new Client(x.app);
    const email = await cl.signup(undefined, "Ada Lovelace", "Acme");
    await x.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
    expect((await cl.post("/api/connections", { email: "me@fastmail.com", password: "fm-app-pass" })).status).toBe(201);
    const row = (await x.db.select().from(mailConnections).get())!;
    const before = x.outbound.sent.length;
    const r = await cl.post("/api/mail-schedules/send", { message: { mailboxId: row.mailboxId, to: ["bob@example.com"], subject: "From my own box", text: "Hi" }, at: new Date(Date.now() + 3_600_000).toISOString() });
    expect(r.status).toBe(201);
    expect(smtp.sent).toHaveLength(0);
    expect((await runMailSchedules(x.deps, { now: new Date(Date.now() + 2 * 3_600_000) })).sent).toBe(1);
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({ from: "me@fastmail.com" });
    expect(imap.folder("me@fastmail.com", "Sent").msgs).toHaveLength(1);
    expect(x.outbound.sent).toHaveLength(before);
  });

  it("a free address sends from the free address", async () => {
    resetWriteBudgetCache();
    const x = await makeTestApp({ FREE_MAIL_DOMAIN: "free.test", FREE_MAIL_DAILY_SENDS: "3" });
    const cl = new Client(x.app);
    const email = await cl.signup(undefined, "Ada Lovelace", "Acme");
    await x.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
    const info = (await cl.get("/api/free-address")).body;
    const mb = (await cl.post("/api/free-address", { localPart: info.suggestion })).body.mailbox;
    await cl.post("/api/mail-schedules/send", { message: { mailboxId: mb.id, to: ["grace@navy.mil"], subject: "Free later", text: "Hello" }, at: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await runMailSchedules(x.deps, { now: new Date(Date.now() + 2 * 3_600_000) })).sent).toBe(1);
    expect(x.outbound.sent.find((m) => m.subject === "Free later")!.from.address).toBe("ada.acme@free.test");
  });

  it("an own domain sends from its address (covered above) and an internal recipient gets it in Inbox", async () => {
    await c.post("/api/mail-schedules/send", { message: { mailboxId: hello.id, to: [sales.address], subject: "Inside", text: "Hi" }, at: new Date(Date.now() + 3_600_000).toISOString() });
    await runMailSchedules(ctx.deps, { now: new Date(Date.now() + 2 * 3_600_000) });
    const got = (await c.get(`/api/mail/messages?mailboxId=${sales.id}&folder=inbox`)).body.messages;
    expect(got.map((m: { subject: string }) => m.subject)).toContain("Inside");
  });
});

describe("MCP: snooze_thread and schedule_send", () => {
  async function mcpConnect(key: string) {
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const client = new McpClient({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    return client;
  }
  const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

  it("a read only key can list but not snooze or schedule", async () => {
    const m = await mailToHello();
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const mcp = await mcpConnect(ro);
    const r = await mcp.callTool({ name: "snooze_thread", arguments: { threadId: m.threadId, preset: "tomorrow" } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toContain("read_only_key");
    const s = await mcp.callTool({ name: "schedule_send", arguments: { to: ["a@example.com"], subject: "x", text: "x", preset: "tomorrow" } });
    expect(s.isError).toBe(true);
    expect(data(await mcp.callTool({ name: "list_scheduled", arguments: { view: "snoozed" } })).items).toHaveLength(0);
    await mcp.close();
  });

  it("a workspace key snoozes a thread; an agent's scheduled send keeps its approval rule when it goes", async () => {
    const m = await mailToHello();
    const ws = (await c.post("/api/developer/keys", { name: "ws" })).body.secret;
    const mcp = await mcpConnect(ws);
    const snoozed = data(await mcp.callTool({ name: "snooze_thread", arguments: { threadId: m.threadId, preset: "tomorrow" } }));
    expect(snoozed.threadId).toBe(m.threadId);
    expect(await inboxIds(hello.id)).not.toContain(m.id);
    await mcp.close();

    const { agent, apiKey } = (await c.post("/api/agents", { name: "Outreach", localPart: "outreach", approvalMode: "always" })).body;
    const am = await mcpConnect(apiKey.secret);
    const sched = data(await am.callTool({ name: "schedule_send", arguments: { to: ["lead@example.com"], subject: "Intro", text: "Hello", at: new Date(Date.now() + 3_600_000).toISOString() } }));
    expect(sched.id).toMatch(/^msch_/);
    const listed = data(await am.callTool({ name: "list_scheduled", arguments: { view: "scheduled" } })).items;
    expect(listed).toHaveLength(1);
    expect(listed[0].send).toMatchObject({ subject: "Intro", agentId: agent.id });
    expect((await runMailSchedules(ctx.deps, { now: new Date(Date.now() + 2 * 3_600_000) })).sent).toBe(1);
    // Approval mode "always": it waits for a person rather than going out.
    expect(ctx.outbound.sent.find((x) => x.subject === "Intro")).toBeUndefined();
    const approvals = (await c.get("/api/approvals")).body;
    expect(JSON.stringify(approvals)).toContain("Intro");

    // Cancel through MCP.
    const again = data(await am.callTool({ name: "schedule_send", arguments: { to: ["lead@example.com"], subject: "Second", text: "x", preset: "tomorrow" } }));
    expect(data(await am.callTool({ name: "cancel_scheduled", arguments: { id: again.id } })).ok).toBe(true);
    await am.close();
  });
});
