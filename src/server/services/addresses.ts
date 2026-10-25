import { and, asc, eq } from "drizzle-orm";
import type { DB } from "../db";
import { aliases, domains, mailboxes } from "../db/schema";
import { newId } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/errors";
import { assertCanCreate, getPlan } from "./plans";
import type { CreateAliasInput, CreateMailboxInput } from "@/shared/schemas";

async function domainInOrg(db: DB, orgId: string, domainId: string) {
  const d = await db.select().from(domains).where(and(eq(domains.id, domainId), eq(domains.orgId, orgId))).get();
  if (!d) throw notFound("Domain");
  return d;
}

/** An address is either a mailbox or an alias, never both. */
async function assertAddressFree(db: DB, address: string) {
  const [m, a] = await Promise.all([
    db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.address, address)).get(),
    db.select({ id: aliases.id }).from(aliases).where(eq(aliases.address, address)).get(),
  ]);
  if (m || a) throw conflict(`${address} is already in use.`);
}

// ---------------------------------------------------------------- mailboxes

/** People's mailboxes by default; agent inboxes are listed with their agents. */
export async function listMailboxes(db: DB, orgId: string, kind: "person" | "agent" | "all" = "person") {
  return db.select().from(mailboxes).where(and(eq(mailboxes.orgId, orgId), kind === "all" ? undefined : eq(mailboxes.kind, kind))).orderBy(asc(mailboxes.address));
}

export async function getMailbox(db: DB, orgId: string, id: string) {
  const m = await db.select().from(mailboxes).where(and(eq(mailboxes.id, id), eq(mailboxes.orgId, orgId))).get();
  if (!m) throw notFound("Mailbox");
  return m;
}

export async function createMailbox(db: DB, orgId: string, input: CreateMailboxInput) {
  const d = await domainInOrg(db, orgId, input.domainId);
  await assertCanCreate(db, orgId, "mailboxes");
  const plan = await getPlan(db, orgId);
  const quotaMb = input.quotaMb ?? plan.limits.storagePerMailboxMb;
  if (quotaMb > plan.limits.storagePerMailboxMb) {
    throw badRequest(`The ${plan.name} plan allows up to ${plan.limits.storagePerMailboxMb} MB per mailbox.`);
  }
  const address = `${input.localPart}@${d.name}`;
  await assertAddressFree(db, address);
  const id = newId("mbx");
  await db.insert(mailboxes).values({ id, orgId, domainId: d.id, localPart: input.localPart, address, displayName: input.displayName, quotaMb });
  return getMailbox(db, orgId, id);
}

export async function updateMailbox(db: DB, orgId: string, id: string, patch: { displayName?: string; quotaMb?: number; status?: "active" | "suspended"; replyTo?: string | null }) {
  const m = await getMailbox(db, orgId, id);
  if (patch.quotaMb !== undefined) {
    const plan = await getPlan(db, orgId);
    if (patch.quotaMb > plan.limits.storagePerMailboxMb) throw badRequest(`The ${plan.name} plan allows up to ${plan.limits.storagePerMailboxMb} MB per mailbox.`);
    if (patch.quotaMb * 1024 * 1024 < m.usedBytes) throw badRequest("The quota can't be lower than what the mailbox already stores.");
  }
  await db.update(mailboxes).set(patch).where(eq(mailboxes.id, m.id));
  return getMailbox(db, orgId, id);
}

export async function deleteMailbox(db: DB, orgId: string, id: string) {
  const m = await getMailbox(db, orgId, id);
  if (m.kind === "agent") throw conflict("This is an agent inbox. Delete the agent instead, from Agents or DELETE /api/v1/agents/{id}.");
  await db.update(domains).set({ catchAllMailboxId: null }).where(eq(domains.catchAllMailboxId, m.id));
  await db.delete(mailboxes).where(eq(mailboxes.id, m.id));
  return m;
}

// ---------------------------------------------------------------- aliases

export function presentAlias(a: typeof aliases.$inferSelect) {
  return { ...a, destinations: JSON.parse(a.destinations) as string[] };
}

export async function listAliases(db: DB, orgId: string) {
  const rows = await db.select().from(aliases).where(eq(aliases.orgId, orgId)).orderBy(asc(aliases.address));
  return rows.map(presentAlias);
}

export async function getAlias(db: DB, orgId: string, id: string) {
  const a = await db.select().from(aliases).where(and(eq(aliases.id, id), eq(aliases.orgId, orgId))).get();
  if (!a) throw notFound("Alias");
  return a;
}

function cleanDestinations(address: string, destinations: string[]) {
  const unique = [...new Set(destinations.map((d) => d.toLowerCase()))];
  if (unique.includes(address)) throw badRequest("An alias can't forward to itself.");
  return unique;
}

export async function createAlias(db: DB, orgId: string, input: CreateAliasInput) {
  const d = await domainInOrg(db, orgId, input.domainId);
  await assertCanCreate(db, orgId, "aliases");
  const address = `${input.localPart}@${d.name}`;
  await assertAddressFree(db, address);
  const id = newId("als");
  await db.insert(aliases).values({ id, orgId, domainId: d.id, localPart: input.localPart, address, destinations: JSON.stringify(cleanDestinations(address, input.destinations)) });
  return presentAlias(await getAlias(db, orgId, id));
}

export async function updateAlias(db: DB, orgId: string, id: string, patch: { destinations?: string[]; enabled?: boolean }) {
  const a = await getAlias(db, orgId, id);
  await db.update(aliases).set({
    enabled: patch.enabled,
    destinations: patch.destinations ? JSON.stringify(cleanDestinations(a.address, patch.destinations)) : undefined,
  }).where(eq(aliases.id, a.id));
  return presentAlias(await getAlias(db, orgId, id));
}

export async function deleteAlias(db: DB, orgId: string, id: string) {
  const a = await getAlias(db, orgId, id);
  await db.delete(aliases).where(eq(aliases.id, a.id));
  return presentAlias(a);
}
