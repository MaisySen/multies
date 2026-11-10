/**
 * R34 (MB-166, MB-169): the outbound send guard. Three checks on mail a person sends, after the plan's daily cap:
 *
 *  1. Kill switch: an operator sets a workspace's sending off (sendCapDaily = 0, the operator console's "Sending off"
 *     toggle or PUT /api/admin/workspaces/:id/sending). Sends are refused with a clear message; nothing is queued.
 *  2. Growing limit: a new workspace may send to `newSenderDaily` outside recipients a day (20) for its first
 *     `newSenderDays` (7). After that the plan's cap applies, unless the last 7 days had more than 4% bounces or any
 *     spam complaint, which keeps it at the new sender limit.
 *  3. Shared sender headroom: the sending account's daily allowance (`providerDailyCap`, 100) is shared by every
 *     workspace, Multies' own sign-in mail and another product. Person mail stops at `holdAt` (90) for the day, so
 *     sign-in codes and password resets (system mail, which never comes through here) always have room.
 *
 * Over a cap is never a silent drop: the message is queued until midnight UTC as a scheduled send with the reason
 * (Outbox shows "Queued until tomorrow" and why); an operator can send it anyway.
 *
 * Reads only: the counts are COUNT queries over the delivery rows the send already writes (no counter row, so no
 * extra D1 write per send).
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { deliveries } from "../../db/schema";

export interface SendGuardConfig { providerDailyCap: number; holdAt: number; newSenderDaily: number; newSenderDays: number }
export const SEND_GUARD_DEFAULTS: SendGuardConfig = { providerDailyCap: 100, holdAt: 90, newSenderDaily: 20, newSenderDays: 7 };
export const guardConfig = (deps: Deps): SendGuardConfig => ({ ...SEND_GUARD_DEFAULTS, ...(deps.config as { sendGuard?: Partial<SendGuardConfig> }).sendGuard });

export const SENDING_OFF_MESSAGE = "Sending is turned off for this workspace. Write to contact@fintex.au and we'll look at it with you.";

/** Midnight UTC after `now`: when a queued send goes. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
const dayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** The kill switch: an operator cap of 0 means sending is off. */
export const sendingOff = (org: { sendCapDaily: number | null }) => org.sendCapDaily === 0;

/**
 * The growing limit for outside recipients, or null when the plan's cap applies. `recent` is the last 7 days of
 * outbound delivery rows (services/abuse.ts recentOutboundStats).
 */
export function newSenderCap(cfg: SendGuardConfig, ageDays: number, recent: { sent: number; bounced: number; complained: number }): number | null {
  if (cfg.newSenderDaily <= 0) return null;
  if (ageDays < cfg.newSenderDays) return cfg.newSenderDaily;
  const dirty = recent.complained > 0 || (recent.sent >= 20 && recent.bounced / recent.sent > 0.04);
  return dirty ? cfg.newSenderDaily : null;
}

/** Outside recipients this workspace sent to today (UTC). */
export async function externalSentToday(deps: Deps, orgId: string): Promise<number> {
  const row = await deps.db.select({ n: sql<number>`count(*)` }).from(deliveries).where(and(
    eq(deliveries.orgId, orgId), eq(deliveries.direction, "outbound"), eq(deliveries.provider, deps.outbound.name),
    inArray(deliveries.status, ["sent", "queued", "delivered", "delayed", "forwarded"]), // PRIV1b (P39): alias forwards are outside mail too
    gte(deliveries.createdAt, dayStart(deps.now())),
  )).get();
  return Number(row?.n ?? 0);
}

/** Everything the shared sending account sent today, every workspace and system mail included. */
export async function providerSentToday(deps: Deps): Promise<number> {
  const row = await deps.db.select({ n: sql<number>`count(*)` }).from(deliveries).where(and(
    eq(deliveries.direction, "outbound"), eq(deliveries.provider, deps.outbound.name),
    inArray(deliveries.status, ["sent", "queued", "delivered", "delayed", "forwarded"]), gte(deliveries.createdAt, dayStart(deps.now())),
  )).get();
  return Number(row?.n ?? 0);
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string; kind: "plan_cap" | "new_sender" | "headroom" };

/** The pure decision, for tests and the send path. */
export function decide(i: {
  cfg: SendGuardConfig; used: number; cap: number; recipients: number; external: number; externalUsed: number;
  newCap: number | null; providerUsed: number; underReview: boolean;
}): GuardVerdict {
  if (i.used + i.recipients > i.cap) {
    return { ok: false, kind: "plan_cap", reason: i.underReview
      ? `This workspace can send to ${i.cap} recipients a day while its sending is under review. Queued until tomorrow.`
      : `Daily sending limit reached (${i.cap} recipients a day). Queued until tomorrow.` };
  }
  if (i.external && i.newCap !== null && i.externalUsed + i.external > i.newCap) {
    return { ok: false, kind: "new_sender", reason: `New workspaces send to ${i.newCap} outside recipients a day for their first week. The limit grows once your mail has a clean record. Queued until tomorrow.` };
  }
  if (i.external && i.cfg.providerDailyCap > 0 && i.providerUsed + i.external > i.cfg.holdAt) {
    return { ok: false, kind: "headroom", reason: "Outside sending is at its limit for today. Queued until tomorrow, and it goes first thing." };
  }
  return { ok: true };
}
