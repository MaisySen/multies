import { and, eq, inArray, lt, notInArray } from "drizzle-orm";
import type { Deps } from "../context";
import { appSettings, auditLogs, deliveries, domains, mailboxes, members, messages, organizations, users } from "../db/schema";
import { runBatch } from "../db";
import { decryptSecret, encryptSecret, generateDkimKeyPair, newId, randomToken } from "../lib/crypto";
import { sql } from "drizzle-orm";
import { authFor } from "../auth";
import { createAlias, createMailbox } from "./addresses";
import { createDomain } from "./domains";
import { deliverInbound } from "./mail/delivery";
import { makeSnippet } from "./mail/mime";
import type { ParsedEmail } from "./mail/mime";
import type { AuthContext } from "../context";
import { listMailboxes } from "./addresses";
import { setAddons } from "./plans";
import "./suite/demo-seed";
import { enqueue } from "./jobs";
import { approveSend, createAgent, listThreads, replyInThread } from "./agents";

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export const DEMO_TTL_MS = 24 * 60 * 60 * 1000;

const SAMPLE_INBOUND: { from: { address: string; name: string }; to: string; subject: string; text: string; hoursAgo: number; replyChain?: boolean }[] = [
  {
    from: { address: "priya@seedround.vc", name: "Priya Raman" }, to: "founders", hoursAgo: 1,
    subject: "Following up from demo day",
    text: "Hi both,\n\nLoved the demo yesterday. The DNS walkthrough was the clearest I've seen. Could we find 30 minutes next week to go deeper on retention numbers?\n\nTuesday or Wednesday afternoon works on my side.\n\nBest,\nPriya",
  },
  {
    from: { address: "maria@blueharbor.co", name: "Maria Gonzalez" }, to: "support", hoursAgo: 3,
    subject: "Can we move our team over this week?",
    text: "Hey team,\n\nWe have 14 people on Google Workspace today. If we point our MX records at you on Friday, will anything get lost over the weekend?\n\nAlso, do aliases support more than one destination? We want sales@ to reach three of us.\n\nThanks!\nMaria",
  },
  {
    from: { address: "receipts@payments.example", name: "Payments" }, to: "billing", hoursAgo: 9,
    subject: "Receipt for your payment: $1,280.00",
    text: "Thanks for your payment.\n\nAmount paid: $1,280.00\nDate: today\nPayment method: Visa ending 4242\n\nQuestions? Reply to this email.",
  },
  {
    from: { address: "dmarc-reports@mail.example", name: "DMARC Reports" }, to: "founders", hoursAgo: 20,
    subject: "Aggregate report: 1,204 messages, 100% aligned",
    text: "Summary for the last 24 hours:\n\n  SPF aligned: 1,204 / 1,204\n  DKIM aligned: 1,204 / 1,204\n  Policy applied: quarantine (0 messages affected)\n\nYour domain is fully protected.",
  },
  {
    from: { address: "jordan@lumen.dev", name: "Jordan Lee" }, to: "hello", hoursAgo: 30,
    subject: "Partnership idea",
    text: "Hi there,\n\nWe build onboarding tooling for B2B SaaS and a lot of our customers ask us for a branded email recommendation. Open to a referral partnership?\n\nJordan",
  },
  {
    from: { address: "alerts@uptime.example", name: "Uptime" }, to: "support", hoursAgo: 52,
    subject: "All systems operational: weekly summary",
    text: "Uptime this week: 100.00%\nAverage response time: 182 ms\nIncidents: 0",
  },
];

/** Creates a throwaway workspace full of realistic sample data. Only reachable when DEMO_MODE is on. */
export async function createDemoWorkspace(deps: Deps) {
  const suffix = randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 5);
  const domainName = `northwind-${suffix}.test`;
  const email = `alex@${domainName}`;
  // A real Better Auth account and session, so the sandbox behaves exactly like a signup.
  const signup = await authFor(deps).api.signUpEmail({ body: { name: "Alex Rivera", email, password: randomToken(24) }, returnHeaders: true });
  const userId = signup.response.user.id;
  const orgId = newId("org");
  await deps.db.insert(organizations).values({ id: orgId, name: "Northwind Labs", slug: orgId, isDemo: true, plan: "starter" });
  // Free plus the A$3 mailbox pack, so the sample's four mailboxes fit. Independent steps run together.
  const [dkimKey] = await Promise.all([
    sampleDkimKey(deps),
    setAddons(deps.db, orgId, { mailboxes: 1 }),
    deps.db.insert(members).values({ id: newId("mem"), organizationId: orgId, userId, role: "owner" }),
    deps.db.update(users).set({ emailVerified: true }).where(eq(users.id, userId)),
  ]);

  const domain = await createDomain(deps, orgId, domainName, { dkimKey });
  // Sample domains can't have real DNS; mark them verified and say so in the report.
  await deps.db.update(domains).set({
    status: "verified",
    verifiedAt: deps.now(),
    lastCheckedAt: deps.now(),
    lastCheck: JSON.stringify({
      checkedAt: deps.now().toISOString(), verified: true,
      records: ["ownership", "mx", "spf", "dkim", "dmarc"].map((id) => ({ id, status: "pass", found: [], message: "Sample domain in a sandbox workspace. Add your own domain to run a live DNS check." })),
    }),
  }).where(eq(domains.id, domain.id));

  const mk = (localPart: string, displayName: string) => createMailbox(deps.db, orgId, { domainId: domain.id, localPart, displayName });
  const boxes = await Promise.all([mk("founders", "Alex Rivera"), mk("support", "Northwind Support"), mk("billing", "Northwind Billing"), mk("hello", "Northwind")]);
  const [founders] = boxes;
  const boxFor = (localPart: string) => boxes.find((b) => b.localPart === localPart)!;
  await Promise.all([
    createAlias(deps.db, orgId, { domainId: domain.id, localPart: "sales", destinations: [founders.address, "alex.rivera@gmail.example"] }),
    createAlias(deps.db, orgId, { domainId: domain.id, localPart: "team", destinations: [founders.address, `support@${domain.name}`] }),
  ]);

  const now = deps.now().getTime();
  // Sample mail is written straight into the mailboxes in one batch rather than through
  // full inbound delivery: delivery re-checks routing, plan, storage, webhooks and agents
  // for every message, which made a demo about 640 sequential database round trips and ran
  // past the Worker's CPU limit on production.
  const rows: (typeof messages.$inferInsert)[] = [];
  const delivered: (typeof deliveries.$inferInsert)[] = [];
  const used = new Map<string, number>();
  const put = (mb: { id: string; address: string }, folder: "inbox" | "archive" | "sent", from: { address: string; name: string }, to: string[], subject: string, text: string, date: Date, sentBy?: string) => {
    const id = newId("msg");
    const sizeBytes = text.length + 600;
    rows.push({
      id, orgId, mailboxId: mb.id, folder, isRead: folder !== "inbox", threadId: newId("thr"),
      messageIdHeader: `<${randomToken(9)}@${from.address.split("@")[1]}>`, fromAddress: from.address, fromName: from.name,
      to: JSON.stringify(to.map((address) => ({ address }))), cc: "[]", bcc: "[]", subject, text, snippet: makeSnippet(text), sizeBytes,
      authResults: folder === "sent" ? null : JSON.stringify({ spf: "pass", dkim: "pass", dmarc: "pass" }), sentByUserId: sentBy ?? null, date,
    });
    used.set(mb.id, (used.get(mb.id) ?? 0) + sizeBytes);
    return id;
  };
  const seed = (from: { address: string; name: string }, localPart: string, subject: string, text: string, date: Date, archived = false) => {
    const mb = boxFor(localPart);
    const id = put(mb, archived ? "archive" : "inbox", from, [mb.address], subject, text, date);
    delivered.push({ id: newId("dlv"), orgId, messageId: id, direction: "inbound", fromAddress: from.address, toAddress: mb.address, subject, status: "delivered", provider: "demo", detail: `Delivered to ${mb.address}`, createdAt: date });
  };
  for (const m of [...SAMPLE_INBOUND].reverse()) seed(m.from, m.to, m.subject, m.text, new Date(now - m.hoursAgo * 3600_000));

  const HISTORY = [
    ["Uptime", "alerts@uptime.example", "support", "Weekly summary: 100% uptime"],
    ["GitHub", "noreply@github.example", "founders", "[northwind/app] Release v1.4.0 published"],
    ["Stripe-like Payments", "receipts@payments.example", "billing", "Your invoice is ready"],
    ["Calendar", "calendar@notify.example", "founders", "Board meeting moved to Thursday"],
    ["Linear-like Tracker", "notify@tracker.example", "founders", "3 issues assigned to you"],
    ["Customer", "sam@acme-corp.example", "support", "Thanks for the quick fix!"],
    ["Recruiting", "talent@hire.example", "hello", "Intro: senior engineer, ex-Fastmail"],
  ] as const;
  for (let i = 0; i < 18; i++) {
    const [name, address, box, subject] = HISTORY[i % HISTORY.length];
    seed({ address, name }, box, subject, `${subject}.\n\nThis is an older message in your demo workspace's archive.`, new Date(now - (60 + i * 15 + (i % 3) * 4) * 3600_000), true);
  }
  // Two messages Alex sent: one outside MyMail (a sandbox never delivers it) and one to the
  // team@ alias, which lands in the founders and support inboxes.
  const alex = { address: founders.address, name: "Alex Rivera" };
  const priyaAt = new Date(now - 20 * 60_000);
  const priyaText = "Hi Priya,\n\nThanks so much! Wednesday at 2pm works great. I'll send an invite.\n\nAlex";
  const toPriya = put(founders, "sent", alex, ["priya@seedround.vc"], "Re: Following up from demo day", priyaText, priyaAt, userId);
  delivered.push({ id: newId("dlv"), orgId, messageId: toPriya, direction: "outbound", fromAddress: alex.address, toAddress: "priya@seedround.vc", subject: "Re: Following up from demo day", status: "sent", provider: "demo", detail: "Sandbox workspace: shown as sent, not delivered outside MyMail.", createdAt: priyaAt });
  const teamAt = new Date(now - 10 * 60_000);
  const team = `team@${domain.name}`;
  const checklist = "Team,\n\nQuick checklist before Friday's launch:\n\n1. DNS verified for the new domain (done)\n2. support@ and billing@ mailboxes live (done)\n3. sales@ alias forwarding to the founders (done)\n\nLet's ship it.\nAlex";
  const toTeam = put(founders, "sent", alex, [team], "Launch checklist for Friday", checklist, teamAt, userId);
  for (const box of ["founders", "support"]) put(boxFor(box), "inbox", alex, [team], "Launch checklist for Friday", checklist, teamAt);
  delivered.push({ id: newId("dlv"), orgId, messageId: toTeam, direction: "outbound", fromAddress: alex.address, toAddress: team, subject: "Launch checklist for Friday", status: "delivered", provider: "internal", detail: `Alias → ${founders.address}, support@${domain.name}`, createdAt: teamAt });

  // One statement per message (D1 allows 100 bound values per statement), all in one batch.
  await runBatch(deps.db, [
    ...rows.map((r) => deps.db.insert(messages).values(r)),
    ...chunk(delivered, 8).map((c) => deps.db.insert(deliveries).values(c)),
    ...[...used].map(([id, n]) => deps.db.update(mailboxes).set({ usedBytes: sql`${mailboxes.usedBytes} + ${n}` }).where(eq(mailboxes.id, id))),
  ]);
  await deps.db.run(sql`UPDATE messages SET folder = 'archive', is_read = 1 WHERE org_id = ${orgId} AND folder = 'inbox' AND date < ${now - 58 * 3600_000}`);

  const auth = { userId, email, name: "Alex Rivera", orgId, role: "owner" as const, sessionId: "demo" };
  await seedDemoAgents(deps, auth, domain, now);
  // Tasks, docs, contacts and deals are seeded by a background job so this request stays small.
  await enqueue(deps, "demo.seed_suite", { orgId, userId, email, name: "Alex Rivera" }, { orgId, maxAttempts: 3 });

  // Backdate the delivery log to each message's date so the activity chart has history.
  await deps.db.run(sql`UPDATE deliveries SET created_at = (SELECT date FROM messages WHERE messages.id = deliveries.message_id) WHERE org_id = ${orgId} AND message_id IS NOT NULL`);

  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000);
  const trail: [string, number, Record<string, unknown>?][] = [
    ["demo.workspace_created", 70],
    ["domain.added", 69, { name: domain.name }],
    ["domain.verified", 68, { name: domain.name }],
    ["mailbox.created", 67, { address: founders.address }],
    ["mailbox.created", 67, { address: `support@${domain.name}` }],
    ["alias.created", 66, { address: `sales@${domain.name}` }],
    ["billing.addons_updated", 60, { addons: { mailboxes: 1 } }],
  ];
  await deps.db.insert(auditLogs).values(trail.map(([action, h, metadata]) => ({ id: newId("aud"), orgId, actorUserId: userId, actorEmail: email, action, metadata: metadata ? JSON.stringify(metadata) : null, createdAt: at(h) })));
  return { userId, orgId, headers: signup.headers };
}

/** Two agents at work: one on its own inbox chasing invoices, one triaging support@ beside the team. */
async function seedDemoAgents(deps: Deps, auth: AuthContext, domain: { id: string; name: string }, now: number) {
  const support = (await listMailboxes(deps.db, auth.orgId)).find((m) => m.localPart === "support")!;
  const [invoices, triage] = await Promise.all([createAgent(deps, auth, { name: "Invoice chaser", localPart: "accounts", domainId: domain.id, createKey: false, sendCapDaily: 40, allowedRecipients: null }), createAgent(deps, auth, { name: "Support triage", localPart: "triage", domainId: domain.id, createKey: false, approvalMode: "external", mailboxIds: [support.id] })]);
  const inbound = async (to: string, from: { address: string; name: string }, subject: string, text: string, hoursAgo: number) => {
    const email: ParsedEmail = {
      messageId: `<${randomToken(9)}@${from.address.split("@")[1]}>`, from, to: [{ address: to }], cc: [], subject, text, date: new Date(now - hoursAgo * 3600_000),
      attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {},
    };
    await deliverInbound(deps, { envelopeFrom: from.address, rcptTo: to, email, sizeBytes: text.length + 600, via: "demo" });
  };
  await Promise.all([inbound(invoices.agent.address, { address: "tom@bondiplumbing.example", name: "Tom Nguyen" }, "Re: Invoice INV-1042",
    "Hi,\n\nSorry, this one slipped. Can you resend the invoice? I can't find the PDF.\n\nCheers,\nTom", 2),
  inbound(`support@${domain.name}`, { address: "kai@flatwhite.example", name: "Kai Morgan" }, "Password reset not arriving",
    "Hi,\n\nI've asked for a password reset three times and nothing has come through. Is something broken?\n\nKai", 0.5)]);

  const as = (a: { id: string }) => ({ ...auth, agentId: a.id, sessionId: `agent:${a.id}` });
  const threadOf = async (mailboxId: string, subject: string) => (await listThreads(deps, auth.orgId, [mailboxId], { limit: 20 })).data.find((t) => t.subject === subject)!.id;

  await Promise.all([
  // The invoice chaser's reply waits for a person, as every send does by default.
  replyInThread(deps, as(invoices.agent), invoices.agent.id, await threadOf(invoices.agent.inboxId, "Re: Invoice INV-1042"), {
    text: "Hi Tom,\n\nNo worries. Here is INV-1042 again: A$1,850.00 for the bathroom refit, due 14 October.\n\nYou can pay by bank transfer to BSB 062-000, account 1234 5678, with INV-1042 as the reference.\n\nThanks,\nNorthwind accounts",
  }),
  // Support triage answered Maria, a person approved it, and it went out labelled as the agent's.
  (async () => {
    const maria = await replyInThread(deps, as(triage.agent), triage.agent.id, await threadOf(support.id, "Can we move our team over this week?"), {
    text: "Hi Maria,\n\nNothing gets lost. Mail keeps arriving at Google until your MX change spreads, then it arrives here, so check both for a day.\n\nAnd yes: an alias can reach as many people as you like, so sales@ can go to all three of you.\n\nNorthwind Support",
  });
    if (maria.status === "pending_approval") await approveSend(deps, auth, maria.approval.id);
  })(),
  // And one more waiting for a decision.
  replyInThread(deps, as(triage.agent), triage.agent.id, await threadOf(support.id, "Password reset not arriving"), {
    text: "Hi Kai,\n\nSorry about that. Reset emails can land in spam, so please check there first. I've also asked the team to look at your account, and someone will reply today.\n\nNorthwind Support",
  }),
  ]);
}

/**
 * One DKIM key pair shared by every sandbox domain (they can't publish DNS or send outside
 * MyMail anyway), made once and kept encrypted in app_settings. Generating an RSA key per
 * demo cost a large share of the Worker's CPU budget.
 */
async function sampleDkimKey(deps: Deps): Promise<{ publicKeyB64: string; privateKeyPem: string }> {
  const KEY = "demo_dkim_key";
  const row = await deps.db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).get();
  if (row) return JSON.parse(await decryptSecret(deps.config.appSecret, row.value)) as { publicKeyB64: string; privateKeyPem: string };
  const pair = await generateDkimKeyPair();
  await deps.db.insert(appSettings).values({ key: KEY, value: await encryptSecret(deps.config.appSecret, JSON.stringify(pair)) }).onConflictDoNothing();
  return pair;
}

/** Removes sandbox workspaces (and their users) older than the TTL. */
export async function purgeDemoWorkspaces(deps: Deps) {
  const cutoff = new Date(deps.now().getTime() - DEMO_TTL_MS);
  // The App Review account is a demo workspace with a password login that must always work.
  const keep = deps.config.keepDemoOrgIds ?? [];
  const old = await deps.db.select({ id: organizations.id }).from(organizations)
    .where(and(eq(organizations.isDemo, true), lt(organizations.createdAt, cutoff), keep.length ? notInArray(organizations.id, keep) : undefined));
  if (!old.length) return 0;
  const ids = old.map((o) => o.id);
  const demoMembers = await deps.db.select({ userId: members.userId }).from(members).where(inArray(members.organizationId, ids));
  await deps.db.delete(organizations).where(inArray(organizations.id, ids));
  if (demoMembers.length) await deps.db.delete(users).where(inArray(users.id, demoMembers.map((m) => m.userId)));
  return ids.length;
}
