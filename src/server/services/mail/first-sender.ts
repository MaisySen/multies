/**
 * MPLAT-108: messages.first_of_sender (0171) is kept by triggers from the moment the migration runs, but rows already
 * stored need the flag filled once. Filling it with one window over the whole messages table could pass D1's limit on
 * a single statement on a large database, so the maintenance pass fills it one mailbox at a time: each statement reads
 * one mailbox's received mail through messages_sender_first_idx, already in (sender, date, id) order, so no sort.
 *
 * Progress lives in app_settings under FIRST_SENDER_KEY: the last mailbox id filled, or "done". The migration writes
 * "done" straight away on a database with no mail. Until "done" is seen, the Important rule keeps the old window
 * (splits.ts, firstTimeAuthCond), so counts and lists are right at every step. Once seen, an isolate remembers it.
 *
 * Why the order is safe: the triggers only ever flag the earliest row of a group they touch, and a fill only flags a
 * group's earliest row that is still 0, so a fill and the triggers never disagree. Mailboxes made after the migration
 * hold only rows the triggers saw, so a mailbox id that sorts before the mark needs no fill.
 */
import { asc, eq, gt, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import type { DB } from "../../db";
import { appSettings, mailboxes } from "../../db/schema";

export const FIRST_SENDER_KEY = "first_of_sender_backfill";
const DONE = "done";

let ready = false;

/** True once this isolate has seen the fill finish; the Important rule then reads the stored flag. */
export const firstSenderReady = () => ready;

/** Tests only: forget what this isolate learned. */
export function forgetFirstSenderReady() { ready = false; }

/** One primary key read until the fill is done, nothing after. A failed read keeps the old (always right) window. */
export async function refreshFirstSenderReady(db: DB): Promise<boolean> {
  if (ready) return true;
  try {
    const row = await db.select({ v: appSettings.value }).from(appSettings).where(eq(appSettings.key, FIRST_SENDER_KEY)).get();
    if (row?.v === DONE) ready = true;
  } catch { /* the window stays in use */ }
  return ready;
}

/**
 * F4: where the fill stands. `after`: every mailbox id up to it is filled. `at`: the mailbox being filled, and the last
 * sender (lower case) done in it. `retry`: mailboxes whose fill failed, each with its failed tries and when it may be
 * tried again. The fill is "done" only when no mailbox is left, none is half filled and none waits to be tried again.
 */
interface Retry { box: string; tries: number; next: number }
interface FillMark { after: string; at?: { box: string; sender: string | null }; retry: Retry[] }

/** W2: a failed mailbox waits 15 minutes, doubling with each failure up to a day. */
const RETRY_BASE_MS = 15 * 60_000;
const RETRY_MAX_MS = 24 * 3_600_000;
/** W2: after this many failures a mailbox is parked: reported once, then tried once a day without reporting. */
export const FILL_MAX_TRIES = 5;

function readMark(v: string | undefined): FillMark {
  if (!v) return { after: "", retry: [] };
  try {
    const o = JSON.parse(v) as { after?: unknown; at?: FillMark["at"]; retry?: unknown };
    if (o && typeof o === "object") {
      // A mark saved before W2 kept retry as a list of mailbox ids: each counts as failed once, due now.
      const retry = Array.isArray(o.retry) ? o.retry.flatMap((x): Retry[] => typeof x === "string" ? [{ box: x, tries: 1, next: 0 }]
        : x && typeof x === "object" && typeof (x as Retry).box === "string" ? [{ box: (x as Retry).box, tries: Number((x as Retry).tries) || 1, next: Number((x as Retry).next) || 0 }] : []) : [];
      return { after: typeof o.after === "string" ? o.after : "", at: o.at, retry };
    }
  } catch { /* a plain mailbox id */ }
  return { after: v, retry: [] };
}

/**
 * F4: fills one mailbox a page of senders at a time: each page lists up to `perPage` senders after `from` (in
 * messages_sender_first_idx order) and flags each one's earliest message with one index seek, so no statement reads
 * more than those senders' rows. Stops at the deadline; returns whether the mailbox is done and the last sender done.
 */
async function fillMailbox(db: DB, box: string, from: string | null, perPage: number, deadline: number): Promise<{ done: boolean; sender: string | null }> {
  let after = from;
  const received = sql`mailbox_id = ${box} and folder <> 'sent' and folder <> 'drafts'`;
  const past = (col: SQL) => (after === null ? sql`1 = 1` : sql`${col} > ${after}`);
  for (;;) {
    const page = await db.all<{ k: string }>(sql`select distinct lower(from_address) as k from messages where ${received} and ${past(sql`lower(from_address)`)} order by 1 limit ${perPage}`);
    if (!page.length) return { done: true, sender: after };
    const last = page[page.length - 1].k;
    await db.run(sql`update messages set first_of_sender = 1 where first_of_sender = 0 and id in (
      select (select p.id from messages p where p.mailbox_id = ${box} and lower(p.from_address) = s.k and p.folder <> 'sent' and p.folder <> 'drafts' order by p.date, p.id limit 1)
      from (select distinct lower(from_address) as k from messages where ${received} and ${past(sql`lower(from_address)`)} and lower(from_address) <= ${last}) s)`);
    after = last;
    if (page.length < perPage) return { done: true, sender: after };
    if (Date.now() >= deadline) return { done: false, sender: after };
  }
}

/**
 * One maintenance step: fills first_of_sender mailbox by mailbox (at most `mailboxesPerPass`, stopping after
 * `budgetMs`), writing the mark after each one, so no progress is lost. F4: a mailbox whose fill fails is set aside
 * instead of stopping the others; the fill is never marked done while one is unfilled. W2: it is tried again after a
 * growing wait, after the new mailboxes, and reported once when it has failed FILL_MAX_TRIES times.
 */
export async function fillFirstSender(deps: Deps, opts: { mailboxesPerPass?: number; sendersPerPage?: number; budgetMs?: number } = {}): Promise<{ filled: number; done: boolean }> {
  if (ready) return { filled: 0, done: true };
  const { db } = deps;
  const perPass = opts.mailboxesPerPass ?? 25;
  const perPage = opts.sendersPerPage ?? 200;
  const deadline = Date.now() + (opts.budgetMs ?? 5_000);
  const raw = (await db.select({ v: appSettings.value }).from(appSettings).where(eq(appSettings.key, FIRST_SENDER_KEY)).get())?.v;
  if (raw === DONE) { ready = true; return { filled: 0, done: true }; }
  const mark = readMark(raw);
  const save = async () => {
    const value = JSON.stringify(mark);
    await db.insert(appSettings).values({ key: FIRST_SENDER_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  };
  let filled = 0;
  let tried = 0;
  const now = deps.now().getTime();
  /** Fills one mailbox from `from`; false when the pass should stop (out of time). */
  const one = async (box: string, from: string | null): Promise<boolean> => {
    tried++;
    const before = mark.retry.find((r) => r.box === box);
    mark.retry = mark.retry.filter((r) => r.box !== box);
    try {
      const r = await fillMailbox(db, box, from, perPage, deadline);
      if (r.done) { filled++; if (mark.at?.box === box) mark.at = undefined; }
      // W1: a mailbox stopped by the deadline is the one half filled (`at`), resumed from its last sender next pass,
      // whether it came new or from the retry list; it is no longer on the retry list, so it never restarts from the top.
      else mark.at = { box, sender: r.sender };
    } catch (err) {
      if (mark.at?.box === box) mark.at = undefined;
      const tries = (before?.tries ?? 0) + 1;
      mark.retry.push({ box, tries, next: now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (tries - 1)) });
      deps.log?.warn("first_sender.fill_failed", { mailbox: box, tries, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      // W2: reported once, when it is parked, not on every pass.
      if (tries === FILL_MAX_TRIES) deps.reportError?.(err, { where: "first_sender.fill", mailbox: box, parked: true });
    }
    if (box > mark.after && mark.at?.box !== box) mark.after = box;
    await save();
    return Date.now() < deadline && mark.at === undefined;
  };
  // W1, W2: the one left half filled first (from where it stopped), then new mailboxes, then failed ones that are due,
  // so mailboxes that keep failing never use up the pass before new ones get theirs.
  if (mark.at && (tried >= perPass || !(await one(mark.at.box, mark.at.sender)))) return { filled, done: false };
  for (;;) {
    const next = await db.select({ id: mailboxes.id }).from(mailboxes).where(mark.after ? gt(mailboxes.id, mark.after) : undefined).orderBy(asc(mailboxes.id)).limit(1).get();
    if (!next) break;
    if (tried >= perPass || !(await one(next.id, null))) return { filled, done: false };
  }
  for (const r of [...mark.retry].filter((x) => x.next <= now).sort((a, b) => a.next - b.next)) {
    if (tried >= perPass || !(await one(r.box, null))) return { filled, done: false };
  }
  // Never done while a mailbox is unfilled: the old window stays in use meanwhile, so counts stay right.
  if (mark.retry.length || mark.at) return { filled, done: false };
  await db.insert(appSettings).values({ key: FIRST_SENDER_KEY, value: DONE }).onConflictDoUpdate({ target: appSettings.key, set: { value: DONE } });
  ready = true;
  return { filled, done: true };
}
