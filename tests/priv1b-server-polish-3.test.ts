/**
 * PRIV1b round 3, batch "server-polish-3" (SP1..SP6). SP1 (odd recipient JSON) and SP2, SP3 (rule reads, Add to
 * Documents order) are in tests/priv1b-share-levels-2.test.ts. Here: a comp workspace's referral credit counts what
 * it pays and its campaign batch uses the Business cap (SP4); the system mail domain is reserved and every system
 * delivery uses one stamp rule (SP5); the prune and the calendar person filter keep to forms the IN guard checks (SP6).
 */
import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { domains, jobs, mailboxes, messages, organizations, referrals } from "@/server/db/schema";
import { runCampaignBatch } from "@/server/services/campaigns/r109";
import { grantReferral } from "@/server/services/billing/referrals";
import { setAddons } from "@/server/services/plans";
import { sendSystemEmail } from "@/server/services/system-mail";
import { onDeliverDead } from "@/server/services/mail/deliver-job";

const DAY = 86_400_000;
const S = (x: unknown) => JSON.stringify(x);
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_BUSINESS: "price_biz" };

/** Just enough Stripe for the referral grant: customers, charges, cards and balance transactions. */
function fakeStripe() {
  const credits: { customer: string; amount: number }[] = [];
  let customers = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    const list = () => json({ object: "list", data: [], has_more: false, url: url.pathname });
    if (url.pathname === "/v1/customers" && method === "POST") return json({ id: `cus_new${++customers}`, object: "customer" });
    const bt = url.pathname.match(/^\/v1\/customers\/([^/]+)\/balance_transactions$/);
    if (bt) {
      const amount = Number(new URLSearchParams(String(init?.body ?? "")).get("amount"));
      credits.push({ customer: bt[1]!, amount });
      return json({ id: `cbtxn_${credits.length}`, object: "customer_balance_transaction", customer: bt[1], amount });
    }
    if (url.pathname === "/v1/charges" || url.pathname === "/v1/payment_methods") return list();
    return json({ error: { message: `unexpected ${method} ${url.pathname}` } }, 400);
  };
  return { credits, fetch: fetchImpl as typeof fetch };
}

describe("PRIV1b SP4: a comp workspace pays nothing for its granted plan", () => {
  it("the referral credit counts only paid add-ons for a comp workspace, and the stored legacy plan otherwise", async () => {
    const stripe = fakeStripe();
    const ctx = await makeTestApp(STRIPE_ENV, { fetch: stripe.fetch });
    const a = new Client(ctx.app);
    await a.signup("ref.owner@acme.io");
    const b = new Client(ctx.app);
    await b.signup("bob@newco.io");
    const referrerOrg = (await a.get("/api/account/me")).body.organization.id as string;
    const referredOrg = (await b.get("/api/account/me")).body.organization.id as string;
    await setAddons(ctx.db, referredOrg, { mailboxes: 1 }); // A$3 a month
    const grant = async (id: string, org: { plan: "starter" | "pro"; compPlan: boolean }) => {
      await ctx.db.update(organizations).set({ ...org, stripeCustomerId: "cus_B" }).where(eq(organizations.id, referredOrg));
      await ctx.db.delete(referrals).where(eq(referrals.referredOrgId, referredOrg));
      await ctx.db.insert(referrals).values({ id, referrerOrgId: referrerOrg, referredOrgId: referredOrg, code: "ABCD2345", status: "pending", eligibleAt: new Date(Date.now() - DAY) });
      stripe.credits.length = 0;
      expect(await grantReferral(ctx.deps, id)).toMatchObject({ status: "credited" });
      return (await ctx.db.select().from(referrals).where(eq(referrals.id, id)).get())!;
    };
    // Comp: granted Business, pays only the add-on. The old total added Business's A$49 (capped at A$20).
    const comp = await grant("ref_sp4comp", { plan: "starter", compPlan: true });
    expect(comp.referredCreditCents).toBe(300);
    expect(stripe.credits.map((c) => c.amount)).toEqual([-300, -300]);
    // A workspace that pays for the legacy Pro plan still has it counted.
    const pro = await grant("ref_sp4pro0", { plan: "pro", compPlan: false });
    expect(pro.referredCreditCents).toBe(1500);
    expect(stripe.credits[0]!.amount).toBe(-1500);
  }, 60_000);

  it("a campaign batch on a comp workspace goes out under the Business daily cap, a starter one under its own", async () => {
    const ctx = await makeTestApp();
    const owner = new Client(ctx.app);
    await owner.signup("camp.owner@acme.io");
    const me = (await owner.get("/api/account/me")).body;
    const orgId = me.organization.id as string;
    const userId = me.user.id as string;
    const now = Date.now();
    await ctx.db.run(sql`insert into audience_lists (id, org_id, name, owner_user_id, signup_key, created_at, updated_at) values ('aul_sp4', ${orgId}, 'List', ${userId}, 'sk_sp4', ${now}, ${now})`);
    const campaign = async (id: string) => {
      await ctx.db.run(sql`insert into campaigns (id, org_id, list_id, user_id, name, subject, status, created_at, updated_at) values (${id}, ${orgId}, 'aul_sp4', ${userId}, 'News', 'Hi', 'sending', ${now}, ${now})`);
      for (let i = 0; i < 60; i += 10) {
        const rows = Array.from({ length: 10 }, (_, j) => sql`(${id}, ${i + j}, ${orgId}, ${`p${i + j}@example.org`}, ${`${id}_t${i + j}`})`);
        await ctx.db.run(sql`insert into campaign_recipients (campaign_id, idx, org_id, email, token) values ${sql.join(rows, sql`, `)}`);
      }
      await runCampaignBatch(ctx.deps, id);
      return (await ctx.db.select().from(jobs).where(and(eq(jobs.orgId, orgId), eq(jobs.type, "campaign.send")))).filter((j) => JSON.parse(j.payload).id === id).length;
    };
    await ctx.db.update(organizations).set({ plan: "starter", compPlan: false }).where(eq(organizations.id, orgId));
    expect(await campaign("cmp_sp4start")).toBe(50);
    await ctx.db.run(sql`delete from merge_daily where org_id = ${orgId}`);
    await ctx.db.update(organizations).set({ compPlan: true }).where(eq(organizations.id, orgId));
    expect(await campaign("cmp_sp4comp0")).toBe(60);
  }, 60_000);
});

describe("PRIV1b SP5: the system mail domain", () => {
  const ENV = { SYSTEM_FROM: "no-reply@sysmail.example" };

  it("no workspace but the operator's can add it, even as a pending claim", async () => {
    const ctx = await makeTestApp(ENV);
    const owner = new Client(ctx.app);
    await owner.signup("sys.owner@acme.io");
    for (const name of ["sysmail.example", "SysMail.Example."]) {
      const r = await owner.post("/api/domains", { name });
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.body)).toContain("reserved");
    }
    expect((await ctx.db.select().from(domains).where(eq(domains.name, "sysmail.example"))).length).toBe(0);
    // An ordinary domain still adds, and the operator workspace may hold the system domain.
    expect((await owner.post("/api/domains", { name: "acme.io" })).status).toBe(201);
    const op = new Client(ctx.app);
    await op.signup("ops@operator.example");
    const opOrg = (await op.get("/api/account/me")).body.organization.id as string;
    ctx.deps.config.operatorInbox = { ...ctx.deps.config.operatorInbox, orgId: opOrg };
    expect((await op.post("/api/domains", { name: "sysmail.example" })).status).toBe(201);
  }, 60_000);

  it("account mail and bounce notices share one stamp: pass from the deployment's domain, none under an unverified claim", async () => {
    const ctx = await makeTestApp(ENV);
    const owner = new Client(ctx.app);
    await owner.signup("stamp.owner@acme.io");
    const orgId = (await owner.get("/api/account/me")).body.organization.id as string;
    const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id as string;
    await ctx.db.update(domains).set({ status: "verified" }).where(eq(domains.id, domainId));
    const box = (await owner.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" })).body.mailbox.id as string;
    const inbox = async (prefix: string) => (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, box), eq(messages.folder, "inbox")))).filter((m) => m.subject.startsWith(prefix));
    const stamp = (m: { authResults: string | null }) => JSON.parse(m.authResults!).dmarc as string;
    const sent = { id: "msg_sp5sent0000000000", orgId, mailboxId: box, folder: "sent", threadId: "thr_sp5", fromAddress: "team@acme.io", fromName: "Team", to: S([{ name: "", address: "x@example.org" }]), subject: "SP5 subject", text: "t", snippet: "t", date: new Date(), isRead: true };
    await ctx.db.insert(messages).values(sent as never);
    const both = async () => {
      await sendSystemEmail(ctx.deps, { to: "team@acme.io", subject: "Notice SP5", text: "hello" });
      await onDeliverDead(ctx.deps, { orgId, messageId: sent.id, to: ["x@example.org"], cc: [], bcc: [] }, null, "550 no such user");
      const [notice, ndr] = [(await inbox("Notice SP5")).at(-1)!, (await inbox("Undeliverable")).at(-1)!];
      return [stamp(notice), stamp(ndr)];
    };
    expect(await both()).toEqual(["pass", "pass"]);
    // A claim held from before the reservation, short of verified: neither kind of system mail is stamped pass.
    const dom = (await ctx.db.select().from(domains).where(eq(domains.id, domainId)).get())!;
    await ctx.db.insert(domains).values({ ...dom, id: "dom_sp5claim", name: "sysmail.example", status: "pending" });
    expect(await both()).toEqual(["none", "none"]);
    await ctx.db.update(domains).set({ status: "verified" }).where(eq(domains.id, "dom_sp5claim"));
    expect(await both()).toEqual(["pass", "pass"]);
    expect((await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, box))).length).toBe(1);
  }, 60_000);
});

describe("PRIV1b SP6: no raw IN the guard can't see", () => {
  it("the access log prune and the calendar person filter use inIds or a marked inArray", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of ["../src/server/services/maintenance.ts", "../src/server/services/suite/calendar-sync.ts"]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      expect(src, f).not.toMatch(/\}\s+in\s+\$\{/);
      expect(src, f).not.toMatch(/\} in \(select/);
    }
  });
});
