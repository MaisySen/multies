import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { messages, users } from "@/server/db/schema";
import { CATEGORIES_DEFAULT_FROM, importantBaseCond, splitCountParts } from "@/server/services/mail/splits";
import { refreshFirstSenderReady } from "@/server/services/mail/first-sender";

/**
 * R59 hotfix (prod D1 reads at 245% of the free daily limit): Inbox tab counts were quadratic because the first time
 * sender check compared lower(from_address) per row in a correlated subquery that no index serves. These tests keep
 * the behaviour (first message of a new authenticated sender is Important, the second is Other) and guard the cost:
 * no correlated subquery may scan the messages table.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let mailboxId: string;
let now = new Date("2026-10-29T03:00:00Z");
let tick = 0;
const raw = (q: string) => (ctx.db as unknown as { $client: { prepare: (q: string) => { all: (...a: unknown[]) => unknown[] } } }).$client.prepare(q);

async function inbound(subject: string, address: string, opts: { headers?: Record<string, string>; auth?: Record<string, string> } = {}) {
  tick += 1;
  await deliverInbound(ctx.deps, {
    envelopeFrom: address, rcptTo: "hello@acme.io", sizeBytes: 300, via: "test",
    email: {
      messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from: { address, name: address.split("@")[0] }, to: [{ address: "hello@acme.io" }], cc: [], subject, text: "Hi",
      date: new Date(now.getTime() + tick * 1000), attachments: [], authResults: (opts.auth ?? { spf: "pass", dkim: "pass", dmarc: "pass" }) as never, headers: opts.headers ?? {},
    },
  });
}
const subjects = async (split: string) =>
  ((await owner.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox&split=${split}&limit=200`)).body.messages as { subject: string }[]).map((m) => m.subject).sort();
const tabs = async () => Object.fromEntries(((await owner.get(`/api/mail/splits?mailboxId=${mailboxId}`)).body.tabs as { name: string; unread: number }[]).map((t) => [t.name, t.unread]));
const counts = async () => (await owner.get("/api/counts")).body.mail as { inbox: number; important: number; other: number };

/** EXPLAIN QUERY PLAN rows of a statement, with each row's ancestors' details. */
function plan(stmt: { sql: string; params: unknown[] }) {
  const rows = raw(`explain query plan ${stmt.sql}`).all(...stmt.params) as { id: number; parent: number; detail: string }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows.map((r) => {
    const up: string[] = [];
    for (let p = byId.get(r.parent); p; p = byId.get(p.parent)) up.push(p.detail);
    return { detail: r.detail, up };
  });
}

beforeEach(async () => {
  ctx = await makeTestApp();
  await refreshFirstSenderReady(ctx.db); // MPLAT-108: a new database has no mail, so 0171 marks the fill done
  now = new Date("2026-10-29T03:00:00Z");
  ctx.deps.now = () => now;
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  // R85T: an account made before R85 keeps Important and Other until its person picks a style (signup stamps the wall
  // clock, so pin it; accounts made after 2026-10-31 10:00 UTC open on Primary, Updates and Promotions, tested below).
  await ctx.db.update(users).set({ createdAt: new Date(CATEGORIES_DEFAULT_FROM - 86_400_000) }).where(eq(users.email, "owner@acme.io"));
  await owner.post("/api/org/plan", { plan: "pro" });
  const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await owner.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await owner.post(`/api/domains/${domainId}/verify`);
  mailboxId = (await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox.id;
});

describe("Inbox tab counts stay cheap (R59 hotfix)", () => {
  it("no correlated subquery scans messages, and first time is a stored flag (MPLAT-108)", () => {
    const stmt = ctx.deps.db.select({ n: sql<number>`count(*)` }).from(messages)
      .where(sql`${messages.orgId} = ${"o"} and ${messages.folder} = 'inbox' and ${messages.isRead} = 0 and ${importantBaseCond("o")}`).toSQL();
    expect(stmt.sql).not.toMatch(/lower\(p\.from_address\)\s*=\s*lower\(/);
    const rows = plan(stmt);
    // No per row subquery at all: each set (wrote to, Sent threads, teammates, contacts) is read once.
    expect(rows.filter((r) => /CORRELATED/.test(r.detail)).map((r) => r.detail)).toEqual([]);
    // MPLAT-108: first time is messages.first_of_sender (kept by triggers), so no set is built over received mail.
    expect(stmt.sql).toContain(`"messages"."first_of_sender" = 1`);
    expect(rows.some((r) => /^SEARCH p\b/.test(r.detail))).toBe(false);
  });

  it("the counts statement evaluates the Important rule once per row (Other is derived)", () => {
    const parts = splitCountParts("o", []);
    expect(parts.notClaimed).toBeNull();
    const stmt = ctx.deps.db.select({ n: sql<number>`coalesce(sum(case when ${parts.important} then 1 else 0 end), 0)` }).from(messages).toSQL();
    expect(stmt.sql.match(/first_of_sender/g)?.length).toBe(1);
    expect(stmt.sql).not.toMatch(/row_number\(\)/);
  });

  it("a reply in a thread this mailbox wrote in is Important (Sent threads set)", async () => {
    await owner.post("/api/mail/send", { mailboxId, to: ["zed@robots.io"], subject: "Quote", text: "Hello" });
    const sent = await ctx.deps.db.select({ threadId: messages.threadId, messageIdHeader: messages.messageIdHeader }).from(messages).where(eq(messages.folder, "sent")).get();
    tick += 1;
    await deliverInbound(ctx.deps, {
      envelopeFrom: "other@elsewhere.io", rcptTo: "hello@acme.io", sizeBytes: 300, via: "test",
      email: {
        messageId: "<reply1@elsewhere.io>", from: { address: "other@elsewhere.io", name: "Other" }, to: [{ address: "hello@acme.io" }], cc: [], subject: "Re: Quote", text: "Hi",
        inReplyTo: sent!.messageIdHeader, references: sent!.messageIdHeader, date: new Date(now.getTime() + tick * 1000), attachments: [], authResults: { spf: "fail" } as never, headers: {},
      } as never,
    });
    expect(await subjects("important")).toEqual(["Re: Quote"]);
  });

  it("first message of a new authenticated sender is Important, the next is Other; counts, tabs and lists agree", async () => {
    await inbound("First note", "ana@studio.io");
    await inbound("Second note", "ana@studio.io");
    await inbound("Hello from Bo", "bo@corp.io");
    await inbound("Receipt", "noreply@shop.com");
    await inbound("No DKIM", "kim@corp.io", { auth: { spf: "pass", dkim: "none", dmarc: "none" } });
    expect(await subjects("important")).toEqual(["First note", "Hello from Bo"]);
    expect(await subjects("other")).toEqual(["No DKIM", "Receipt", "Second note"]);
    expect(await tabs()).toEqual({ Important: 2, Other: 3 });
    expect(await counts()).toEqual({ inbox: 5, important: 2, other: 3 });
  });

  it("a split that claims mail leaves both Important and Other, in counts and tabs", async () => {
    await inbound("First note", "ana@studio.io");
    await inbound("Invoice 7", "billing@vendor.io");
    await inbound("Receipt", "noreply@shop.com");
    const r = await owner.post("/api/mail/splits", { name: "Billing", rules: [{ field: "fromContains", value: "billing" }], match: "all", leavesImportant: true });
    expect(r.status).toBeLessThan(300);
    expect(await tabs()).toEqual({ Important: 1, Other: 1, Billing: 1 });
    const c = await counts();
    expect(c).toEqual({ inbox: 3, important: 1, other: 1 });
  });

  it("many first time senders at once keep exact counts", async () => {
    for (let i = 0; i < 40; i++) await inbound(`Note ${i}`, `p${i}@people${i}.io`);
    for (let i = 0; i < 10; i++) await inbound(`Again ${i}`, `p${i}@people${i}.io`);
    expect(await tabs()).toEqual({ Important: 40, Other: 10 });
    expect(await counts()).toMatchObject({ inbox: 50, important: 40, other: 10 });
  });

  it("R85T: a sender moved to a tab moves in counts too, not only in tabs and lists", async () => {
    await inbound("First note", "ana@studio.io");
    await inbound("Receipt", "noreply@shop.com");
    await inbound("Receipt 2", "noreply@shop.com");
    expect(await counts()).toEqual({ inbox: 3, important: 1, other: 2 });
    const m = await ctx.deps.db.select({ id: messages.id }).from(messages).where(eq(messages.subject, "Receipt")).get();
    expect((await owner.post("/api/mail/splits/teach", { messageId: m!.id, tab: "important" })).status).toBe(200);
    expect(await subjects("important")).toEqual(["First note", "Receipt", "Receipt 2"]);
    expect(await subjects("other")).toEqual([]);
    expect(await tabs()).toEqual({ Important: 3, Other: 0 });
    expect(await counts()).toEqual({ inbox: 3, important: 3, other: 0 });
    // And back out again: Ana moved to Other.
    const a = await ctx.deps.db.select({ id: messages.id }).from(messages).where(eq(messages.subject, "First note")).get();
    await owner.post("/api/mail/splits/teach", { messageId: a!.id, tab: "other" });
    expect(await tabs()).toEqual({ Important: 2, Other: 1 });
    expect(await counts()).toEqual({ inbox: 3, important: 2, other: 1 });
  });
});

describe("Primary, Updates and Promotions (R85, accounts made after 2026-10-31 10:00 UTC)", () => {
  beforeEach(async () => {
    await ctx.db.update(users).set({ createdAt: new Date(CATEGORIES_DEFAULT_FROM + 1000) }).where(eq(users.email, "owner@acme.io"));
  });

  it("people land in Primary, bulk in Updates or Promotions; counts, tabs and lists agree", async () => {
    await inbound("First note", "ana@studio.io");
    await inbound("Second note", "ana@studio.io");
    await inbound("Receipt", "noreply@shop.com");
    await inbound("50% off this weekend", "deals@shop.com", { headers: { "list-unsubscribe": "<https://shop.com/u>" } });
    expect(await subjects("primary")).toEqual(["First note", "Second note"]);
    expect(await subjects("updates")).toEqual(["Receipt"]);
    expect(await subjects("promotions")).toEqual(["50% off this weekend"]);
    expect(await tabs()).toEqual({ Primary: 2, Updates: 1, Promotions: 1 });
    // The counts route keeps its Important and Other fields for API callers; they agree with those lists.
    expect(await counts()).toEqual({ inbox: 4, important: (await subjects("important")).length, other: (await subjects("other")).length });
  });

  it("a split that claims mail leaves the built in tabs, in tabs and lists", async () => {
    await inbound("First note", "ana@studio.io");
    await inbound("Invoice 7", "billing@vendor.io");
    await inbound("Receipt", "noreply@shop.com");
    const r = await owner.post("/api/mail/splits", { name: "Billing", rules: [{ field: "fromContains", value: "billing" }], match: "all", leavesImportant: true });
    expect(r.status).toBeLessThan(300);
    expect(await tabs()).toEqual({ Primary: 1, Updates: 1, Promotions: 0, Billing: 1 });
    expect(await subjects("primary")).toEqual(["First note"]);
    expect(await subjects(r.body.split.id)).toEqual(["Invoice 7"]);
  });

  it("many senders at once keep exact counts", async () => {
    for (let i = 0; i < 40; i++) await inbound(`Note ${i}`, `p${i}@people${i}.io`);
    for (let i = 0; i < 10; i++) await inbound(`Statement ${i}`, `noreply@bank${i}.io`);
    for (let i = 0; i < 5; i++) await inbound(`Sale ${i}`, `deals@shop${i}.io`, { headers: { "list-unsubscribe": "<https://x.io/u>" } });
    expect(await tabs()).toEqual({ Primary: 40, Updates: 10, Promotions: 5 });
    expect((await subjects("primary")).length).toBe(40);
    expect((await subjects("updates")).length).toBe(10);
    expect((await subjects("promotions")).length).toBe(5);
    expect(await counts()).toMatchObject({ inbox: 55 });
  });
});
