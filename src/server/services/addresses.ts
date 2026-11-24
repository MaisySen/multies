import { and, asc, eq } from "drizzle-orm";
import type { DB } from "../db";
import type { Deps } from "../context";
import { aliases, domains, mailboxes, members, users } from "../db/schema";
import { audit } from "./audit";
import { newId } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { callerWho, canOpen, isPersonalOwner } from "./mail-access-priv1a";
import type { CallerLike } from "../lib/actor-kind";
import { assertCanCreate, getPlan } from "./plans";
import { isOperatorDomainRow, type OperatorConfig } from "./suite/operator-inbox";
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

/** PRIV1b (P37): the member of this workspace who signs in with `address`, if any. One indexed read (users.email is unique). */
export async function memberSigningInAs(db: DB, orgId: string, address: string) {
  return db.select({ userId: users.id, email: users.email }).from(users)
    .innerJoin(members, and(eq(members.userId, users.id), eq(members.organizationId, orgId), eq(members.kind, "human")))
    .where(eq(users.email, address.toLowerCase())).get();
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

/**
 * `operator` (R26, DF-18): the deployment's operator settings. support@ and security@ on the company domain in the
 * operator workspace are the deployment's own addresses, so they don't count against that workspace's plan.
 */
export async function createMailbox(db: DB, orgId: string, input: CreateMailboxInput, operator?: OperatorConfig, who?: { deps: Deps; userId: string; email?: string | null; ip?: string | null }) {
  const d = await domainInOrg(db, orgId, input.domainId);
  const operatorAddress = !!operator && isOperatorDomainRow(operator, { orgId, name: d.name })
    && operator.operatorInbox.addresses.includes(`${input.localPart}@${d.name}`.toLowerCase());
  if (!operatorAddress) await assertCanCreate(db, orgId, "mailboxes");
  const plan = await getPlan(db, orgId);
  const quotaMb = input.quotaMb ?? plan.limits.storagePerMailboxMb;
  if (quotaMb > plan.limits.storagePerMailboxMb) {
    throw badRequest(`The ${plan.name} plan allows up to ${plan.limits.storagePerMailboxMb} MB per mailbox.`);
  }
  const address = `${input.localPart}@${d.name}`;
  await assertAddressFree(db, address);
  const id = newId("mbx");
  await db.insert(mailboxes).values({ id, orgId, domainId: d.id, localPart: input.localPart, address, displayName: input.displayName, quotaMb });
  // PRIV1b (P37): a mailbox at a colleague's sign in address receives their account mail (password resets).
  // Allowed (that is how an admin sets up Pat's mailbox), but Pat is told and the audit log says who did it.
  if (who) {
    const target = await memberSigningInAs(db, orgId, address);
    if (target && target.userId !== who.userId) {
      await audit(db, { orgId, actorUserId: who.userId || null, actorEmail: who.email ?? null, action: "mailbox.created_at_member_login", targetType: "mailbox", targetId: id, metadata: { address, memberUserId: target.userId }, ip: who.ip ?? null });
      const { notify } = await import("./suite/notify");
      await notify(who.deps, orgId, target.userId, { type: "security.mailbox_at_login", entityType: "mailbox", entityId: id, title: `A mailbox was created at your sign in address ${address}. Mail for it, including password resets, now lands there.`, actorName: who.email ?? null });
    }
  }
  return getMailbox(db, orgId, id);
}

export async function updateMailbox(db: DB, orgId: string, id: string, patch: { displayName?: string; quotaMb?: number; status?: "active" | "suspended"; replyTo?: string | null }, who: CallerLike & { userId: string; role?: "owner" | "admin" | "member" | null }) {
  const m = await getMailbox(db, orgId, id);
  // PRIV1b (P7): on a personal mailbox only its owner (nobody on an orphan, P9) sets the name and Reply-To,
  // so an admin can't route the owner's replies to herself. Admins keep quota and status; elsewhere admins only.
  const admin = who.role === "owner" || who.role === "admin";
  if ((patch.quotaMb !== undefined || patch.status !== undefined) && !admin) throw forbidden("Only workspace owners and admins can change a mailbox's storage or status.");
  if (patch.displayName !== undefined || patch.replyTo !== undefined) {
    const own = m.personal ? await isPersonalOwner(db, callerWho({ ...who, orgId }), m.id) : undefined;
    // PRIV1b (P7, S3): like the rest of PRIV1a, a personal mailbox the caller can't open answers 404; a share gets 403.
    if (m.personal && !own && !(await canOpen(db, callerWho({ ...who, orgId }), m.id, "read"))) throw notFound("Mailbox");
    if (m.personal ? !own : !admin) throw forbidden(m.personal ? "Only the person this mailbox belongs to can change its name or Reply-To." : "Only workspace owners and admins can change a mailbox.");
  }
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

export async function createAlias(db: DB, orgId: string, input: CreateAliasInput, actorUserId = "") {
  const d = await domainInOrg(db, orgId, input.domainId);
  await assertCanCreate(db, orgId, "aliases");
  const address = `${input.localPart}@${d.name}`;
  await assertAddressFree(db, address);
  // PRIV1b (P37): an alias at a colleague's sign in address would forward their password resets wherever the admin points it.
  const target = await memberSigningInAs(db, orgId, address);
  if (target && target.userId !== actorUserId) throw conflict(`${address} is the sign in address of a member of this workspace. Create a mailbox for them instead.`);
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
