/**
 * TD5 universal mentions (MENTIONS_TD5): the record_refs index (which text mentions which record), the @ picker search,
 * per viewer resolution of record tokens, and the References panel (mentioned in, mentions).
 *
 * Permission rules are the same as search, checked in every read: members see every task, project, doc, contact, deal,
 * meeting and form of their workspace; invoices are for owners and admins; a private contact note only for its author;
 * chat only in public channels or channels and DMs the reader belongs to; mail threads only in the reader's mailbox
 * scope. Anything else reads as "restricted" with no title, subtitle or link. Ids from another workspace read as
 * "deleted" (lists) or 404 (the record path). Project guests, portal users, keys and agents never reach these paths.
 *
 * Nothing here stores or logs text: the index keeps ids only, and a failed index write reports { where, sourceType }.
 */
import { inIds } from "@/server/lib/sql-chunks";
import { and, desc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../context";
import {
  chatChannels, chatMembers, contacts, crmEntries, deals, docs, forms, invoiceDocs, meetings, messages, projects, recordRefs, tasks,
} from "../db/schema";
import { HttpError } from "../lib/errors";
import { containsText } from "../lib/like-search";
import type { SuiteActor } from "./suite/common";
import {
  diffRefs, parseRefs, PICK_TYPES, rankByRecency, refKey, REFS_PAGE, refUrl, RESOLVE_MAX,
  type ItemType, type RecordRef, type RefItem, type RefType, type ResolvedRef, type SourceType,
} from "../../shared/mentions-td5";

type A = SuiteActor;
const notFound = () => new HttpError(404, "not_found", "Page not found.");
const isAdmin = (a: Partial<A>) => a.role === "owner" || a.role === "admin";

// ---------------------------------------------------------------- open check

/** vv8k (always) and MENTIONS_EXCLUDE workspaces never use mentions. */
export function isMentionsExcluded(org: { id: string; slug?: string | null; name?: string | null }, extra = ""): boolean {
  const hay = [org.id, org.slug ?? "", org.name ?? ""].map((s) => s.toLowerCase());
  const words = ["vv8k", ...extra.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];
  return words.some((x) => hay.some((h) => h === x || h.includes(x)));
}

const openCache = new Map<string, { ok: boolean; at: number }>();
/** True when mentions are on for this workspace (flag on and not excluded). Cached per isolate for 5 minutes. */
export async function mentionsOn(deps: Deps, orgId: string): Promise<boolean> {
  if (!deps.config.mentionsTd5 || !orgId) return false;
  const hit = openCache.get(orgId);
  const now = Date.now();
  if (hit && now - hit.at < 300_000) return hit.ok;
  const [o] = await deps.db.all<{ id: string; slug: string | null; name: string | null }>(sql`select id, slug, name from organizations where id = ${orgId} limit 1`);
  const ok = !!o && !isMentionsExcluded(o, deps.config.mentionsExclude ?? "");
  if (openCache.size > 2000) openCache.clear();
  openCache.set(orgId, { ok, at: now });
  return ok;
}

/** People only: a signed in member of a workspace with mentions on. Everything else is a 404. */
export async function assertMentionsOpen(deps: Deps, a: Partial<A>): Promise<void> {
  if (!deps.config.mentionsTd5) throw notFound();
  if (!a.userId || !a.orgId || !a.role || a.agentId || a.apiKeyId) throw notFound();
  if (!(await mentionsOn(deps, a.orgId))) throw notFound();
}

// ---------------------------------------------------------------- index

export interface Source { type: SourceType; id: string; parentType?: string | null; parentId?: string | null }

/** Only targets that exist in this workspace are indexed (a foreign or made up id is ignored). */
async function existingTargets(deps: Deps, orgId: string, refs: RecordRef[]): Promise<RecordRef[]> {
  if (!refs.length) return [];
  const byType = groupIds(refs);
  const found = new Set<string>();
  await Promise.all([...byType].map(async ([type, ids]) => {
    const rows = await idsIn(deps, orgId, type, ids);
    for (const r of rows) found.add(`${type}:${r.id}`);
    for (const r of rows) if (r.ref) found.add(`${type}:${r.ref}`);
  }));
  // A task token may name the task by its ref (OPS-12): index the real id.
  const out: RecordRef[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    if (!found.has(refKey(r))) continue;
    let id = r.id;
    if (r.type === "task" && /^[A-Za-z0-9]{1,6}-\d+$/.test(r.id)) {
      try { const { resolveTaskId } = await import("./suite/tasks"); id = await resolveTaskId(deps, orgId, r.id); } catch { continue; }
    }
    const k = `${r.type}:${id}`;
    if (!seen.has(k)) { seen.add(k); out.push({ type: r.type, id }); }
  }
  return out;
}

/** The id (and task ref) rows of one type that exist in this workspace, deleted ones included. */
async function idsIn(deps: Deps, orgId: string, type: RefType, ids: string[]): Promise<{ id: string; ref?: string }[]> {
  const db = deps.db;
  const list = [...new Set(ids)].slice(0, RESOLVE_MAX);
  if (!list.length) return [];
  switch (type) {
    case "task": {
      const plain = list.filter((x) => !/^[A-Za-z0-9]{1,6}-\d+$/.test(x));
      const refs = list.filter((x) => /^[A-Za-z0-9]{1,6}-\d+$/.test(x));
      const rows = plain.length ? await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, orgId), inIds(tasks.id, plain))) : [];
      const out: { id: string; ref?: string }[] = rows;
      if (refs.length) {
        const { resolveTaskId } = await import("./suite/tasks");
        for (const r of refs) { try { await resolveTaskId(deps, orgId, r); out.push({ id: r, ref: r }); } catch { /* unknown ref */ } }
      }
      return out;
    }
    case "project": return db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), inIds(projects.id, list)));
    case "doc": return db.select({ id: docs.id }).from(docs).where(and(eq(docs.orgId, orgId), inIds(docs.id, list)));
    case "contact": return db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.orgId, orgId), inIds(contacts.id, list)));
    case "deal": return db.select({ id: deals.id }).from(deals).where(and(eq(deals.orgId, orgId), inIds(deals.id, list)));
    case "meeting": return db.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.orgId, orgId), inIds(meetings.id, list)));
    case "form": return db.select({ id: forms.id }).from(forms).where(and(eq(forms.orgId, orgId), inIds(forms.id, list)));
    case "invoice": return db.select({ id: invoiceDocs.id }).from(invoiceDocs).where(and(eq(invoiceDocs.orgId, orgId), inIds(invoiceDocs.id, list)));
    case "thread": {
      const rows = await db.select({ id: messages.threadId }).from(messages).where(and(eq(messages.orgId, orgId), inIds(messages.threadId, list)));
      return rows.filter((r): r is { id: string } => !!r.id);
    }
  }
}

function groupIds(refs: RecordRef[]): Map<RefType, string[]> {
  const m = new Map<RefType, string[]>();
  for (const r of refs) m.set(r.type, [...(m.get(r.type) ?? []), r.id]);
  return m;
}

/**
 * Keeps the index for one source in step with its text: adds new targets, removes ones no longer in the text. Never
 * fails the save it rides on (a failure is reported with no text) and does nothing when mentions are off.
 */
export async function syncRefs(deps: Deps, who: { orgId: string; userId?: string | null }, source: Source, text: string | null | undefined): Promise<void> {
  try {
    if (!(await mentionsOn(deps, who.orgId))) return;
    await syncRefList(deps, who, source, await existingTargets(deps, who.orgId, parseRefs(text)));
  } catch (err) {
    deps.reportError?.(err, { where: "mentions-td5.sync", sourceType: source.type });
  }
}

/** The same, for a source that already knows its targets (a doc's page links). */
export async function syncRefList(deps: Deps, who: { orgId: string; userId?: string | null }, source: Source, want: RecordRef[]): Promise<{ added: number; removed: number }> {
  const have = await deps.db.select({ type: recordRefs.targetType, id: recordRefs.targetId }).from(recordRefs)
    .where(and(eq(recordRefs.sourceType, source.type), eq(recordRefs.sourceId, source.id), eq(recordRefs.orgId, who.orgId)));
  const { add, remove } = diffRefs(have.map((h) => ({ type: h.type as RefType, id: h.id })), want);
  for (const r of remove) {
    await deps.db.delete(recordRefs).where(and(eq(recordRefs.sourceType, source.type), eq(recordRefs.sourceId, source.id), eq(recordRefs.targetType, r.type), eq(recordRefs.targetId, r.id)));
  }
  if (add.length) {
    const now = deps.now();
    await deps.db.insert(recordRefs).values(add.map((r) => ({
      orgId: who.orgId, sourceType: source.type, sourceId: source.id, parentType: source.parentType ?? null, parentId: source.parentId ?? null,
      targetType: r.type, targetId: r.id, createdBy: who.userId ?? null, createdAt: now,
    }))).onConflictDoNothing();
  }
  return { added: add.length, removed: remove.length };
}

/** A doc's page links (already checked to be in this workspace) mirrored as the doc's references. */
export async function syncDocRefs(deps: Deps, orgId: string, docId: string, links: { type: string; id: string }[]): Promise<void> {
  try {
    if (!(await mentionsOn(deps, orgId))) return;
    const want = links.filter((l): l is RecordRef => l.type === "doc" || l.type === "task" || l.type === "project").filter((l) => !(l.type === "doc" && l.id === docId));
    await syncRefList(deps, { orgId }, { type: "doc", id: docId }, want);
  } catch (err) {
    deps.reportError?.(err, { where: "mentions-td5.sync", sourceType: "doc" });
  }
}

/** A deleted source leaves no rows. */
export async function removeSource(deps: Deps, orgId: string, source: { type: SourceType; id: string }): Promise<void> {
  try {
    if (!deps.config.mentionsTd5) return;
    await deps.db.delete(recordRefs).where(and(eq(recordRefs.orgId, orgId), eq(recordRefs.sourceType, source.type), eq(recordRefs.sourceId, source.id)));
  } catch (err) {
    deps.reportError?.(err, { where: "mentions-td5.remove", sourceType: source.type });
  }
}

// ---------------------------------------------------------------- resolve (per viewer)

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** What this viewer may see of each ref: the record, "restricted" (exists, no access) or "deleted" (gone or unknown). */
export async function resolveRefs(deps: Deps, a: A, refs: RecordRef[]): Promise<Map<string, ResolvedRef>> {
  const out = new Map<string, ResolvedRef>();
  const list = refs.slice(0, RESOLVE_MAX);
  const db = deps.db;
  const orgId = a.orgId;
  const ok = (type: RefType, key: string, id: string, title: string, subtitle: string, url: string) => out.set(`${type}:${key}`, { state: "ok", type, id, title: title || "Untitled", subtitle, url });
  const restricted = (type: RefType, key: string) => out.set(`${type}:${key}`, { state: "restricted", type, id: key });
  const byType = groupIds(list);
  await Promise.all([...byType].map(async ([type, rawIds]) => {
    const ids = [...new Set(rawIds)];
    switch (type) {
      case "task": {
        const { resolveTaskId } = await import("./suite/tasks");
        const real = new Map<string, string>();
        for (const x of ids) {
          if (/^[A-Za-z0-9]{1,6}-\d+$/.test(x)) { try { real.set(await resolveTaskId(deps, orgId, x), x); } catch { /* unknown */ } } else real.set(x, x);
        }
        if (!real.size) break;
        const rows = await db.select({ id: tasks.id, title: tasks.title, number: tasks.number, projectId: tasks.projectId, deletedAt: tasks.deletedAt, key: projects.key, projectName: projects.name })
          .from(tasks).leftJoin(projects, eq(projects.id, tasks.projectId)).where(and(eq(tasks.orgId, orgId), inIds(tasks.id, [...real.keys()])));
        for (const r of rows) {
          const k = real.get(r.id)!;
          if (r.deletedAt) continue;
          ok("task", k, r.id, r.title, [r.key ? `${r.key}-${r.number}` : "", r.projectName ?? ""].filter(Boolean).join(" · "), refUrl({ type: "task", id: r.id }, { projectId: r.projectId }));
        }
        break;
      }
      case "project": {
        const rows = await db.select({ id: projects.id, name: projects.name, key: projects.key, deletedAt: projects.deletedAt }).from(projects).where(and(eq(projects.orgId, orgId), inIds(projects.id, ids)));
        for (const r of rows) if (!r.deletedAt) ok("project", r.id, r.id, r.name, `Project · ${r.key}`, refUrl({ type: "project", id: r.id }));
        break;
      }
      case "doc": {
        const rows = await db.select({ id: docs.id, title: docs.title, kind: docs.kind, deletedAt: docs.deletedAt }).from(docs).where(and(eq(docs.orgId, orgId), inIds(docs.id, ids)));
        for (const r of rows) if (!r.deletedAt) ok("doc", r.id, r.id, r.title, r.kind === "whiteboard" ? "Whiteboard" : r.kind === "table" ? "Table" : "Doc", refUrl({ type: "doc", id: r.id }));
        break;
      }
      case "contact": {
        const rows = await db.select({ id: contacts.id, name: contacts.name, email: contacts.email, deletedAt: contacts.deletedAt }).from(contacts).where(and(eq(contacts.orgId, orgId), inIds(contacts.id, ids)));
        for (const r of rows) if (!r.deletedAt) ok("contact", r.id, r.id, r.name || r.email || "Contact", "Contact", refUrl({ type: "contact", id: r.id }));
        break;
      }
      case "deal": {
        const rows = await db.select({ id: deals.id, title: deals.title, deletedAt: deals.deletedAt }).from(deals).where(and(eq(deals.orgId, orgId), inIds(deals.id, ids)));
        for (const r of rows) if (!r.deletedAt) ok("deal", r.id, r.id, r.title, "Deal", refUrl({ type: "deal", id: r.id }));
        break;
      }
      case "meeting": {
        const rows = await db.select({ id: meetings.id, title: meetings.title, startsAt: meetings.startsAt, deletedAt: meetings.deletedAt }).from(meetings).where(and(eq(meetings.orgId, orgId), inIds(meetings.id, ids)));
        for (const r of rows) if (!r.deletedAt) ok("meeting", r.id, r.id, r.title, `Meeting · ${(iso(r.startsAt) ?? "").slice(0, 10)}`, refUrl({ type: "meeting", id: r.id }));
        break;
      }
      case "form": {
        const rows = await db.select({ id: forms.id, name: forms.name, deletedAt: forms.deletedAt }).from(forms).where(and(eq(forms.orgId, orgId), inIds(forms.id, ids)));
        for (const r of rows) if (!r.deletedAt) ok("form", r.id, r.id, r.name, "Form", refUrl({ type: "form", id: r.id }));
        break;
      }
      case "invoice": {
        const rows = await db.select({ id: invoiceDocs.id, kind: invoiceDocs.kind, number: invoiceDocs.number, buyerName: invoiceDocs.buyerName }).from(invoiceDocs).where(and(eq(invoiceDocs.orgId, orgId), inIds(invoiceDocs.id, ids)));
        for (const r of rows) {
          if (!isAdmin(a)) { restricted("invoice", r.id); continue; }
          ok("invoice", r.id, r.id, `${r.kind === "quote" ? "Quote" : "Invoice"} ${r.number ?? "draft"}`, r.buyerName ?? "Invoice", refUrl({ type: "invoice", id: r.id }));
        }
        break;
      }
      case "thread": {
        const { scopeOf } = await import("./suite/common");
        const scope = await scopeOf(deps, a);
        for (const t of ids.slice(0, 20)) {
          const m = await db.select({ id: messages.id, subject: messages.subject, mailboxId: messages.mailboxId }).from(messages)
            .where(and(eq(messages.orgId, orgId), eq(messages.threadId, t))).orderBy(desc(messages.date)).limit(1).get();
          if (!m) continue;
          if (scope && !scope.includes(m.mailboxId)) { restricted("thread", t); continue; }
          ok("thread", t, t, m.subject || "(no subject)", "Email", refUrl({ type: "thread", id: t }, { messageId: m.id }));
        }
        break;
      }
    }
  }));
  for (const r of list) if (!out.has(refKey(r))) out.set(refKey(r), { state: "deleted", type: r.type, id: r.id });
  return out;
}

// ---------------------------------------------------------------- picker search

export interface PickItem { kind: "person" | "record"; type: RefType | "member" | "agent"; id: string; title: string; subtitle: string; at: string | null }

/** People and the records this viewer can see whose title matches, newest first. An empty query lists the newest. */
export async function searchMentions(deps: Deps, a: A, rawQ: string, limit = 12): Promise<{ people: PickItem[]; records: PickItem[] }> {
  const q = String(rawQ ?? "").normalize("NFKC").trim().slice(0, 60);
  const lim = Math.min(Math.max(Number(limit) || 12, 1), 20);
  const per = q ? 5 : 3;
  const db = deps.db;
  const orgId = a.orgId;
  const has = (col: Parameters<typeof containsText>[0]) => (q ? containsText(col, q) : sql`1 = 1`);
  const { assignees } = await import("./suite/tasks");
  const everyone = await assignees(deps, orgId);
  const ql = q.toLowerCase();
  const people = everyone
    .filter((p) => !q || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(ql)) || p.name.toLowerCase().includes(ql))
    .slice(0, 5)
    .map((p) => ({ kind: "person" as const, type: p.type as "member" | "agent", id: p.id.includes(":") ? p.id.split(":")[1]! : p.id, title: p.name, subtitle: p.type === "agent" ? "Agent" : "Person", at: null }));
  const want = new Set(PICK_TYPES.filter((t) => t !== "invoice" || isAdmin(a)));
  const runs: Promise<PickItem[]>[] = [];
  const add = (t: RefType, p: Promise<PickItem[]>) => { if (want.has(t)) runs.push(p); };
  add("task", db.select({ id: tasks.id, title: tasks.title, number: tasks.number, key: projects.key, at: tasks.updatedAt }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), has(tasks.title))).orderBy(desc(tasks.updatedAt)).limit(per)
    .then((r) => r.map((x) => ({ kind: "record" as const, type: "task" as const, id: x.id, title: x.title, subtitle: `Task · ${x.key}-${x.number}`, at: iso(x.at) }))));
  add("project", db.select({ id: projects.id, name: projects.name, key: projects.key, at: projects.updatedAt }).from(projects)
    .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt), has(projects.name))).orderBy(desc(projects.updatedAt)).limit(per)
    .then((r) => r.map((x) => ({ kind: "record" as const, type: "project" as const, id: x.id, title: x.name, subtitle: `Project · ${x.key}`, at: iso(x.at) }))));
  add("doc", db.select({ id: docs.id, title: docs.title, at: docs.updatedAt }).from(docs)
    .where(and(eq(docs.orgId, orgId), isNull(docs.deletedAt), has(docs.title))).orderBy(desc(docs.updatedAt)).limit(per)
    .then((r) => r.map((x) => ({ kind: "record" as const, type: "doc" as const, id: x.id, title: x.title || "Untitled", subtitle: "Doc", at: iso(x.at) }))));
  add("contact", db.select({ id: contacts.id, name: contacts.name, email: contacts.email, at: contacts.updatedAt }).from(contacts)
    .where(and(eq(contacts.orgId, orgId), isNull(contacts.deletedAt), q ? or(containsText(contacts.name, q), containsText(contacts.email, q)) : sql`1 = 1`)).orderBy(desc(contacts.updatedAt)).limit(per)
    .then((r) => r.map((x) => ({ kind: "record" as const, type: "contact" as const, id: x.id, title: x.name || x.email || "Contact", subtitle: "Contact", at: iso(x.at) }))));
  add("deal", db.select({ id: deals.id, title: deals.title, at: deals.updatedAt }).from(deals)
    .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), has(deals.title))).orderBy(desc(deals.updatedAt)).limit(per)
    .then((r) => r.map((x) => ({ kind: "record" as const, type: "deal" as const, id: x.id, title: x.title, subtitle: "Deal", at: iso(x.at) }))));
  add("meeting", db.select({ id: meetings.id, title: meetings.title, at: meetings.updatedAt }).from(meetings)
    .where(and(eq(meetings.orgId, orgId), isNull(meetings.deletedAt), has(meetings.title))).orderBy(desc(meetings.updatedAt)).limit(per)
    .then((r) => r.map((x) => ({ kind: "record" as const, type: "meeting" as const, id: x.id, title: x.title, subtitle: "Meeting", at: iso(x.at) }))));
  add("form", db.select({ id: forms.id, name: forms.name, at: forms.updatedAt }).from(forms)
    .where(and(eq(forms.orgId, orgId), isNull(forms.deletedAt), has(forms.name))).orderBy(desc(forms.updatedAt)).limit(per)
    .then((r) => r.map((x) => ({ kind: "record" as const, type: "form" as const, id: x.id, title: x.name, subtitle: "Form", at: iso(x.at) }))));
  add("invoice", db.select({ id: invoiceDocs.id, kind: invoiceDocs.kind, number: invoiceDocs.number, buyerName: invoiceDocs.buyerName, at: invoiceDocs.updatedAt }).from(invoiceDocs)
    .where(and(eq(invoiceDocs.orgId, orgId), q ? or(containsText(invoiceDocs.number, q), containsText(invoiceDocs.buyerName, q)) : sql`1 = 1`)).orderBy(desc(invoiceDocs.updatedAt)).limit(per)
    .then((r) => r.map((x) => ({ kind: "record" as const, type: "invoice" as const, id: x.id, title: `${x.kind === "quote" ? "Quote" : "Invoice"} ${x.number ?? "draft"}`, subtitle: x.buyerName ? `Invoice · ${x.buyerName}` : "Invoice", at: iso(x.at) }))));
  const records = rankByRecency((await Promise.all(runs)).flat()).slice(0, lim);
  return { people, records };
}

// ---------------------------------------------------------------- References panel

/** The record a source text lives on, as the panel shows it. */
function containerOf(row: { sourceType: string; sourceId: string; parentType: string | null; parentId: string | null }): { type: ItemType; id: string; messageId?: string } | null {
  switch (row.sourceType) {
    case "chat": return row.parentId ? { type: "channel", id: row.parentId, messageId: row.sourceId } : null;
    case "task": return { type: "task", id: row.sourceId };
    case "doc": return { type: "doc", id: row.sourceId };
    case "task_comment": return row.parentId ? { type: "task", id: row.parentId } : null;
    case "doc_comment": return row.parentId ? { type: "doc", id: row.parentId } : null;
    case "note": return row.parentId && (row.parentType === "contact" || row.parentType === "deal") ? { type: row.parentType, id: row.parentId } : null;
    default: return null;
  }
}

/** Chat containers: the channel's name for members who may read it, restricted otherwise. */
async function resolveChannels(deps: Deps, a: A, items: { id: string; messageId?: string }[]): Promise<Map<string, ResolvedRef>> {
  const out = new Map<string, ResolvedRef>();
  const ids = [...new Set(items.map((x) => x.id))].slice(0, RESOLVE_MAX);
  if (!ids.length) return out;
  const rows = await deps.db.select({ id: chatChannels.id, kind: chatChannels.kind, name: chatChannels.name, isPrivate: chatChannels.isPrivate }).from(chatChannels)
    .where(and(eq(chatChannels.orgId, a.orgId), inIds(chatChannels.id, ids)));
  const mine = new Set((await deps.db.select({ id: chatMembers.channelId }).from(chatMembers)
    .where(and(eq(chatMembers.userId, a.userId!), inIds(chatMembers.channelId, ids)))).map((r) => r.id));
  for (const r of rows) {
    const open = r.kind === "channel" && !r.isPrivate;
    if (!open && !mine.has(r.id)) { out.set(`channel:${r.id}`, { state: "restricted", type: "channel", id: r.id }); continue; }
    out.set(`channel:${r.id}`, { state: "ok", type: "channel", id: r.id, title: r.kind === "dm" ? "Direct message" : `#${r.name}`, subtitle: "Chat", url: `/app/chat/${encodeURIComponent(r.id)}` });
  }
  for (const id of ids) if (!out.has(`channel:${id}`)) out.set(`channel:${id}`, { state: "deleted", type: "channel", id });
  return out;
}

/** Private contact notes the viewer may not read (someone else's). */
async function hiddenNotes(deps: Deps, a: A, noteIds: string[]): Promise<Set<string>> {
  if (!noteIds.length) return new Set();
  const rows = await deps.db.select({ id: crmEntries.id, private: crmEntries.private, by: crmEntries.createdById, deletedAt: crmEntries.deletedAt }).from(crmEntries)
    .where(and(eq(crmEntries.orgId, a.orgId), inIds(crmEntries.id, [...new Set(noteIds)])));
  return new Set(rows.filter((r) => r.deletedAt || (r.private && r.by !== a.userId)).map((r) => r.id));
}

function encodeCursor(at: Date, k: string) { return `${new Date(at).getTime()}.${k}`; }
function decodeCursor(c: string | undefined): { at: Date; k: string } | null {
  if (!c || c.length > 300) return null;
  const i = c.indexOf(".");
  const ms = Number(c.slice(0, i));
  return i > 0 && Number.isFinite(ms) ? { at: new Date(ms), k: c.slice(i + 1) } : null;
}

/**
 * The References panel for one record: "in" lists the records whose text mentions it, "out" the records it mentions.
 * 404 unless the viewer can see the record itself. Newest first, REFS_PAGE per page, `next` is the cursor.
 */
export async function listReferences(deps: Deps, a: A, target: RecordRef, dir: "in" | "out", cursor?: string): Promise<{ items: RefItem[]; next: string | null; total: number }> {
  const self = (await resolveRefs(deps, a, [target])).get(refKey(target));
  if (!self || self.state !== "ok") throw notFound();
  const id = self.id; // a task ref resolves to the real id
  const cur = decodeCursor(cursor);
  const db = deps.db;
  const key = dir === "in" ? sql`${recordRefs.sourceType} || ':' || ${recordRefs.sourceId}` : sql`${recordRefs.targetType} || ':' || ${recordRefs.targetId}`;
  const scope: SQL = dir === "in"
    ? and(eq(recordRefs.orgId, a.orgId), eq(recordRefs.targetType, target.type), eq(recordRefs.targetId, id))!
    : and(eq(recordRefs.orgId, a.orgId), or(
      and(eq(recordRefs.sourceType, target.type), eq(recordRefs.sourceId, id)),
      and(eq(recordRefs.parentType, target.type), eq(recordRefs.parentId, id)),
    ))!;
  const page: SQL = cur ? or(lt(recordRefs.createdAt, cur.at), and(eq(recordRefs.createdAt, cur.at), sql`${key} < ${cur.k}`))! : sql`1 = 1`;
  const rows = await db.select({
    sourceType: recordRefs.sourceType, sourceId: recordRefs.sourceId, parentType: recordRefs.parentType, parentId: recordRefs.parentId,
    targetType: recordRefs.targetType, targetId: recordRefs.targetId, createdAt: recordRefs.createdAt, k: sql<string>`${key}`,
  }).from(recordRefs).where(and(scope, page)).orderBy(desc(recordRefs.createdAt), desc(key)).limit(REFS_PAGE + 1);
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(recordRefs).where(scope);
  const more = rows.length > REFS_PAGE;
  const pageRows = rows.slice(0, REFS_PAGE);
  const hidden = await hiddenNotes(deps, a, pageRows.filter((r) => r.sourceType === "note").map((r) => r.sourceId));
  const items: RefItem[] = [];
  const seen = new Set<string>();
  if (dir === "out") {
    const visible = pageRows.filter((r) => !(r.sourceType === "note" && hidden.has(r.sourceId)));
    const resolved = await resolveRefs(deps, a, visible.map((r) => ({ type: r.targetType as RefType, id: r.targetId })));
    for (const r of visible) {
      const k = `${r.targetType}:${r.targetId}`;
      if (seen.has(k) || (r.targetType === target.type && r.targetId === id)) continue;
      seen.add(k);
      items.push({ key: k, at: iso(r.createdAt)!, via: r.sourceType as SourceType, record: resolved.get(k)! });
    }
  } else {
    const conts = pageRows.map((r) => ({ r, c: containerOf(r) })).filter((x): x is { r: typeof x.r; c: NonNullable<typeof x.c> } => !!x.c);
    const recs = conts.filter((x) => x.c.type !== "channel").map((x) => ({ type: x.c.type as RefType, id: x.c.id }));
    const [resolved, chans] = await Promise.all([resolveRefs(deps, a, recs), resolveChannels(deps, a, conts.filter((x) => x.c.type === "channel").map((x) => x.c))]);
    for (const { r, c } of conts) {
      const k = `${c.type}:${c.id}`;
      if (seen.has(k) || (c.type === target.type && c.id === id)) continue;
      seen.add(k);
      let record = c.type === "channel" ? chans.get(k)! : resolved.get(k)!;
      if (r.sourceType === "note" && hidden.has(r.sourceId) && record.state === "ok") record = { state: "restricted", type: record.type, id: record.id };
      if (record.state === "ok" && c.messageId) record = { ...record, url: `${record.url}?message=${encodeURIComponent(c.messageId)}` };
      items.push({ key: k, at: iso(r.createdAt)!, via: r.sourceType as SourceType, record });
    }
  }
  const last = pageRows[pageRows.length - 1];
  return { items, next: more && last ? encodeCursor(last.createdAt, last.k) : null, total: Number(n) || 0 };
}

// ---------------------------------------------------------------- chat cards per viewer

type LinkLike = { type: string; id: string; ref: string | null; title: string; messageId?: string; state?: "restricted" | "deleted"; subtitle?: string; url?: string };
type MsgLike = { body: string; links: LinkLike[] };

/**
 * Chat link cards for THIS reader: every record token in the message (and every stored link) is resolved with the
 * reader's access. A reader without access gets "restricted" with an empty title and no ref, never the author's view.
 */
export async function viewerChatLinks<T extends MsgLike>(deps: Deps, a: A, msgs: T[]): Promise<T[]> {
  if (!msgs.length || !a.userId || a.agentId || a.apiKeyId || !(await mentionsOn(deps, a.orgId))) return msgs;
  const all: RecordRef[] = [];
  for (const m of msgs) {
    for (const r of parseRefs(m.body)) all.push(r);
    for (const l of m.links) if (l.type === "task" || l.type === "doc" || l.type === "thread") all.push({ type: l.type, id: l.id });
  }
  if (!all.length) return msgs;
  const uniq = [...new Map(all.map((r) => [refKey(r), r])).values()].slice(0, RESOLVE_MAX);
  const res = await resolveRefs(deps, a, uniq);
  const card = (r: RecordRef, prev?: LinkLike): LinkLike => {
    const x = res.get(refKey(r));
    if (!x) return prev ?? { type: r.type, id: r.id, ref: null, title: "" };
    if (x.state === "ok") return { type: r.type, id: r.id, ref: prev?.ref ?? null, title: x.title, subtitle: x.subtitle, url: x.url, messageId: prev?.messageId };
    return { type: r.type, id: r.id, ref: null, title: "", state: x.state };
  };
  return msgs.map((m) => {
    const stored = new Map(m.links.map((l) => [`${l.type}:${l.id}`, l]));
    const links: LinkLike[] = m.links.map((l) => (["task", "doc", "thread"].includes(l.type) ? card({ type: l.type as RefType, id: l.id }, l) : l));
    for (const r of parseRefs(m.body)) if (!stored.has(refKey(r))) links.push(card(r));
    return { ...m, links };
  });
}
