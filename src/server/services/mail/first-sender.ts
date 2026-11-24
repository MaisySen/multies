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
import { asc, eq, gt, sql } from "drizzle-orm";
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
 * One maintenance step: fills first_of_sender for up to `mailboxesPerPass` mailboxes (and stops early after
 * `budgetMs`), then moves the mark. Writes only rows whose flag changes, plus the mark.
 */
export async function fillFirstSender(deps: Deps, opts: { mailboxesPerPass?: number; budgetMs?: number } = {}): Promise<{ filled: number; done: boolean }> {
  if (ready) return { filled: 0, done: true };
  const { db } = deps;
  const perPass = opts.mailboxesPerPass ?? 25;
  const budget = opts.budgetMs ?? 5_000;
  const mark = (await db.select({ v: appSettings.value }).from(appSettings).where(eq(appSettings.key, FIRST_SENDER_KEY)).get())?.v ?? "";
  if (mark === DONE) { ready = true; return { filled: 0, done: true }; }
  const boxes = await db.select({ id: mailboxes.id }).from(mailboxes).where(mark ? gt(mailboxes.id, mark) : undefined).orderBy(asc(mailboxes.id)).limit(perPass);
  const started = Date.now();
  let last = mark;
  let filled = 0;
  for (const b of boxes) {
    await db.run(sql`update messages set first_of_sender = 1 where first_of_sender = 0 and id in (
      select f.id from (select p.id, row_number() over (partition by lower(p.from_address) order by p.date, p.id) as rn
        from messages p where p.mailbox_id = ${b.id} and p.folder <> 'sent' and p.folder <> 'drafts') f where f.rn = 1)`);
    last = b.id;
    filled++;
    if (Date.now() - started >= budget) break;
  }
  const done = filled === boxes.length && boxes.length < perPass;
  const value = done ? DONE : last;
  if (value && value !== mark) await db.insert(appSettings).values({ key: FIRST_SENDER_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  if (done) ready = true;
  return { filled, done };
}
