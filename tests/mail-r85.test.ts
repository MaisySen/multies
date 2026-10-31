import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { users, messages } from "@/server/db/schema";
import { addPin, categoryOf, MailRuleInput, ruleMatches, describeConditions } from "@/shared/mail-rules-r85";
import { isRobotSender } from "@/shared/mail-splits";
import { CATEGORIES_DEFAULT_FROM } from "@/server/services/mail/splits";

/** R85: Inbox tab styles (Primary, Updates, Promotions), teach a tab by moving, mail rules with ordered actions, labels. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let mailboxId: string;
let now = new Date("2026-10-31T03:00:00Z");

async function inbound(subject: string, from: { address: string; name: string }, headers: Record<string, string> = {}, extra: { attachments?: { filename: string; contentType: string; content: Uint8Array }[] } = {}) {
  const messageId = `<${Math.random().toString(36).slice(2)}@example.com>`;
  now = new Date(now.getTime() + 1000);
  await deliverInbound(ctx.deps, {
    envelopeFrom: from.address, rcptTo: "hello@acme.io", sizeBytes: 300, via: "test",
    email: { messageId, from, to: [{ address: "hello@acme.io" }], cc: [], subject, text: "Hi there", date: now, attachments: extra.attachments ?? [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers },
  });
  const row = await ctx.db.select({ id: messages.id, threadId: messages.threadId }).from(messages).where(eq(messages.messageIdHeader, messageId)).get();
  return row!;
}
const subjects = async (split: string) =>
  ((await owner.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox&split=${split}`)).body.messages as { subject: string }[]).map((m) => m.subject).sort();
const tabs = async () => (await owner.get(`/api/mail/splits?mailboxId=${mailboxId}`)).body as { tabs: { id: string; unread: number }[]; style: string; defaultTab: string };

beforeEach(async () => {
  ctx = await makeTestApp();
  now = new Date("2026-10-31T03:00:00Z");
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
  // Accounts made before the release keep Important and Other.
  await ctx.db.update(users).set({ createdAt: new Date(CATEGORIES_DEFAULT_FROM - 86_400_000) }).where(eq(users.email, "owner@acme.io"));
});

describe("shared rules", () => {
  it("sorts mail into Primary, Updates and Promotions", () => {
    expect(categoryOf({ from: "grace@client.com", subject: "Lunch?", isBulk: false }, isRobotSender)).toBe("primary");
    expect(categoryOf({ from: "news@shop.com", subject: "Weekly picks", isBulk: true }, isRobotSender)).toBe("promotions");
    expect(categoryOf({ from: "team@shop.com", subject: "50% off everything", isBulk: true }, isRobotSender)).toBe("promotions");
    expect(categoryOf({ from: "noreply@shop.com", subject: "Your order has shipped", isBulk: true }, isRobotSender)).toBe("updates");
    expect(categoryOf({ from: "news@bank.com", subject: "Your statement is ready", isBulk: true }, isRobotSender)).toBe("updates");
  });
  it("matches conditions, all or any", () => {
    const m = { from: "ap@acme.com.au", fromName: "Accounts", to: ["hello@acme.io"], subject: "Invoice 42", hasAttachments: true };
    expect(ruleMatches({ match: "all", conditions: [{ field: "domain", value: "acme.com.au" }, { field: "subject", value: "invoice" }] }, m)).toBe(true);
    expect(ruleMatches({ match: "all", conditions: [{ field: "domain", value: "com.au" }, { field: "hasAttachment", value: "" }] }, m)).toBe(true);
    expect(ruleMatches({ match: "all", conditions: [{ field: "domain", value: "acme.com" }] }, m)).toBe(false);
    expect(ruleMatches({ match: "any", conditions: [{ field: "from", value: "nobody" }, { field: "to", value: "hello@" }] }, m)).toBe(true);
    expect(describeConditions({ match: "any", conditions: [{ field: "from", value: "a" }, { field: "hasAttachment", value: "" }] })).toBe('from contains "a" or has an attachment');
  });
  it("caps pins, newest kept", () => {
    let p: Record<string, string> = {};
    for (let i = 0; i < 5; i++) p = addPin(p, `s${i}`, "updates", 3);
    expect(Object.keys(p)).toEqual(["s2", "s3", "s4"]);
    expect(Object.keys(addPin(p, "s2", "primary", 3))).toEqual(["s3", "s4", "s2"]);
  });
  it("validates rules", () => {
    expect(MailRuleInput.safeParse({ name: "x", mailboxId: "m", conditions: [], actions: [{ kind: "star" }] }).success).toBe(false);
    expect(MailRuleInput.safeParse({ name: "x", mailboxId: "m", conditions: [{ field: "from", value: "" }], actions: [{ kind: "star" }] }).success).toBe(false);
    expect(MailRuleInput.safeParse({ name: "x", mailboxId: "m", conditions: [{ field: "hasAttachment" }], actions: [{ kind: "forward", to: "not an email" }] }).success).toBe(false);
    expect(MailRuleInput.safeParse({ name: "x", mailboxId: "m", conditions: [{ field: "hasAttachment" }], actions: [{ kind: "label", label: "tab:x" }] }).success).toBe(false);
    expect(MailRuleInput.safeParse({ name: "x", mailboxId: "m", conditions: [{ field: "hasAttachment" }], actions: [{ kind: "label", label: "Bills" }, { kind: "mark_read" }] }).success).toBe(true);
  });
});

describe("inbox tabs", () => {
  async function seed() {
    await inbound("Lunch on Friday", { address: "grace@client.com", name: "Grace" });
    await inbound("50% off this weekend", { address: "news@shop.com", name: "Shop" }, { "list-unsubscribe": "<mailto:u@shop.com>" });
    await inbound("Your order has shipped", { address: "noreply@shop.com", name: "Shop" });
  }

  it("keeps Important and Other for an existing account until they choose", async () => {
    await seed();
    const t = await tabs();
    expect(t.style).toBe("classic");
    expect(t.tabs.map((x) => x.id)).toEqual(["important", "other"]);
  });

  it("new accounts open on Primary, Updates and Promotions", async () => {
    await ctx.db.update(users).set({ createdAt: new Date(CATEGORIES_DEFAULT_FROM + 1000) }).where(eq(users.email, "owner@acme.io"));
    const t = await tabs();
    expect(t.style).toBe("categories");
    expect(t.defaultTab).toBe("primary");
  });

  it("shows Primary, Updates and Promotions with counts, and off shows none", async () => {
    await seed();
    expect((await owner.put("/api/mail/splits/style", { style: "categories" })).status).toBe(200);
    const t = await tabs();
    expect(t.tabs.map((x) => [x.id, x.unread])).toEqual([["primary", 1], ["updates", 1], ["promotions", 1]]);
    expect(await subjects("primary")).toEqual(["Lunch on Friday"]);
    expect(await subjects("promotions")).toEqual(["50% off this weekend"]);
    expect(await subjects("updates")).toEqual(["Your order has shipped"]);
    await owner.put("/api/mail/splits/style", { style: "off" });
    expect((await tabs()).tabs).toEqual([]);
    // Important still answers for API callers.
    expect(await subjects("important")).toEqual(["Lunch on Friday"]);
  });

  it("moving a thread to a tab teaches its sender, and undo puts it back", async () => {
    await owner.put("/api/mail/splits/style", { style: "categories" });
    const promo = await inbound("Weekly picks", { address: "news@shop.com", name: "Shop" }, { "list-unsubscribe": "<mailto:u@shop.com>" });
    const taught = await owner.post("/api/mail/splits/teach", { messageId: promo.id, tab: "primary" });
    expect(taught.status).toBe(200);
    expect(taught.body.previous).toEqual({ thread: null, sender: null });
    expect(await subjects("primary")).toEqual(["Weekly picks"]);
    await inbound("Next week's picks", { address: "news@shop.com", name: "Shop" }, { "list-unsubscribe": "<mailto:u@shop.com>" });
    expect(await subjects("primary")).toEqual(["Next week's picks", "Weekly picks"]);
    expect(await subjects("promotions")).toEqual([]);
    const settings = (await owner.get("/api/mail/splits/settings")).body;
    expect(settings.senders).toEqual([{ address: "news@shop.com", tab: "primary" }]);
    await owner.post("/api/mail/splits/pins/restore", { threadId: promo.threadId, thread: null, sender: "news@shop.com", senderTab: null });
    expect(await subjects("primary")).toEqual([]);
    expect((await subjects("promotions")).length).toBe(2);
  });

  it("a moved thread can go to a split, and unknown tabs answer 404", async () => {
    const split = (await owner.post("/api/mail/splits", { name: "Clients", rules: [{ field: "fromDomain", value: "client.com" }] })).body.split;
    const m = await inbound("Hello from a stranger", { address: "x@else.com", name: "X" });
    expect((await owner.post("/api/mail/splits/teach", { messageId: m.id, tab: split.id, sender: false })).status).toBe(200);
    expect(await subjects(split.id)).toEqual(["Hello from a stranger"]);
    expect(await subjects("important")).toEqual([]);
    expect((await owner.post("/api/mail/splits/teach", { messageId: m.id, tab: "nope" })).status).toBe(404);
  });
});

describe("mail rules", () => {
  const rule = (actions: unknown[], conditions: unknown[] = [{ field: "domain", value: "client.com" }]) => ({ name: "Client mail", mailboxId, conditions, actions });

  it("runs several actions in order and logs the run", async () => {
    const r = await owner.post("/api/mail/rules", rule([{ kind: "label", label: "Clients" }, { kind: "mark_read" }, { kind: "star" }, { kind: "notify" }, { kind: "create_task", priority: "high", dueInDays: 1 }]));
    expect(r.status).toBe(201);
    const m = await inbound("Can you send the quote?", { address: "grace@client.com", name: "Grace" });
    await inbound("Unrelated", { address: "bob@else.com", name: "Bob" });
    const row = await ctx.db.select().from(messages).where(eq(messages.id, m.id)).get();
    expect(row!.isRead).toBe(true);
    expect(row!.isStarred).toBe(true);
    const runs = (await owner.get(`/api/mail/rules/${r.body.rule.id}/runs`)).body.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].steps.map((s: { action: string }) => s.action)).toEqual(["label", "mark_read", "star", "notify", "create_task"]);
    const list = (await owner.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox&label=Clients`)).body.messages;
    expect(list.map((x: { subject: string; labels: string[] }) => [x.subject, x.labels])).toEqual([["Can you send the quote?", ["Clients"]]]);
    expect((await owner.get("/api/mail/labels")).body.labels).toEqual([{ label: "Clients", threads: 1 }]);
    expect((await owner.get("/api/mail/rules")).body.rules[0].runCount).toBe(1);
  });

  it("tests on recent mail before saving, and a turned off rule does nothing", async () => {
    await inbound("Quote please", { address: "grace@client.com", name: "Grace" });
    await inbound("Other", { address: "bob@else.com", name: "Bob" });
    const t = await owner.post("/api/mail/rules/test", { mailboxId, conditions: [{ field: "domain", value: "client.com" }] });
    expect(t.body.scanned).toBe(2);
    expect(t.body.matched).toBe(1);
    expect(t.body.sample[0].subject).toBe("Quote please");
    const r = (await owner.post("/api/mail/rules", { ...rule([{ kind: "archive" }]), enabled: false })).body.rule;
    const m = await inbound("Second", { address: "grace@client.com", name: "Grace" });
    expect((await ctx.db.select().from(messages).where(eq(messages.id, m.id)).get())!.folder).toBe("inbox");
    expect((await owner.get(`/api/mail/rules/${r.id}/runs`)).body.runs).toHaveLength(0);
    await owner.patch(`/api/mail/rules/${r.id}`, { enabled: true });
    const m2 = await inbound("Third", { address: "grace@client.com", name: "Grace" });
    expect((await ctx.db.select().from(messages).where(eq(messages.id, m2.id)).get())!.folder).toBe("archive");
  });

  it("replies with a saved reply once per sender a day, never to bulk mail, and forwards", async () => {
    const snip = (await owner.post("/api/mail/snippets", { name: "Thanks", body: "Thanks {{first_name}}, we got it." })).body.snippet;
    await owner.post("/api/mail/rules", rule([{ kind: "auto_reply", snippetId: snip.id }, { kind: "forward", to: "boss@partner.com" }], [{ field: "subject", value: "order" }]));
    const before = ctx.outbound.sent.length;
    await inbound("New order 1", { address: "grace@client.com", name: "Grace Hopper" });
    const sent = ctx.outbound.sent.slice(before);
    expect(sent.map((s) => [s.to.join(","), s.subject])).toEqual([["grace@client.com", "Re: New order 1"], ["boss@partner.com", "Fwd: New order 1"]]);
    expect(sent[0].text).toContain("Thanks Grace");
    await inbound("New order 2", { address: "grace@client.com", name: "Grace Hopper" });
    const again = ctx.outbound.sent.slice(before + 2);
    expect(again.map((s) => s.to.join(","))).toEqual(["boss@partner.com"]);
    await inbound("Order news", { address: "news@shop.com", name: "Shop" }, { "list-unsubscribe": "<mailto:u@shop.com>" });
    expect(ctx.outbound.sent.slice(before + 3).map((s) => s.to.join(","))).toEqual(["boss@partner.com"]);
  });

  it("checks tabs and saved replies at save time, and runs quiet actions on recent mail", async () => {
    expect((await owner.post("/api/mail/rules", rule([{ kind: "move_to_tab", tab: "promotions" }]))).status).toBe(400);
    await owner.put("/api/mail/splits/style", { style: "categories" });
    expect((await owner.post("/api/mail/rules", rule([{ kind: "auto_reply", snippetId: "nope" }]))).status).toBe(404);
    await inbound("Old one", { address: "grace@client.com", name: "Grace" });
    const r = (await owner.post("/api/mail/rules", rule([{ kind: "move_to_tab", tab: "promotions" }, { kind: "forward", to: "boss@partner.com" }]))).body.rule;
    const before = ctx.outbound.sent.length;
    const ran = await owner.post(`/api/mail/rules/${r.id}/run-recent`, {});
    expect(ran.body).toEqual({ ran: 1, matched: 1 });
    expect(ctx.outbound.sent.length).toBe(before);
    expect(await subjects("promotions")).toEqual(["Old one"]);
    const runs = (await owner.get(`/api/mail/rules/${r.id}/runs`)).body.runs;
    // The forward is left out on purpose, so the run counts as done and the rule shows no problem.
    expect(runs[0].status).toBe("ok");
    expect(runs[0].steps[1]).toMatchObject({ action: "forward", skipped: true });
    expect((await owner.get(`/api/mail/rules/${r.id}`)).body.rule.lastError).toBeNull();
  });

  it("keeps rules to their owner", async () => {
    const r = (await owner.post("/api/mail/rules", rule([{ kind: "star" }]))).body.rule;
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve");
    expect((await other.get(`/api/mail/rules/${r.id}`)).status).toBe(404);
    expect((await other.post("/api/mail/rules", rule([{ kind: "star" }]))).status).toBe(404);
    expect((await other.del(`/api/mail/rules/${r.id}`)).status).toBe(404);
  });
});
