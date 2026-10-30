import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { messages } from "@/server/db/schema";
import { importantBaseCond, splitCountParts } from "@/server/services/mail/splits";

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
  now = new Date("2026-10-29T03:00:00Z");
  ctx.deps.now = () => now;
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
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
  it("no correlated subquery scans messages: the first time sender set is built once per statement", () => {
    const stmt = ctx.deps.db.select({ n: sql<number>`count(*)` }).from(messages)
      .where(sql`${messages.orgId} = ${"o"} and ${messages.folder} = 'inbox' and ${messages.isRead} = 0 and ${importantBaseCond("o")}`).toSQL();
    expect(stmt.sql).not.toMatch(/lower\(p\.from_address\)\s*=\s*lower\(/);
    const rows = plan(stmt);
    // No per row subquery at all: each set (wrote to, Sent threads, teammates, contacts, first time) is read once.
    expect(rows.filter((r) => /CORRELATED/.test(r.detail)).map((r) => r.detail)).toEqual([]);
    // The first time set is an uncorrelated list subquery over the workspace's own rows (index on org_id).
    expect(rows.some((r) => /^LIST SUBQUERY/.test(r.detail))).toBe(true);
    expect(rows.filter((r) => /p\b/.test(r.detail) && r.up.some((u) => /LIST SUBQUERY/.test(u))).map((r) => r.detail).join(" ")).toMatch(/USING (COVERING )?INDEX messages_org/);
  });

  it("the counts statement evaluates the Important rule once per row (Other is derived)", () => {
    const parts = splitCountParts("o", []);
    expect(parts.notClaimed).toBeNull();
    const stmt = ctx.deps.db.select({ n: sql<number>`coalesce(sum(case when ${parts.important} then 1 else 0 end), 0)` }).from(messages).toSQL();
    expect(stmt.sql.match(/row_number\(\)/g)?.length).toBe(1);
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
});
