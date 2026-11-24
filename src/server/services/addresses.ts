import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { DB } from "../db";
import type { Deps } from "../context";
import { agentMailboxAccess, aliases, authEmailHooks, domains, mailboxAccess, mailConnections, mailboxes, members, users } from "../db/schema";
import { audit } from "./audit";
import { newId } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { callerWho, canOpen, isPersonalOwner, personalOwnerState } from "./mail-access-priv1a";
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

/**
 * Wave 2 review X3 (P37): a team mailbox at a member's sign in address becomes that member's personal mailbox only when
 * the workspace owner confirms it in Settings. Converting on join (or on an email change) let an admin capture an
 * unshared team mailbox as a sockpuppet's personal mailbox by inviting its address. Only the workspace owner, signed in
 * to the app, and only for a mailbox in the admins' list (loginAddressTeamMailboxes). A domain's catch-all and a mailbox
 * that sends the workspace's sign-up emails can't be personal, so they are refused with the reason. Other people's
 * grants and AI agents' access to it end with the conversion (they would no longer open it); the audit entry counts them
 * and the member is told.
 */
export async function convertLoginMailbox(deps: Deps, who: CallerLike & { orgId: string; userId: string; email?: string | null; role?: string | null }, mailboxId: string, ip?: string | null) {
  const { requirePerson } = await import("../lib/actor-kind");
  requirePerson(who, "Making a team mailbox someone's personal mailbox");
  if (who.role !== "owner") throw forbidden("Only the workspace owner can make a team mailbox a member's personal mailbox.");
  const listed = (await loginAddressTeamMailboxes(deps, who.orgId, 500)).find((m) => m.id === mailboxId);
  if (!listed) throw notFound("Team mailbox at a member's sign in address");
  const mb = (await deps.db.select().from(mailboxes).where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, who.orgId))).get())!;
  const [d, hook] = await Promise.all([
    deps.db.select({ catchAll: domains.catchAllMailboxId }).from(domains).where(eq(domains.id, mb.domainId)).get(),
    deps.db.select({ id: authEmailHooks.id }).from(authEmailHooks).where(eq(authEmailHooks.mailboxId, mb.id)).get(),
  ]);
  if (d?.catchAll === mb.id) throw conflict(`${mb.address} catches mail for unknown addresses on its domain, so it stays a team mailbox. Pick another catch-all first.`);
  if (hook) throw conflict(`${mb.address} sends this workspace's sign-up emails, so it stays a team mailbox. Pick another mailbox for them first.`);
  const won = await deps.db.update(mailboxes).set({ personal: true, ownerUserId: listed.userId })
    .where(and(eq(mailboxes.id, mb.id), eq(mailboxes.personal, false))).returning({ id: mailboxes.id });
  if (!won.length) throw conflict(`${mb.address} is already a personal mailbox.`);
  const grants = await deps.db.delete(mailboxAccess).where(and(eq(mailboxAccess.mailboxId, mb.id), ne(mailboxAccess.userId, listed.userId))).returning({ u: mailboxAccess.userId });
  const agentRows = await deps.db.delete(agentMailboxAccess).where(eq(agentMailboxAccess.mailboxId, mb.id)).returning({ a: agentMailboxAccess.agentId });
  // Wave 3 review Y8 (a): app passwords someone else made while it was a team mailbox go too, as when a share ends.
  await (await import("./mailserver")).destroyForeignAppPasswords(deps, who.orgId, mb.id).catch((err: unknown) => deps.reportError?.(err, { where: "make_personal.app_passwords" }));
  await audit(deps.db, { orgId: who.orgId, actorUserId: who.userId, actorEmail: who.email ?? null, action: "mailbox.made_personal_by_owner", targetType: "mailbox", targetId: mb.id, ip: ip ?? null,
    metadata: { address: mb.address, memberUserId: listed.userId, grantsEnded: grants.length, agentsEnded: agentRows.length } });
  const { notify } = await import("./suite/notify");
  await notify(deps, who.orgId, listed.userId, { type: "security.mailbox_at_login", entityType: "mailbox", entityId: mb.id, title: `${mb.address}, at your sign in address, is now your personal mailbox: mail for it, including password resets, lands there and only you can open it.`, actorName: who.email ?? null }).catch(() => undefined);
  return { id: mb.id, address: mb.address, personal: true as const, ownerUserId: listed.userId, grantsEnded: grants.length, agentsEnded: agentRows.length };
}

/**
 * Wave 1 review V12: for admins, the team mailboxes at a member's sign in address (left as team mailboxes because they
 * are in team use, or made before the rule): account mail for that member, password resets included, lands there.
 * Wave 2 review X3: the workspace owner converts one with convertLoginMailbox; nothing converts on its own.
 */
export async function loginAddressTeamMailboxes(deps: Deps, orgId: string, limit = 50) {
  const rows = await deps.db.select({ id: mailboxes.id, address: mailboxes.address, domainName: domains.name, memberName: users.name, memberEmail: users.email, userId: users.id }).from(mailboxes)
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .innerJoin(users, sql`lower(${users.email}) = lower(${mailboxes.address})`)
    .innerJoin(members, and(eq(members.userId, users.id), eq(members.organizationId, mailboxes.orgId), eq(members.kind, "human")))
    .where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.personal, false), eq(mailboxes.kind, "person"), sql`${mailboxes.orgId} <> 'org_platform'`)).limit(limit);
  return rows.filter((r) => !(isOperatorDomainRow(deps.config, { orgId, name: r.domainName }) && deps.config.operatorInbox.addresses.includes(r.address.toLowerCase())))
    .map((r) => ({ id: r.id, address: r.address, member: r.memberName || r.memberEmail, userId: r.userId }));
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
  // PRIV1b (P37, round 2 owner decision): a mailbox at a human member's sign in address receives that person's account
  // mail (password resets, sign in links), so it is that person's personal mailbox, whoever creates it. The operator's
  // own addresses (support@, security@ on the company domain) stay team mailboxes. Migration 0174 did the same for
  // mailboxes made before.
  const target = operatorAddress ? undefined : await memberSigningInAs(db, orgId, address);
  await db.insert(mailboxes).values({ id, orgId, domainId: d.id, localPart: input.localPart, address, displayName: input.displayName, quotaMb, ...(target ? { personal: true, ownerUserId: target.userId } : {}) });
  // Allowed (that is how an admin sets up Pat's mailbox), but Pat is told and the audit log says who did it.
  if (who) {
    if (target && target.userId !== who.userId) {
      await audit(db, { orgId, actorUserId: who.userId || null, actorEmail: who.email ?? null, action: "mailbox.created_at_member_login", targetType: "mailbox", targetId: id, metadata: { address, memberUserId: target.userId }, ip: who.ip ?? null });
      const { notify } = await import("./suite/notify");
      await notify(who.deps, orgId, target.userId, { type: "security.mailbox_at_login", entityType: "mailbox", entityId: id, title: `A mailbox was created at your sign in address ${address}. It is your personal mailbox: mail for it, including password resets, lands there and only you can open it.`, actorName: who.email ?? null });
    }
  }
  return getMailbox(db, orgId, id);
}

type Who = CallerLike & { userId: string; role?: "owner" | "admin" | "member" | null };

/**
 * PRIV1b (P59, round 2 owner decision): only the person a personal mailbox belongs to suspends, deletes or disconnects
 * it. Once that person has left (an orphan), the workspace owner may. Anyone else who can open it (a share) gets 403;
 * anyone who can't gets 404, as everywhere in PRIV1a. Team and agent mailboxes are not checked here.
 */
export async function assertMayRemovePersonal(db: DB, orgId: string, mailboxId: string, who: Who) {
  const st = await personalOwnerState(db, callerWho({ ...who, orgId }), mailboxId);
  if (st === undefined || st === "owner") return;
  if (st === "orphan" && who.role === "owner") return;
  if (await canOpen(db, callerWho({ ...who, orgId }), mailboxId, "read")) throw forbidden("Only the person this mailbox belongs to can suspend, delete or disconnect it.");
  throw notFound("Mailbox");
}

export async function updateMailbox(db: DB, orgId: string, id: string, patch: { displayName?: string; quotaMb?: number; status?: "active" | "suspended"; replyTo?: string | null }, who: Who) {
  const m = await getMailbox(db, orgId, id);
  // PRIV1b (P7): on a personal mailbox only its owner (nobody on an orphan, P9) sets the name and Reply-To,
  // so an admin can't route the owner's replies to herself. Admins keep quota; elsewhere admins only.
  // PRIV1b (P59): and only its owner (the workspace owner once the owner left) suspends it.
  const admin = who.role === "owner" || who.role === "admin";
  if (patch.status !== undefined && m.personal) await assertMayRemovePersonal(db, orgId, m.id, who);
  else if (patch.status !== undefined && !admin) throw forbidden("Only workspace owners and admins can change a mailbox's storage or status.");
  if (patch.quotaMb !== undefined && !admin) throw forbidden("Only workspace owners and admins can change a mailbox's storage or status.");
  // Wave 1 review V3: a connected mailbox waiting for its emailed code (P60) stays suspended until the code is entered.
  if (patch.status === "active" && m.status !== "active" && await db.select({ id: mailConnections.id }).from(mailConnections).where(and(eq(mailConnections.mailboxId, m.id), eq(mailConnections.status, "verifying"))).get()) {
    throw conflict("This mailbox waits for the code we emailed to its address. Enter the code to turn it on.");
  }
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
  // Wave 2 review X5: a suspend made while a connection waits for its code is not undone when the code is entered.
  if (patch.status === "suspended") await db.update(mailConnections).set({ verifySuspendedMailbox: false }).where(and(eq(mailConnections.mailboxId, m.id), eq(mailConnections.verifySuspendedMailbox, true)));
  return getMailbox(db, orgId, id);
}

/**
 * Who may delete this mailbox (before anything is removed, the mail server account included): a team mailbox takes a
 * workspace owner or admin; a personal one its owner (P59). Returns the mailbox.
 */
export async function assertMayDeleteMailbox(db: DB, orgId: string, id: string, who: Who) {
  const m = await getMailbox(db, orgId, id);
  if (m.personal) await assertMayRemovePersonal(db, orgId, m.id, who);
  else if (who.role !== "owner" && who.role !== "admin") throw forbidden("Only workspace owners and admins can delete a mailbox.");
  return m;
}

export async function deleteMailbox(db: DB, orgId: string, id: string, who: Who) {
  const m = await assertMayDeleteMailbox(db, orgId, id, who);
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
