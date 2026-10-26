/**
 * R31: split inbox (services side). R32: first time senders with SPF and DKIM passing join Important (firstTimeAuthCond). Splits are a person's own (per user per workspace). Which tab a message
 * shows under is worked out at read time from what the messages table already keeps (sender, recipients,
 * thread, is_bulk), so nothing is written per message and no backfill runs.
 *
 * Rule values are bound as SQL string literals (quotes doubled, control characters dropped), not as
 * parameters: a person can have 12 splits of 10 rules each, and D1 allows 100 bound variables a statement.
 */
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { mailSplits, messages } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import { BULK_LOCAL_PARTS, SPLITS_MAX, type MailSplit, type SplitRuleT, type SplitTab } from "@/shared/mail-splits";
import { snoozeHiddenCond } from "./schedules";

export interface SplitActor { orgId: string; userId: string; agentId?: string | null; scope?: string }

function person(a: SplitActor) {
  if (!a.userId || a.agentId) throw new HttpError(403, "person_only", "Splits belong to a person. Use a personal key or sign in.");
  return a.userId;
}
function writable(a: SplitActor) {
  if (a.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
}

/** A safe SQLite string literal: control characters dropped, quotes doubled. */
export function lit(v: string): SQL {
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 400);
  return sql.raw(`'${clean.replace(/'/g, "''")}'`);
}
const likeLit = (v: string) => lit(`%${v.toLowerCase().replace(/[!%_]/g, (ch) => `!${ch}`)}%`);
const ESC = sql.raw(`escape '!'`);

/** Teammates: workspace members' sign-in addresses and the workspace's own mailboxes. */
function teammateCond(orgId: string): SQL {
  return sql`(lower(${messages.fromAddress}) in (select lower(u.email) from users u join members mm on mm.user_id = u.id where mm.organization_id = ${orgId})
    or lower(${messages.fromAddress}) in (select lower(mb.address) from mailboxes mb where mb.org_id = ${orgId}))`;
}

const ROBOT_LOCALS = sql.raw(BULK_LOCAL_PARTS.map((p) => `'${p}'`).join(", "));
/** Not bulk: no bulk headers on ingest and no robot sender address (older rows have no is_bulk). */
function notBulkCond(): SQL {
  const local = sql`lower(substr(${messages.fromAddress}, 1, instr(${messages.fromAddress}, '@') - 1))`;
  return sql`(coalesce(${messages.isBulk}, 0) = 0 and ${local} not in (${ROBOT_LOCALS}) and ${local} not like 'noreply%' and ${local} not like 'no-reply%' and ${local} not like 'notification%')`;
}

/** Mail from a person: someone the workspace wrote to, a teammate, a saved contact, or a reply in a thread this mailbox wrote in. */
export function importantBaseCond(orgId: string): SQL {
  // Uncorrelated, so SQLite builds the set of addresses once per query rather than once per row.
  const wroteTo = sql`lower(${messages.fromAddress}) in (select lower(json_extract(j.value, '$.address')) from messages s, json_each(s.to_json) j where s.org_id = ${orgId} and s.folder = 'sent')`;
  const inThread = sql`exists (select 1 from messages t where t.mailbox_id = ${messages.mailboxId} and t.thread_id = ${messages.threadId} and t.folder = 'sent')`;
  // Contacts made by hand, imported or by an agent; every sender becomes a "mail" contact on its own, so those don't count.
  const contact = sql`lower(${messages.fromAddress}) in (select lower(ct.email) from contacts ct where ct.org_id = ${orgId} and ct.source <> 'mail')`;
  return sql`(${notBulkCond()} and (${wroteTo} or ${inThread} or ${teammateCond(orgId)} or ${contact} or ${firstTimeAuthCond()}))`;
}

/**
 * R32 (product decision): a first time sender lands in Important when the message passed SPF and DKIM (the
 * authentication results stored on ingest, with DMARC not failing, so the domains line up) and it is not bulk
 * (the caller already requires notBulkCond: no list headers, no robot address). First time means no earlier
 * message from that address in this mailbox. Failing or missing SPF or DKIM stays in Other.
 */
export function firstTimeAuthCond(): SQL {
  const res = (k: string) => sql`lower(coalesce(json_extract(${messages.authResults}, ${sql.raw(`'$.${k}'`)}), ''))`;
  const passed = sql`(${messages.authResults} is not null and json_valid(${messages.authResults}) and ${res("spf")} = 'pass' and ${res("dkim")} = 'pass' and ${res("dmarc")} <> 'fail')`;
  const earlier = sql`exists (select 1 from messages p where p.mailbox_id = ${messages.mailboxId} and p.folder <> 'sent' and p.folder <> 'drafts'
    and lower(p.from_address) = lower(${messages.fromAddress}) and (p.date < ${messages.date} or (p.date = ${messages.date} and p.id < ${messages.id})))`;
  return sql`(${messages.folder} <> 'sent' and ${passed} and not ${earlier})`;
}

export function ruleCond(r: SplitRuleT, orgId: string): SQL {
  const v = (r.value ?? "").trim().toLowerCase();
  switch (r.field) {
    case "fromContains": return sql`lower(${messages.fromAddress} || ' ' || ${messages.fromName}) like ${likeLit(v)} ${ESC}`;
    case "fromDomain": {
      const d = v.replace(/^@+/, "").replace(/[!%_]/g, (ch) => `!${ch}`);
      return sql`(lower(${messages.fromAddress}) like ${lit(`%@${d}`)} ${ESC} or lower(${messages.fromAddress}) like ${lit(`%.${d}`)} ${ESC})`;
    }
    case "to": return sql`(lower(${messages.to} || ${messages.cc}) like ${likeLit(v)} ${ESC} or ${messages.mailboxId} = ${lit(r.value.trim())})`;
    case "subjectContains": return sql`lower(${messages.subject}) like ${likeLit(v)} ${ESC}`;
    case "calendarInvite": return sql`exists (select 1 from attachments a where a.message_id = ${messages.id} and (lower(a.content_type) like 'text/calendar%' or lower(a.filename) like '%.ics'))`;
    case "fromTeammate": return teammateCond(orgId);
  }
}

export function splitMatchCond(s: Pick<MailSplit, "rules" | "match">, orgId: string): SQL {
  const parts = s.rules.map((r) => ruleCond(r, orgId));
  if (!parts.length) return sql`0`;
  return sql`(${sql.join(parts, s.match === "any" ? sql` or ` : sql` and `)})`;
}

type Row = typeof mailSplits.$inferSelect;
function present(r: Row): MailSplit {
  let rules: SplitRuleT[];
  try { rules = JSON.parse(r.rules) as SplitRuleT[]; } catch { rules = []; }
  return { id: r.id, name: r.name, rules, match: r.match, leavesImportant: r.leavesImportant, position: r.position };
}

export async function listSplits(deps: Deps, a: SplitActor): Promise<MailSplit[]> {
  const userId = person(a);
  const rows = await deps.db.select().from(mailSplits).where(and(eq(mailSplits.orgId, a.orgId), eq(mailSplits.userId, userId))).orderBy(asc(mailSplits.position), asc(mailSplits.createdAt));
  return rows.map(present);
}

async function own(deps: Deps, a: SplitActor, id: string) {
  const userId = person(a);
  const r = await deps.db.select().from(mailSplits).where(and(eq(mailSplits.id, id), eq(mailSplits.orgId, a.orgId), eq(mailSplits.userId, userId))).get();
  if (!r) throw notFound("Split");
  return r;
}

export async function getSplit(deps: Deps, a: SplitActor, id: string) { return present(await own(deps, a, id)); }

export async function createSplit(deps: Deps, a: SplitActor, input: { name: string; rules: SplitRuleT[]; match?: "all" | "any"; leavesImportant?: boolean; position?: number }) {
  writable(a);
  const userId = person(a);
  const existing = await listSplits(deps, a);
  if (existing.length >= SPLITS_MAX) throw badRequest(`You can have up to ${SPLITS_MAX} splits.`);
  const name = input.name.trim();
  if (["important", "other"].includes(name.toLowerCase())) throw badRequest("Important and Other are already tabs. Pick another name.");
  if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "split_exists", "You already have a split with that name.");
  const now = deps.now();
  const id = newId("spl");
  await deps.db.insert(mailSplits).values({
    id, orgId: a.orgId, userId, name, rules: JSON.stringify(input.rules), match: input.match ?? "all",
    leavesImportant: input.leavesImportant ?? true, position: input.position ?? existing.length, createdAt: now, updatedAt: now,
  });
  return getSplit(deps, a, id);
}

export async function updateSplit(deps: Deps, a: SplitActor, id: string, patch: { name?: string; rules?: SplitRuleT[]; match?: "all" | "any"; leavesImportant?: boolean; position?: number }) {
  writable(a);
  await own(deps, a, id);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (["important", "other"].includes(name.toLowerCase())) throw badRequest("Important and Other are already tabs. Pick another name.");
    const clash = (await listSplits(deps, a)).find((s) => s.id !== id && s.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new HttpError(409, "split_exists", "You already have a split with that name.");
  }
  await deps.db.update(mailSplits).set({
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.rules ? { rules: JSON.stringify(patch.rules) } : {}),
    ...(patch.match ? { match: patch.match } : {}),
    ...(patch.leavesImportant !== undefined ? { leavesImportant: patch.leavesImportant } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    updatedAt: deps.now(),
  }).where(eq(mailSplits.id, id));
  return getSplit(deps, a, id);
}

/** Sets the order of all the person's splits at once (ids in the new order). One write per split that moved. */
export async function reorderSplits(deps: Deps, a: SplitActor, ids: string[]) {
  writable(a);
  const current = await listSplits(deps, a);
  const known = new Set(current.map((s) => s.id));
  if (ids.length !== current.length || ids.some((id) => !known.has(id))) throw badRequest("List every split once, in the new order.");
  const now = deps.now();
  for (const [i, id] of ids.entries()) {
    if (current.find((s) => s.id === id)?.position !== i) await deps.db.update(mailSplits).set({ position: i, updatedAt: now }).where(eq(mailSplits.id, id));
  }
  return listSplits(deps, a);
}

export async function deleteSplit(deps: Deps, a: SplitActor, id: string) {
  writable(a);
  await own(deps, a, id);
  await deps.db.delete(mailSplits).where(eq(mailSplits.id, id));
  return { deleted: true };
}

/** Mail that a split claims (it leaves Important and Other). */
function claimedCond(splits: MailSplit[], orgId: string): SQL | null {
  const leaving = splits.filter((s) => s.leavesImportant && s.rules.length);
  if (!leaving.length) return null;
  return sql`(${sql.join(leaving.map((s) => splitMatchCond(s, orgId)), sql` or `)})`;
}

/** The SQL condition for one tab: "important", "other" or a split id. Unknown ids answer 404. */
export async function splitCond(deps: Deps, a: SplitActor, split: string, splits?: MailSplit[]): Promise<SQL> {
  const list = splits ?? (a.userId && !a.agentId ? await listSplits(deps, a) : []);
  const claimed = claimedCond(list, a.orgId);
  const base = importantBaseCond(a.orgId);
  if (split === "important") return claimed ? sql`(${base} and not ${claimed})` : base;
  if (split === "other") return claimed ? sql`(not ${base} and not ${claimed})` : sql`(not ${base})`;
  const s = list.find((x) => x.id === split);
  if (!s) throw notFound("Split");
  return splitMatchCond(s, a.orgId);
}

/** Inbox tabs for a mailbox (or every mailbox in scope), each with its unread count. Snoozed mail is left out. */
export async function splitTabs(deps: Deps, a: SplitActor, q: { mailboxId?: string; scope: string[] | null }): Promise<SplitTab[]> {
  const list = await listSplits(deps, a);
  const tabs: { id: string; name: string; builtIn: boolean }[] = [
    { id: "important", name: "Important", builtIn: true },
    { id: "other", name: "Other", builtIn: true },
    ...list.map((s) => ({ id: s.id, name: s.name, builtIn: false })),
  ];
  const out: SplitTab[] = [];
  for (const t of tabs) {
    const cond = await splitCond(deps, a, t.id, list);
    const row = await deps.db.select({ n: sql<number>`count(*)` }).from(messages).where(and(
      eq(messages.orgId, a.orgId), q.mailboxId ? eq(messages.mailboxId, q.mailboxId) : undefined, q.scope ? inIds(messages.mailboxId, q.scope) : undefined,
      eq(messages.folder, "inbox"), eq(messages.isRead, false), snoozeHiddenCond(deps.now()), cond,
    )).get();
    out.push({ ...t, unread: Number(row?.n ?? 0) });
  }
  return out;
}

/** Live preview for the rule builder: how many Inbox threads these rules match. */
export async function previewSplit(deps: Deps, a: SplitActor, input: { rules: SplitRuleT[]; match?: "all" | "any"; mailboxId?: string }, scope: string[] | null) {
  person(a);
  const row = await deps.db.select({ n: sql<number>`count(distinct ${messages.threadId})` }).from(messages).where(and(
    eq(messages.orgId, a.orgId), input.mailboxId ? eq(messages.mailboxId, input.mailboxId) : undefined, scope ? inIds(messages.mailboxId, scope) : undefined,
    eq(messages.folder, "inbox"), splitMatchCond({ rules: input.rules, match: input.match ?? "all" }, a.orgId),
  )).get();
  return { threads: Number(row?.n ?? 0) };
}
