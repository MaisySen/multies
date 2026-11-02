/**
 * TD5 universal mentions (MENTIONS_TD5): the pure rules shared by the server and the web app.
 *
 * A record mention is stored in text as a token `<#type:id>`. The token never carries a title: every reader gets the
 * title resolved for them at read time, so a person without access sees "Restricted item" and nothing else.
 * While someone edits, tokens show as `@[Title]` labels and turn back into tokens on save (labelsToTokens).
 */

export const REF_TYPES = ["task", "project", "doc", "contact", "deal", "meeting", "form", "invoice", "thread"] as const;
export type RefType = (typeof REF_TYPES)[number];
/** The kinds the @ picker offers (mail threads are linked from mail, not picked). */
export const PICK_TYPES: RefType[] = ["task", "project", "doc", "contact", "deal", "meeting", "form", "invoice"];
export const SOURCE_TYPES = ["chat", "task", "task_comment", "doc_comment", "note", "doc"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const REF_LABELS: Record<RefType, string> = {
  task: "Task", project: "Project", doc: "Doc", contact: "Contact", deal: "Deal", meeting: "Meeting", form: "Form", invoice: "Invoice", thread: "Email",
};
export const SOURCE_LABELS: Record<SourceType, string> = {
  chat: "Chat message", task: "Task", task_comment: "Task comment", doc_comment: "Doc comment", note: "Contact note", doc: "Doc",
};

/** At most this many record tokens are indexed per source text; more are kept as text but not linked. */
export const MAX_REFS_PER_SOURCE = 20;
export const RESOLVE_MAX = 50;
export const REFS_PAGE = 20;

const ID = "[A-Za-z0-9_.@-]{1,200}";
export const REF_TOKEN_RE = new RegExp(`<#(${REF_TYPES.join("|")}):(${ID})>`, "g");

export interface RecordRef { type: RefType; id: string }
export const refKey = (r: RecordRef) => `${r.type}:${r.id}`;

export function isRefType(x: unknown): x is RefType { return typeof x === "string" && (REF_TYPES as readonly string[]).includes(x); }
export function isSourceType(x: unknown): x is SourceType { return typeof x === "string" && (SOURCE_TYPES as readonly string[]).includes(x); }

/** "task:abc" to a ref, or null when the type or id is not allowed. */
export function parseRefKey(k: unknown): RecordRef | null {
  if (typeof k !== "string" || k.length > 220) return null;
  const i = k.indexOf(":");
  if (i < 1) return null;
  const type = k.slice(0, i), id = k.slice(i + 1);
  return isRefType(type) && new RegExp(`^${ID}$`).test(id) ? { type, id } : null;
}

/** The record tokens in a text, in order, without duplicates, capped at MAX_REFS_PER_SOURCE. */
export function parseRefs(text: string | null | undefined, max = MAX_REFS_PER_SOURCE): RecordRef[] {
  const out: RecordRef[] = [];
  const seen = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(REF_TOKEN_RE)) {
    const r = { type: m[1] as RefType, id: m[2]! };
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

/** The token written for a picked record. */
export const refToken = (r: RecordRef) => `<#${r.type}:${r.id}>`;

/** What changed between two sets of refs: the rows to add and the rows to remove. */
export function diffRefs(before: RecordRef[], after: RecordRef[]): { add: RecordRef[]; remove: RecordRef[] } {
  const b = new Set(before.map(refKey)), a = new Set(after.map(refKey));
  return { add: after.filter((r) => !b.has(refKey(r))), remove: before.filter((r) => !a.has(refKey(r))) };
}

/** A label is safe inside @[ ]: no brackets, no line breaks, at most 80 characters. */
export function cleanLabel(title: string): string {
  const t = title.replace(/[[\]\r\n<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return t || "Untitled";
}

/**
 * Tokens to `@[Title]` labels for editing. `titles` maps refKey to the title the viewer may see (or "Restricted item" /
 * "Deleted item"). Labels that would clash get a number, so every label maps back to exactly one token.
 */
export function tokensToLabels(text: string, titles: Record<string, string>): { text: string; map: Record<string, string> } {
  const map: Record<string, string> = {};
  const byToken = new Map<string, string>();
  const used = new Set<string>();
  const out = text.replace(REF_TOKEN_RE, (tok, type: string, id: string) => {
    const hit = byToken.get(tok);
    if (hit) return hit;
    const base = cleanLabel(titles[`${type}:${id}`] ?? "Loading");
    let label = `@[${base}]`;
    for (let n = 2; used.has(label); n++) label = `@[${base} ${n}]`;
    used.add(label);
    byToken.set(tok, label);
    map[label] = tok;
    return label;
  });
  return { text: out, map };
}

/** Labels back to tokens (longest first, so "@[Plan 2]" is not read as "@[Plan]"). Unknown labels stay as typed. */
export function labelsToTokens(text: string, map: Record<string, string>): string {
  let out = text;
  for (const label of Object.keys(map).sort((a, b) => b.length - a.length)) out = out.split(label).join(map[label]!);
  return out;
}

/** The @words being typed before the caret (records and people share the trigger): up to 3 words, 40 characters. */
export function atQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@((?:[^\s@[\]<>]+ ?){0,3})$/.exec(text.slice(0, caret));
  if (!m || m[2]!.length > 40 || /^\s/.test(m[2]!)) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/** Plain words for a token where no title is known yet (notifications, previews): never a title. */
export function tokensToPlain(text: string): string {
  return text.replace(REF_TOKEN_RE, (_t, type: string) => `@${REF_LABELS[type as RefType].toLowerCase()}`);
}

/** Where a record opens in the app. */
export function refUrl(r: RecordRef, extra: { projectId?: string | null; channelId?: string | null; messageId?: string | null } = {}): string {
  const id = encodeURIComponent(r.id);
  switch (r.type) {
    case "task": return extra.projectId ? `/app/tasks?project=${encodeURIComponent(extra.projectId)}&task=${id}` : `/app/tasks?task=${id}`;
    case "project": return `/app/tasks?project=${id}`;
    case "doc": return `/app/docs/${id}`;
    case "contact": return `/app/contacts/${id}`;
    case "deal": return `/app/deals?deal=${id}`;
    case "meeting": return `/app/meetings/${id}`;
    case "form": return `/app/forms?form=${id}`;
    case "invoice": return `/app/contacts/invoices/${id}`;
    case "thread": return extra.messageId ? `/app/mail?message=${encodeURIComponent(extra.messageId)}` : `/app/mail`;
  }
}

/** A References panel item can also be a chat channel (where a message mentioned the record). */
export type ItemType = RefType | "channel";
/** What a reader sees for one ref: the record, or a placeholder that carries no title. */
export type ResolvedRef =
  | { state: "ok"; type: ItemType; id: string; title: string; subtitle: string; url: string }
  | { state: "restricted"; type: ItemType; id: string }
  | { state: "deleted"; type: ItemType; id: string };

export const RESTRICTED_LABEL = "Restricted item";
export const DELETED_LABEL = "Deleted item";
export function displayTitle(r: ResolvedRef | undefined): string {
  if (!r) return "Loading";
  return r.state === "ok" ? r.title : r.state === "restricted" ? RESTRICTED_LABEL : DELETED_LABEL;
}

/** One row of a References panel. */
export interface RefItem { key: string; at: string; via: SourceType; record: ResolvedRef; where?: string | null }

/** Rank picker results: newest first, ties by title. */
export function rankByRecency<T extends { at: string | null; title: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.title.localeCompare(b.title));
}
