import { count, eq } from "drizzle-orm";
import type { DB } from "../db";
import { aliases, domains, mailboxes, memberships, organizations } from "../db/schema";
import { PLANS, type Plan } from "@/shared/plans";
import { notFound, planLimit } from "../lib/errors";

export async function getOrg(db: DB, orgId: string) {
  const org = await db.select().from(organizations).where(eq(organizations.id, orgId)).get();
  if (!org) throw notFound("Workspace");
  return org;
}

export async function getPlan(db: DB, orgId: string): Promise<Plan> {
  return PLANS[(await getOrg(db, orgId)).plan];
}

export async function usage(db: DB, orgId: string) {
  const [d, m, a, s] = await Promise.all([
    db.select({ n: count() }).from(domains).where(eq(domains.orgId, orgId)).get(),
    db.select({ n: count() }).from(mailboxes).where(eq(mailboxes.orgId, orgId)).get(),
    db.select({ n: count() }).from(aliases).where(eq(aliases.orgId, orgId)).get(),
    db.select({ n: count() }).from(memberships).where(eq(memberships.orgId, orgId)).get(),
  ]);
  return { domains: d?.n ?? 0, mailboxes: m?.n ?? 0, aliases: a?.n ?? 0, seats: s?.n ?? 0 };
}

const LABEL = { domains: "domains", mailboxes: "mailboxes", aliases: "aliases" } as const;

/** Throws a 403 `plan_limit` when creating one more `kind` would exceed the plan. */
export async function assertCanCreate(db: DB, orgId: string, kind: keyof typeof LABEL) {
  // (seats are enforced in services/team.ts, where pending invites count too)
  const [plan, used] = await Promise.all([getPlan(db, orgId), usage(db, orgId)]);
  const limit = plan.limits[kind];
  if (used[kind] >= limit) {
    throw planLimit(`Your ${plan.name} plan includes ${limit} ${limit === 1 ? LABEL[kind].replace(/s$/, "") : LABEL[kind]}. Upgrade to add more.`);
  }
}
