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
import { mailPrefs, mailSplits, messages, users } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import { BULK_LOCAL_PARTS, SPLITS_MAX, type MailSplit, type SplitRuleT, type SplitTab } from "@/shared/mail-splits";
import { snoozeHiddenCond } from "./schedules";
import { BUILT_IN_TABS, NOT_PROMO_WORDS, PROMO_LOCAL_PARTS, PROMO_WORDS, parsePins, type TabPins, type TabStyle } from "@/shared/mail-rules-r85";
import { featureOn } from "../console/flags"; // OPS1 feature flags

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
/** LK1: `col` (already lower cased) contains `v`; instr has no 50 byte LIKE pattern limit. */
const hasLit = (col: SQL, v: string) => sql`instr(${col}, lower(${lit(v.toLowerCase())})) > 0`;

/** Teammates: workspace members' sign-in addresses and the workspace's own mailboxes. */
function teammateCond(orgId: string): SQL {
  return sql`(lower(${messages.fromAddress}) in (select lower(u.email) from users u join members mm on mm.user_id = u.id where mm.organization_id = ${orgId})
    or lower(${messages.fromAddress}) in (select lower(mb.address) from mailboxes mb where mb.org_id = ${orgId}))`;
}

const ROBOT_LOCALS = sql.raw(BULK_LOCAL_PARTS.map((p) => `'${p}'`).join(", "));
/** Not bulk: no bulk headers on ingest and no robot sender address (older rows have no is_bulk). */
export function notBulkCond(): SQL {
  const local = sql`lower(substr(${messages.fromAddress}, 1, instr(${messages.fromAddress}, '@') - 1))`;
  return sql`(coalesce(${messages.isBulk}, 0) = 0 and ${local} not in (${ROBOT_LOCALS}) and ${local} not like 'noreply%' and ${local} not like 'no-reply%' and ${local} not like 'notification%')`;
}

/** Mail from a person: someone the workspace wrote to, a teammate, a saved contact, or a reply in a thread this mailbox wrote in. */
export function importantBaseCond(orgId: string): SQL {
  // Uncorrelated, so SQLite builds the set of addresses once per query rather than once per row.
  const wroteTo = sql`lower(${messages.fromAddress}) in (select lower(json_extract(j.value, '$.address')) from messages s, json_each(s.to_json) j where s.org_id = ${orgId} and s.folder = 'sent')`;
  // R59 hotfix: uncorrelated too. As a correlated EXISTS, SQLite served it with the (mailbox, folder) index and read every
  // Sent row of the mailbox for each unread row; now the workspace's Sent threads are read once per statement.
  const inThread = sql`(${messages.mailboxId}, ${messages.threadId}) in (select t.mailbox_id, t.thread_id from messages t where t.org_id = ${orgId} and t.folder = 'sent')`;
  // Contacts made by hand, imported or by an agent; every sender becomes a "mail" contact on its own, so those don't count.
  const contact = sql`lower(${messages.fromAddress}) in (select lower(ct.email) from contacts ct where ct.org_id = ${orgId} and ct.source <> 'mail')`;
  return sql`(${notBulkCond()} and (${wroteTo} or ${inThread} or ${teammateCond(orgId)} or ${contact} or ${firstTimeAuthCond(orgId)}))`;
}

/**
 * R32 (product decision): a first time sender lands in Important when the message passed SPF and DKIM (the
 * authentication results stored on ingest, with DMARC not failing, so the domains line up) and it is not bulk
 * (the caller already requires notBulkCond: no list headers, no robot address). First time means no earlier
 * message from that address in this mailbox. Failing or missing SPF or DKIM stays in Other.
 *
 * R59 hotfix (D1 reads): "first" is the earliest message per mailbox and sender, worked out ONCE per statement as an
 * uncorrelated set (one pass over the workspace's received mail, built only when some row gets this far). It used to
 * be a correlated EXISTS comparing lower(from_address) per row, which no index serves, so every unread Inbox row
 * scanned its whole mailbox: about 188k rows read per count on a 5k message backfilled mailbox.
 */
export function firstTimeAuthCond(orgId: string): SQL {
  const res = (k: string) => sql`lower(coalesce(json_extract(${messages.authResults}, ${sql.raw(`'$.${k}'`)}), ''))`;
  const passed = sql`(${messages.authResults} is not null and json_valid(${messages.authResults}) and ${res("spf")} = 'pass' and ${res("dkim")} = 'pass' and ${res("dmarc")} <> 'fail')`;
  const first = sql`${messages.id} in (select f.id from (select p.id, row_number() over (partition by p.mailbox_id, lower(p.from_address) order by p.date, p.id) as rn
    from messages p where p.org_id = ${orgId} and p.folder <> 'sent' and p.folder <> 'drafts') f where f.rn = 1)`;
  return sql`(${messages.folder} <> 'sent' and ${passed} and ${first})`;
}

export function ruleCond(r: SplitRuleT, orgId: string): SQL {
  const v = (r.value ?? "").trim().toLowerCase();
  switch (r.field) {
    case "fromContains": return hasLit(sql`lower(${messages.fromAddress} || ' ' || ${messages.fromName})`, v);
    case "fromDomain": {
      const d = v.replace(/^@+/, "");
      // LK1: an ends with test, so a long domain never meets D1's 50 byte LIKE pattern limit.
      const ends = (x: string) => sql`substr(lower(${messages.fromAddress}), -length(${lit(x)})) = lower(${lit(x)})`;
      return sql`(${ends(`@${d}`)} or ${ends(`.${d}`)})`;
    }
    case "to": return sql`(${hasLit(sql`lower(${messages.to} || ${messages.cc})`, v)} or ${messages.mailboxId} = ${lit(r.value.trim())})`;
    case "subjectContains": return hasLit(sql`lower(${messages.subject})`, v);
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

export async function createSplit(deps: Deps, a: SplitActor, input: { name: string; rules: SplitRuleT[]; match?: "all" | "any"; leavesImportant?: boolean; position?: number }, opts: { id?: string; retry?: boolean } = {}) {
  writable(a);
  const userId = person(a);
  const existing = await listSplits(deps, a);
  // R53 (MB-239): a retry under the same Idempotency-Key gets the split its first attempt made, not "already exists".
  if (opts.id && opts.retry && existing.some((s) => s.id === opts.id)) return getSplit(deps, a, opts.id);
  if (existing.length >= SPLITS_MAX) throw badRequest(`You can have up to ${SPLITS_MAX} splits.`);
  const name = input.name.trim();
  if (["important", "other", "primary", "updates", "promotions"].includes(name.toLowerCase())) throw badRequest("That name is already a tab. Pick another name.");
  if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "split_exists", "You already have a split with that name.");
  const now = deps.now();
  const id = opts.id ?? newId("spl");
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
    if (["important", "other", "primary", "updates", "promotions"].includes(name.toLowerCase())) throw badRequest("That name is already a tab. Pick another name.");
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
  // R85: Primary, Updates and Promotions, and tabs with senders or threads pinned to them, take the general path.
  const st = a.userId && !a.agentId ? await tabsState(deps, a) : null;
  if (st && (st.style === "categories" || hasPins(st.pins) || (CATEGORY_TAB_IDS as string[]).includes(split))) {
    const cond = tabCondsFor(a.orgId, list, st, split);
    if (!cond) throw notFound("Split");
    return cond;
  }
  const claimed = claimedCond(list, a.orgId);
  const base = importantBaseCond(a.orgId);
  if (split === "important") return claimed ? sql`(${base} and not ${claimed})` : base;
  if (split === "other") return claimed ? sql`(not ${base} and not ${claimed})` : sql`(not ${base})`;
  const s = list.find((x) => x.id === split);
  if (!s) throw notFound("Split");
  return splitMatchCond(s, a.orgId);
}

/**
 * R59 hotfix: what a count statement needs for Important and Other so the Important rule is evaluated once per row.
 * Other is "not claimed" minus Important (a row is in exactly one of them, or claimed by a split). With no claiming
 * split, notClaimed is null and Other is the row count minus Important.
 */
export function splitCountParts(orgId: string, list: MailSplit[]): { important: SQL; notClaimed: SQL | null } {
  const claimed = claimedCond(list, orgId);
  // R61a (D1 reads): "is true" / "is not true", never coalesce(<rule>, 0). The meaning is the same (a NULL counts as no), but
  // inside coalesce() SQLite ran the rule's IN subqueries again for every unread row: 1,109,372 rows read per count on
  // production for a workspace with 10,411 unread Inbox rows, against 73,836 written this way (measured 30 Oct).
  const base = sql`(${importantBaseCond(orgId)}) is true`;
  if (!claimed) return { important: base, notClaimed: null };
  const notClaimed = sql`(${claimed}) is not true`;
  return { important: sql`(${base} and ${notClaimed})`, notClaimed };
}

/** Inbox tabs for a mailbox (or every mailbox in scope), each with its unread count. Snoozed mail is left out. R59: one statement for every tab. */
export async function splitTabs(deps: Deps, a: SplitActor, q: { mailboxId?: string; scope: string[] | null }, state?: TabsState): Promise<SplitTab[]> {
  const list = await listSplits(deps, a);
  // R85: a person's tab style. "off": no tabs. Categories or pins: the general count (one statement too).
  const st = state ?? (a.userId && !a.agentId ? await tabsState(deps, a) : null);
  if (st?.style === "off") return [];
  if (st && (st.style === "categories" || hasPins(st.pins))) return generalTabs(deps, a, q, list, st);
  // R61a kill switch (MAIL_SPLIT_COUNTS=off): the tabs stay, their unread counts read as 0 and no count runs.
  if (!featureOn(deps, "mailSplitCounts")) { // OPS1: the platform wide flag
    return [
      { id: "important", name: "Important", builtIn: true, unread: 0 },
      { id: "other", name: "Other", builtIn: true, unread: 0 },
      ...list.map((s) => ({ id: s.id, name: s.name, builtIn: false, unread: 0 })),
    ];
  }
  const parts = splitCountParts(a.orgId, list);
  const sum = (c: SQL) => sql<number>`coalesce(sum(case when ${c} then 1 else 0 end), 0)`;
  const cols: Record<string, SQL<number>> = { total: sql<number>`count(*)`, important: sum(parts.important) };
  if (parts.notClaimed) cols.notClaimed = sum(parts.notClaimed);
  list.forEach((s, i) => { cols[`s${i}`] = sum(sql`(${splitMatchCond(s, a.orgId)}) is true`); });
  const row = (await deps.db.select(cols).from(messages).where(and(
    eq(messages.orgId, a.orgId), q.mailboxId ? eq(messages.mailboxId, q.mailboxId) : undefined, q.scope ? inIds(messages.mailboxId, q.scope) : undefined,
    eq(messages.folder, "inbox"), eq(messages.isRead, false), snoozeHiddenCond(deps.now()),
  )).get()) as Record<string, number> | undefined;
  const n = (k: string) => Number(row?.[k] ?? 0);
  const important = n("important");
  const other = (parts.notClaimed ? n("notClaimed") : n("total")) - important;
  return [
    { id: "important", name: "Important", builtIn: true, unread: important },
    { id: "other", name: "Other", builtIn: true, unread: Math.max(0, other) },
    ...list.map((s, i) => ({ id: s.id, name: s.name, builtIn: false, unread: n(`s${i}`) })),
  ];
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

// ---------------------------------------------------------------- R85: tab styles and pins

/** Accounts made from this moment open on Primary, Updates and Promotions; older accounts keep Important and Other until they choose. */
export const CATEGORIES_DEFAULT_FROM = Date.parse("2026-10-31T16:00:00Z");
const CATEGORY_TAB_IDS = ["primary", "updates", "promotions"];

export interface TabsState { style: TabStyle; pins: TabPins; chosen: boolean }

export function hasPins(p: TabPins) { return Object.keys(p.s).length > 0 || Object.keys(p.t).length > 0; }

/** The person's tab style and pins in one read (their user row and mail prefs). */
export async function tabsState(deps: Deps, a: { orgId: string; userId: string }): Promise<TabsState> {
  const row = await deps.db.select({ createdAt: users.createdAt, style: mailPrefs.inboxTabs, pins: mailPrefs.tabPins }).from(users)
    .leftJoin(mailPrefs, and(eq(mailPrefs.orgId, a.orgId), eq(mailPrefs.userId, users.id)))
    .where(eq(users.id, a.userId)).get();
  const created = row?.createdAt ? new Date(row.createdAt as unknown as Date).getTime() : 0;
  const style: TabStyle = row?.style ?? (created >= CATEGORIES_DEFAULT_FROM ? "categories" : "classic");
  return { style, pins: parsePins(row?.pins ?? null), chosen: !!row?.style };
}

const inLits = (col: SQL, values: string[]): SQL => (values.length ? sql`${col} in (${sql.join(values.map((v) => lit(v)), sql`, `)})` : sql`0`);

function promoCond(): SQL {
  const local = sql`lower(substr(${messages.fromAddress}, 1, instr(${messages.fromAddress}, '@') - 1))`;
  const subj = sql`lower(${messages.subject})`;
  const like = (w: string) => hasLit(subj, w);
  const promo = sql`(${inLits(local, PROMO_LOCAL_PARTS)} or ${sql.join(PROMO_WORDS.map(like), sql` or `)})`;
  return sql`(${promo} and not (${sql.join(NOT_PROMO_WORDS.map(like), sql` or `)}))`;
}

/** The rule behind a built in tab, before pins and splits take their share. */
function builtInHeuristic(orgId: string, id: string): SQL | null {
  switch (id) {
    case "important": return sql`(${importantBaseCond(orgId)}) is true`;
    case "other": return sql`(${importantBaseCond(orgId)}) is not true`;
    case "primary": return sql`(${notBulkCond()}) is true`;
    case "promotions": return sql`((${notBulkCond()}) is not true and (${promoCond()}) is true)`;
    case "updates": return sql`((${notBulkCond()}) is not true and (${promoCond()}) is not true)`;
    default: return null;
  }
}

/** Every tab id the person has now: the style's built in tabs, then their splits. */
export function tabIdsOf(style: TabStyle, list: MailSplit[]): string[] {
  const builtIn = style === "off" ? BUILT_IN_TABS.classic : BUILT_IN_TABS[style];
  return [...builtIn.map((t) => t.id), ...list.map((s) => s.id)];
}

/**
 * One tab's condition with pins: a thread pinned to a tab shows there; else a sender pinned to a tab; else the splits
 * that claim mail; else the built in rule. Pins to a tab the person no longer has are ignored. Values are literals.
 */
export function tabCondsFor(orgId: string, list: MailSplit[], st: TabsState, tab: string): SQL | null {
  const style: TabStyle = st.style === "off" ? "classic" : st.style;
  const valid = new Set(tabIdsOf(style, list));
  // API callers may still ask for Important or Other while categories are on (and the reverse): both rules stay readable.
  const known = valid.has(tab) || builtInHeuristic(orgId, tab) !== null;
  if (!known) return null;
  const threadPins = Object.entries(st.pins.t).filter(([, t]) => valid.has(t));
  const senderPins = Object.entries(st.pins.s).filter(([, t]) => valid.has(t));
  const threadCol = sql`${messages.threadId}`;
  const fromCol = sql`lower(${messages.fromAddress})`;
  const anyThread = threadPins.length ? inLits(threadCol, threadPins.map(([k]) => k)) : null;
  const anySender = senderPins.length ? inLits(fromCol, senderPins.map(([k]) => k.toLowerCase())) : null;
  const pinnedAny = anyThread && anySender ? sql`(${anyThread} or ${anySender})` : anyThread ?? anySender;
  const pinOf = (t: string): SQL | null => {
    const th = threadPins.filter(([, x]) => x === t).map(([k]) => k);
    const se = senderPins.filter(([, x]) => x === t).map(([k]) => k.toLowerCase());
    const parts: SQL[] = [];
    if (th.length) parts.push(inLits(threadCol, th));
    if (se.length) parts.push(anyThread ? sql`(not ${anyThread} and ${inLits(fromCol, se)})` : inLits(fromCol, se));
    return parts.length ? sql`(${sql.join(parts, sql` or `)})` : null;
  };
  const notPinned = (c: SQL) => (pinnedAny ? sql`(not ${pinnedAny} and ${c})` : c);
  const withPin = (t: string, c: SQL) => { const p = pinOf(t); return p ? sql`(${p} or ${notPinned(c)})` : notPinned(c); };
  const split = list.find((s) => s.id === tab);
  if (split) return withPin(tab, sql`(${splitMatchCond(split, orgId)}) is true`);
  const claimed = claimedCond(list, orgId);
  const h = builtInHeuristic(orgId, tab)!;
  return withPin(tab, claimed ? sql`((${claimed}) is not true and ${h})` : h);
}

/** Tabs with unread counts for categories or pins: one statement, one sum per tab. */
async function generalTabs(deps: Deps, a: SplitActor, q: { mailboxId?: string; scope: string[] | null }, list: MailSplit[], st: TabsState): Promise<SplitTab[]> {
  const style = st.style === "off" ? "classic" : st.style;
  const builtIn = BUILT_IN_TABS[style];
  const tabs = [...builtIn.map((t) => ({ id: t.id, name: t.name, builtIn: true })), ...list.map((s) => ({ id: s.id, name: s.name, builtIn: false }))];
  if (!featureOn(deps, "mailSplitCounts")) return tabs.map((t) => ({ ...t, unread: 0 }));
  const cols: Record<string, SQL<number>> = {};
  tabs.forEach((t, i) => { cols[`t${i}`] = sql<number>`coalesce(sum(case when ${tabCondsFor(a.orgId, list, st, t.id)!} then 1 else 0 end), 0)`; });
  const row = (await deps.db.select(cols).from(messages).where(and(
    eq(messages.orgId, a.orgId), q.mailboxId ? eq(messages.mailboxId, q.mailboxId) : undefined, q.scope ? inIds(messages.mailboxId, q.scope) : undefined,
    eq(messages.folder, "inbox"), eq(messages.isRead, false), snoozeHiddenCond(deps.now()),
  )).get()) as Record<string, number> | undefined;
  return tabs.map((t, i) => ({ ...t, unread: Number(row?.[`t${i}`] ?? 0) }));
}
