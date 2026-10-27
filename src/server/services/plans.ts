import { and, count, eq, sql } from "drizzle-orm";
import type { DB } from "../db";
import { aliases, domains, mailboxes, members, orgAddons, organizations, usageCounters } from "../db/schema";
import { ADDONS, ADDON_ORDER, PLANS, effectiveLimits, isAddonId, type AddonId, type AddonQuantities, type Plan } from "@/shared/plans";
import { notFound, planLimit } from "../lib/errors";

export async function getOrg(db: DB, orgId: string) {
  const org = await db.select().from(organizations).where(eq(organizations.id, orgId)).get();
  if (!org) throw notFound("Workspace");
  return org;
}

export async function getAddons(db: DB, orgId: string): Promise<AddonQuantities> {
  const rows = await db.select().from(orgAddons).where(eq(orgAddons.orgId, orgId));
  const out: AddonQuantities = {};
  for (const r of rows) if (isAddonId(r.addonId) && r.quantity > 0) out[r.addonId] = r.quantity;
  return out;
}

/** Replaces a workspace's add-ons (from the Stripe subscription, or instantly when billing is off). */
export async function setAddons(db: DB, orgId: string, addons: AddonQuantities) {
  await db.delete(orgAddons).where(eq(orgAddons.orgId, orgId));
  const rows = ADDON_ORDER.filter((id) => (addons[id] ?? 0) > 0).map((id) => ({ orgId, addonId: id, quantity: Math.min(addons[id]!, ADDONS[id].maxQuantity) }));
  if (rows.length) await db.insert(orgAddons).values(rows);
}

/** The workspace's plan with its add-ons applied to the limits. */
export async function getPlan(db: DB, orgId: string): Promise<Plan & { addons: AddonQuantities }> {
  const [org, addons] = await Promise.all([getOrg(db, orgId), getAddons(db, orgId)]);
  const base = PLANS[org.plan];
  return { ...base, limits: effectiveLimits(base, addons), addons };
}

/** "2026-10": metered allowances reset on the first of each month (UTC). */
export const periodOf = (now: Date) => now.toISOString().slice(0, 7);

export async function readCounter(db: DB, orgId: string, metric: string, now: Date) {
  const row = await db.select({ n: usageCounters.count }).from(usageCounters)
    .where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.period, periodOf(now)), eq(usageCounters.metric, metric))).get();
  return row?.n ?? 0;
}

/** Adds to a monthly counter and returns the new total. */
export async function bumpCounter(db: DB, orgId: string, metric: string, now: Date, by = 1) {
  const period = periodOf(now);
  await db.insert(usageCounters).values({ orgId, period, metric, count: by })
    .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.period, usageCounters.metric], set: { count: sql`${usageCounters.count} + ${by}` } });
  return readCounter(db, orgId, metric, now);
}

export async function usage(db: DB, orgId: string, now = new Date()) {
  // R40 (MB-199): one statement with scalar subqueries instead of seven queries. Each query costs the Worker
  // a round of statement building, binding and result mapping, and this runs on every /api/org and billing read.
  // The rows read are the same (each subquery uses the same org index as before).
  const period = periodOf(now);
  const row = await db.select({
    d: sql<number>`(select count(*) from ${domains} where ${domains.orgId} = ${orgId})`,
    m: sql<number>`(select count(*) from ${mailboxes} where ${mailboxes.orgId} = ${orgId} and ${mailboxes.kind} = 'person')`,
    ag: sql<number>`(select count(*) from ${mailboxes} where ${mailboxes.orgId} = ${orgId} and ${mailboxes.kind} = 'agent')`,
    a: sql<number>`(select count(*) from ${aliases} where ${aliases.orgId} = ${orgId})`,
    // AI agent members take no seat (they have their own limit, agentMembers).
    s: sql<number>`(select count(*) from ${members} where ${members.organizationId} = ${orgId} and ${members.kind} = 'human')`,
    st: sql<number>`(select coalesce(sum(${mailboxes.usedBytes}), 0) from ${mailboxes} where ${mailboxes.orgId} = ${orgId})`,
    am: sql<number>`(select ${usageCounters.count} from ${usageCounters} where ${usageCounters.orgId} = ${orgId} and ${usageCounters.period} = ${period} and ${usageCounters.metric} = 'agent_messages')`,
  }).from(sql`(select 1)`).get();
  return {
    domains: Number(row?.d ?? 0), mailboxes: Number(row?.m ?? 0), agentInboxes: Number(row?.ag ?? 0), aliases: Number(row?.a ?? 0), seats: Number(row?.s ?? 0),
    storageMb: Math.ceil(Number(row?.st ?? 0) / (1024 * 1024)), agentMessages: Number(row?.am ?? 0),
  };
}

/** The add-on that raises a limit, for upgrade prompts. */
export const ADDON_FOR: Partial<Record<string, AddonId>> = {
  domains: "domain", mailboxes: "mailboxes", seats: "mailboxes", aliases: "mailboxes", storageMb: "storage",
  dailySends: "send_boost", agentInboxes: "agent_inbox", agentMessagesMonthly: "agent_inbox",
};

/** "Add an extra domain for A$1 a month." */
export function addonHint(limit: string) {
  const id = ADDON_FOR[limit];
  if (!id) return "Add more from Billing.";
  const a = ADDONS[id];
  const price = `A$${a.priceMonthly} a month`;
  return `Add ${a.unit === "domain" ? "an extra domain" : a.unit === "inbox" ? "an agent inbox" : `a ${a.name.toLowerCase()} (${a.unit})`} for ${price}.`;
}

const LABEL = { domains: "domains", mailboxes: "mailboxes", aliases: "aliases", agentInboxes: "agent inboxes" } as const;

async function countOf(db: DB, orgId: string, kind: keyof typeof LABEL) {
  const q = kind === "domains" ? db.select({ n: count() }).from(domains).where(eq(domains.orgId, orgId))
    : kind === "aliases" ? db.select({ n: count() }).from(aliases).where(eq(aliases.orgId, orgId))
    : db.select({ n: count() }).from(mailboxes).where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.kind, kind === "mailboxes" ? "person" : "agent")));
  return (await q.get())?.n ?? 0;
}

/** Throws a 403 `plan_limit` when creating one more `kind` would exceed the plan. */
export async function assertCanCreate(db: DB, orgId: string, kind: keyof typeof LABEL) {
  // (seats are enforced in services/team.ts, where pending invites count too)
  // Counts only the one thing being created: the full usage() read (seven queries, including
  // usage_counters) ran once per mailbox, alias and domain a demo makes (Sentry MYMAIL-API-M).
  const [plan, used] = await Promise.all([getPlan(db, orgId), countOf(db, orgId, kind)]);
  const limit = plan.limits[kind];
  if (used >= limit) {
    const what = limit === 1 ? LABEL[kind].replace(/es$/, "").replace(/s$/, "") : LABEL[kind];
    throw planLimit(`Your workspace includes ${limit} ${what}. ${addonHint(kind)}`);
  }
}

/** Limits the workspace is already over for a set of limits, e.g. after removing an add-on. */
export function overLimits(used: Awaited<ReturnType<typeof usage>>, limits: Plan["limits"]) {
  const pairs: [keyof typeof used, keyof Plan["limits"], string][] = [
    ["domains", "domains", "domains"], ["mailboxes", "mailboxes", "mailboxes"], ["agentInboxes", "agentInboxes", "agent inboxes"],
    ["aliases", "aliases", "aliases"], ["seats", "seats", "people"], ["storageMb", "storageMb", "stored mail"],
  ];
  return pairs.filter(([u, l]) => used[u] > limits[l]).map(([, , label]) => label);
}
