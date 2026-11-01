/**
 * R94 CRM timeline (CRM_TIMELINE). One paged activity stream per contact and per company, logged notes and calls,
 * next steps (tasks linked to the record, with the task reminders), saved segments, contacts from CSV, and the deal
 * forecast. Every source is a bounded, indexed query merged newest first; a member sees only mail from mailboxes
 * they can open and only their own private notes.
 */
import { and, desc, eq, inArray, isNull, or, sql, type SQLWrapper } from "drizzle-orm";
import type { Deps } from "../../context";
import { bookings, changes, companies, contacts, crmEntries, crmSegments, deals, formSubmissions, forms, meetings, messages } from "../../db/schema";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { addressNeedle, chunkIds, containsLower, endsWithLower, inIds } from "../../lib/sql-chunks";
import { actorOf, assertWritable, createdBy, iso, parseDate, recordWrite, scopeOf, sortableId, type SuiteActor } from "./common";
import { dealProbability, ensureCompany, isFreeMail, listContacts, presentContact, type ContactSegmentFilters, type DealStage } from "./contacts";
import type { CsvContact } from "../../../shared/crm-csv";

type Actor = SuiteActor & { role?: "owner" | "admin" | "member" };
const isAdmin = (a: Actor) => !!a.system || a.role === "owner" || a.role === "admin";

export const TIMELINE_KINDS = ["mail", "note", "call", "meeting", "task", "deal", "form", "booking"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];
export const CALL_OUTCOMES = ["connected", "no_answer", "voicemail", "busy", "wrong_number"] as const;

export interface TimelineItem {
  kind: TimelineKind;
  id: string;
  at: string;
  mail?: { threadId: string; subject: string; count: number; lastDirection: "inbound" | "outbound"; snippet: string; messageId: string };
  entry?: { id: string; kind: "note" | "call" | "meeting"; body: string; outcome: string | null; durationMin: number | null; private: boolean; authorName: string | null; mine: boolean; canEdit: boolean; entityType: string; entityId: string };
  meeting?: { id: string; title: string; startsAt: string; durationMin: number; status: string };
  task?: { id: string; ref: string; title: string; statusName: string; done: boolean; due: string | null };
  deal?: { id: string; title: string; stage: string; value: number; event: "created" | "won" | "lost"; reason: string | null };
  form?: { id: string; formId: string; formName: string; fields: { label: string; value: string }[] };
  booking?: { id: string; startsAt: string; durationMin: number; status: string; note: string };
  /** On a company timeline: whose item it is. */
  person?: { id: string; name: string };
}

/** Cursor: "<ms>_<item id>". Items come strictly after it in (at desc, id desc) order. */
export function encodeCursor(i: Pick<TimelineItem, "at" | "id">) { return `${new Date(i.at).getTime()}_${i.id}`; }
export function decodeCursor(c?: string | null): { at: number; id: string } | null {
  if (!c) return null;
  const k = c.indexOf("_");
  const at = Number(k > 0 ? c.slice(0, k) : NaN);
  if (!Number.isFinite(at) || at < 0) return null;
  return { at, id: c.slice(k + 1) };
}
const before = (i: Pick<TimelineItem, "at" | "id">, cur: { at: number; id: string } | null) => {
  if (!cur) return true;
  const t = new Date(i.at).getTime();
  return t < cur.at || (t === cur.at && i.id < cur.id);
};
/** Rows strictly after the cursor in (at desc, id desc) order, for sources whose item id is the row id. */
const afterCur = (at: SQLWrapper, id: SQLWrapper, cur: Cursor | null) => (cur ? sql`(${at} < ${cur.at} or (${at} = ${cur.at} and ${id} < ${cur.id}))` : undefined);
type Cursor = { at: number; id: string };
const order = (x: TimelineItem, y: TimelineItem) => (x.at === y.at ? (x.id < y.id ? 1 : -1) : x.at < y.at ? 1 : -1);

/** Merges each source's newest rows into one page. A source that filled its fetch means more may follow. */
export function mergePage(sources: TimelineItem[][], cur: { at: number; id: string } | null, limit: number) {
  const all = sources.flat().filter((i) => before(i, cur)).sort(order);
  const items = all.slice(0, limit);
  const more = all.length > limit;
  return { items, nextCursor: more && items.length ? encodeCursor(items[items.length - 1]) : null };
}

interface Subject { type: "contact" | "company"; id: string; name: string; emails: string[]; contactIds: string[]; domain: string | null; people: Map<string, string> }

async function loadSubject(deps: Deps, orgId: string, type: "contact" | "company", id: string): Promise<Subject> {
  if (type === "contact") {
    const c = await deps.db.select().from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.id, id), isNull(contacts.deletedAt))).get();
    if (!c) throw notFound("Contact");
    return { type, id, name: c.name || c.email, emails: [c.email], contactIds: [c.id], domain: null, people: new Map([[c.id, c.name || c.email]]) };
  }
  const co = await deps.db.select().from(companies).where(and(eq(companies.orgId, orgId), eq(companies.id, id), isNull(companies.deletedAt))).get();
  if (!co) throw notFound("Company");
  const people = await deps.db.select({ id: contacts.id, email: contacts.email, name: contacts.name }).from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.companyId, id), isNull(contacts.deletedAt))).limit(200);
  const domain = co.domain && !isFreeMail(co.domain) ? co.domain.toLowerCase().replace(/[^a-z0-9.-]/g, "") : null;
  return { type, id, name: co.name, emails: people.map((p) => p.email), contactIds: people.map((p) => p.id), domain, people: new Map(people.map((p) => [p.id, p.name || p.email])) };
}

const MAIL_SCAN = 2000;

/** Threads with this person (or anyone at the company's domain), newest last message first, mailbox scope applied. */
async function mailSource(deps: Deps, orgId: string, s: Subject, scope: string[] | null, cur: Cursor | null, n: number): Promise<TimelineItem[]> {
  const conds = [];
  for (const email of s.emails.slice(0, s.type === "company" && s.domain ? 0 : 20)) {
    const needle = addressNeedle(email);
    conds.push(eq(sql`lower(${messages.fromAddress})`, email), containsLower(messages.to, needle), containsLower(messages.cc, needle));
  }
  if (s.domain) {
    const d = s.domain.replace(/[%_"]/g, "");
    conds.push(endsWithLower(messages.fromAddress, `@${d}`), containsLower(messages.to, `@${d}"`), containsLower(messages.cc, `@${d}"`));
  }
  if (!conds.length) return [];
  if (scope && !scope.length) return [];
  // The newest matching messages (bounded), grouped by thread; a thread shows once, at its newest message.
  const rows = await deps.db.select({ threadId: messages.threadId, subject: messages.subject, date: messages.date, folder: messages.folder, snippet: messages.snippet, id: messages.id })
    .from(messages).where(and(eq(messages.orgId, orgId), sql`${messages.folder} not in ('drafts','trash','spam')`, or(...conds), scope ? inIds(messages.mailboxId, scope) : undefined))
    .orderBy(desc(messages.date)).limit(MAIL_SCAN);
  const byThread = new Map<string, { last: typeof rows[number]; count: number }>();
  for (const r of rows) {
    const t = byThread.get(r.threadId);
    if (t) t.count++; else byThread.set(r.threadId, { last: r, count: 1 });
  }
  const out: TimelineItem[] = [];
  for (const [threadId, t] of byThread) {
    const item = { id: `mail:${threadId}`, at: t.last.date.toISOString() };
    if (!before(item, cur)) continue;
    out.push({ kind: "mail", id: `mail:${threadId}`, at: t.last.date.toISOString(), mail: { threadId, subject: t.last.subject, count: t.count, lastDirection: t.last.folder === "sent" ? "outbound" : "inbound", snippet: t.last.snippet, messageId: t.last.id } });
    if (out.length > n) break;
  }
  return out;
}

async function entrySource(deps: Deps, a: Actor, s: Subject, cur: Cursor | null, n: number, kinds: Set<TimelineKind>): Promise<TimelineItem[]> {
  const want = (["note", "call", "meeting"] as const).filter((k) => kinds.has(k));
  if (!want.length) return [];
  const target = s.type === "contact" ? and(eq(crmEntries.entityType, "contact"), eq(crmEntries.entityId, s.id)) : or(and(eq(crmEntries.entityType, "company"), eq(crmEntries.entityId, s.id)), s.contactIds.length ? and(eq(crmEntries.entityType, "contact"), inIds(crmEntries.entityId, s.contactIds.slice(0, 200))) : undefined);
  const me = actorOf(a).id;
  const rows = await deps.db.select().from(crmEntries).where(and(
    eq(crmEntries.orgId, a.orgId), target, isNull(crmEntries.deletedAt),
    want.length < 3 ? inArray(crmEntries.kind, want) : undefined, // D1: at most two literal kinds
    me ? or(eq(crmEntries.private, false), eq(crmEntries.createdById, me)) : eq(crmEntries.private, false),
    afterCur(crmEntries.occurredAt, crmEntries.id, cur),
  )).orderBy(desc(crmEntries.occurredAt), desc(crmEntries.id)).limit(n + 1);
  return rows.map((r) => ({
    kind: r.kind, id: r.id, at: r.occurredAt.toISOString(),
    entry: presentEntry(r, a),
    ...(s.type === "company" && r.entityType === "contact" ? { person: { id: r.entityId, name: s.people.get(r.entityId) ?? "" } } : {}),
  }));
}

type EntryRow = typeof crmEntries.$inferSelect;
function presentEntry(r: EntryRow, a: Actor) {
  const mine = !!r.createdById && r.createdById === actorOf(a).id;
  return { id: r.id, kind: r.kind, body: r.body, outcome: r.outcome, durationMin: r.durationMin, private: r.private, authorName: r.authorName, mine, canEdit: mine || isAdmin(a), entityType: r.entityType, entityId: r.entityId, occurredAt: r.occurredAt.toISOString() };
}

async function meetingSource(deps: Deps, orgId: string, s: Subject, cur: Cursor | null, n: number): Promise<TimelineItem[]> {
  if (!s.contactIds.length) return [];
  const rows = await deps.db.select({ id: meetings.id, title: meetings.title, startsAt: meetings.startsAt, durationMin: meetings.durationMin, status: meetings.status, sourceId: meetings.sourceId })
    .from(meetings).where(and(eq(meetings.orgId, orgId), eq(meetings.sourceType, "contact"), inIds(meetings.sourceId, s.contactIds.slice(0, 200)), isNull(meetings.deletedAt), afterCur(meetings.startsAt, meetings.id, cur)))
    .orderBy(desc(meetings.startsAt)).limit(n + 1);
  return rows.map((m) => ({ kind: "meeting" as const, id: m.id, at: m.startsAt.toISOString(), meeting: { id: m.id, title: m.title, startsAt: m.startsAt.toISOString(), durationMin: m.durationMin, status: m.status }, ...person(s, m.sourceId) }));
}
const person = (s: Subject, contactId: string | null | undefined) => (s.type === "company" && contactId ? { person: { id: contactId, name: s.people.get(contactId) ?? "" } } : {});

async function bookingSource(deps: Deps, orgId: string, s: Subject, cur: Cursor | null, n: number): Promise<TimelineItem[]> {
  if (!s.emails.length) return [];
  const rows = await deps.db.select().from(bookings)
    .where(and(eq(bookings.orgId, orgId), inIds(bookings.email, s.emails.slice(0, 200)), afterCur(bookings.createdAt, bookings.id, cur)))
    .orderBy(desc(bookings.createdAt)).limit(n + 1);
  return rows.map((b) => ({ kind: "booking" as const, id: b.id, at: b.createdAt.toISOString(), booking: { id: b.id, startsAt: b.startsAt.toISOString(), durationMin: b.durationMin, status: b.status, note: b.note.slice(0, 300) } }));
}

async function formSource(deps: Deps, orgId: string, s: Subject, cur: Cursor | null, n: number): Promise<TimelineItem[]> {
  if (!s.contactIds.length) return [];
  const rows = await deps.db.select({ id: formSubmissions.id, data: formSubmissions.data, createdAt: formSubmissions.createdAt, formId: formSubmissions.formId, entityId: formSubmissions.entityId, name: forms.name, fields: forms.fields })
    .from(formSubmissions).innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .where(and(eq(formSubmissions.entityType, "contact"), inIds(formSubmissions.entityId, s.contactIds.slice(0, 200)), eq(formSubmissions.orgId, orgId), afterCur(formSubmissions.createdAt, formSubmissions.id, cur)))
    .orderBy(desc(formSubmissions.createdAt)).limit(n + 1);
  return rows.map((r) => ({ kind: "form" as const, id: r.id, at: r.createdAt.toISOString(), form: { id: r.id, formId: r.formId, formName: r.name, fields: formFields(r.fields, r.data) }, ...person(s, r.entityId) }));
}

/** The first answers of a submission with their labels, for the timeline card. */
export function formFields(fieldsJson: string, dataJson: string, max = 3) {
  let defs: { id?: string; label?: string; type?: string }[] = [];
  let data: Record<string, unknown> = {};
  try { defs = JSON.parse(fieldsJson) as typeof defs; } catch { /* keep empty */ }
  try { data = JSON.parse(dataJson) as typeof data; } catch { /* keep empty */ }
  const label = new Map(defs.filter((d) => d.id).map((d) => [d.id!, d.label || d.id!]));
  const out: { label: string; value: string }[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined || v === "" || typeof v === "object") continue;
    out.push({ label: label.get(k) ?? k, value: String(v).slice(0, 160) });
    if (out.length >= max) break;
  }
  return out;
}

async function dealSource(deps: Deps, orgId: string, s: Subject, cur: Cursor | null, n: number): Promise<TimelineItem[]> {
  const where = s.type === "contact" ? eq(deals.contactId, s.id) : eq(deals.companyId, s.id);
  const rows = await deps.db.select().from(deals).where(and(eq(deals.orgId, orgId), where, isNull(deals.deletedAt))).orderBy(desc(deals.createdAt)).limit(200);
  const out: TimelineItem[] = [];
  for (const d of rows) {
    const base = { id: d.id, title: d.title, stage: d.stage, value: d.valueCents / 100 };
    out.push({ kind: "deal", id: `deal:${d.id}:c`, at: d.createdAt.toISOString(), deal: { ...base, event: "created", reason: null } });
    if ((d.stage === "won" || d.stage === "lost") && d.closedAt) out.push({ kind: "deal", id: `deal:${d.id}:${d.stage}`, at: d.closedAt.toISOString(), deal: { ...base, event: d.stage, reason: d.closeReason ?? null } });
  }
  return out.filter((i) => before(i, cur)).sort(order).slice(0, n + 1);
}

async function taskSource(deps: Deps, a: Actor, s: Subject, cur: Cursor | null, n: number) {
  const { linked, listTasks } = await import("./tasks");
  const ids = new Set(await linked(deps, a.orgId, s.type, s.id, "task"));
  if (!ids.size) return { items: [] as TimelineItem[], nextStep: null };
  // listTasks applies the member's project access; only linked tasks are kept.
  const visible = (await listTasks(deps, a, { includeSubtasks: true, limit: 1000 })).filter((t) => ids.has(t.id));
  const open = visible.filter((t) => t.status !== "done" && t.due).sort((x, y) => (x.due! < y.due! ? -1 : 1));
  const nextStep = open[0] ? { id: open[0].id, ref: open[0].ref, title: open[0].title, due: open[0].due } : null;
  const items = visible
    .map((t) => ({ kind: "task" as const, id: t.id, at: t.createdAt, task: { id: t.id, ref: t.ref, title: t.title, statusName: t.statusName, done: t.status === "done", due: t.due ?? null } }))
    .filter((i) => before(i, cur)).sort(order).slice(0, n + 1);
  return { items, nextStep };
}

export async function timelinePage(deps: Deps, a: Actor, q: { type: "contact" | "company"; id: string; cursor?: string | null; kinds?: TimelineKind[]; limit?: number }) {
  const limit = Math.max(5, Math.min(q.limit ?? 30, 50));
  const cur = decodeCursor(q.cursor);
  const kinds = new Set<TimelineKind>(q.kinds?.length ? q.kinds : TIMELINE_KINDS);
  const s = await loadSubject(deps, a.orgId, q.type, q.id);
  const scope = await scopeOf(deps, a);
  const none = Promise.resolve([] as TimelineItem[]);
  const [mail, entries, meet, book, form, deal, task] = await Promise.all([
    kinds.has("mail") ? mailSource(deps, a.orgId, s, scope, cur, limit) : none,
    entrySource(deps, a, s, cur, limit, kinds),
    kinds.has("meeting") ? meetingSource(deps, a.orgId, s, cur, limit) : none,
    kinds.has("booking") ? bookingSource(deps, a.orgId, s, cur, limit) : none,
    kinds.has("form") ? formSource(deps, a.orgId, s, cur, limit) : none,
    kinds.has("deal") ? dealSource(deps, a.orgId, s, cur, limit) : none,
    taskSource(deps, a, s, cur, limit),
  ]);
  const page = mergePage([mail, entries, meet, book, form, deal, kinds.has("task") ? task.items : []], cur, limit);
  return { ...page, nextStep: cur ? undefined : task.nextStep, subject: { type: s.type, id: s.id, name: s.name } };
}

/* Logged notes, calls and meeting summaries */

export interface EntryInput { entityType: "contact" | "company" | "deal"; entityId: string; kind: "note" | "call" | "meeting"; body: string; outcome?: string | null; durationMin?: number | null; occurredAt?: string | null; private?: boolean }

async function assertEntity(deps: Deps, orgId: string, type: EntryInput["entityType"], id: string) {
  const t = type === "contact" ? contacts : type === "company" ? companies : deals;
  const row = await deps.db.select({ id: t.id }).from(t).where(and(eq(t.orgId, orgId), eq(t.id, id), isNull(t.deletedAt))).get();
  if (!row) throw notFound(type === "contact" ? "Contact" : type === "company" ? "Company" : "Deal");
}

export function validateEntry(i: Pick<EntryInput, "kind" | "body" | "outcome" | "durationMin">) {
  const body = (i.body ?? "").trim();
  if (i.kind !== "call" && !body) throw badRequest("Write something first.");
  if (i.kind === "call" && i.outcome && !(CALL_OUTCOMES as readonly string[]).includes(i.outcome)) throw badRequest("Pick how the call went.");
  if (i.durationMin !== undefined && i.durationMin !== null && (i.durationMin < 0 || i.durationMin > 1440)) throw badRequest("Minutes must be between 0 and 1440.");
  return body;
}

export async function createEntry(deps: Deps, a: Actor, i: EntryInput) {
  assertWritable(a);
  const body = validateEntry(i);
  await assertEntity(deps, a.orgId, i.entityType, i.entityId);
  const now = deps.now();
  const id = sortableId("cre", now.getTime());
  const at = parseDate(i.occurredAt ?? null) ?? now;
  const who = actorOf(a);
  await deps.db.insert(crmEntries).values({
    id, orgId: a.orgId, entityType: i.entityType, entityId: i.entityId, kind: i.kind, body,
    outcome: i.kind === "call" ? i.outcome ?? null : null, durationMin: i.kind === "note" ? null : i.durationMin ?? null,
    occurredAt: at > now ? now : at, private: !!i.private, authorName: who.name, ...createdBy(a), createdAt: now, updatedAt: now,
  });
  if (!i.private) await recordWrite(deps, a, { entityType: i.entityType, entityId: i.entityId, op: "update", verb: i.kind === "call" ? "call_logged" : i.kind === "meeting" ? "meeting_logged" : "note_added", data: { entryId: id } });
  const row = await deps.db.select().from(crmEntries).where(eq(crmEntries.id, id)).get();
  return presentEntry(row!, a);
}

async function ownEntry(deps: Deps, a: Actor, id: string) {
  const r = await deps.db.select().from(crmEntries).where(and(eq(crmEntries.orgId, a.orgId), eq(crmEntries.id, id), isNull(crmEntries.deletedAt))).get();
  const me = actorOf(a).id;
  if (!r || (r.private && r.createdById !== me)) throw notFound("Note");
  if (r.createdById !== me && !isAdmin(a)) throw forbidden("Only the person who wrote it or an admin can change it.");
  return r;
}

export async function updateEntry(deps: Deps, a: Actor, id: string, p: Partial<Pick<EntryInput, "body" | "outcome" | "durationMin" | "occurredAt" | "private">>) {
  assertWritable(a);
  const r = await ownEntry(deps, a, id);
  const body = p.body !== undefined ? validateEntry({ kind: r.kind, body: p.body, outcome: p.outcome ?? r.outcome, durationMin: p.durationMin }) : r.body;
  if (p.outcome !== undefined || p.durationMin !== undefined) validateEntry({ kind: r.kind, body: body || "x", outcome: p.outcome, durationMin: p.durationMin });
  const now = deps.now();
  const at = p.occurredAt !== undefined ? parseDate(p.occurredAt) ?? r.occurredAt : r.occurredAt;
  await deps.db.update(crmEntries).set({
    body, ...(p.outcome !== undefined && r.kind === "call" ? { outcome: p.outcome } : {}),
    ...(p.durationMin !== undefined && r.kind !== "note" ? { durationMin: p.durationMin } : {}),
    occurredAt: at > now ? now : at,
    // Only the author can make a note private or shared.
    ...(p.private !== undefined && r.createdById === actorOf(a).id ? { private: p.private } : {}),
    updatedAt: now, version: r.version + 1,
  }).where(eq(crmEntries.id, id));
  return presentEntry((await deps.db.select().from(crmEntries).where(eq(crmEntries.id, id)).get())!, a);
}

export async function deleteEntry(deps: Deps, a: Actor, id: string) {
  assertWritable(a);
  const r = await ownEntry(deps, a, id);
  await deps.db.update(crmEntries).set({ deletedAt: deps.now(), updatedAt: deps.now(), version: r.version + 1 }).where(eq(crmEntries.id, id));
  return { ok: true as const, id };
}

export async function restoreEntry(deps: Deps, a: Actor, id: string) {
  assertWritable(a);
  const r = await deps.db.select().from(crmEntries).where(and(eq(crmEntries.orgId, a.orgId), eq(crmEntries.id, id))).get();
  const me = actorOf(a).id;
  if (!r || (r.private && r.createdById !== me)) throw notFound("Note");
  if (r.createdById !== me && !isAdmin(a)) throw forbidden("Only the person who wrote it or an admin can change it.");
  await deps.db.update(crmEntries).set({ deletedAt: null, updatedAt: deps.now(), version: r.version + 1 }).where(eq(crmEntries.id, id));
  return presentEntry((await deps.db.select().from(crmEntries).where(eq(crmEntries.id, id)).get())!, a);
}

/* Next step: a task linked to the record, due on a day, assigned to the person setting it */

export async function setNextStep(deps: Deps, a: Actor, i: { entityType: "contact" | "company"; entityId: string; title: string; due: string }) {
  assertWritable(a);
  const title = i.title.trim();
  if (!title) throw badRequest("Say what the next step is.");
  if (!parseDate(i.due)) throw badRequest("Pick a due date.");
  await assertEntity(deps, a.orgId, i.entityType, i.entityId);
  const { createTask, link } = await import("./tasks");
  const task = await createTask(deps, a, { title, due: i.due, ...(a.userId ? { assignee: { type: "member", id: a.userId } } : {}) });
  await link(deps, a.orgId, { type: i.entityType, id: i.entityId }, { type: "task", id: task.id });
  await recordWrite(deps, a, { entityType: i.entityType, entityId: i.entityId, op: "update", verb: "next_step_set", data: { taskId: task.id, title } });
  return { id: task.id, ref: task.ref, title: task.title, due: task.due };
}

/* Companies */

export async function createCompany(deps: Deps, a: Actor, i: { name: string; domain?: string | null; notes?: string }) {
  assertWritable(a);
  const name = i.name.trim();
  if (!name) throw badRequest("Give the company a name.");
  const domain = normaliseDomain(i.domain);
  if (domain) {
    const had = await deps.db.select({ id: companies.id, deletedAt: companies.deletedAt }).from(companies).where(and(eq(companies.orgId, a.orgId), eq(companies.domain, domain))).get();
    if (had && !had.deletedAt) throw badRequest("A company with that website is already here.");
    if (had) {
      await deps.db.update(companies).set({ name, deletedAt: null, updatedAt: deps.now() }).where(eq(companies.id, had.id));
      return { id: had.id, name, domain };
    }
  }
  const now = deps.now();
  const id = sortableId("cmp", now.getTime());
  await deps.db.insert(companies).values({ id, orgId: a.orgId, name, domain, notes: i.notes ?? "", ...createdBy(a), createdAt: now, updatedAt: now });
  await recordWrite(deps, a, { entityType: "company", entityId: id, op: "create", verb: "created", data: { name } });
  return { id, name, domain };
}

export function normaliseDomain(d?: string | null) {
  const v = (d ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  if (!v) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) || v.length > 253) throw badRequest("That website does not look right. Try something like example.com.");
  return v;
}

/* Segments */

export const SegmentFilters = (f: Record<string, unknown>): ContactSegmentFilters & { q?: string; companyId?: string } => {
  const out: ContactSegmentFilters & { q?: string; companyId?: string } = {};
  if (typeof f.q === "string" && f.q.trim()) out.q = f.q.trim().slice(0, 100);
  if (typeof f.companyId === "string" && f.companyId) out.companyId = f.companyId;
  if (f.source === "mail" || f.source === "manual" || f.source === "import" || f.source === "agent") out.source = f.source;
  if (f.noCompany === true || f.noCompany === "1" || f.noCompany === "true") out.noCompany = true;
  if (f.hasOpenDeal === true || f.hasOpenDeal === "1" || f.hasOpenDeal === "true") out.hasOpenDeal = true;
  const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) && x > 0 && x <= 3650 ? Math.round(x) : undefined; };
  if (n(f.lastWithinDays)) out.lastWithinDays = n(f.lastWithinDays);
  else if (n(f.lastOlderThanDays)) out.lastOlderThanDays = n(f.lastOlderThanDays);
  return out;
};

export async function listSegments(deps: Deps, a: Actor) {
  const rows = await deps.db.select().from(crmSegments).where(and(eq(crmSegments.orgId, a.orgId), isNull(crmSegments.deletedAt), or(isNull(crmSegments.userId), a.userId ? eq(crmSegments.userId, a.userId) : sql`0`)))
    .orderBy(crmSegments.position, crmSegments.createdAt).limit(100);
  return rows.map((r) => presentSegment(r, a));
}
type SegmentRow = typeof crmSegments.$inferSelect;
function presentSegment(r: SegmentRow, a: Actor) {
  let filters: Record<string, unknown> = {};
  try { filters = JSON.parse(r.filters) as Record<string, unknown>; } catch { /* empty */ }
  return { id: r.id, name: r.name, filters: SegmentFilters(filters), shared: !r.userId, canEdit: r.userId ? r.userId === a.userId : isAdmin(a) || r.createdById === a.userId };
}

export async function createSegment(deps: Deps, a: Actor, i: { name: string; filters: Record<string, unknown>; shared?: boolean }) {
  assertWritable(a);
  const name = i.name.trim();
  if (!name) throw badRequest("Give the segment a name.");
  const count = await deps.db.select({ n: sql<number>`count(*)` }).from(crmSegments).where(and(eq(crmSegments.orgId, a.orgId), isNull(crmSegments.deletedAt))).get();
  if (Number(count?.n ?? 0) >= 100) throw badRequest("You have 100 segments. Remove one to add another.");
  const now = deps.now();
  const id = sortableId("seg", now.getTime());
  await deps.db.insert(crmSegments).values({ id, orgId: a.orgId, userId: i.shared ? null : a.userId || null, name, filters: JSON.stringify(SegmentFilters(i.filters)), position: now.getTime(), ...createdBy(a), createdAt: now, updatedAt: now });
  return presentSegment((await deps.db.select().from(crmSegments).where(eq(crmSegments.id, id)).get())!, a);
}

async function editableSegment(deps: Deps, a: Actor, id: string) {
  const r = await deps.db.select().from(crmSegments).where(and(eq(crmSegments.orgId, a.orgId), eq(crmSegments.id, id), isNull(crmSegments.deletedAt))).get();
  if (!r || (r.userId && r.userId !== a.userId)) throw notFound("Segment");
  if (!presentSegment(r, a).canEdit) throw forbidden("Only an admin or the person who made it can change a team segment.");
  return r;
}

export async function updateSegment(deps: Deps, a: Actor, id: string, p: { name?: string; filters?: Record<string, unknown> }) {
  assertWritable(a);
  const r = await editableSegment(deps, a, id);
  const name = p.name !== undefined ? p.name.trim() : r.name;
  if (!name) throw badRequest("Give the segment a name.");
  await deps.db.update(crmSegments).set({ name, ...(p.filters ? { filters: JSON.stringify(SegmentFilters(p.filters)) } : {}), updatedAt: deps.now(), version: r.version + 1 }).where(eq(crmSegments.id, id));
  return presentSegment((await deps.db.select().from(crmSegments).where(eq(crmSegments.id, id)).get())!, a);
}

export async function deleteSegment(deps: Deps, a: Actor, id: string) {
  assertWritable(a);
  const r = await editableSegment(deps, a, id);
  await deps.db.update(crmSegments).set({ deletedAt: deps.now(), updatedAt: deps.now(), version: r.version + 1 }).where(eq(crmSegments.id, id));
  return { ok: true as const, id };
}

export async function segmentContacts(deps: Deps, a: Actor, f: Record<string, unknown>, page: { limit?: number; offset?: number }) {
  return listContacts(deps, a.orgId, { ...SegmentFilters(f), limit: page.limit, offset: page.offset });
}

/* CSV import: the browser parses and checks; the server is sent small batches */

export const IMPORT_BATCH = 25;

export async function importCheck(deps: Deps, orgId: string, emails: string[]) {
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 5000);
  let existing = 0;
  for (const chunk of chunkIds(list)) {
    const r = await deps.db.select({ n: sql<number>`count(*)` }).from(contacts).where(and(eq(contacts.orgId, orgId), inIds(contacts.email, chunk), isNull(contacts.deletedAt))).get();
    existing += Number(r?.n ?? 0);
  }
  return { total: list.length, existing, new: list.length - existing };
}

export async function importBatch(deps: Deps, a: Actor, rows: CsvContact[], mode: "skip" | "update") {
  assertWritable(a);
  if (rows.length > IMPORT_BATCH) throw badRequest(`Send at most ${IMPORT_BATCH} rows at a time.`);
  const list = rows.map((r) => ({ ...r, email: r.email.trim().toLowerCase() }));
  const had = new Map((await deps.db.select({ id: contacts.id, email: contacts.email, name: contacts.name, phone: contacts.phone, title: contacts.title, companyId: contacts.companyId, deletedAt: contacts.deletedAt, version: contacts.version })
    .from(contacts).where(and(eq(contacts.orgId, a.orgId), inIds(contacts.email, list.map((r) => r.email))))).map((r) => [r.email, r]));
  // Companies: by the name in the file, else by the work domain (as mail does). One lookup for the batch.
  const names = [...new Set(list.map((r) => r.company?.trim()).filter(Boolean) as string[])];
  const byName = new Map<string, string>();
  if (names.length) {
    const found = await deps.db.select({ id: companies.id, name: companies.name }).from(companies)
      .where(and(eq(companies.orgId, a.orgId), isNull(companies.deletedAt), inIds(sql`lower(${companies.name})`, names.map((n) => n.toLowerCase()))));
    for (const f of found) byName.set(f.name.toLowerCase(), f.id);
  }
  const now = deps.now();
  let created = 0, updated = 0, skipped = 0;
  const failed: { email: string; reason: string }[] = [];
  const inserts: (typeof contacts.$inferInsert)[] = [];
  const feed: (typeof changes.$inferInsert)[] = [];
  const who = actorOf(a);
  for (const r of list) {
    try {
      let companyId: string | null = null;
      if (r.company) {
        const key = r.company.toLowerCase();
        if (!byName.has(key)) {
          const domain = r.email.split("@")[1] ?? "";
          const viaDomain = !isFreeMail(domain) ? await ensureCompany(deps, a, domain) : null;
          if (viaDomain) { await deps.db.update(companies).set({ name: r.company, updatedAt: now }).where(and(eq(companies.id, viaDomain), sql`${companies.name} = ${companyNameGuess(domain)}`)); byName.set(key, viaDomain); }
          else { const c = await createCompany(deps, a, { name: r.company }); byName.set(key, c.id); }
        }
        companyId = byName.get(key) ?? null;
      }
      const old = had.get(r.email);
      if (old && !old.deletedAt) {
        if (mode === "skip") { skipped++; continue; }
        await deps.db.update(contacts).set({
          ...(r.name ? { name: r.name } : {}), ...(r.phone ? { phone: r.phone } : {}), ...(r.title ? { title: r.title } : {}),
          ...(companyId ? { companyId } : {}), updatedAt: now, version: old.version + 1,
        }).where(eq(contacts.id, old.id));
        feed.push({ orgId: a.orgId, entityType: "contact", entityId: old.id, op: "update", version: old.version + 1, actorType: who.type, actorId: who.id, actorName: who.name, verb: "updated_from_import", data: "{}" });
        updated++;
        continue;
      }
      if (old && old.deletedAt) {
        await deps.db.update(contacts).set({ deletedAt: null, name: r.name || old.name, ...(r.phone ? { phone: r.phone } : {}), ...(r.title ? { title: r.title } : {}), ...(companyId ? { companyId } : {}), updatedAt: now, version: old.version + 1 }).where(eq(contacts.id, old.id));
        feed.push({ orgId: a.orgId, entityType: "contact", entityId: old.id, op: "update", version: old.version + 1, actorType: who.type, actorId: who.id, actorName: who.name, verb: "imported", data: "{}" });
        created++;
        continue;
      }
      if (!companyId) companyId = await ensureCompany(deps, a, r.email.split("@")[1] ?? "");
      const id = sortableId("con", now.getTime());
      inserts.push({ id, orgId: a.orgId, companyId, name: r.name ?? "", email: r.email, phone: r.phone ?? null, title: r.title ?? null, notes: r.notes ?? "", source: "import", ownerUserId: a.userId || null, messageCount: 0, ...createdBy(a), createdAt: now, updatedAt: now });
      feed.push({ orgId: a.orgId, entityType: "contact", entityId: id, op: "create", version: 1, actorType: who.type, actorId: who.id, actorName: who.name, verb: "imported", data: "{}" });
      created++;
    } catch (err) {
      failed.push({ email: r.email, reason: err instanceof Error ? err.message : "Could not import" });
    }
  }
  // D1 takes at most 100 bound values a statement: contacts in groups of 5, feed rows in groups of 10.
  for (let i = 0; i < inserts.length; i += 5) await deps.db.insert(contacts).values(inserts.slice(i, i + 5)).onConflictDoNothing();
  for (let i = 0; i < feed.length; i += 10) await deps.db.insert(changes).values(feed.slice(i, i + 10));
  return { created, updated, skipped, failed };
}
const companyNameGuess = (domain: string) => { const l = domain.toLowerCase().split(".")[0] ?? domain; return l.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || domain; };

/* Forecast */

export interface ForecastDeal { stage: DealStage; valueCents: number; probability: number | null; expectedCloseAt: Date | null; closedAt: Date | null; closeReason: string | null }

/** Weighted open pipeline by expected close month (this month and the next five), won and lost this month, top reasons over 90 days. */
export function computeForecast(rows: ForecastDeal[], now: Date) {
  const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const months: { month: string; weighted: number; total: number; count: number }[] = [];
  for (let k = 0; k < 6; k++) months.push({ month: monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1))), weighted: 0, total: 0, count: 0 });
  const thisMonth = monthKey(now);
  let openWeighted = 0, openTotal = 0, openCount = 0, noDate = 0, overdue = 0, wonThisMonth = 0, lostThisMonth = 0, wonCount = 0, lostCount = 0;
  const reasons = { won: new Map<string, number>(), lost: new Map<string, number>() };
  const since = now.getTime() - 90 * 86_400_000;
  for (const d of rows) {
    const value = d.valueCents / 100;
    if (d.stage === "won" || d.stage === "lost") {
      if (d.closedAt && monthKey(d.closedAt) === thisMonth) { if (d.stage === "won") { wonThisMonth += value; wonCount++; } else { lostThisMonth += value; lostCount++; } }
      if (d.closedAt && d.closedAt.getTime() >= since && d.closeReason) { const m = reasons[d.stage]; m.set(d.closeReason, (m.get(d.closeReason) ?? 0) + 1); }
      continue;
    }
    const w = (value * dealProbability(d.stage, d.probability)) / 100;
    openWeighted += w; openTotal += value; openCount++;
    if (!d.expectedCloseAt) { noDate++; continue; }
    const key = monthKey(d.expectedCloseAt);
    const slot = months.find((m) => m.month === key) ?? (key < thisMonth ? months[0] : null);
    if (key < thisMonth) overdue++;
    if (slot) { slot.weighted += w; slot.total += value; slot.count++; }
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([reason, count]) => ({ reason, count }));
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    currency: "AUD", openWeighted: round(openWeighted), openTotal: round(openTotal), openCount, noDate, overdue,
    wonThisMonth: round(wonThisMonth), lostThisMonth: round(lostThisMonth), wonCount, lostCount,
    months: months.map((m) => ({ ...m, weighted: round(m.weighted), total: round(m.total) })),
    reasons: { won: top(reasons.won), lost: top(reasons.lost) },
  };
}

export async function forecast(deps: Deps, orgId: string) {
  const rows = await deps.db.select({ stage: deals.stage, valueCents: deals.valueCents, probability: deals.probability, expectedCloseAt: deals.expectedCloseAt, closedAt: deals.closedAt, closeReason: deals.closeReason })
    .from(deals).where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt))).limit(5000);
  return computeForecast(rows, deps.now());
}

export const presentForList = presentContact;
export { iso };
