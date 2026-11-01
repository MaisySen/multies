/**
 * R98 search (SEARCH_R98): typo tolerant, filtered, ranked search across the workspace, and the small title index
 * the command menu keeps in memory for instant results.
 *
 * Same permission rules as round 20 (search.ts), checked in every query, never after the fact:
 * - mail: the caller's mailbox scope; chat: public channels plus private channels and DMs the person belongs to;
 * - files: task files in the caller's workspace, chat files only in channels the caller can read;
 * - notes (CRM notes, calls and meetings, only with CRM_TIMELINE): shared ones, plus the caller's own private ones.
 *   Nobody else sees a private note, admins included. Keys and guests get no notes;
 * - a project guest: that project's tasks, docs and files, and its guest channels. Nothing else.
 *
 * Reads only, bounded: every query has a LIMIT, the typo pass runs only when a word finds nothing, and nothing here
 * runs on a hot route (the menu calls it while someone types, the index when the menu opens).
 */
import { and, desc, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../context";
import { chatChannels, chatFiles, chatMessages, contacts, crmEntries, deals, docs, members, messages, projects, taskFiles, tasks, users } from "../db/schema";
import { HttpError } from "../lib/errors";
import { inIds } from "../lib/sql-chunks";
import { scopeOf, type SuiteActor } from "./suite/common";
import { plainText } from "./suite/chat";
import { notBlockedBy } from "./suite/reports-r35";
import { searchAttachmentText } from "./tools/attachment-index";
import {
  excerpt, readableChannels, SEARCH_BUDGET_MS, SEARCH_DEFAULT_LIMIT, SEARCH_LABELS, SEARCH_MAX_CHARS, SEARCH_MIN_CHARS, SEARCH_TYPES_R98,
  type SearchItem, type SearchResult, type SearchType, type SearchViewer,
} from "./search";
import { containsAny, containsText } from "../lib/like-search";

// ---------------------------------------------------------------- words, typos, ranking (pure)

/** Lower case words of a query: letters and digits (any script), at most 6, each at most 40 characters. */
export function queryWords(q: string): string[] {
  const words = q.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}@._'-]+/u).map((w) => w.replace(/^[._'-]+|[._'-]+$/g, "")).filter((w) => w.length > 0);
  return [...new Set(words)].slice(0, 6).map((w) => w.slice(0, 40));
}

/** How many typos a word may have: none under 4 letters, 1 from 4, 2 from 8. */
export function typoBudget(word: string): number {
  return word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0;
}

/** Optimal string alignment distance (insert, delete, substitute, swap two neighbours), stopping above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length, m = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

/**
 * The pieces of a word the typo pass looks for. One typo (or one swap) always leaves one of them whole:
 * the first half, the second half, or (for a swap across the middle) the first half less its last letter.
 */
export function typoPieces(word: string): string[] {
  if (typoBudget(word) === 0) return [];
  const h = Math.ceil(word.length / 2);
  // A swap across the middle breaks both halves; one letter shorter on each side is whole again.
  const pieces = [word.slice(0, h), word.slice(h), word.slice(0, h - 1), word.slice(h + 1)];
  return [...new Set(pieces.filter((p) => p.length >= 2))];
}

/** Words of a text, plus the parts of joined words ("lease-floorplan.png" also gives "lease", "floorplan", "png"). */
const tokensOf = (text: string) => {
  const words = text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}@._'-]+/u).filter(Boolean);
  const parts = words.flatMap((w) => (/[@._'-]/.test(w) ? w.split(/[@._'-]+/).filter(Boolean) : []));
  return parts.length ? [...words, ...parts] : words;
};

/** The closest word in `text` to `word` within its typo budget (prefix aware: "invo" is close to "invoice"), or null. */
export function closeWord(word: string, text: string): { word: string; distance: number } | null {
  const budget = typoBudget(word);
  if (!budget) return null;
  let best: { word: string; distance: number } | null = null;
  for (const t of tokensOf(text)) {
    if (t.includes(word)) return { word: t, distance: 0 };
    const whole = editDistance(word, t, budget);
    const prefix = t.length > word.length ? editDistance(word, t.slice(0, word.length), budget) + 0.5 : budget + 1;
    const d = Math.min(whole, prefix);
    if (d <= budget && (!best || d < best.distance)) best = { word: t, distance: d };
  }
  return best;
}

/**
 * A score for one result: every word must be found (exactly, or within its typo budget when `fuzzy`), or the result
 * is dropped (null). Title matches beat body matches, whole words beat word starts beat parts of words, exact beats typo.
 */
export function scoreMatch(words: string[], title: string, body: string, fuzzy: boolean): { score: number; typos: number; corrected: Map<string, string> } | null {
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  const titleWords = tokensOf(t);
  let score = 0, typos = 0;
  const corrected = new Map<string, string>();
  for (const w of words) {
    if (titleWords.includes(w)) score += 30;
    else if (titleWords.some((x) => x.startsWith(w))) score += 22;
    else if (t.includes(w)) score += 14;
    else if (b.includes(w)) score += 6;
    else if (fuzzy) {
      const inTitle = closeWord(w, t);
      const hit = inTitle ?? closeWord(w, b.slice(0, 4000));
      if (!hit) return null;
      score += inTitle ? 10 - hit.distance * 3 : 3 - hit.distance;
      typos += Math.ceil(hit.distance);
      if (hit.distance > 0) corrected.set(w, hit.word);
    } else return null;
  }
  if (t === words.join(" ")) score += 25;
  else if (t.startsWith(words.join(" "))) score += 10;
  return { score, typos, corrected };
}

// ---------------------------------------------------------------- filters

export interface SearchFilters {
  /** A workspace member's user id: mail from them, tasks assigned to or made by them, docs, messages, files and notes by them. */
  person?: string | null;
  /** Inclusive day range, YYYY-MM-DD, in UTC. */
  from?: string | null;
  to?: string | null;
  /** Only tasks, docs, chat and files of this project. */
  project?: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Validates filters from a query string. Bad values are a 422 with a plain message. */
export function parseFilters(q: { person?: string; from?: string; to?: string; project?: string }): SearchFilters {
  const f: SearchFilters = {};
  for (const k of ["from", "to"] as const) {
    const v = q[k]?.trim();
    if (!v) continue;
    if (!DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new HttpError(422, "validation_failed", `Use a date like 2026-10-31 for ${k}.`);
    f[k] = v;
  }
  if (f.from && f.to && f.from > f.to) throw new HttpError(422, "validation_failed", "The start date is after the end date.");
  for (const k of ["person", "project"] as const) {
    const v = q[k]?.trim();
    if (v) { if (v.length > 80 || !/^[\w-]+$/.test(v)) throw new HttpError(422, "validation_failed", `Unknown ${k}.`); f[k] = v; }
  }
  return f;
}

/** Which types a filter can apply to. A type that cannot honour an active filter is left out rather than shown unfiltered. */
export const FILTER_TYPES: Record<"person" | "project", SearchType[]> = {
  person: ["mail", "tasks", "docs", "chat", "files", "notes"],
  project: ["tasks", "docs", "chat", "files"],
};

const range = (col: Parameters<typeof gte>[0], f: SearchFilters): SQL | undefined => and(
  f.from ? gte(col as never, new Date(`${f.from}T00:00:00.000Z`) as never) : undefined,
  f.to ? lte(col as never, new Date(`${f.to}T23:59:59.999Z`) as never) : undefined,
);

// ---------------------------------------------------------------- matching SQL

/** LK1: instr, so a long word (a URL, a pasted line) never meets D1's 50 byte LIKE limit. */
const likeAny = (cols: SQL[], piece: string) => containsAny(cols, piece);
/** Every word somewhere in the columns (exact pass), or, for the typo pass, one of each word's pieces. */
function matchAll(cols: SQL[], words: string[], fuzzy: boolean): SQL {
  return and(...words.map((w) => {
    if (!fuzzy || !typoBudget(w)) return likeAny(cols, w);
    return or(...typoPieces(w).map((p) => likeAny(cols, p)))!;
  }))!;
}

interface Candidate { item: SearchItem; title: string; body: string; at: number; /** An exact task key (OPS-12): always first. */ pinned?: boolean }
interface Ctx {
  deps: Deps; v: SearchViewer; words: string[]; fuzzy: boolean; limit: number; f: SearchFilters; person: { id: string; email: string } | null;
  /** R110: only these ids (re-checking that cited sources are still openable, with the very same scope). */
  ids?: string[];
}
/** R110: the id filter of the id-only mode (undefined when not in that mode). */
const onlyIds = (c: Ctx, col: Parameters<typeof inIds>[0]) => (c.ids ? inIds(col, c.ids) : undefined);

const iso = (d: Date | number | null | undefined) => (d == null ? null : new Date(d).toISOString());
const isKey = (a: SuiteActor) => !!(a.agentId || a.apiKeyId);
/** How many rows a group reads before ranking: enough to rank, never unbounded. */
const fetchN = (c: Ctx) => Math.min(c.limit * (c.fuzzy ? 8 : 3), 80);
const orgOf = (v: SearchViewer) => (v.kind === "guest" ? v.orgId : v.actor.orgId);
const userOf = (v: SearchViewer) => (v.kind === "actor" && !isKey(v.actor) && v.actor.userId ? v.actor.userId : null);

async function mailGroup(c: Ctx): Promise<Candidate[]> {
  if (c.v.kind !== "actor") return [];
  const scope = await scopeOf(c.deps, c.v.actor);
  if (scope && !scope.length) return [];
  const rows = await c.deps.db.select({
    id: messages.id, threadId: messages.threadId, mailboxId: messages.mailboxId, folder: messages.folder, subject: messages.subject,
    fromName: messages.fromName, fromAddress: messages.fromAddress, snippet: messages.snippet, date: messages.date,
  }).from(messages)
    .where(and(eq(messages.orgId, c.v.actor.orgId), scope ? inIds(messages.mailboxId, scope) : undefined, sql`${messages.folder} <> 'trash'`,
      c.person ? sql`lower(${messages.fromAddress}) = ${c.person.email.toLowerCase()}` : undefined, range(messages.date, c.f), onlyIds(c, messages.id),
      matchAll([sql`${messages.subject}`, sql`${messages.fromName}`, sql`${messages.fromAddress}`, sql`${messages.snippet}`], c.words, c.fuzzy)))
    .orderBy(desc(messages.date)).limit(fetchN(c));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const m of rows) {
    if (seen.has(m.threadId)) continue;
    seen.add(m.threadId);
    out.push({
      title: m.subject || "", body: `${m.fromName} ${m.fromAddress} ${m.snippet}`, at: m.date ? new Date(m.date).getTime() : 0,
      item: { type: "mail", id: m.id, title: m.subject || "(no subject)", subtitle: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress, snippet: m.snippet.slice(0, 160),
        url: `/app/mail?mailbox=${encodeURIComponent(m.mailboxId)}&folder=${encodeURIComponent(m.folder)}&m=${encodeURIComponent(m.id)}`, at: iso(m.date) },
    });
  }
  return out;
}

const STATUS_LABEL = { todo: "To do", doing: "In progress", done: "Done" } as const;
const TASK_KEY = /^([a-z0-9]{1,6})-(\d+)$/i;

async function taskGroup(c: Ctx): Promise<Candidate[]> {
  const orgId = orgOf(c.v);
  const projectId = c.v.kind === "guest" ? c.v.projectId : c.f.project ?? undefined;
  if (c.v.kind === "guest" && c.f.project && c.f.project !== c.v.projectId) return [];
  const cols = { id: tasks.id, title: tasks.title, notes: tasks.notes, number: tasks.number, status: tasks.status, projectId: tasks.projectId, updatedAt: tasks.updatedAt, key: projects.key, projectName: projects.name };
  const base = and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), isNull(tasks.triageState), projectId ? eq(tasks.projectId, projectId) : undefined,
    c.person ? or(and(eq(tasks.assigneeType, "member"), eq(tasks.assigneeId, c.person.id)), eq(tasks.createdById, c.person.id), containsText(tasks.coAssignees, `"member:${c.person.id}"`)) : undefined,
    range(tasks.updatedAt, c.f), onlyIds(c, tasks.id));
  const key = c.words.length === 1 ? TASK_KEY.exec(c.words[0]) : null;
  const exact = key ? await c.deps.db.select(cols).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(base, eq(projects.orgId, orgId), sql`upper(${projects.key}) = ${key[1].toUpperCase()}`, eq(tasks.number, Number(key[2])))).limit(1) : [];
  const rows = await c.deps.db.select(cols).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(base, matchAll([sql`${tasks.title}`, sql`${tasks.notes}`], c.words, c.fuzzy))).orderBy(desc(tasks.updatedAt)).limit(fetchN(c));
  const toCand = (t: (typeof rows)[number], pinned = false): Candidate => ({
    title: t.title, body: t.notes, at: new Date(t.updatedAt).getTime(), pinned,
    item: { type: "tasks", id: t.id, title: t.title, subtitle: `${t.key}-${t.number} · ${STATUS_LABEL[t.status]} · ${t.projectName}`,
      snippet: c.words.every((w) => t.title.toLowerCase().includes(w)) ? "" : excerpt(t.notes, c.words[0]), url: c.v.kind === "guest" ? `/guest?task=${encodeURIComponent(t.id)}` : `/app/tasks?project=${encodeURIComponent(t.projectId)}&task=${encodeURIComponent(t.id)}`, at: iso(t.updatedAt) },
  });
  return [...exact.map((t) => toCand(t, true)), ...rows.filter((r) => !exact.some((e) => e.id === r.id)).map((t) => toCand(t))];
}

async function docGroup(c: Ctx): Promise<Candidate[]> {
  const projectId = c.v.kind === "guest" ? c.v.projectId : c.f.project ?? undefined;
  if (c.v.kind === "guest" && c.f.project && c.f.project !== c.v.projectId) return [];
  const rows = await c.deps.db.select({ id: docs.id, title: docs.title, plainText: docs.plainText, updatedAt: docs.updatedAt, kind: docs.kind }).from(docs)
    .where(and(eq(docs.orgId, orgOf(c.v)), isNull(docs.deletedAt), projectId ? eq(docs.projectId, projectId) : undefined,
      c.person ? eq(docs.createdById, c.person.id) : undefined, range(docs.updatedAt, c.f), onlyIds(c, docs.id), matchAll([sql`${docs.title}`, sql`${docs.plainText}`], c.words, c.fuzzy)))
    .orderBy(desc(docs.updatedAt)).limit(fetchN(c));
  return rows.map((d) => ({
    title: d.title, body: d.plainText, at: new Date(d.updatedAt).getTime(),
    item: { type: "docs", id: d.id, title: d.title || "Untitled", subtitle: d.kind === "whiteboard" ? "Whiteboard" : "Doc", snippet: excerpt(d.plainText, c.words[0]), url: c.v.kind === "guest" ? `/guest?doc=${encodeURIComponent(d.id)}` : `/app/docs/${encodeURIComponent(d.id)}`, at: iso(d.updatedAt) },
  }));
}

async function channelsFor(c: Ctx) {
  let channels = await readableChannels(c.deps, c.v);
  if (c.f.project) {
    const withProject = await c.deps.db.select({ id: chatChannels.id }).from(chatChannels).where(and(eq(chatChannels.orgId, orgOf(c.v)), eq(chatChannels.projectId, c.f.project)));
    const ok = new Set(withProject.map((r) => r.id));
    channels = channels.filter((ch) => ok.has(ch.id));
  }
  return channels;
}

async function chatGroup(c: Ctx): Promise<Candidate[]> {
  const channels = await channelsFor(c);
  if (!channels.length) return [];
  const byId = new Map(channels.map((ch) => [ch.id, ch]));
  const rows = await c.deps.db.select({
    id: chatMessages.id, channelId: chatMessages.channelId, parentId: chatMessages.parentId, authorName: chatMessages.authorName, body: chatMessages.body,
    mentions: chatMessages.mentions, links: chatMessages.links, createdAt: chatMessages.createdAt,
  }).from(chatMessages)
    .where(and(eq(chatMessages.orgId, orgOf(c.v)), inIds(chatMessages.channelId, [...byId.keys()]), isNull(chatMessages.deletedAt),
      c.person ? eq(chatMessages.authorId, c.person.id) : undefined, range(chatMessages.createdAt, c.f), onlyIds(c, chatMessages.id),
      matchAll([sql`${chatMessages.body}`], c.words, c.fuzzy), notBlockedBy(chatMessages.authorId, userOf(c.v))))
    .orderBy(desc(chatMessages.createdAt)).limit(fetchN(c));
  return rows.map((m) => {
    const ch = byId.get(m.channelId)!;
    let text = m.body;
    try { text = plainText(m.body, JSON.parse(m.mentions), JSON.parse(m.links)); } catch { /* raw body */ }
    const where = ch.kind === "dm" ? "Direct message" : `#${ch.name}`;
    const url = c.v.kind === "guest" ? `/guest?channel=${encodeURIComponent(ch.id)}` : `/app/chat/${encodeURIComponent(ch.id)}?thread=${encodeURIComponent(m.parentId ?? m.id)}`;
    return { title: "", body: text, at: new Date(m.createdAt).getTime(), item: { type: "chat" as const, id: m.id, title: excerpt(text, c.words[0], 120), subtitle: `${m.authorName || "Someone"} in ${where}`, snippet: "", url, at: iso(m.createdAt) } };
  });
}

async function contactGroup(c: Ctx): Promise<Candidate[]> {
  if (c.v.kind !== "actor") return [];
  const rows = await c.deps.db.select({ id: contacts.id, name: contacts.name, email: contacts.email, title: contacts.title, lastContactAt: contacts.lastContactAt, updatedAt: contacts.updatedAt }).from(contacts)
    .where(and(eq(contacts.orgId, c.v.actor.orgId), isNull(contacts.deletedAt), range(contacts.updatedAt, c.f), onlyIds(c, contacts.id), matchAll([sql`${contacts.name}`, sql`${contacts.email}`], c.words, c.fuzzy)))
    .orderBy(sql`coalesce(${contacts.lastContactAt}, ${contacts.updatedAt}) desc`).limit(fetchN(c));
  return rows.map((r) => ({
    title: `${r.name} ${r.email}`, body: r.title ?? "", at: new Date(r.lastContactAt ?? r.updatedAt).getTime(),
    item: { type: "contacts", id: r.id, title: r.name || r.email, subtitle: [r.name ? r.email : "", r.title ?? ""].filter(Boolean).join(" · "), snippet: "", url: `/app/contacts/${encodeURIComponent(r.id)}`, at: iso(r.lastContactAt ?? r.updatedAt) },
  }));
}

const STAGE_LABEL = { lead: "Lead", qualified: "Qualified", proposal: "Proposal", won: "Won", lost: "Lost" } as const;
async function dealGroup(c: Ctx): Promise<Candidate[]> {
  if (c.v.kind !== "actor") return [];
  const rows = await c.deps.db.select({ id: deals.id, title: deals.title, stage: deals.stage, valueCents: deals.valueCents, updatedAt: deals.updatedAt }).from(deals)
    .where(and(eq(deals.orgId, c.v.actor.orgId), isNull(deals.deletedAt), range(deals.updatedAt, c.f), onlyIds(c, deals.id), matchAll([sql`${deals.title}`], c.words, c.fuzzy)))
    .orderBy(desc(deals.updatedAt)).limit(fetchN(c));
  return rows.map((d) => ({
    title: d.title, body: "", at: new Date(d.updatedAt).getTime(),
    item: { type: "deals", id: d.id, title: d.title, subtitle: `${STAGE_LABEL[d.stage]} · ${(d.valueCents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 })}`, snippet: "", url: `/app/deals?deal=${encodeURIComponent(d.id)}`, at: iso(d.updatedAt) },
  }));
}

async function attachmentGroup(c: Ctx): Promise<Candidate[]> {
  if (c.v.kind !== "actor" || c.fuzzy || c.person || c.f.from || c.f.to || c.ids) return [];
  const scope = await scopeOf(c.deps, c.v.actor);
  const rows = await searchAttachmentText(c.deps, c.v.actor.orgId, scope, c.words.join(" "), { limit: c.limit });
  return rows.map((r) => ({
    title: r.filename || "", body: r.snip ?? "", at: Number(r.date),
    item: { type: "attachments", id: r.attachment_id, title: r.filename || "Attachment", subtitle: [r.subject || "(no subject)", r.from_name || r.from_address].filter(Boolean).join(" · "),
      snippet: (r.snip ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      url: `/app/mail?mailbox=${encodeURIComponent(r.mailbox_id)}&folder=${encodeURIComponent(r.folder)}&m=${encodeURIComponent(r.message_id)}&attachment=${encodeURIComponent(r.attachment_id)}`, at: iso(Number(r.date)) },
  }));
}

const sizeLabel = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Files on tasks (the caller's workspace, or a guest's one project) and in chat channels the caller can read. */
async function fileGroup(c: Ctx): Promise<Candidate[]> {
  const orgId = orgOf(c.v);
  const projectId = c.v.kind === "guest" ? c.v.projectId : c.f.project ?? undefined;
  if (c.v.kind === "guest" && c.f.project && c.f.project !== c.v.projectId) return [];
  const n = fetchN(c);
  const onTasks = c.deps.db.select({ id: taskFiles.id, filename: taskFiles.filename, sizeBytes: taskFiles.sizeBytes, createdAt: taskFiles.createdAt, by: taskFiles.uploadedByName, taskId: tasks.id, taskTitle: tasks.title, projectId: tasks.projectId })
    .from(taskFiles).innerJoin(tasks, eq(tasks.id, taskFiles.taskId))
    .where(and(eq(taskFiles.orgId, orgId), eq(tasks.orgId, orgId), isNull(tasks.deletedAt), isNull(tasks.triageState), projectId ? eq(tasks.projectId, projectId) : undefined,
      c.person ? and(eq(taskFiles.uploadedByType, "member"), eq(taskFiles.uploadedById, c.person.id)) : undefined, range(taskFiles.createdAt, c.f), onlyIds(c, taskFiles.id),
      matchAll([sql`${taskFiles.filename}`], c.words, c.fuzzy)))
    .orderBy(desc(taskFiles.createdAt)).limit(n);
  const channels = await channelsFor(c);
  const byId = new Map(channels.map((ch) => [ch.id, ch]));
  const inChat = channels.length ? c.deps.db.select({ id: chatFiles.id, filename: chatFiles.filename, sizeBytes: chatFiles.sizeBytes, createdAt: chatFiles.createdAt, channelId: chatFiles.channelId, messageId: chatFiles.messageId, authorId: chatMessages.authorId, parentId: chatMessages.parentId, deletedAt: chatMessages.deletedAt })
    .from(chatFiles).innerJoin(chatMessages, eq(chatMessages.id, chatFiles.messageId))
    .where(and(eq(chatFiles.orgId, orgId), inIds(chatFiles.channelId, [...byId.keys()]), isNull(chatMessages.deletedAt), eq(chatMessages.channelId, chatFiles.channelId),
      c.person ? eq(chatMessages.authorId, c.person.id) : undefined, range(chatFiles.createdAt, c.f), onlyIds(c, chatFiles.id), matchAll([sql`${chatFiles.filename}`], c.words, c.fuzzy),
      notBlockedBy(chatMessages.authorId, userOf(c.v))))
    .orderBy(desc(chatFiles.createdAt)).limit(n) : Promise.resolve([]);
  const [a, b] = await Promise.all([onTasks, inChat]);
  return [
    ...a.map((r) => ({ title: r.filename, body: "", at: new Date(r.createdAt).getTime(), item: { type: "files" as const, id: r.id, title: r.filename, subtitle: `On ${r.taskTitle} · ${sizeLabel(r.sizeBytes)}`, snippet: "",
      url: c.v.kind === "guest" ? `/guest?task=${encodeURIComponent(r.taskId)}` : `/app/tasks?project=${encodeURIComponent(r.projectId)}&task=${encodeURIComponent(r.taskId)}`, at: iso(r.createdAt) } })),
    ...b.map((r) => {
      const ch = byId.get(r.channelId)!;
      const url = c.v.kind === "guest" ? `/guest?channel=${encodeURIComponent(ch.id)}` : `/app/chat/${encodeURIComponent(ch.id)}?thread=${encodeURIComponent(r.parentId ?? r.messageId)}`;
      return { title: r.filename, body: "", at: new Date(r.createdAt).getTime(), item: { type: "files" as const, id: r.id, title: r.filename, subtitle: `In ${ch.kind === "dm" ? "a direct message" : `#${ch.name}`} · ${sizeLabel(r.sizeBytes)}`, snippet: "", url, at: iso(r.createdAt) } };
    }),
  ];
}

const KIND_LABEL = { note: "Note", call: "Call", meeting: "Meeting" } as const;
/** CRM notes, calls and meetings: shared ones, and only the caller's own private ones (admins included). People only. */
async function noteGroup(c: Ctx): Promise<Candidate[]> {
  const me = userOf(c.v);
  if (c.v.kind !== "actor" || !me) return [];
  const rows = await c.deps.db.select({ id: crmEntries.id, entityType: crmEntries.entityType, entityId: crmEntries.entityId, kind: crmEntries.kind, body: crmEntries.body, isPrivate: crmEntries.private, authorName: crmEntries.authorName, occurredAt: crmEntries.occurredAt })
    .from(crmEntries)
    .where(and(eq(crmEntries.orgId, c.v.actor.orgId), isNull(crmEntries.deletedAt), or(eq(crmEntries.private, false), eq(crmEntries.createdById, me)),
      c.person ? eq(crmEntries.createdById, c.person.id) : undefined, range(crmEntries.occurredAt, c.f), onlyIds(c, crmEntries.id), matchAll([sql`${crmEntries.body}`], c.words, c.fuzzy)))
    .orderBy(desc(crmEntries.occurredAt)).limit(fetchN(c));
  return rows.map((r) => {
    const url = r.entityType === "contact" ? `/app/contacts/${encodeURIComponent(r.entityId)}` : r.entityType === "company" ? `/app/contacts/companies/${encodeURIComponent(r.entityId)}` : `/app/deals?deal=${encodeURIComponent(r.entityId)}`;
    return { title: "", body: r.body, at: new Date(r.occurredAt).getTime(), item: { type: "notes" as const, id: r.id, title: excerpt(r.body, c.words[0], 120), subtitle: [KIND_LABEL[r.kind], r.isPrivate ? "Private" : "", r.authorName ?? ""].filter(Boolean).join(" · "), snippet: "", url, at: iso(r.occurredAt) } };
  });
}

// ---------------------------------------------------------------- the search

export interface SearchResultR98 extends SearchResult {
  /** The query with each misspelt word replaced by the word that was found, when the typo pass answered. */
  corrected?: string;
  /** The filters applied, echoed back. */
  filters?: SearchFilters;
}

const GROUPS: Record<SearchType, (c: Ctx) => Promise<Candidate[]>> = {
  mail: mailGroup, tasks: taskGroup, docs: docGroup, chat: chatGroup, contacts: contactGroup, deals: dealGroup, attachments: attachmentGroup, files: fileGroup, notes: noteGroup,
};

function rank(c: Ctx, cands: Candidate[]): { items: (SearchItem & { match?: "exact" | "typo" })[]; corrected: Map<string, string> } {
  const corrected = new Map<string, string>();
  const scored = cands.flatMap((x) => {
    const s = x.pinned ? { score: 1000, typos: 0, corrected: new Map<string, string>() } : scoreMatch(c.words, x.title || x.item.title, x.body, c.fuzzy);
    return s ? [{ x, s }] : [];
  });
  scored.sort((p, q) => q.s.score - p.s.score || p.s.typos - q.s.typos || q.x.at - p.x.at);
  const top = scored.slice(0, c.limit);
  for (const { s } of top) for (const [k, v] of s.corrected) if (!corrected.has(k)) corrected.set(k, v);
  return { items: top.map(({ x, s }) => ({ ...x.item, match: s.typos ? "typo" as const : "exact" as const })), corrected };
}

/** Resolves the person filter to a member of the caller's workspace (never someone elsewhere). */
async function personOf(deps: Deps, orgId: string, id: string | null | undefined) {
  if (!id) return null;
  const [r] = await deps.db.select({ id: users.id, email: users.email }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), eq(members.userId, id))).limit(1);
  if (!r) throw new HttpError(422, "validation_failed", "That person is not in this workspace.");
  return r;
}

/** The sources a viewer may search at all (guests: their project's tasks, docs, chat and files; keys: no notes). */
function allowedTypes(deps: Deps, v: SearchViewer, requested?: SearchType[]): SearchType[] {
  let types: SearchType[] = requested?.length ? SEARCH_TYPES_R98.filter((t) => requested.includes(t)) : [...SEARCH_TYPES_R98];
  if (v.kind === "guest") types = types.filter((t) => t === "tasks" || t === "docs" || t === "chat" || t === "files");
  else if (isKey(v.actor)) types = types.filter((t) => t !== "notes");
  const tools = deps.config.tools;
  if (!(tools.enabled && tools.features.includes("index") && deps.indexDb)) types = types.filter((t) => t !== "attachments");
  if (!deps.config.crmTimeline) types = types.filter((t) => t !== "notes");
  return types;
}

/**
 * R98 search: every source the viewer can open, in parallel, each bounded; words in any order; ranked; filtered.
 * A group whose exact pass finds nothing for a word of 4 or more letters runs one typo pass. Answers within the budget.
 */
export async function searchR98(deps: Deps, v: SearchViewer, rawQuery: string, opts: { types?: SearchType[]; limit?: number; budgetMs?: number; filters?: SearchFilters; strict?: boolean } = {}): Promise<SearchResultR98> {
  const started = Date.now();
  const q = (rawQuery ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_CHARS);
  const words = queryWords(q);
  if (q.length < SEARCH_MIN_CHARS || !words.length) throw new HttpError(422, "validation_failed", `Type at least ${SEARCH_MIN_CHARS} characters to search.`);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? SEARCH_DEFAULT_LIMIT), 1), 20);
  const f = opts.filters ?? {};
  let types = allowedTypes(deps, v, opts.types);
  if (f.person) types = types.filter((t) => FILTER_TYPES.person.includes(t));
  if (f.project) types = types.filter((t) => FILTER_TYPES.project.includes(t));
  // A guest cannot filter by person (they cannot see the workspace's people); the filter then finds nothing.
  if (v.kind === "guest" && f.person) types = [];
  const person = v.kind === "guest" ? null : await personOf(deps, v.actor.orgId, f.person);
  const base = { deps, v, words, limit, f, person };
  const done = new Map<SearchType, SearchItem[]>();
  const fixes = new Map<string, string>();
  const runOne = async (t: SearchType) => {
    const exact = rank({ ...base, fuzzy: false }, await GROUPS[t]({ ...base, fuzzy: false }));
    if (exact.items.length || opts.strict || !words.some((w) => typoBudget(w))) return exact.items;
    const loose = rank({ ...base, fuzzy: true }, await GROUPS[t]({ ...base, fuzzy: true }));
    for (const [k, val] of loose.corrected) if (!fixes.has(k)) fixes.set(k, val);
    return loose.items;
  };
  const all = Promise.all(types.map((t) => runOne(t).then((items) => { done.set(t, items); }, (err) => { deps.reportError?.(err, { where: "search_r98", type: t }); done.set(t, []); })));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), opts.budgetMs ?? SEARCH_BUDGET_MS); });
  const outcome = await Promise.race([all.then(() => "done" as const), timeout]);
  if (timer) clearTimeout(timer);
  const groups = types.filter((t) => done.has(t)).map((t) => ({ type: t, label: SEARCH_LABELS[t], items: done.get(t)! })).filter((g) => g.items.length > 0);
  const lower = q.toLowerCase();
  const corrected = fixes.size ? queryWords(lower).map((w) => fixes.get(w) ?? w).join(" ") : undefined;
  return { query: lower, groups, tookMs: Date.now() - started, partial: outcome === "timeout", ...(corrected && corrected !== lower ? { corrected } : {}), filters: f };
}

// ---------------------------------------------------------------- the instant index

export interface IndexEntry { type: SearchType | "projects" | "channels"; id: string; title: string; subtitle: string; url: string; at: string | null; projectId?: string | null; personId?: string | null; keys?: string }
export const INDEX_CAP = { tasks: 300, docs: 300, projects: 200, contacts: 300, deals: 150, channels: 200, files: 150 } as const;

/**
 * The titles the command menu indexes in the browser for instant, typo tolerant results: the newest of each kind the
 * person can open, checked by the same rules as search. Bounded by INDEX_CAP and read newest first (rowid or the
 * org and updated index), so a big workspace costs the same as a small one. People only (keys get a 403).
 */
export async function searchIndex(deps: Deps, a: SuiteActor): Promise<{ items: IndexEntry[]; builtAt: string; tookMs: number }> {
  const started = Date.now();
  if (isKey(a) || !a.userId) throw new HttpError(403, "forbidden", "Only people can load the search index.");
  const orgId = a.orgId;
  const db = deps.db;
  const v: SearchViewer = { kind: "actor", actor: a };
  const [taskRows, docRows, projectRows, contactRows, dealRows, channels] = await Promise.all([
    db.select({ id: tasks.id, title: tasks.title, number: tasks.number, projectId: tasks.projectId, updatedAt: tasks.updatedAt, assigneeType: tasks.assigneeType, assigneeId: tasks.assigneeId, key: projects.key, projectName: projects.name })
      .from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), isNull(tasks.triageState))).orderBy(sql`${tasks}.rowid desc`).limit(INDEX_CAP.tasks),
    db.select({ id: docs.id, title: docs.title, updatedAt: docs.updatedAt, projectId: docs.projectId, kind: docs.kind, createdById: docs.createdById }).from(docs)
      .where(and(eq(docs.orgId, orgId), isNull(docs.deletedAt))).orderBy(desc(docs.updatedAt)).limit(INDEX_CAP.docs),
    db.select({ id: projects.id, name: projects.name, key: projects.key, updatedAt: projects.updatedAt }).from(projects)
      .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt), isNull(projects.archivedAt))).limit(INDEX_CAP.projects),
    db.select({ id: contacts.id, name: contacts.name, email: contacts.email, title: contacts.title, updatedAt: contacts.updatedAt }).from(contacts)
      .where(and(eq(contacts.orgId, orgId), isNull(contacts.deletedAt))).orderBy(sql`${contacts}.rowid desc`).limit(INDEX_CAP.contacts),
    db.select({ id: deals.id, title: deals.title, stage: deals.stage, updatedAt: deals.updatedAt }).from(deals)
      .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt))).orderBy(sql`${deals}.rowid desc`).limit(INDEX_CAP.deals),
    readableChannels(deps, v),
  ]);
  const named = channels.filter((ch) => ch.kind === "channel").slice(0, INDEX_CAP.channels);
  const readable = channels.map((ch) => ch.id);
  const [tf, cf] = await Promise.all([
    db.select({ id: taskFiles.id, filename: taskFiles.filename, createdAt: taskFiles.createdAt, taskId: tasks.id, taskTitle: tasks.title, projectId: tasks.projectId })
      .from(taskFiles).innerJoin(tasks, eq(tasks.id, taskFiles.taskId))
      .where(and(eq(taskFiles.orgId, orgId), eq(tasks.orgId, orgId), isNull(tasks.deletedAt), isNull(tasks.triageState))).orderBy(sql`${taskFiles}.rowid desc`).limit(INDEX_CAP.files),
    readable.length ? db.select({ id: chatFiles.id, filename: chatFiles.filename, createdAt: chatFiles.createdAt, channelId: chatFiles.channelId, messageId: chatFiles.messageId, parentId: chatMessages.parentId })
      .from(chatFiles).innerJoin(chatMessages, eq(chatMessages.id, chatFiles.messageId))
      .where(and(eq(chatFiles.orgId, orgId), inIds(chatFiles.channelId, readable), isNull(chatMessages.deletedAt), notBlockedBy(chatMessages.authorId, a.userId)))
      .orderBy(sql`${chatFiles}.rowid desc`).limit(INDEX_CAP.files) : Promise.resolve([]),
  ]);
  const chName = new Map(channels.map((ch) => [ch.id, ch]));
  const items: IndexEntry[] = [
    ...taskRows.map((t) => ({ type: "tasks" as const, id: t.id, title: t.title, subtitle: `${t.key}-${t.number} · ${t.projectName}`, url: `/app/tasks?project=${encodeURIComponent(t.projectId)}&task=${encodeURIComponent(t.id)}`, at: iso(t.updatedAt), projectId: t.projectId, personId: t.assigneeType === "member" ? t.assigneeId : null, keys: `${t.key}-${t.number}` })),
    ...docRows.map((d) => ({ type: "docs" as const, id: d.id, title: d.title || "Untitled", subtitle: d.kind === "whiteboard" ? "Whiteboard" : "Doc", url: `/app/docs/${encodeURIComponent(d.id)}`, at: iso(d.updatedAt), projectId: d.projectId, personId: d.createdById })),
    ...projectRows.map((p) => ({ type: "projects" as const, id: p.id, title: p.name, subtitle: `Project · ${p.key}`, url: `/app/tasks?project=${encodeURIComponent(p.id)}`, at: iso(p.updatedAt), projectId: p.id, keys: p.key })),
    ...contactRows.map((r) => ({ type: "contacts" as const, id: r.id, title: r.name || r.email, subtitle: [r.name ? r.email : "", r.title ?? ""].filter(Boolean).join(" · "), url: `/app/contacts/${encodeURIComponent(r.id)}`, at: iso(r.updatedAt), keys: r.email })),
    ...dealRows.map((d) => ({ type: "deals" as const, id: d.id, title: d.title, subtitle: `Deal · ${STAGE_LABEL[d.stage]}`, url: `/app/deals?deal=${encodeURIComponent(d.id)}`, at: iso(d.updatedAt) })),
    ...named.map((ch) => ({ type: "channels" as const, id: ch.id, title: `#${ch.name}`, subtitle: "Channel", url: `/app/chat/${encodeURIComponent(ch.id)}`, at: null, keys: ch.name })),
    ...tf.map((r) => ({ type: "files" as const, id: r.id, title: r.filename, subtitle: `On ${r.taskTitle}`, url: `/app/tasks?project=${encodeURIComponent(r.projectId)}&task=${encodeURIComponent(r.taskId)}`, at: iso(r.createdAt), projectId: r.projectId })),
    ...cf.map((r) => { const ch = chName.get(r.channelId)!; return { type: "files" as const, id: r.id, title: r.filename, subtitle: ch.kind === "dm" ? "In a direct message" : `In #${ch.name}`, url: `/app/chat/${encodeURIComponent(r.channelId)}?thread=${encodeURIComponent(r.parentId ?? r.messageId)}`, at: iso(r.createdAt) }; }),
  ];
  return { items, builtAt: new Date().toISOString(), tookMs: Date.now() - started };
}

// ---------------------------------------------------------------- R110: Ask retrieval and source re-checks

/** A source the asker can open, with its text for the AI (server only; never sent to a browser as is). */
export interface RetrievedR98 extends SearchItem { body: string; score: number }
/** Ask cites only these (attachment text has no id re-check yet, so it is left out). */
export const ASK_SOURCE_TYPES: SearchType[] = ["mail", "tasks", "docs", "contacts", "deals", "files", "chat", "notes"];
const BODY_CHARS = 1_500;

/**
 * R110: the same groups, scope and ranking as R98 search, at question time, returning each hit's text.
 * Anything the viewer cannot open is never read: the permission scope is inside every group's query.
 */
export async function retrieveR98(deps: Deps, v: SearchViewer, rawQuery: string, opts: { types?: SearchType[]; limit?: number } = {}): Promise<RetrievedR98[]> {
  const words = queryWords((rawQuery ?? "").slice(0, SEARCH_MAX_CHARS));
  if (!words.length) return [];
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 8), 1), 20);
  const types = allowedTypes(deps, v, opts.types ?? ASK_SOURCE_TYPES).filter((t) => t !== "attachments");
  const base = { deps, v, words, limit, f: {}, person: null };
  const scored: { x: Candidate; score: number }[] = [];
  await Promise.all(types.map(async (t) => {
    try {
      for (const fuzzy of [false, true]) {
        if (fuzzy && !words.some((w) => typoBudget(w))) break;
        const got = (await GROUPS[t]({ ...base, fuzzy })).flatMap((x) => {
          const s = x.pinned ? { score: 1000 } : scoreMatch(words, x.title || x.item.title, x.body, fuzzy);
          return s ? [{ x, score: s.score }] : [];
        });
        if (got.length) { scored.push(...got); break; }
      }
    } catch (err) { deps.reportError?.(err, { where: "ask_retrieve", type: t }); }
  }));
  scored.sort((a, b) => b.score - a.score || b.x.at - a.x.at);
  return scored.slice(0, limit).map(({ x, score }) => ({ ...x.item, body: `${x.title ? `${x.title}\n` : ""}${x.body}`.replace(/\s+/g, " ").trim().slice(0, BODY_CHARS), score }));
}

export type SourceRef = { type: SearchType; id: string };
/**
 * R110: which of these sources the viewer can open now, by the very same group queries (id-only mode).
 * Used when a saved answer is reopened, so access removed since then hides it.
 */
export async function openableR98(deps: Deps, v: SearchViewer, refs: SourceRef[]): Promise<Set<string>> {
  const out = new Set<string>();
  const allowed = new Set(allowedTypes(deps, v, ASK_SOURCE_TYPES));
  const byType = new Map<SearchType, string[]>();
  for (const r of refs) if (allowed.has(r.type) && r.type !== "attachments") byType.set(r.type, [...(byType.get(r.type) ?? []), r.id]);
  await Promise.all([...byType].map(async ([t, ids]) => {
    const c: Ctx = { deps, v, words: [], fuzzy: false, limit: 20, f: {}, person: null, ids: [...new Set(ids)].slice(0, 40) };
    for (const x of await GROUPS[t](c)) if (c.ids!.includes(x.item.id)) out.add(`${t}:${x.item.id}`);
  }));
  return out;
}
