/**
 * R32: which D1 writes can wait when the account's daily write budget runs low (services/write-budget.ts).
 *
 *   essential   mail delivery and sending, sign in and sessions, the tasks, messages and docs people make,
 *               billing and plan counters, audit rows. Never refused or delayed here on production.
 *   deferrable  bookkeeping a person does not lose by missing: page and item visits (catch up "last seen"),
 *               read markers set by opening something, notification read marks, last used and last seen
 *               touches on keys and guests. Each call site names its kind below.
 *
 * Levels (from the account wide analytics reading, cached per isolate):
 *   ok / off    deferrable writes go through as before
 *   warn (60%)  coalesced: at most one write per kind and item every 15 minutes (per isolate), for the
 *               bookkeeping nobody sees change (visits, last used, last seen). Read state a person sees
 *               (chat and mail read on open, notification read marks) still writes at warn: a channel that
 *               stays bold after you read it is a visible bug, and these already write only on a change.
 *   shed (85%)  skipped: the caller answers success and nothing is written
 *
 * Staging's strict mode (WRITE_BUDGET_GUARD=strict) still refuses every API write from 60%, in app.ts.
 */
import type { Deps } from "../context";
import { writeBudget, type WriteBudgetLevel } from "./write-budget";

export type DeferrableKind =
  | "item_visit"      // catch up "last visit" rows (item_visits)
  | "chat_read"       // chat read marker set by opening a channel (chat_members.last_read_at)
  | "mail_read_on_open" // a thread marked read because it was opened (not the Mark read action)
  | "notification_read" // notification read marks
  | "last_used"       // last used times on API keys, inbound keys, OAuth grants, auth email hooks
  | "last_seen";      // last seen times on project guests

export const DEFERRABLE_KINDS: readonly DeferrableKind[] = ["item_visit", "chat_read", "mail_read_on_open", "notification_read", "last_used", "last_seen"];

/** Kinds coalesced at warn; the read state kinds write at warn and are skipped only at shed. */
export const COALESCED_AT_WARN: ReadonlySet<DeferrableKind> = new Set<DeferrableKind>(["item_visit", "last_used", "last_seen"]);

/** At warn, one write per kind and item in this window. */
export const COALESCE_MS = 15 * 60_000;
const MAX_KEYS = 5_000;
const lastWrite = new Map<string, number>();
const counts = { written: 0, coalesced: 0, skipped: 0 };

/** Test hook. */
export function resetWritePriority() { lastWrite.clear(); counts.written = counts.coalesced = counts.skipped = 0; }

/** What this isolate did with deferrable writes since it started (shown on /api/health as writes.deferred). */
export function deferredCounts() { return { ...counts }; }

export type DeferrableOutcome = "written" | "coalesced" | "skipped";

/** The decision alone, for callers that fold the write into a larger statement. */
export function decideDeferrable(level: WriteBudgetLevel, kind: DeferrableKind, itemKey: string, nowMs: number): DeferrableOutcome {
  if (level === "shed") return "skipped";
  if (level !== "warn" || !COALESCED_AT_WARN.has(kind)) return "written";
  const key = `${kind}:${itemKey}`;
  const last = lastWrite.get(key);
  if (last !== undefined && nowMs - last < COALESCE_MS) return "coalesced";
  if (lastWrite.size >= MAX_KEYS) lastWrite.clear();
  lastWrite.set(key, nowMs);
  return "written";
}

/**
 * Runs a deferrable write unless the budget says it should wait. Never throws for the budget: the caller
 * answers success either way. `itemKey` names the thing written (user and item), so coalescing is per item.
 */
export async function deferrableWrite(deps: Deps, kind: DeferrableKind, itemKey: string, write: () => Promise<unknown>): Promise<DeferrableOutcome> {
  const { level } = await writeBudget(deps);
  const outcome = decideDeferrable(level, kind, itemKey, deps.now().getTime());
  counts[outcome] += 1;
  if (outcome === "written") await write();
  else deps.log?.info("d1.write_deferred", { kind, outcome, level });
  return outcome;
}
