/**
 * Round 22 (R22.4b): saved replies (snippets) with {{variables}}. A saved reply belongs to the
 * workspace; shared ones are visible to every member and agent, private ones only to their author.
 *
 * Who can do what: members, workspace keys and agent keys can list, read and render; members and
 * full keys can create; the author, or an owner or admin, can edit and delete. Read only keys and
 * read only OAuth tokens can list and render but not change anything. Guests have no workspace
 * session. Another workspace's ids, and other people's private replies, are 404.
 *
 * Rendering for a thread checks that the caller can open it (same workspace, a mailbox in their
 * scope), the same rule as the shared inbox. D1 cost: create, update and delete are 1 row plus
 * 1 index entry each; list and render write nothing.
 */
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { agents, mailboxes, mailSnippets, messages, organizations, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { firstNameOf, firstRecipient, renderSnippet, snippetDate, SNIPPET_BODY_MAX, SNIPPET_NAME_MAX, SNIPPET_SHORTCUT_RE, SNIPPET_SUBJECT_MAX, type SnippetVars } from "@/shared/snippets";
import { assertWritable, scopeOf, sortableId, type SuiteActor } from "./common";
import { inIds } from "../../lib/sql-chunks";

type Row = typeof mailSnippets.$inferSelect;
export interface SnippetInput { name?: string; shortcut?: string | null; subject?: string | null; body?: string; shared?: boolean }

const authorKey = (a: SuiteActor) => a.agentId || a.userId || "";
const isLead = (a: SuiteActor) => !a.agentId && (a.role === "owner" || a.role === "admin");
const isAuthor = (r: Row, a: SuiteActor) => !!authorKey(a) && r.createdBy === authorKey(a);
const visible = (r: Row, a: SuiteActor) => r.shared || isAuthor(r, a);

function present(r: Row, a: SuiteActor, names: Map<string, string>) {
  return {
    id: r.id,
    name: r.name,
    shortcut: r.shortcut,
    subject: r.subject,
    body: r.body,
    shared: r.shared,
    createdBy: { id: r.createdBy, name: names.get(r.createdBy) ?? "Former member" },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    canEdit: isAuthor(r, a) || isLead(a),
  };
}
export type Snippet = ReturnType<typeof present>;

async function authorNames(deps: Deps, orgId: string, rows: Row[]) {
  const ids = [...new Set(rows.map((r) => r.createdBy))];
  if (!ids.length) return new Map<string, string>();
  const [people, bots] = await Promise.all([
    deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inIds(users.id, ids)),
    deps.db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.orgId, orgId), inIds(agents.id, ids))),
  ]);
  return new Map<string, string>([...people.map((p) => [p.id, p.name || p.email] as [string, string]), ...bots.map((b) => [b.id, b.name] as [string, string])]);
}

function invalid(field: string, message: string): never {
  throw new HttpError(422, "validation_failed", message, { fields: { [field]: message } });
}

function clean(input: SnippetInput, partial: boolean) {
  const out: Partial<Pick<Row, "name" | "shortcut" | "subject" | "body" | "shared">> = {};
  if (input.name !== undefined || !partial) {
    const name = (input.name ?? "").trim();
    if (!name) invalid("name", "Give the saved reply a name.");
    if (name.length > SNIPPET_NAME_MAX) invalid("name", `Names can be up to ${SNIPPET_NAME_MAX} characters.`);
    out.name = name;
  }
  if (input.body !== undefined || !partial) {
    const body = (input.body ?? "").replace(/\r\n/g, "\n");
    if (!body.trim()) invalid("body", "Write the reply text first.");
    if (body.length > SNIPPET_BODY_MAX) invalid("body", `Saved replies can be up to ${SNIPPET_BODY_MAX.toLocaleString("en")} characters.`);
    out.body = body;
  }
  if (input.shortcut !== undefined) {
    const s = (input.shortcut ?? "").trim().replace(/^\//, "").toLowerCase();
    if (s && !SNIPPET_SHORTCUT_RE.test(s)) invalid("shortcut", "Shortcuts are one word: letters, numbers, - or _, up to 32 characters.");
    out.shortcut = s || null;
  }
  if (input.subject !== undefined) {
    const s = (input.subject ?? "").trim();
    if (s.length > SNIPPET_SUBJECT_MAX) invalid("subject", `Subjects can be up to ${SNIPPET_SUBJECT_MAX} characters.`);
    out.subject = s || null;
  }
  if (input.shared !== undefined) out.shared = !!input.shared;
  return out;
}

async function assertShortcutFree(deps: Deps, orgId: string, shortcut: string | null | undefined, exceptId?: string) {
  if (!shortcut) return;
  const hit = await deps.db.select({ id: mailSnippets.id }).from(mailSnippets)
    .where(and(eq(mailSnippets.orgId, orgId), eq(mailSnippets.shortcut, shortcut), exceptId ? ne(mailSnippets.id, exceptId) : undefined)).get();
  if (hit) throw new HttpError(409, "conflict", `The shortcut /${shortcut} is already used by another saved reply.`, { fields: { shortcut: "Already used." } });
}

/** Saved replies this caller can see, by name. q filters by name, shortcut or text. */
export async function listSnippets(deps: Deps, a: SuiteActor, opts: { q?: string } = {}) {
  const rows = await deps.db.select().from(mailSnippets).where(eq(mailSnippets.orgId, a.orgId)).orderBy(asc(mailSnippets.name), asc(mailSnippets.id)).limit(500);
  const q = (opts.q ?? "").trim().toLowerCase().replace(/^\//, "");
  const mine = rows.filter((r) => visible(r, a)).filter((r) => !q || r.name.toLowerCase().includes(q) || (r.shortcut ?? "").includes(q) || r.body.toLowerCase().includes(q));
  const names = await authorNames(deps, a.orgId, mine);
  return { snippets: mine.map((r) => present(r, a, names)) };
}

async function load(deps: Deps, a: SuiteActor, id: string) {
  if (!id || id.length > 100) throw notFound("Saved reply");
  const r = await deps.db.select().from(mailSnippets).where(and(eq(mailSnippets.id, id), eq(mailSnippets.orgId, a.orgId))).get();
  if (!r || !visible(r, a)) throw notFound("Saved reply");
  return r;
}

export async function getSnippet(deps: Deps, a: SuiteActor, id: string) {
  const r = await load(deps, a, id);
  return present(r, a, await authorNames(deps, a.orgId, [r]));
}

export async function createSnippet(deps: Deps, a: SuiteActor, input: SnippetInput) {
  assertWritable(a);
  const by = authorKey(a);
  if (!by) throw new HttpError(403, "forbidden", "Only a person or an agent can save a reply.");
  const v = clean(input, false);
  await assertShortcutFree(deps, a.orgId, v.shortcut);
  const now = deps.now();
  const row: Row = { id: sortableId("snp", now.getTime()), orgId: a.orgId, name: v.name!, shortcut: v.shortcut ?? null, subject: v.subject ?? null, body: v.body!, shared: v.shared ?? true, createdBy: by, createdAt: now, updatedAt: now };
  await deps.db.insert(mailSnippets).values(row);
  return present(row, a, await authorNames(deps, a.orgId, [row]));
}

export async function updateSnippet(deps: Deps, a: SuiteActor, id: string, input: SnippetInput) {
  assertWritable(a);
  const r = await load(deps, a, id);
  if (!isAuthor(r, a) && !isLead(a)) throw new HttpError(403, "forbidden", "Only the person who made this saved reply, or an admin, can change it.");
  const v = clean(input, true);
  if (v.shortcut !== undefined && v.shortcut !== r.shortcut) await assertShortcutFree(deps, a.orgId, v.shortcut, r.id);
  const next: Row = { ...r, ...v, updatedAt: deps.now() };
  await deps.db.update(mailSnippets).set({ ...v, updatedAt: next.updatedAt }).where(eq(mailSnippets.id, r.id));
  return present(next, a, await authorNames(deps, a.orgId, [next]));
}

export async function deleteSnippet(deps: Deps, a: SuiteActor, id: string) {
  assertWritable(a);
  const r = await load(deps, a, id);
  if (!isAuthor(r, a) && !isLead(a)) throw new HttpError(403, "forbidden", "Only the person who made this saved reply, or an admin, can delete it.");
  await deps.db.delete(mailSnippets).where(eq(mailSnippets.id, r.id));
  return { ok: true, id: r.id };
}

/** The thread's newest inbound sender and its mailbox, when the caller can open it; else 404. */
async function threadContext(deps: Deps, a: SuiteActor, threadId: string, scope: string[] | null) {
  if (!threadId || threadId.length > 200) throw notFound("Thread");
  const rows = await deps.db.select({ mailboxId: messages.mailboxId, folder: messages.folder, fromAddress: messages.fromAddress, fromName: messages.fromName }).from(messages)
    .where(and(eq(messages.orgId, a.orgId), eq(messages.threadId, threadId), sql`${messages.folder} <> 'drafts'`, scope ? inIds(messages.mailboxId, scope) : undefined))
    .orderBy(desc(messages.date)).limit(50);
  if (!rows.length) throw notFound("Thread");
  const inbound = rows.find((m) => m.folder !== "sent" && m.folder !== "trash");
  return { mailboxId: rows[0].mailboxId, sender: inbound ? { name: inbound.fromName, email: inbound.fromAddress } : null };
}

export interface RenderContext { threadId?: string | null; to?: string | null; mailboxId?: string | null }

/** The variables for this caller and context. Missing values stay empty. */
export async function snippetVars(deps: Deps, a: SuiteActor, ctx: RenderContext = {}): Promise<SnippetVars> {
  const scope = await scopeOf(deps, a);
  const thread = ctx.threadId ? await threadContext(deps, a, ctx.threadId, scope) : null;
  const typed = firstRecipient(ctx.to);
  // The thread's sender wins unless the To field names someone else.
  const who = thread?.sender && (!typed || typed.email.toLowerCase() === thread.sender.email.toLowerCase()) ? thread.sender : typed;
  const mailboxId = ctx.mailboxId || thread?.mailboxId || null;
  if (ctx.mailboxId && scope && !scope.includes(ctx.mailboxId)) throw notFound("Mailbox");
  const [org, me, bot, box] = await Promise.all([
    deps.db.select({ name: organizations.name, timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, a.orgId)).get(),
    a.userId && !a.agentId ? deps.db.select({ name: users.name, timezone: users.timezone }).from(users).where(eq(users.id, a.userId)).get() : undefined,
    a.agentId ? deps.db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, a.agentId), eq(agents.orgId, a.orgId))).get() : undefined,
    mailboxId ? deps.db.select({ address: mailboxes.address }).from(mailboxes).where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, a.orgId))).get() : undefined,
  ]);
  if (ctx.mailboxId && !box) throw notFound("Mailbox");
  const myName = bot?.name ?? me?.name ?? (a.email?.startsWith("api-key:") ? "" : a.name ?? "");
  return {
    first_name: firstNameOf(who?.name),
    name: who?.name ?? "",
    email: who?.email ?? "",
    my_name: myName,
    my_first_name: firstNameOf(myName),
    company: org?.name ?? "",
    mailbox: box?.address ?? "",
    date: snippetDate(deps.now(), me?.timezone || org?.timezone),
  };
}

/** A saved reply filled in for a context: { subject, body } plus the values used. */
export async function renderSnippetFor(deps: Deps, a: SuiteActor, id: string, ctx: RenderContext = {}) {
  const r = await load(deps, a, id);
  const vars = await snippetVars(deps, a, ctx);
  return { id: r.id, subject: r.subject ? renderSnippet(r.subject, vars) : "", body: renderSnippet(r.body, vars), variables: vars };
}
