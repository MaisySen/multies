import { and, eq, inArray, lt } from "drizzle-orm";
import type { Deps } from "../context";
import { domains, memberships, organizations, users } from "../db/schema";
import { randomToken } from "../lib/crypto";
import { audit } from "./audit";
import { createUserWithOrg } from "./auth";
import { createAlias, createMailbox } from "./addresses";
import { createDomain } from "./domains";
import { deliverInbound } from "./mail/delivery";
import { sendMessage } from "./mail/send";
import type { ParsedEmail } from "./mail/mime";

export const DEMO_TTL_MS = 24 * 60 * 60 * 1000;

const SAMPLE_INBOUND: { from: { address: string; name: string }; to: string; subject: string; text: string; hoursAgo: number; replyChain?: boolean }[] = [
  {
    from: { address: "priya@seedround.vc", name: "Priya Raman" }, to: "founders", hoursAgo: 1,
    subject: "Following up from demo day",
    text: "Hi both,\n\nLoved the demo yesterday — the DNS walkthrough was the clearest I've seen. Could we find 30 minutes next week to go deeper on retention numbers?\n\nTuesday or Wednesday afternoon works on my side.\n\nBest,\nPriya",
  },
  {
    from: { address: "maria@blueharbor.co", name: "Maria Gonzalez" }, to: "support", hoursAgo: 3,
    subject: "Can we move our team over this week?",
    text: "Hey team,\n\nWe have 14 people on Google Workspace today. If we point our MX records at you on Friday, will anything get lost over the weekend?\n\nAlso — do aliases support more than one destination? We want sales@ to reach three of us.\n\nThanks!\nMaria",
  },
  {
    from: { address: "receipts@payments.example", name: "Payments" }, to: "billing", hoursAgo: 9,
    subject: "Receipt for your payment — $1,280.00",
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
    subject: "All systems operational — weekly summary",
    text: "Uptime this week: 100.00%\nAverage response time: 182 ms\nIncidents: 0",
  },
];

/** Creates a throwaway workspace full of realistic sample data. Only reachable when DEMO_MODE is on. */
export async function createDemoWorkspace(deps: Deps) {
  const suffix = randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 5);
  const email = `demo-${suffix}@sandbox.mymail.invalid`;
  const { userId, orgId } = await createUserWithOrg(deps.db, { name: "Alex Rivera", email, password: randomToken(24), organization: "Northwind Labs" }, { isDemo: true });
  await deps.db.update(organizations).set({ plan: "pro" }).where(eq(organizations.id, orgId));

  const domain = await createDomain(deps, orgId, `northwind-${suffix}.test`);
  // Sample domains can't have real DNS; mark them verified and say so in the report.
  await deps.db.update(domains).set({
    status: "verified",
    verifiedAt: deps.now(),
    lastCheckedAt: deps.now(),
    lastCheck: JSON.stringify({
      checkedAt: deps.now().toISOString(), verified: true,
      records: ["ownership", "mx", "spf", "dkim", "dmarc"].map((id) => ({ id, status: "pass", found: [], message: "Sample domain in a sandbox workspace — add your own domain to run a live DNS check." })),
    }),
  }).where(eq(domains.id, domain.id));

  const mk = (localPart: string, displayName: string) => createMailbox(deps.db, orgId, { domainId: domain.id, localPart, displayName });
  const founders = await mk("founders", "Alex Rivera");
  await mk("support", "Northwind Support");
  await mk("billing", "Northwind Billing");
  await mk("hello", "Northwind");
  await createAlias(deps.db, orgId, { domainId: domain.id, localPart: "sales", destinations: [founders.address, "alex.rivera@gmail.example"] });
  await createAlias(deps.db, orgId, { domainId: domain.id, localPart: "team", destinations: [founders.address, `support@${domain.name}`] });

  const now = deps.now().getTime();
  for (const m of [...SAMPLE_INBOUND].reverse()) {
    const date = new Date(now - m.hoursAgo * 3600_000);
    const email: ParsedEmail = {
      messageId: `<${randomToken(9)}@${m.from.address.split("@")[1]}>`,
      from: m.from, to: [{ address: `${m.to}@${domain.name}` }], cc: [], subject: m.subject, text: m.text, date,
      attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {},
    };
    await deliverInbound(deps, { envelopeFrom: m.from.address, rcptTo: `${m.to}@${domain.name}`, email, sizeBytes: m.text.length + 600, via: "demo" });
  }

  const auth = { userId, email, name: "Alex Rivera", orgId, role: "owner" as const, sessionId: "demo" };
  await sendMessage(deps, auth, {
    mailboxId: founders.id, to: ["priya@seedround.vc"], subject: "Re: Following up from demo day",
    text: "Hi Priya,\n\nThanks so much! Wednesday at 2pm works great — I'll send an invite.\n\nAlex",
  });
  await sendMessage(deps, auth, {
    mailboxId: founders.id, to: [`team@${domain.name}`], subject: "Launch checklist for Friday",
    text: "Team,\n\nQuick checklist before Friday's launch:\n\n1. DNS verified for the new domain ✅\n2. support@ and billing@ mailboxes live ✅\n3. sales@ alias forwarding to the founders ✅\n\nLet's ship it.\nAlex",
  });

  await audit(deps.db, { orgId, actorUserId: userId, actorEmail: email, action: "demo.workspace_created" });
  return { userId, orgId };
}

/** Removes sandbox workspaces (and their users) older than the TTL. */
export async function purgeDemoWorkspaces(deps: Deps) {
  const cutoff = new Date(deps.now().getTime() - DEMO_TTL_MS);
  const old = await deps.db.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.isDemo, true), lt(organizations.createdAt, cutoff)));
  if (!old.length) return 0;
  const ids = old.map((o) => o.id);
  const members = await deps.db.select({ userId: memberships.userId }).from(memberships).where(inArray(memberships.orgId, ids));
  await deps.db.delete(organizations).where(inArray(organizations.id, ids));
  if (members.length) await deps.db.delete(users).where(inArray(users.id, members.map((m) => m.userId)));
  return ids.length;
}
