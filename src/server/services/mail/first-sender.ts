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
 * sender (lower case) done in it. `retry`: mailboxes whose fill failed, tried again first on the next pass. The fill
 * is "done" only when no mailbox is left, none is half filled and none waits to be tried again.
 */
interface FillMark { after: string; at?: { box: string; sender: string | null }; retry: string[] }

function readMark(v: string | undefined): FillMark {
  if (!v) return { after: "", retry: [] };
  try {
    const o = JSON.parse(v) as Partial<FillMark>;
    if (o && typeof o === "object") return { after: typeof o.after === "string" ? o.after : "", at: o.at, retry: Array.isArray(o.retry) ? o.retry.filter((x): x is string => typeof x === "string") : [] };
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
 * `budgetMs`), writing the mark after each one, so no progress is lost. F4: a mailbox whose fill fails is reported and
 * set aside for the next pass instead of stopping the others; the fill is never marked done while one is unfilled.
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
  /** Fills one mailbox from `from`; false when the pass should stop (out of time). */
  const one = async (box: string, from: string | null): Promise<boolean> => {
    tried++;
    try {
      const r = await fillMailbox(db, box, from, perPage, deadline);
      if (r.done) { filled++; mark.retry = mark.retry.filter((x) => x !== box); if (mark.at?.box === box) mark.at = undefined; }
      else mark.at = { box, sender: r.sender };
    } catch (err) {
      deps.log?.warn("first_sender.fill_failed", { mailbox: box, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      deps.reportError?.(err, { where: "first_sender.fill" });
      if (mark.at?.box === box) mark.at = undefined;
      if (!mark.retry.includes(box)) mark.retry.push(box);
    }
    if (box > mark.after && mark.at?.box !== box) mark.after = box;
    await save();
    return Date.now() < deadline && mark.at === undefined;
  };
  // Mailboxes set aside on an earlier pass first, each tried once a pass, then the one left half filled, then new ones.
  for (const box of [...mark.retry]) {
    if (tried >= perPass || !(await one(box, null))) return { filled, done: false };
  }
  if (mark.at && (tried >= perPass || !(await one(mark.at.box, mark.at.sender)))) return { filled, done: false };
  for (;;) {
    const next = await db.select({ id: mailboxes.id }).from(mailboxes).where(mark.after ? gt(mailboxes.id, mark.after) : undefined).orderBy(asc(mailboxes.id)).limit(1).get();
    if (!next) break;
    if (tried >= perPass || !(await one(next.id, null))) return { filled, done: false };
  }
  if (mark.retry.length) return { filled, done: false }; // one failed on this pass: never done while it is unfilled
  await db.insert(appSettings).values({ key: FIRST_SENDER_KEY, value: DONE }).onConflictDoUpdate({ target: appSettings.key, set: { value: DONE } });
  ready = true;
  return { filled, done: true };
}
