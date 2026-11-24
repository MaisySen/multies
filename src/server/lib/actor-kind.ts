/**
 * AIS1 (audit of 11 Nov 2026): one answer to "who is really calling?".
 *
 * Several guardrails must only be lowered by a person signed in to the app, never by an API key or a connected
 * AI app (an agent's approval rule, a Triage decision, a public link with no end date). Before this module each
 * service had its own check and they disagreed: calendar-sync counts a connected app as the person, the mailbox
 * log only looked at the "api-key:" email prefix, and team.ts looked at the session id, which the MCP route
 * rewrites to "mcp:...". Use this module for every new "people only" rule.
 *
 * How each caller looks when it reaches a service:
 * - person: a Better Auth session from the web app or the phone app. A random session id, no apiKeyId, no agentId.
 * - workspace_key: resolveApiKey. apiKeyId is the key id, session id "apikey:<id>", keyKind "workspace". Round 2: the
 *   role is its maker's current one, at most "admin" (a demoted maker's key reads "member"), so keyKind tells it
 *   apart from an agent member's key.
 * - agent_key: resolveApiKey for an agent inbox key. As above, with agentId set.
 * - agent_member_key: resolveApiKey for an AI agent member's key. apiKeyId set, role "member".
 * - oauth: resolveOAuthToken (MCP only). The person's own userId, email and role, apiKeyId "oauth:<grantId>".
 * - agent: an agent's own send (asAgent in services/agents). Session id "agent:<id>"; since PRIV1b it may carry
 *   the maker's or the approver's userId, so the session id is checked before the userId.
 * - system: automations and jobs (SuiteActor.system), or nobody (no userId).
 *
 * apiKeyId, agentId and system are the signals. The session id is only a fallback for an AuthContext that lost
 * those fields, and SuiteActor has no session id at all.
 */
import { HttpError } from "./errors";

export type CallerKind = "person" | "workspace_key" | "agent_key" | "agent_member_key" | "oauth" | "agent" | "system";

/** The fields that tell callers apart. AuthContext, the v1 actor and SuiteActor all fit. */
export interface CallerLike {
  userId?: string | null;
  agentId?: string | null;
  apiKeyId?: string | null;
  system?: boolean;
  sessionId?: string | null;
  role?: string | null;
  /** Set by resolveApiKey: which kind of key this is. Trusted over the role when present. */
  keyKind?: "workspace" | "agent" | "agent_member" | null;
}

export function callerKind(a: CallerLike): CallerKind {
  if (a.system) return "system";
  const key = a.apiKeyId ?? "";
  if (a.agentId) return key ? "agent_key" : "agent";
  if (key.startsWith("oauth:")) return "oauth";
  if (key && a.keyKind === "workspace") return "workspace_key";
  if (key && a.keyKind === "agent_member") return "agent_member_key";
  if (key) return a.role === "member" ? "agent_member_key" : "workspace_key";
  // No key fields: fall back to the session id. The MCP route prefixes it with "mcp:".
  const session = (a.sessionId ?? "").replace(/^mcp:/, "");
  if (session.startsWith("oauth:")) return "oauth";
  if (session.startsWith("apikey:")) return a.role === "member" ? "agent_member_key" : "workspace_key";
  if (session.startsWith("agent:")) return "agent";
  if (!a.userId) return "system";
  return "person";
}

/**
 * Round 2: a workspace key or an agent member's key acts for the workspace, not for the person who made it, so it has
 * no personal mailbox access of its own (its maker's personal mailboxes and the shares she holds stay closed to it).
 */
export const isKeyWithoutPerson = (a: CallerLike): boolean => {
  const k = callerKind(a);
  return k === "workspace_key" || k === "agent_member_key";
};

/** True only for a person signed in to the web app or the phone app. A key or a connected AI app is never a person. */
export const isPersonSession = (a: CallerLike): boolean => callerKind(a) === "person";

/**
 * Refuses anyone but a person signed in to the app. `what` starts the sentence the caller reads, for example
 * "Letting an agent send without approval". Answers 403 person_only, the code the other people-only rules use.
 */
export function requirePerson(a: CallerLike, what: string): void {
  if (isPersonSession(a)) return;
  throw new HttpError(403, "person_only", `${what} needs a person signed in to Multies. An API key or a connected AI app can't do it.`);
}
