/**
 * AIS1 (audit of 11 Nov 2026, rows 50 and 15): who made the request an audit entry or a task change was written in.
 *
 * The audit log used to record a connected AI app's action as the person (same id, same email, no IP), and entries
 * written by services, MCP tools and v1 routes had no IP at all, because each of the 250 or so audit() calls had to pass
 * the IP and nothing said which key or app called. Instead, one small store per request carries that:
 * - app.ts opens it where it reads the request's IP (`c.var.ip`), for every route and sub-app, the lazily built
 *   v1 and MCP ones included. The Team AI drain after the response runs outside it.
 * - requireAuth (a person's session) and the v1 key check (an API key, or a connected app on MCP) note the caller
 *   once auth is known. Noting copies plain values; the shared auth objects are never changed.
 * - audit() (services/audit.ts) and recordWrite() (services/suite/common.ts) ask stampFor() for the IP and the caller
 *   stamp (shared/audit-caller.ts) of the entry they are about to write. Values passed explicitly win.
 *
 * Which entries get it:
 * - An entry naming a person (actorUserId) gets it only when that person is the caller: a key's or an app's
 *   own person, or the person signed in.
 * - In a request made with a key or a connected app, every other entry it causes (its agent's send, a rule, the system)
 *   gets the stamp and the IP, because the key or the app made it happen. A connected app's stamp there also names
 *   the person who connected it and the connection (causedStampFor), since the entry's actor is not that person.
 * - In a person's request, a row written for an agent or the system keeps neither their IP nor anything else (an
 *   approved send is the agent's).
 * - In a request with nobody signed in yet (signing up, signing in, a lockout), a row naming someone gets the IP.
 * - An address Multies can't read ("unknown") is not stored.
 *
 * Workers rarely lose an AsyncLocalStorage store under load (see request-state.ts). Then the entry has no stamp, as
 * before this round: a missing stamp never refuses or changes the write itself.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { callerKind, type CallerLike } from "./actor-kind";
import { makeCallerStamp, type CallerStamp } from "@/shared/audit-caller";

/** What a resolved auth carries that names its caller. ApiKeyAuth, the OAuth auth and a session's AuthContext all fit. */
export interface CallerAuth extends CallerLike {
  email?: string | null;
  /** The person's name (a session's or a connected app's). */
  name?: string | null;
  /** resolveApiKey: the key's name and prefix. */
  keyName?: string | null;
  keyPrefix?: string | null;
  /** resolveOAuthToken: the connected app's registered name. */
  clientName?: string | null;
}

interface NotedCaller { userId: string; email: string; stamp: CallerStamp | null; caused: CallerStamp | null }
interface RequestCaller { ip: string | null; caller?: NotedCaller }

let store: AsyncLocalStorage<RequestCaller> | undefined;

const usableIp = (ip: string | null | undefined) => (ip && !ip.startsWith("unknown") ? ip.slice(0, 64) : null);

/** Runs one request with its IP in scope (app.ts). The store is made on the first request, not at startup. */
export function runWithRequestCaller<T>(ip: string | null | undefined, fn: () => T): T {
  store ??= new AsyncLocalStorage<RequestCaller>();
  return store.run({ ip: usableIp(ip) }, fn);
}

/** The stamp a caller's entries carry: null for a person, an agent's own send or the system. */
export function callerStampFor(auth: CallerAuth): CallerStamp | null {
  const kind = callerKind(auth);
  if (kind === "oauth") return makeCallerStamp(kind, { app: auth.clientName });
  if (kind === "workspace_key" || kind === "agent_key" || kind === "agent_member_key") return makeCallerStamp(kind, { key: auth.keyName, prefix: auth.keyPrefix });
  return null;
}

/**
 * The stamp on an entry the caller's request writes for an agent or the system. A key's is its own stamp (the key
 * names itself). A connected app's adds the person who connected it (user, person) and the connection (grant), so two
 * people's apps of the same name sending as one agent read apart in the log and the export.
 */
export function causedStampFor(auth: CallerAuth): CallerStamp | null {
  const own = callerStampFor(auth);
  if (own?.kind !== "oauth") return own;
  const grant = auth.apiKeyId?.startsWith("oauth:") ? auth.apiKeyId.slice("oauth:".length) : undefined;
  return makeCallerStamp("oauth", { app: auth.clientName, user: auth.userId, person: auth.name, grant });
}

/** Notes who is calling, once auth is resolved (requireAuth, the v1 key check). Outside a request it does nothing. */
export function noteRequestCaller(auth: CallerAuth): void {
  const s = store?.getStore();
  if (!s) return;
  s.caller = { userId: auth.userId ?? "", email: auth.email ?? "", stamp: callerStampFor(auth), caused: causedStampFor(auth) };
}

/** The actor an entry names: an audit row's actor fields, or a task change's actor. */
export interface EntryActor { actorUserId?: string | null; actorEmail?: string | null }

/**
 * The IP and caller stamp for one entry written now, or null when the entry gets neither (no request, or the
 * entry is not the caller's; see the header for the rule).
 */
export function stampFor(e: EntryActor): { ip: string | null; caller: CallerStamp | null } | null {
  const s = store?.getStore();
  if (!s) return null;
  const c = s.caller;
  if (!c) return e.actorUserId || e.actorEmail ? { ip: s.ip, caller: null } : null;
  if (e.actorUserId) return e.actorUserId === c.userId ? { ip: s.ip, caller: c.stamp } : null;
  if (c.stamp) return { ip: s.ip, caller: e.actorEmail && e.actorEmail === c.email ? c.stamp : c.caused };
  return e.actorEmail && e.actorEmail === c.email ? { ip: s.ip, caller: null } : null;
}
