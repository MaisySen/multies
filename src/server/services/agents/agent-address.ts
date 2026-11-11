/**
 * AIS1 (audit of 11 Nov 2026, row 1, Critical): an AI agent can't become a person.
 *
 * On the live workspace an API key invited agent@<domain>, the address of an agent's own inbox. The invite and the
 * "Confirm your email" mail landed in that inbox, the agent read the link from its feed, and the address became a
 * normal Member with a seat and mailbox access, outside the agent's approval rule, send cap and allow list.
 *
 * `agentAddress` answers "would mail to this address reach an AI agent?" for any workspace on the platform:
 * - an agent inbox (mailboxes.kind = 'agent'), also with +tags (agent+x@ is agent@);
 * - an alias whose destinations reach one, followed through nested aliases in any workspace (disabled aliases count
 *   too: switching one back on would route account mail to the agent);
 * - an address with no mailbox or alias on a domain whose catch-all is an agent inbox;
 * - an agent member's internal address (people.ts AGENT_EMAIL_DOMAIN).
 * Only on a domain its owner proved in DNS (as routeRecipient): mail to an address on a claim nobody proved goes to
 * the real domain's own mail server, never to an agent here.
 * Domains, mailbox and alias addresses are unique on the platform, so each step is one indexed read. Reads only.
 *
 * Every refusal is flagged in the audit log: in the workspace where it was tried, else in the agent's workspace.
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import type { DB } from "../../db";
import { aliases, domains, mailboxes, members, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { audit } from "../audit";
import { isAgentEmail } from "../people";

export interface AgentAddress {
  /** The workspace the agent belongs to (null for an agent member whose workspace is gone). */
  orgId: string | null;
  /** How mail to the address reaches the agent. */
  via: "agent_inbox" | "alias" | "catch_all" | "agent_member";
}

const MAX_DEPTH = 5;

/** `Agent+News@Acme.io` → `agent@acme.io`; "" when it is not an address. */
export function normalAddress(raw: string): string {
  const [local = "", domain = "", extra] = raw.trim().toLowerCase().split("@");
  if (!local || !domain || extra !== undefined) return "";
  return `${local.split("+")[0]}@${domain}`;
}

function destinationsOf(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

/** Where mail to `address` would reach an AI agent, or null when it reaches no agent. */
export async function agentAddress(db: DB, address: string): Promise<AgentAddress | null> {
  return find(db, normalAddress(address), 0, new Set());
}

async function find(db: DB, addr: string, depth: number, seen: Set<string>): Promise<AgentAddress | null> {
  if (!addr || seen.has(addr) || depth > MAX_DEPTH) return null;
  seen.add(addr);
  if (isAgentEmail(addr)) {
    const m = await db.select({ orgId: members.organizationId }).from(users)
      .innerJoin(members, and(eq(members.userId, users.id), eq(members.kind, "agent"))).where(eq(users.email, addr)).get();
    return { orgId: m?.orgId ?? null, via: "agent_member" };
  }
  // As routeRecipient (PRIV1b P36): only a domain its owner proved in DNS routes mail inside the platform. An agent
  // inbox on a claim nobody proved never gets that address's mail, so it must not block a real person's invite,
  // sign-up or password reset (anyone can add any domain name).
  const domain = await db.select({ catchAll: domains.catchAllMailboxId, status: domains.status, verifiedAt: domains.verifiedAt }).from(domains).where(eq(domains.name, addr.split("@")[1])).get();
  if (!domain || (domain.status !== "verified" && !domain.verifiedAt)) return null;
  const mb = await db.select({ orgId: mailboxes.orgId, kind: mailboxes.kind }).from(mailboxes).where(eq(mailboxes.address, addr)).get();
  if (mb) return mb.kind === "agent" ? { orgId: mb.orgId, via: "agent_inbox" } : null;
  const alias = await db.select({ destinations: aliases.destinations }).from(aliases).where(eq(aliases.address, addr)).get();
  if (alias) {
    for (const dest of destinationsOf(alias.destinations)) {
      const hit = await find(db, normalAddress(dest), depth + 1, seen);
      if (hit) return { orgId: hit.orgId, via: "alias" };
    }
    return null;
  }
  if (domain.catchAll) {
    const c = await db.select({ orgId: mailboxes.orgId, kind: mailboxes.kind }).from(mailboxes).where(eq(mailboxes.id, domain.catchAll)).get();
    if (c?.kind === "agent") return { orgId: c.orgId, via: "catch_all" };
  }
  return null;
}

/** The message a refused invite, sign-up or join shows. */
export const agentAddressMessage = (email: string) =>
  `${email} is an AI agent's inbox. An agent can't join as a person. Add agents in Agents instead.`;

export interface RefusalContext {
  /** Audit action, for example "member.invite_refused". */
  action: string;
  /** The workspace where it was tried; the agent's own workspace when there is none (a sign-up). */
  orgId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Throws 422 agent_address when mail to `email` reaches an AI agent, after flagging the attempt in the audit log.
 * Returns quietly otherwise. Costs a few indexed reads and, only on a refusal, one audit write.
 */
export async function refuseAgentAddress(deps: Deps, email: string, ctx: RefusalContext): Promise<void> {
  const hit = await agentAddress(deps.db, email);
  if (!hit) return;
  const orgId = ctx.orgId || hit.orgId;
  const address = normalAddress(email) || email;
  if (orgId) {
    await audit(deps.db, {
      orgId, actorUserId: ctx.actorUserId ?? null, actorEmail: ctx.actorEmail ?? null, action: ctx.action, ip: ctx.ip ?? null,
      // Never another workspace's id: this row is read by the admins of the workspace where it was tried.
      metadata: { email: address, reason: hit.via, ...ctx.metadata },
    }).catch((err: unknown) => deps.reportError?.(err, { where: "agent_address.audit" }));
  }
  deps.log?.warn("agent_address.refused", { action: ctx.action, reason: hit.via });
  throw new HttpError(422, "agent_address", agentAddressMessage(address), { fields: { email: agentAddressMessage(address) } });
}
