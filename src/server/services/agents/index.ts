/**
 * Agent inboxes: email addresses for AI agents, worked through agent-scoped API keys and
 * the MCP server. Each agent has its own inbox (a mailbox of kind `agent`) and can be
 * given shared mailboxes too, so people and agents work the same threads. Guardrails:
 * a daily send cap, an optional recipient allow list, an approval mode (a person approves
 * sends before they leave), the plan's monthly agent message allowance, and an audit log
 * entry for everything an agent does.
 */
import { and, asc, count, desc, eq, gt, gte, lt, or, sql, type SQL } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import {
  agentEvents, agentMailboxAccess, agents, apiKeys, attachments, auditLogs, domains, mailboxes, messages, sendApprovals, users,
} from "../../db/schema";

/** Agent thread reads are audited once per agent, thread and hour. */
export const READ_AUDIT_ROLLUP_MS = 60 * 60_000;
import { fromB64Or, newId, randomToken } from "../../lib/crypto";
import { HttpError, badRequest, conflict, forbidden, notFound, planLimit } from "../../lib/errors";
import { audit } from "../audit";
import { addonHint, assertCanCreate, bumpCounter, getPlan, readCounter } from "../plans";
import { createApiKey, listApiKeys } from "../developer/api-keys";
import { emitEvent } from "../developer/webhooks";
import { routeRecipient } from "../mail/delivery";
import { sendMessage, type SendResult } from "../mail/send";
import { deprovisionMailbox } from "../mailserver";
import { mailboxScope } from "../team";
import { memberSigningInAs } from "../addresses";
import { assertOpen, keepOpenableBy } from "../mail-access-priv1a";
import { assertMailboxNotHeld } from "../mail/archive-r111"; // PRIV1b (P44)
import { logMailboxOpen } from "../mailbox-sharing-priv1a";
import { agentMessage, extractCodes, extractLinks, latestText } from "./parse";
import { listThreadStates, threadViewCond, type ThreadView } from "../mail/thread-state";
import { inChunks, inIds } from "../../lib/sql-chunks";
import { containsAny } from "../../lib/like-search";
import { callerKind, isPersonSession, requirePerson } from "../../lib/actor-kind";

type Agent = typeof agents.$inferSelect;
type Mailbox = typeof mailboxes.$inferSelect;

/** Who is acting: a person in the app, a workspace API key, or an agent's own key. */
export type Actor = AuthContext & { apiKeyId?: string; agentId?: string | null };

export type ApprovalMode = Agent["approvalMode"];

const DAY = 86_400_000;
const APPROVAL_TTL_DAYS = 7;

/**
 * AIS1 (row 51): a new agent's daily send cap when nobody asks for another. A person in the app may set more, up
 * to the plan's limit; a key or a connected AI app may only set less. It used to default to the plan's limit
 * (2,000 a day on Business), for agents made in the app and through the API alike.
 */
export const AGENT_DEFAULT_DAILY_SENDS = 100;

/** AIS1 (row 4): how much each approval mode holds back. A key may move an agent up this scale, never down. */
const APPROVAL_RANK: Record<"never" | "external" | "always", number> = { never: 0, external: 1, always: 2 };

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";

function parseAllow(v: string | null): string[] | null {
  return v ? (JSON.parse(v) as string[]) : null;
}

export function presentAgent(a: Agent, mb: Pick<Mailbox, "address" | "displayName" | "id">, extra: { mailboxIds?: string[]; sentToday?: number; pendingApprovals?: number } = {}) {
  return {
    id: a.id, name: a.name, description: a.description, address: mb.address, inboxId: mb.id,
    approvalMode: a.approvalMode, sendCapDaily: a.sendCapDaily, allowedRecipients: parseAllow(a.allowedRecipients),
    status: a.status, mailboxIds: extra.mailboxIds ?? [mb.id], sentToday: extra.sentToday ?? 0, pendingApprovals: extra.pendingApprovals ?? 0,
    createdAt: a.createdAt,
  };
}

async function row(deps: Deps, orgId: string, id: string) {
  const r = await deps.db.select({ a: agents, mb: mailboxes }).from(agents).innerJoin(mailboxes, eq(mailboxes.id, agents.mailboxId))
    .where(and(eq(agents.id, id), eq(agents.orgId, orgId))).get();
  if (!r) throw notFound("Agent");
  return r;
}

/** The agent's own inbox plus the mailboxes it was given. */
export async function agentMailboxIds(deps: Deps, a: Agent): Promise<string[]> {
  const rows = await deps.db.select({ id: agentMailboxAccess.mailboxId }).from(agentMailboxAccess).where(eq(agentMailboxAccess.agentId, a.id));
  // PRIV1a: an agent never reaches a personal mailbox its maker can't open (an admin can't route someone's inbox through one).
  return keepOpenableBy(deps.db, a.orgId, a.createdByUserId, [a.mailboxId, ...rows.map((r) => r.id).filter((id) => id !== a.mailboxId)]);
}

/**
 * PRIV1b (P4): the agent's mailboxes as this caller may work them. The agent's own key gets them all; a person or a
 * workspace key acting for the agent loses the personal mailboxes the caller doesn't own (the maker's private inbox
 * isn't open to every admin's key through the agent).
 */
export async function agentMailboxIdsFor(deps: Deps, actor: Actor, agent: Agent | string): Promise<string[]> {
  const a = typeof agent === "string" ? (await row(deps, actor.orgId, agent)).a : agent;
  const ids = await agentMailboxIds(deps, a);
  return actor.agentId === a.id ? ids : keepOpenableBy(deps.db, a.orgId, actor.userId, ids);
}

const startOfUtcDay = (now: Date) => new Date(Math.floor(now.getTime() / DAY) * DAY);

/**
 * R58: the agent's sent mail today. The workspace filter lets it ride the (org_id, folder, date) index; without it the
 * count read every message of every workspace (a full table scan on each agent send and each agent card).
 */
export function agentSentTodayQuery(db: Deps["db"], a: { id: string; orgId: string }, since: Date) {
  return db.select({ n: count() }).from(messages).where(and(eq(messages.orgId, a.orgId), eq(messages.folder, "sent"), gte(messages.date, since), eq(messages.sentByAgentId, a.id)));
}

async function sentTodayBy(deps: Deps, a: { id: string; orgId: string }) {
  const since = startOfUtcDay(deps.now());
  const agentId = a.id;
  const [sent, queued] = await Promise.all([
    agentSentTodayQuery(deps.db, a, since).get(),
    deps.db.select({ n: count() }).from(sendApprovals).where(and(eq(sendApprovals.agentId, agentId), eq(sendApprovals.status, "pending"), gte(sendApprovals.createdAt, since))).get(),
  ]);
  return (sent?.n ?? 0) + (queued?.n ?? 0);
}

async function withStats(deps: Deps, a: Agent, mb: Mailbox) {
  const [mailboxIds, sentToday, pending] = await Promise.all([
    agentMailboxIds(deps, a),
    sentTodayBy(deps, a),
    deps.db.select({ n: count() }).from(sendApprovals).where(and(eq(sendApprovals.agentId, a.id), eq(sendApprovals.status, "pending"))).get(),
  ]);
  return presentAgent(a, mb, { mailboxIds, sentToday, pendingApprovals: pending?.n ?? 0 });
}

export async function listAgents(deps: Deps, orgId: string) {
  const rows = await deps.db.select({ a: agents, mb: mailboxes }).from(agents).innerJoin(mailboxes, eq(mailboxes.id, agents.mailboxId))
    .where(eq(agents.orgId, orgId)).orderBy(asc(agents.createdAt));
  return Promise.all(rows.map((r) => withStats(deps, r.a, r.mb)));
}

export async function getAgent(deps: Deps, orgId: string, id: string) {
  const r = await row(deps, orgId, id);
  return withStats(deps, r.a, r.mb);
}

/** An agent key may only act as its own agent. */
export function assertActsAs(actor: Actor, agentId: string) {
  if (actor.agentId && actor.agentId !== agentId) throw new HttpError(403, "agent_key_scope", "This key belongs to another agent.");
}

export function assertWorkspaceActor(actor: Actor) {
  if (actor.agentId) throw new HttpError(403, "agent_key_scope", "Agent keys can't manage agents. Use a workspace key from Settings, Developers.");
  if (actor.role === "member") throw forbidden("Only workspace owners and admins can manage agent inboxes.");
}

/**
 * PRIV1b (P3, P4): a personal mailbox goes on an agent only by its owner's own hand (for a key: the key's creator).
 * Admins manage agents, they don't route someone's private inbox through one, and a share never counts.
 */
async function assertOwnPersonal(deps: Deps, actor: Actor, ids: string[]) {
  if (!ids.length) return;
  const rows = await deps.db.select({ id: mailboxes.id, owner: mailboxes.ownerUserId }).from(mailboxes)
    .where(and(eq(mailboxes.orgId, actor.orgId), eq(mailboxes.personal, true), inIds(mailboxes.id, ids)));
  if (rows.some((r) => !actor.userId || r.owner !== actor.userId)) throw forbidden("Only its owner can give a personal mailbox to an agent.");
}

const actorFields = (actor: Actor) => ({ actorUserId: actor.userId || null, actorEmail: actor.email });

/** For an agent's own actions: the audit actor is the agent, by address. */
const agentActor = (a: Agent, mb: Pick<Mailbox, "address">) => ({ actorUserId: null, actorEmail: `agent:${mb.address}`, agentId: a.id });

/** An allow list as it is stored: lower case, and an empty list means anyone (null). */
const allowList = (v: string[] | null | undefined) => (v?.length ? v.map((r) => r.toLowerCase()) : null);

/**
 * AIS1 (row 4): an agent's guardrails are lowered only by a person signed in to the app. A workspace key or a
 * connected AI app (OAuth) that tries is refused with 403 person_only naming the fields, and the attempt is written
 * to the audit log (on the agent's own log when the agent exists). Nothing is written to the agent.
 */
async function refuseLoosening(deps: Deps, actor: Actor, fields: string[], at: { action: "agent.create_refused" | "agent.update_refused"; agentId?: string; name?: string }) {
  if (!fields.length || isPersonSession(actor)) return;
  await audit(deps.db, { orgId: actor.orgId, ...actorFields(actor), agentId: at.agentId ?? null, action: at.action, targetType: "agent", targetId: at.agentId ?? null, metadata: { fields, caller: callerKind(actor), ...(at.name ? { name: at.name } : {}) } });
  try {
    requirePerson(actor, `${at.action === "agent.create_refused" ? "Creating an agent with looser guardrails" : "Loosening an agent's guardrails"} (${fields.join(", ")})`);
  } catch (err) {
    if (err instanceof HttpError) err.details = { fields };
    throw err;
  }
}

/**
 * AIS1 (row 4): the fields of a patch that would loosen the agent. Tightening is fine: more approval, a lower cap,
 * a narrower allow list (every new entry inside the current one), a pause, fewer mailboxes. The same value sent back
 * is not a loosening, so a client can GET, change one field and PATCH the lot.
 */
function looserFields(a: Agent, patch: UpdateAgentInput, held: Set<string>): string[] {
  const out: string[] = [];
  if (patch.approvalMode && APPROVAL_RANK[patch.approvalMode] < APPROVAL_RANK[a.approvalMode]) out.push("approvalMode");
  if (patch.sendCapDaily !== undefined && patch.sendCapDaily > a.sendCapDaily) out.push("sendCapDaily");
  if (patch.allowedRecipients !== undefined) {
    const now = parseAllow(a.allowedRecipients);
    const next = allowList(patch.allowedRecipients);
    // null (or an empty list) is "anyone". "@acme.io" covers bob@acme.io; bob@acme.io doesn't cover "@acme.io".
    if (now && (!next || next.some((r) => !recipientAllowed(now, r)))) out.push("allowedRecipients");
  }
  if (patch.status === "active" && a.status !== "active") out.push("status");
  if (patch.mailboxIds?.some((m) => m !== a.mailboxId && !held.has(m))) out.push("mailboxIds");
  return out;
}

/**
 * AIS1 (row 51): who a new agent may write to unless a person chose otherwise: the workspace's own verified domains.
 * With none verified yet, the creator's own address (a key's: the person who made the key), so the list is never
 * empty, which would mean anyone. Later domains don't join existing agents' lists.
 */
async function defaultAllowList(deps: Deps, actor: Actor, agentAddress: string): Promise<string[]> {
  const own = await deps.db.select({ name: domains.name }).from(domains).where(and(eq(domains.orgId, actor.orgId), eq(domains.status, "verified"))).orderBy(asc(domains.createdAt));
  if (own.length) return own.map((d) => `@${d.name.toLowerCase()}`);
  const me = actor.userId ? await deps.db.select({ email: users.email }).from(users).where(eq(users.id, actor.userId)).get() : undefined;
  return [(me?.email || agentAddress).toLowerCase()];
}

export async function recordEvent(deps: Deps, orgId: string, agentId: string | null, type: string, data: Record<string, unknown>) {
  await deps.db.insert(agentEvents).values({ orgId, agentId, type, data: JSON.stringify(data) });
}

/**
 * The agent's address. A workspace domain when it has one (verified first); otherwise the
 * shared agent domain, when the deployment sets AGENT_MAIL_DOMAIN.
 */
async function pickDomain(deps: Deps, orgId: string, domainId?: string) {
  if (domainId) {
    const d = await deps.db.select().from(domains).where(and(eq(domains.id, domainId), eq(domains.orgId, orgId))).get();
    if (!d) throw notFound("Domain");
    return { domain: d, shared: false };
  }
  const own = await deps.db.select().from(domains).where(eq(domains.orgId, orgId)).orderBy(sql`case when ${domains.status} = 'verified' then 0 else 1 end`, asc(domains.createdAt)).get();
  if (own) return { domain: own, shared: false };
  const shared = deps.config.agents.sharedDomain;
  if (!shared) throw new HttpError(409, "domain_required", "Add a domain first: agent inboxes get an address on one of your domains.");
  return { domain: await ensureSharedDomain(deps, shared), shared: true };
}

/** The platform-owned domain that hosts agent inboxes (and free addresses) for workspaces without a domain. */
async function ensureSharedDomain(deps: Deps, name: string) {
  const { ensurePlatformDomain } = await import("../free-address");
  return ensurePlatformDomain(deps, name);
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  localPart?: string;
  domainId?: string;
  approvalMode?: ApprovalMode;
  sendCapDaily?: number;
  allowedRecipients?: string[] | null;
  mailboxIds?: string[];
  /** Create an agent key in the same call (default true). */
  createKey?: boolean;
}

/** Creates the agent, its inbox and (by default) its API key, in one call. */
export async function createAgent(deps: Deps, actor: Actor, input: CreateAgentInput, opts: { id?: string; mailboxId?: string; retry?: boolean } = {}) {
  assertWorkspaceActor(actor);
  const { db } = deps;
  // R52 (MB-239): a retry under the same Idempotency-Key returns the agent the first attempt made. Its key secret
  // was shown once, in the answer that was lost, so the retry returns apiKey null: make a new key with POST /agents/{id}/keys.
  if (opts.id && opts.retry && await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, opts.id), eq(agents.orgId, actor.orgId))).get()) return { agent: await getAgent(deps, actor.orgId, opts.id), apiKey: null };
  // AIS1 (row 4): a key or a connected AI app makes agents that a person approves every message of, at the default cap or lower.
  await refuseLoosening(deps, actor, [
    ...(input.approvalMode && input.approvalMode !== "always" ? ["approvalMode"] : []),
    ...(input.sendCapDaily !== undefined && input.sendCapDaily > AGENT_DEFAULT_DAILY_SENDS ? ["sendCapDaily"] : []),
  ], { action: "agent.create_refused", name: input.name });
  await assertCanCreate(db, actor.orgId, "agentInboxes");
  const plan = await getPlan(db, actor.orgId);
  // AIS1 (row 51): 100 a day unless someone asks, never above the plan's limit.
  const cap = Math.min(input.sendCapDaily ?? AGENT_DEFAULT_DAILY_SENDS, plan.limits.agentDailySends);
  const { domain, shared } = await pickDomain(deps, actor.orgId, input.domainId);
  const local = input.localPart?.toLowerCase() ?? (shared ? `${slug(input.name)}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x")}` : slug(input.name));
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(local)) throw badRequest("Use letters, numbers, dots, dashes or underscores for the address.");
  const address = `${local}@${domain.name}`;
  const taken = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.address, address)).get();
  if (taken) throw conflict(`${address} is already in use.`);
  // PRIV1b (P37): an agent inbox is never a person's mailbox; at a member's sign in address it would get their password resets.
  if (await memberSigningInAs(db, actor.orgId, address)) throw conflict(`${address} is the sign in address of a member of this workspace. Pick another address for the agent.`);
  const extra = [...new Set(input.mailboxIds ?? [])];
  if (extra.length) {
    const ok = await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.orgId, actor.orgId), inIds(mailboxes.id, extra)));
    if (ok.length !== extra.length) throw badRequest("One of those mailboxes doesn't exist in this workspace.");
    await assertOwnPersonal(deps, actor, extra);
  }
  // AIS1 (row 51): a named list is kept. With none, or "anyone" (null or []) from a key or an AI app, the agent may
  // mail only the workspace's own domains. Only a person in the app picks "anyone" for a new agent.
  const allow = allowList(input.allowedRecipients) ?? (input.allowedRecipients !== undefined && isPersonSession(actor) ? null : await defaultAllowList(deps, actor, address));
  const mailboxId = opts.mailboxId ?? newId("mbx");
  await db.insert(mailboxes).values({
    id: mailboxId, orgId: actor.orgId, domainId: domain.id, localPart: local, address, displayName: input.name, quotaMb: plan.limits.storagePerMailboxMb, kind: "agent",
  });
  const id = opts.id ?? newId("agt");
  await db.insert(agents).values({
    id, orgId: actor.orgId, mailboxId, name: input.name, description: input.description ?? null,
    approvalMode: input.approvalMode ?? "always", sendCapDaily: cap,
    allowedRecipients: allow ? JSON.stringify(allow) : null,
    createdByUserId: actor.userId || null,
  });
  if (extra.length) await db.insert(agentMailboxAccess).values(extra.map((m) => ({ agentId: id, mailboxId: m, orgId: actor.orgId })));
  await audit(db, { orgId: actor.orgId, ...actorFields(actor), agentId: id, action: "agent.created", targetType: "agent", targetId: id, metadata: { name: input.name, address, approvalMode: input.approvalMode ?? "always", sendCapDaily: cap, allowedRecipients: allow, via: actor.apiKeyId ? "api" : "app" } });
  let key: { id: string; secret: string; prefix: string } | null = null;
  if (input.createKey !== false) {
    const k = await createApiKey(deps, actor, { name: `${input.name} agent key`, scope: "full", agentId: id });
    key = { id: k.apiKey.id, prefix: k.apiKey.prefix, secret: k.secret };
    await audit(db, { orgId: actor.orgId, ...actorFields(actor), agentId: id, action: "agent.key_created", targetType: "api_key", targetId: k.apiKey.id });
  }
  const agent = await getAgent(deps, actor.orgId, id);
  await recordEvent(deps, actor.orgId, id, "agent.created", { agentId: id, address });
  await emitEvent(deps, actor.orgId, "agent.created", { id, name: agent.name, address });
  return { agent, apiKey: key };
}

export interface UpdateAgentInput {
  name?: string;
  description?: string | null;
  approvalMode?: ApprovalMode;
  sendCapDaily?: number;
  allowedRecipients?: string[] | null;
  mailboxIds?: string[];
  status?: "active" | "paused";
}

export async function updateAgent(deps: Deps, actor: Actor, id: string, patch: UpdateAgentInput) {
  assertWorkspaceActor(actor);
  const { a } = await row(deps, actor.orgId, id);
  const held = patch.mailboxIds ? new Set((await deps.db.select({ id: agentMailboxAccess.mailboxId }).from(agentMailboxAccess).where(eq(agentMailboxAccess.agentId, a.id))).map((r) => r.id)) : new Set<string>();
  // AIS1 (row 4): a key or a connected AI app may only tighten an agent. Checked before any write, the whole patch refused.
  await refuseLoosening(deps, actor, looserFields(a, patch, held), { action: "agent.update_refused", agentId: a.id });
  if (patch.mailboxIds) {
    // PRIV1b (P3, P4): checked before any write. Mailboxes the agent already holds may stay; new personal ones need their owner.
    await assertOwnPersonal(deps, actor, [...new Set(patch.mailboxIds)].filter((m) => m !== a.mailboxId && !held.has(m)));
  }
  const plan = await getPlan(deps.db, actor.orgId);
  if (patch.sendCapDaily !== undefined && patch.sendCapDaily > plan.limits.agentDailySends) {
    throw planLimit(`Agents can send up to ${plan.limits.agentDailySends} messages a day on your plan.`);
  }
  const allow = patch.allowedRecipients === undefined ? undefined : allowList(patch.allowedRecipients);
  const set = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.approvalMode ? { approvalMode: patch.approvalMode } : {}),
    ...(patch.sendCapDaily !== undefined ? { sendCapDaily: patch.sendCapDaily } : {}),
    ...(allow !== undefined ? { allowedRecipients: allow ? JSON.stringify(allow) : null } : {}),
    ...(patch.status ? { status: patch.status } : {}),
  };
  // AIS1: a patch of only mailboxIds (taking a mailbox away) has nothing to set on the agent row.
  if (Object.keys(set).length) await deps.db.update(agents).set(set).where(eq(agents.id, a.id));
  if (patch.name) await deps.db.update(mailboxes).set({ displayName: patch.name }).where(eq(mailboxes.id, a.mailboxId));
  if (patch.mailboxIds) {
    const ids = [...new Set(patch.mailboxIds.filter((m) => m !== a.mailboxId))];
    if (ids.length) {
      const ok = await deps.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.orgId, actor.orgId), inIds(mailboxes.id, ids)));
      if (ok.length !== ids.length) throw badRequest("One of those mailboxes doesn't exist in this workspace.");
    }
    await deps.db.delete(agentMailboxAccess).where(eq(agentMailboxAccess.agentId, a.id));
    if (ids.length) await deps.db.insert(agentMailboxAccess).values(ids.map((m) => ({ agentId: a.id, mailboxId: m, orgId: actor.orgId })));
  }
  await audit(deps.db, { orgId: actor.orgId, ...actorFields(actor), agentId: a.id, action: "agent.updated", targetType: "agent", targetId: a.id, metadata: { ...patch } });
  return getAgent(deps, actor.orgId, id);
}

/** Deletes the agent, its inbox and mail, and its keys. Pending approvals go with it. */
export async function deleteAgent(deps: Deps, actor: Actor, id: string) {
  assertWorkspaceActor(actor);
  const { a, mb } = await row(deps, actor.orgId, id);
  await assertMailboxNotHeld(deps, actor.orgId, mb.id); // PRIV1b (P44): a held agent inbox stays, as DELETE /api/mailboxes/:id
  await deprovisionMailbox(deps, actor.orgId, mb.id).catch(() => undefined);
  await deps.db.delete(apiKeys).where(eq(apiKeys.agentId, a.id));
  await deps.db.delete(agents).where(eq(agents.id, a.id));
  await deps.db.delete(mailboxes).where(eq(mailboxes.id, mb.id));
  await audit(deps.db, { orgId: actor.orgId, ...actorFields(actor), agentId: a.id, action: "agent.deleted", targetType: "agent", targetId: a.id, metadata: { name: a.name, address: mb.address } });
  await emitEvent(deps, actor.orgId, "agent.deleted", { id: a.id, address: mb.address });
  return { id: a.id, deleted: true };
}

// ---------------------------------------------------------------- keys

export async function createAgentKey(deps: Deps, actor: Actor, agentId: string, name?: string) {
  assertWorkspaceActor(actor);
  const { a } = await row(deps, actor.orgId, agentId);
  // PRIV1b (P4): a key to an agent that holds a personal mailbox is minted only by the agent's maker.
  if (!actor.userId || actor.userId !== a.createdByUserId) {
    const personal = await deps.db.select({ id: mailboxes.id }).from(agentMailboxAccess).innerJoin(mailboxes, eq(mailboxes.id, agentMailboxAccess.mailboxId))
      .where(and(eq(agentMailboxAccess.agentId, a.id), eq(mailboxes.personal, true))).limit(1).get();
    if (personal) throw forbidden("This agent works a personal mailbox. Only the person who made it can create its keys.");
  }
  const k = await createApiKey(deps, actor, { name: name ?? `${a.name} agent key`, scope: "full", agentId: a.id });
  await audit(deps.db, { orgId: actor.orgId, ...actorFields(actor), agentId: a.id, action: "agent.key_created", targetType: "api_key", targetId: k.apiKey.id });
  return k;
}

export async function listAgentKeys(deps: Deps, actor: Actor, agentId: string) {
  assertWorkspaceActor(actor);
  await row(deps, actor.orgId, agentId);
  return listApiKeys(deps, actor.orgId, agentId);
}

export async function revokeAgentKey(deps: Deps, actor: Actor, agentId: string, keyId: string) {
  assertWorkspaceActor(actor);
  const k = await deps.db.select().from(apiKeys).where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, actor.orgId), eq(apiKeys.agentId, agentId))).get();
  if (!k) throw notFound("Agent key");
  await deps.db.delete(apiKeys).where(eq(apiKeys.id, k.id));
  await audit(deps.db, { orgId: actor.orgId, ...actorFields(actor), agentId, action: "agent.key_revoked", targetType: "api_key", targetId: k.id });
  return { id: k.id, revoked: true };
}

// ---------------------------------------------------------------- reading

/**
 * The mailboxes an actor can read: an agent key gets its agent's mailboxes, a workspace
 * key or admin gets everything, a member gets their grants.
 */
export async function scopeFor(deps: Deps, actor: Actor): Promise<string[] | null> {
  if (actor.agentId) {
    const a = await deps.db.select().from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.orgId, actor.orgId))).get();
    if (!a) throw new HttpError(403, "agent_key_scope", "This agent no longer exists.");
    // PRIV1a: an agent never reaches a personal mailbox its maker can't open.
    return agentMailboxIds(deps, a);
  }
  return mailboxScope(deps.db, actor);
}

async function agentNames(deps: Deps, orgId: string) {
  const rows = await deps.db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.orgId, orgId));
  return { agents: new Map(rows.map((r) => [r.id, r.name])) };
}

const scopeCond = (scope: string[] | null) => (scope ? inIds(messages.mailboxId, scope) : undefined);

/** Threads, newest first: one row per thread with its latest message. */
export async function listThreads(deps: Deps, orgId: string, scope: string[] | null, q: { mailboxId?: string; folder?: string; unread?: boolean; before?: string; limit?: number; view?: ThreadView; assignee?: string; viewerUserId?: string | null; extra?: SQL }) {
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
  if (q.mailboxId && scope && !scope.includes(q.mailboxId)) throw notFound("Mailbox");
  const conds = [eq(messages.orgId, orgId), scopeCond(scope), q.mailboxId ? eq(messages.mailboxId, q.mailboxId) : undefined, sql`${messages.folder} not in ('trash', 'drafts')`];
  if (q.folder) conds.push(eq(messages.folder, q.folder as "inbox"));
  if (q.extra) conds.push(q.extra); // R31: an Inbox split
  const grouped = deps.db.select({
    threadId: messages.threadId,
    last: sql<number>`max(${messages.date})`.as("last"),
    total: sql<number>`count(*)`.as("total"),
    unread: sql<number>`sum(case when ${messages.isRead} = 0 then 1 else 0 end)`.as("unread"),
  }).from(messages).where(and(...conds)).groupBy(messages.threadId).as("g");
  const page = await deps.db.select().from(grouped)
    .where(and(q.before ? lt(grouped.last, Number(q.before)) : undefined, q.unread ? gt(grouped.unread, 0) : undefined, threadViewCond(grouped.threadId, orgId, q.view, q.viewerUserId ?? null, q.assignee)))
    .orderBy(desc(grouped.last)).limit(limit + 1);
  const rows = page.slice(0, limit);
  const latest = rows.length
    // D1: at most 100 variables a statement; thread ids and the mailbox scope each bind one variable (inIds), R27.
    ? (await deps.db.select().from(messages).where(and(eq(messages.orgId, orgId), inIds(messages.threadId, rows.map((r) => r.threadId)), scopeCond(scope))))
        .flat().sort((a, b) => Number(b.date) - Number(a.date))
    : [];
  const pending = rows.length
    ? await inChunks(rows.map((r) => r.threadId), (ids) => deps.db.select({ threadId: sendApprovals.threadId, n: count() }).from(sendApprovals)
        .where(and(eq(sendApprovals.orgId, orgId), eq(sendApprovals.status, "pending"), inIds(sendApprovals.threadId, ids), scope ? inIds(sendApprovals.mailboxId, scope) : undefined)).groupBy(sendApprovals.threadId))
    : [];
  const names = await agentNames(deps, orgId);
  const states = await listThreadStates(deps, orgId, rows.map((r) => r.threadId), scope);
  return {
    data: rows.map((r) => {
      const inThread = latest.filter((x) => x.threadId === r.threadId);
      const m = inThread[0];
      const first = inThread[inThread.length - 1];
      const other = inThread.find((x) => x.folder !== "sent") ?? m;
      const agentIds = [...new Set(inThread.map((x) => x.sentByAgentId).filter((x): x is string => !!x))];
      return {
        id: r.threadId, mailboxId: m.mailboxId, subject: first.subject, snippet: m.snippet,
        lastMessageAt: new Date(Number(r.last)).toISOString(), messageCount: Number(r.total), unreadCount: Number(r.unread ?? 0),
        from: { address: other.fromAddress, name: other.fromName || undefined },
        lastSentBy: m.sentByAgentId ? { type: "agent" as const, agentId: m.sentByAgentId, name: names.agents.get(m.sentByAgentId) ?? null } : m.folder === "sent" ? { type: "person" as const } : { type: "external" as const },
        agentsInvolved: agentIds.map((agentId) => ({ agentId, name: names.agents.get(agentId) ?? null })),
        pendingApprovals: Number(pending.find((p) => p.threadId === r.threadId)?.n ?? 0),
        assignee: states.get(r.threadId)?.assignee ?? null, status: states.get(r.threadId)?.status ?? "open",
        // R22.5: when the customer last wrote (the newest message not in sent), for the age on open rows. Computed on read.
        lastInboundAt: inThread.find((x) => x.folder !== "sent")?.date.toISOString() ?? null,
      };
    }),
    nextCursor: page.length > limit && rows.length ? String(rows[rows.length - 1].last) : null,
  };
}

/** One thread as structured JSON: every message with its new text, codes, links and attachments. */
export async function readThread(deps: Deps, actor: Actor, threadId: string, origin: string, headers?: Headers) {
  const scope = await scopeFor(deps, actor);
  const rows = await deps.db.select().from(messages)
    .where(and(eq(messages.orgId, actor.orgId), eq(messages.threadId, threadId), scopeCond(scope), sql`${messages.folder} <> 'drafts'`)).orderBy(asc(messages.date));
  if (!rows.length) throw notFound("Thread");
  const atts = await deps.db.select().from(attachments).where(inIds(attachments.messageId, rows.map((r) => r.id)));
  const names = await agentNames(deps, actor.orgId);
  // PRIV1b (P15): approvals are keyed by thread, which a personal mailbox's copy can share: only mailboxes in scope.
  const approvals = await deps.db.select().from(sendApprovals).where(and(eq(sendApprovals.orgId, actor.orgId), eq(sendApprovals.threadId, threadId), eq(sendApprovals.status, "pending"), scope ? inIds(sendApprovals.mailboxId, scope) : undefined));
  // PRIV1b (P17): the Team inbox reader, v1 GET /threads/{id} and MCP read_thread land in "Who opened my mailbox".
  for (const mb of new Set(rows.map((r) => r.mailboxId))) await logMailboxOpen(deps, actor, mb, "opened_thread", threadId, headers);
  if (actor.agentId) {
    const { a, mb } = await row(deps, actor.orgId, actor.agentId);
    // Reads roll up to one audit row per agent, thread and hour (round 20): an agent polling a thread
    // every minute used to write 3 D1 rows a minute. The row still says who read what and when.
    const since = new Date(deps.now().getTime() - READ_AUDIT_ROLLUP_MS);
    const recent = await deps.db.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.agentId, a.id), gte(auditLogs.createdAt, since), eq(auditLogs.action, "agent.message_read"), eq(auditLogs.targetId, threadId))).limit(1).get();
    if (!recent) await audit(deps.db, { orgId: actor.orgId, ...agentActor(a, mb), action: "agent.message_read", targetType: "thread", targetId: threadId, metadata: { messages: rows.length, via: actor.sessionId.startsWith("mcp:") ? "mcp" : "api", rollup: "hour" } });
  }
  return {
    id: threadId,
    mailboxId: rows[0].mailboxId,
    subject: rows[0].subject,
    messageCount: rows.length,
    messages: rows.map((m) => agentMessage(m, atts.filter((a) => a.messageId === m.id), origin, names)),
    pendingApprovals: approvals.map(presentApproval),
  };
}

/** Searches subject, sender, recipients and body in the actor's mailboxes. */
export async function searchMessages(deps: Deps, actor: Actor, query: string, limit = 25) {
  const scope = await scopeFor(deps, actor);
  const fields = [messages.subject, messages.fromAddress, messages.fromName, messages.text, messages.to];
  const rows = await deps.db.select().from(messages)
    .where(and(eq(messages.orgId, actor.orgId), scopeCond(scope), sql`${messages.folder} <> 'trash'`, containsAny(fields, query.trim())))
    .orderBy(desc(messages.date)).limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((m) => ({
    id: m.id, threadId: m.threadId, mailboxId: m.mailboxId, folder: m.folder, subject: m.subject, snippet: m.snippet,
    from: { address: m.fromAddress, name: m.fromName || undefined }, date: new Date(m.date).toISOString(),
  }));
}

// ---------------------------------------------------------------- sending

export interface AgentSendInput {
  /** Send from this mailbox (the agent's inbox by default). */
  mailboxId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyToId?: string;
  /** Files sent with the message, e.g. a meeting's calendar invite. */
  attachments?: { filename: string; contentType: string; contentBase64: string }[];
}

function recipientAllowed(allow: string[] | null, address: string) {
  if (!allow) return true;
  const a = address.toLowerCase();
  return allow.some((r) => (r.startsWith("@") ? a.endsWith(r) : a === r));
}

export function presentApproval(r: typeof sendApprovals.$inferSelect) {
  const p = JSON.parse(r.payload) as AgentSendInput;
  return {
    id: r.id, agentId: r.agentId, mailboxId: r.mailboxId, threadId: r.threadId, status: r.status,
    to: p.to, cc: p.cc ?? [], bcc: p.bcc ?? [], subject: p.subject, text: p.text, html: p.html ?? null, inReplyToId: p.inReplyToId ?? null,
    decidedBy: r.decidedByEmail, decidedAt: r.decidedAt, note: r.note, messageId: r.messageId, error: r.error,
    expiresAt: r.expiresAt, createdAt: r.createdAt,
  };
}

/** The auth an agent's send runs under: the workspace, acting as the agent. */
const asAgent = (orgId: string, a: Agent, mb: Mailbox): AuthContext => ({
  userId: "", email: `agent:${mb.address}`, name: a.name, orgId, role: "admin", sessionId: `agent:${a.id}`,
});

async function deliverAsAgent(deps: Deps, orgId: string, a: Agent, mb: Mailbox, from: Mailbox, input: AgentSendInput, approvedBy?: Actor) {
  // PRIV1b (P31): from its maker's own personal mailbox (the only personal one agentMailboxIds keeps) the send is
  // checked as the maker, so approvalMode "never" works there. Any other mailbox sends as before.
  const userId = approvedBy ? approvedBy.userId : from.personal && a.createdByUserId && from.ownerUserId === a.createdByUserId ? a.createdByUserId : "";
  const res = await sendMessage(deps, { ...asAgent(orgId, a, mb), userId }, {
    mailboxId: from.id, to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, text: input.text, html: input.html, inReplyToId: input.inReplyToId,
  }, { agentId: a.id, attachments: input.attachments?.map((x) => ({ filename: x.filename, contentType: x.contentType, content: fromB64Or(x.contentBase64, () => new HttpError(422, "validation_failed", "Each attachment needs contentBase64 in base64.")) })) });
  await bumpCounter(deps.db, orgId, "agent_messages", deps.now());
  return res;
}

/**
 * An agent asks to send. Checks status, recipients, the daily cap and the plan's monthly
 * allowance, then either sends now or queues the message for a person to approve.
 */
export async function requestSend(deps: Deps, actor: Actor, agentId: string, input: AgentSendInput): Promise<{ status: "sent"; result: SendResult } | { status: "pending_approval"; approval: ReturnType<typeof presentApproval> }> {
  assertActsAs(actor, agentId);
  const { a, mb } = await row(deps, actor.orgId, agentId);
  const who = agentActor(a, mb);
  const block = async (code: string, message: string, status: 403 | 429 = 403) => {
    await audit(deps.db, { orgId: actor.orgId, ...who, action: "agent.send_blocked", metadata: { code, to: input.to, subject: input.subject } });
    return new HttpError(status, code, message);
  };
  if (a.status !== "active") throw await block("agent_paused", "This agent is paused. A person can resume it in Agents.");
  const fromId = input.mailboxId ?? a.mailboxId;
  const allowed = await agentMailboxIdsFor(deps, actor, a);
  if (!allowed.includes(fromId)) throw await block("mailbox_not_allowed", "This agent can't send from that mailbox.");
  const from = (await deps.db.select().from(mailboxes).where(eq(mailboxes.id, fromId)).get())!;
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
  const allow = parseAllow(a.allowedRecipients);
  const outside = recipients.filter((r) => !recipientAllowed(allow, r));
  if (outside.length) throw await block("recipient_not_allowed", `This agent may only send to its allowed recipients. Not allowed: ${outside.join(", ")}.`);
  if ((await sentTodayBy(deps, a)) >= a.sendCapDaily) throw await block("agent_send_cap", `This agent has reached its limit of ${a.sendCapDaily} messages today. It resets at midnight UTC.`, 429);
  const plan = await getPlan(deps.db, actor.orgId);
  if ((await readCounter(deps.db, actor.orgId, "agent_messages", deps.now())) >= plan.limits.agentMessagesMonthly) {
    throw await block("plan_limit", `Agents in this workspace have sent ${plan.limits.agentMessagesMonthly.toLocaleString("en-AU")} messages this month, the plan's allowance. ${addonHint("agentMessagesMonthly")}`);
  }
  let threadId: string | null = null;
  if (input.inReplyToId) {
    const parent = await deps.db.select().from(messages).where(and(eq(messages.id, input.inReplyToId), eq(messages.orgId, actor.orgId))).get();
    if (!parent || !allowed.includes(parent.mailboxId)) throw notFound("Message");
    threadId = parent.threadId;
  }
  // PRIV1b (P51): "inside" is only a mailbox or alias of this workspace on a verified domain (routeRecipient routes
  // verified domains only). Another workspace on the platform is outside: its mail waits like any other.
  // PRIV1b (S2): an alias counts as inside only when every destination is a mailbox of this workspace (one level).
  const box = async (r: string) => { const x = await routeRecipient(deps.db, r); return x.kind === "mailbox" && x.mailbox.orgId === a.orgId; };
  const ours = async (r: string) => {
    const x = await routeRecipient(deps.db, r);
    if (x.kind === "mailbox") return x.mailbox.orgId === a.orgId;
    if (x.kind !== "alias" || x.alias.orgId !== a.orgId) return false;
    let dest: unknown;
    try { dest = JSON.parse(x.alias.destinations); } catch { return false; }
    return Array.isArray(dest) && dest.length > 0 && (await Promise.all(dest.map((d) => typeof d === "string" && box(d)))).every(Boolean);
  };
  const external = (await Promise.all(recipients.map(ours))).some((h) => !h);
  const needsApproval = a.approvalMode === "always" || (a.approvalMode === "external" && external);
  if (needsApproval) {
    const id = newId("apr");
    await deps.db.insert(sendApprovals).values({
      id, orgId: actor.orgId, agentId: a.id, mailboxId: from.id, threadId, payload: JSON.stringify({ ...input, mailboxId: from.id }),
      apiKeyId: actor.apiKeyId ?? null, expiresAt: new Date(deps.now().getTime() + APPROVAL_TTL_DAYS * DAY),
    });
    const approval = presentApproval((await deps.db.select().from(sendApprovals).where(eq(sendApprovals.id, id)).get())!);
    await audit(deps.db, { orgId: actor.orgId, ...who, action: "agent.send_queued", targetType: "approval", targetId: id, metadata: { to: input.to, subject: input.subject, reason: a.approvalMode } });
    await recordEvent(deps, actor.orgId, a.id, "approval.requested", { approvalId: id, mailboxId: from.id, to: input.to, subject: input.subject, threadId }); // PRIV1b (S3): filtered like message events
    await emitEvent(deps, actor.orgId, "approval.requested", { approvalId: id, agentId: a.id, agent: a.name, mailboxId: from.id, from: from.address, to: input.to, subject: input.subject, threadId }); // PRIV1b (AP1): mailboxId, so the webhook filter does not rest on the from address
    // Everyone who can open that inbox gets it in their notifications inbox (and on their phone).
    try {
      const { notify } = await import("../suite/notify");
      const { usersWhoCanOpen } = await import("../team");
      for (const u of await usersWhoCanOpen(deps.db, actor.orgId, from.id)) {
        await notify(deps, actor.orgId, u, { type: "approval.requested", entityType: "approval", entityId: id, title: `${a.name} wants to send "${input.subject || "(no subject)"}" to ${[input.to].flat().join(", ")}`.slice(0, 300), actorName: a.name });
      }
    } catch (err) { deps.reportError?.(err, { where: "approval.notify" }); }
    return { status: "pending_approval", approval };
  }
  const result = await deliverAsAgent(deps, actor.orgId, a, mb, from, input);
  await audit(deps.db, { orgId: actor.orgId, ...who, action: "agent.message_sent", targetType: "message", targetId: result.messageId, metadata: { to: input.to, subject: input.subject, from: from.address } });
  await recordEvent(deps, actor.orgId, a.id, "message.sent", { messageId: result.messageId, mailboxId: from.id, to: input.to, subject: input.subject });
  return { status: "sent", result };
}

/** Replies in a thread: to the sender (or everyone with replyAll), threaded, "Re:" subject. */
export async function replyInThread(deps: Deps, actor: Actor, agentId: string, threadId: string, input: { text: string; html?: string; replyAll?: boolean; mailboxId?: string }) {
  assertActsAs(actor, agentId);
  const { a } = await row(deps, actor.orgId, agentId);
  const allowed = await agentMailboxIdsFor(deps, actor, a);
  const rows = await deps.db.select().from(messages)
    .where(and(eq(messages.orgId, actor.orgId), eq(messages.threadId, threadId), inIds(messages.mailboxId, allowed), sql`${messages.folder} <> 'drafts'`)).orderBy(desc(messages.date));
  const last = rows.find((m) => m.folder !== "sent") ?? rows[0];
  if (!last) throw notFound("Thread");
  const own = (await deps.db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.id, last.mailboxId)).get())!.address;
  const replyTo = last.folder === "sent" ? (JSON.parse(last.to) as { address: string }[]).map((t) => t.address) : [last.replyTo ?? last.fromAddress];
  const others = input.replyAll ? [...(JSON.parse(last.to) as { address: string }[]), ...(JSON.parse(last.cc) as { address: string }[])].map((t) => t.address) : [];
  const cc = [...new Set(others.map((x) => x.toLowerCase()))].filter((x) => x !== own && !replyTo.map((r) => r.toLowerCase()).includes(x));
  const subject = /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`;
  return requestSend(deps, actor, agentId, { mailboxId: input.mailboxId ?? last.mailboxId, to: replyTo, cc: cc.length ? cc : undefined, subject, text: input.text, html: input.html, inReplyToId: last.id });
}

// ---------------------------------------------------------------- approvals

/** Approvals a person may see: owners and admins see all; members see their mailboxes'. */
export async function listApprovals(deps: Deps, actor: Actor, q: { status?: string; agentId?: string; limit?: number } = {}) {
  const scope = await scopeFor(deps, actor);
  const rows = await deps.db.select().from(sendApprovals).where(and(
    eq(sendApprovals.orgId, actor.orgId),
    q.status ? eq(sendApprovals.status, q.status as "pending") : undefined,
    q.agentId ? eq(sendApprovals.agentId, q.agentId) : undefined,
    actor.agentId ? eq(sendApprovals.agentId, actor.agentId) : undefined,
    scope && !actor.agentId ? inIds(sendApprovals.mailboxId, scope) : undefined,
  )).orderBy(desc(sendApprovals.createdAt)).limit(Math.min(q.limit ?? 50, 200));
  return rows.map(presentApproval);
}

async function approvalFor(deps: Deps, actor: Actor, id: string, need: "reply" | "send") {
  if (actor.agentId) throw new HttpError(403, "agent_key_scope", "An agent can't approve its own messages. A person approves them in the app.");
  const r = await deps.db.select().from(sendApprovals).where(and(eq(sendApprovals.id, id), eq(sendApprovals.orgId, actor.orgId))).get();
  if (!r) throw notFound("Approval");
  const scope = await scopeFor(deps, actor);
  if (scope && !scope.includes(r.mailboxId)) throw notFound("Approval");
  // PRIV1b (P11): rejecting needs Read and reply, approving (it sends) needs Send as; a read share only looks.
  await assertOpen(deps.db, actor, r.mailboxId, need);
  if (r.status !== "pending") throw conflict(`This message was already ${r.status === "sent" ? "approved and sent" : r.status}.`);
  if (r.expiresAt.getTime() <= deps.now().getTime()) throw conflict("This request expired. The agent can ask again.");
  return r;
}

/** A person approves (optionally after editing the subject or text): the message is sent as the agent. */
export async function approveSend(deps: Deps, actor: Actor, id: string, edits: { subject?: string; text?: string } = {}) {
  const r = await approvalFor(deps, actor, id, "send");
  const { a, mb } = await row(deps, actor.orgId, r.agentId);
  const from = (await deps.db.select().from(mailboxes).where(eq(mailboxes.id, r.mailboxId)).get())!;
  const input = { ...(JSON.parse(r.payload) as AgentSendInput), ...(edits.subject !== undefined ? { subject: edits.subject } : {}), ...(edits.text !== undefined ? { text: edits.text } : {}) };
  // Claim it first so two people approving at once send once.
  const claimed = await deps.db.update(sendApprovals).set({ status: "sent", decidedByUserId: actor.userId || null, decidedByEmail: actor.email, decidedAt: deps.now() })
    .where(and(eq(sendApprovals.id, r.id), eq(sendApprovals.status, "pending"))).returning({ id: sendApprovals.id });
  if (!claimed.length) throw conflict("Someone else just decided this one.");
  try {
    const result = await deliverAsAgent(deps, actor.orgId, a, mb, from, input, actor);
    await deps.db.update(sendApprovals).set({ messageId: result.messageId, payload: JSON.stringify(input) }).where(eq(sendApprovals.id, r.id));
    await audit(deps.db, { orgId: actor.orgId, ...actorFields(actor), agentId: a.id, action: "approval.approved", targetType: "approval", targetId: r.id, metadata: { messageId: result.messageId, edited: Object.keys(edits).length > 0, to: input.to, subject: input.subject } });
    await recordEvent(deps, actor.orgId, a.id, "approval.decided", { approvalId: r.id, decision: "approved", messageId: result.messageId });
    await emitEvent(deps, actor.orgId, "approval.decided", { approvalId: r.id, agentId: a.id, decision: "approved", messageId: result.messageId, by: actor.email });
    return { approval: presentApproval((await deps.db.select().from(sendApprovals).where(eq(sendApprovals.id, r.id)).get())!), result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.db.update(sendApprovals).set({ status: "failed", error: message }).where(eq(sendApprovals.id, r.id));
    await audit(deps.db, { orgId: actor.orgId, ...actorFields(actor), agentId: a.id, action: "approval.failed", targetType: "approval", targetId: r.id, metadata: { error: message } });
    throw err;
  }
}

export async function rejectSend(deps: Deps, actor: Actor, id: string, note?: string) {
  const r = await approvalFor(deps, actor, id, "reply");
  await deps.db.update(sendApprovals).set({ status: "rejected", note: note ?? null, decidedByUserId: actor.userId || null, decidedByEmail: actor.email, decidedAt: deps.now() }).where(eq(sendApprovals.id, r.id));
  await audit(deps.db, { orgId: actor.orgId, ...actorFields(actor), agentId: r.agentId, action: "approval.rejected", targetType: "approval", targetId: r.id, metadata: { note } });
  await recordEvent(deps, actor.orgId, r.agentId, "approval.decided", { approvalId: r.id, decision: "rejected", note });
  await emitEvent(deps, actor.orgId, "approval.decided", { approvalId: r.id, agentId: r.agentId, decision: "rejected", note: note ?? null, by: actor.email });
  return presentApproval((await deps.db.select().from(sendApprovals).where(eq(sendApprovals.id, r.id)).get())!);
}

/** Maintenance: requests nobody decided within a week expire. */
export async function expireApprovals(deps: Deps) {
  const done = await deps.db.update(sendApprovals).set({ status: "expired" })
    .where(and(eq(sendApprovals.status, "pending"), lt(sendApprovals.expiresAt, deps.now()))).returning({ id: sendApprovals.id, orgId: sendApprovals.orgId, agentId: sendApprovals.agentId });
  for (const d of done) await recordEvent(deps, d.orgId, d.agentId, "approval.decided", { approvalId: d.id, decision: "expired" });
  return done.length;
}

// ---------------------------------------------------------------- inbound and events

/** Called after mail lands in a mailbox: every agent that can read it gets an event. */
export async function notifyAgentsOfInbound(deps: Deps, mb: Pick<Mailbox, "id" | "orgId">, m: { id: string; threadId: string; from: { address: string; name?: string }; subject: string; text: string; html?: string | null }) {
  const own = await deps.db.select({ id: agents.id }).from(agents).where(eq(agents.mailboxId, mb.id));
  const given = await deps.db.select({ id: agents.id, maker: agents.createdByUserId }).from(agentMailboxAccess).innerJoin(agents, eq(agents.id, agentMailboxAccess.agentId))
    .where(eq(agentMailboxAccess.mailboxId, mb.id));
  // PRIV1b (P3): the same rule as agentMailboxIds. A personal mailbox's mail reaches only an agent its owner made,
  // while the owner is a member. (S1) The mailbox is read once, not once per agent, on the delivery path.
  let shared: { id: string }[] = given;
  if (given.length) {
    const box = await deps.db.select({ personal: mailboxes.personal, owner: mailboxes.ownerUserId }).from(mailboxes).where(eq(mailboxes.id, mb.id)).get();
    if (box?.personal) {
      const owner = box.owner && (await keepOpenableBy(deps.db, mb.orgId, box.owner, [mb.id])).length ? box.owner : null;
      shared = given.filter((g) => !!owner && g.maker === owner);
    }
  }
  const ids = [...new Set([...own, ...shared].map((r) => r.id))];
  const parsed = { messageId: m.id, threadId: m.threadId, mailboxId: mb.id, from: m.from, subject: m.subject, latestText: latestText(m.text), codes: extractCodes(m.text, m.subject), links: extractLinks(m.text, m.html) };
  for (const id of ids) await recordEvent(deps, mb.orgId, id, "message.received", parsed);
  return { agentIds: ids, parsed };
}

/**
 * Events after `after` (a sequence number), oldest first. Agent keys see their own agent's.
 * PRIV1b (P3): message events carry mail, so each is kept only when its mailbox is in the caller's own scope (an
 * agent key: its agent's mailboxes now; a person or workspace key: what they may open), whichever agent it is for.
 */
export async function eventsSince(deps: Deps, actor: Actor, q: { after?: number; agentId?: string; limit?: number }) {
  return (await eventsPage(deps, actor, q)).events;
}

/** eventsSince plus `last`, the newest sequence number returned, so a stream moves on. */
export async function eventsPage(deps: Deps, actor: Actor, q: { after?: number; agentId?: string; limit?: number }) {
  const agentId = actor.agentId ?? q.agentId;
  if (agentId) await row(deps, actor.orgId, agentId);
  const limit = Math.min(q.limit ?? 100, 500);
  const base = and(eq(agentEvents.orgId, actor.orgId), gt(agentEvents.seq, q.after ?? 0), agentId ? eq(agentEvents.agentId, agentId) : undefined);
  const read = async (cond: SQL | undefined) => (await deps.db.select().from(agentEvents).where(and(base, cond)).orderBy(asc(agentEvents.seq)).limit(limit))
    .map((r) => ({ id: r.seq, type: r.type, agentId: r.agentId, data: JSON.parse(r.data) as Record<string, unknown>, createdAt: r.createdAt }));
  const page = (events: Awaited<ReturnType<typeof read>>) => ({ events, last: events.length ? events[events.length - 1].id : q.after ?? 0 });
  // PRIV1b (P3, S3): message events and approval.requested carry mail (to, subject, codes), so they are kept only when
  // their mailbox is in the caller's scope. A quiet poll needs no scope read.
  const all = await read(undefined);
  if (!all.some(carriesMail)) return page(all);
  const scope = await scopeFor(deps, actor);
  if (!scope) return page(all);
  // PRIV1b (M2): filtered in SQL, so a page never fills with hidden events and a poller can't stall behind them.
  // An older event with no mailbox id is seen only by the agent's own key.
  const mb = sql`json_extract(${agentEvents.data}, '$.mailboxId')`;
  const mailish = sql`(${agentEvents.type} like 'message.%' or ${agentEvents.type} = 'approval.requested')`;
  return page(await read(or(sql`not ${mailish}`, inIds(mb, scope), actor.agentId ? and(sql`${mb} is null`, eq(agentEvents.agentId, actor.agentId)) : undefined)));
}
const carriesMail = (e: { type: string }) => e.type.startsWith("message.") || e.type === "approval.requested";

/** The newest event sequence number, so a new stream starts from now. */
export async function latestEventSeq(deps: Deps, orgId: string) {
  const r = await deps.db.select({ n: sql<number>`coalesce(max(${agentEvents.seq}), 0)` }).from(agentEvents).where(eq(agentEvents.orgId, orgId)).get();
  return Number(r?.n ?? 0);
}

/** Maintenance: events older than 7 days are pruned. */
export async function pruneAgentEvents(deps: Deps) {
  const cutoff = new Date(deps.now().getTime() - 7 * DAY);
  await deps.db.delete(agentEvents).where(lt(agentEvents.createdAt, cutoff));
}

export async function agentAudit(deps: Deps, actor: Actor, agentId: string, limit = 100) {
  const { listAudit } = await import("../audit");
  await row(deps, actor.orgId, agentId);
  return listAudit(deps.db, actor.orgId, { agentId, limit });
}
