/**
 * AIS1 (audit of 11 Nov 2026, rows 50 and 15): how an audit entry or a task history line says what acted when it was
 * not a person in the app.
 *
 * During a request made with an API key or a connected AI app (OAuth, MCP), the server writes a `caller` stamp into the
 * audit entry's metadata and into the task change's data (src/server/lib/request-caller.ts): the kind of caller, the
 * key's name and prefix, or the app's name. A person's own action in the web or phone app has no stamp, so the two
 * read apart even though a connected app carries the person's id and email. The stamp is a copy, so an entry still
 * names its key after the key is deleted.
 * A connected app's stamp on an entry its request writes for an agent or the system (the agent's send, a rule) also
 * names the person who connected the app and the connection, since that entry's actor is the agent, not the person:
 * the app's name is whatever it registered with, so on its own it names nobody (AIS1 review 2).
 *
 * The labels are plain English like the rest of the audit views; the CSV and JSON export use the same words.
 */

export type CallerStampKind = "workspace_key" | "agent_key" | "agent_member_key" | "oauth";

export interface CallerStamp {
  kind: CallerStampKind;
  /** A key's name, as its admin named it in Settings, Developers or on the agent page. */
  key?: string;
  /** A key's first characters (mm_live_3kf9), as the key lists show them. */
  prefix?: string;
  /** A connected AI app's name, as it registered itself (Claude, ChatGPT, Cursor). */
  app?: string;
  /** A connected app, on an entry written for an agent or the system: the id of the person who connected it. */
  user?: string;
  /** That person's name, for the label. */
  person?: string;
  /** That connection's id, as Settings, Developers lists it (GET /api/oauth/grants). */
  grant?: string;
}

const KINDS: ReadonlySet<string> = new Set<CallerStampKind>(["workspace_key", "agent_key", "agent_member_key", "oauth"]);
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

type StampParts = { key?: unknown; prefix?: unknown; app?: unknown; user?: unknown; person?: unknown; grant?: unknown };

/** Builds a stamp, dropping empty parts; names are cut to 80 characters, a prefix to 20, an id to 64. */
export function makeCallerStamp(kind: CallerStampKind, parts: StampParts = {}): CallerStamp {
  const key = text(parts.key, 80), prefix = text(parts.prefix, 20), app = text(parts.app, 80);
  const user = text(parts.user, 64), person = text(parts.person, 80), grant = text(parts.grant, 64);
  return {
    kind, ...(key ? { key } : {}), ...(prefix ? { prefix } : {}), ...(app ? { app } : {}),
    ...(user ? { user } : {}), ...(person ? { person } : {}), ...(grant ? { grant } : {}),
  };
}

/** The stamp in a parsed metadata or data object's `caller` field, or null for a person's own action or an old entry. */
export function callerStampOf(v: unknown): CallerStamp | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== "string" || !KINDS.has(o.kind)) return null;
  return makeCallerStamp(o.kind as CallerStampKind, o);
}

const KEY_WORDS: Record<Exclude<CallerStampKind, "oauth">, string> = {
  workspace_key: "API key",
  agent_key: "agent key",
  agent_member_key: "agent member key",
};

function keyName(s: CallerStamp, word: string) {
  const named = s.key ? `${word} ${s.key}` : word;
  return s.prefix ? `${named} (${s.prefix})` : named;
}

/** "via Claude (connected app)", "via Ada's Claude (connected app)", "via API key Billing bot (mm_live_3kf9)". */
export function viaLabel(s: CallerStamp): string {
  if (s.kind === "oauth" && s.person) return s.app ? `via ${s.person}'s ${s.app} (connected app)` : `via ${s.person}'s connected app`;
  if (s.kind === "oauth") return s.app ? `via ${s.app} (connected app)` : "via a connected app";
  return `via ${keyName(s, KEY_WORDS[s.kind])}`;
}

/**
 * Who an audit entry names, for the audit views. A key acting for the whole workspace (actor "api-key:<prefix>") reads
 * as the key itself, by name and prefix, or by prefix alone for an entry written before the stamp existed. An agent's or a
 * person's entry keeps its actor, and `via` says which key or connected app they acted through.
 */
export function auditWho(e: { actorEmail?: string | null; metadata?: Record<string, unknown> | null }): { actor: string | null; via: string | null } {
  const stamp = callerStampOf(e.metadata?.caller);
  const email = e.actorEmail ?? null;
  if (email?.startsWith("api-key:")) {
    const prefix = email.slice("api-key:".length);
    if (stamp && stamp.kind !== "oauth" && stamp.kind !== "agent_key" && (!stamp.prefix || stamp.prefix === prefix)) {
      const word = KEY_WORDS[stamp.kind];
      return { actor: keyName({ ...stamp, prefix }, word.charAt(0).toUpperCase() + word.slice(1)), via: null };
    }
    return { actor: `API key (${prefix})`, via: stamp ? viaLabel(stamp) : null };
  }
  return { actor: email, via: stamp ? viaLabel(stamp) : null };
}
