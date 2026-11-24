/**
 * Round 2: replay protection for signed webhooks. A provider's signature proves who sent a request, not that it is the
 * first time it arrives: a captured request still verifies for the whole signature window (5 minutes). Each handler
 * notes the delivery's id here after the signature check and before doing anything; a second arrival of the same id is
 * answered 200 ("already handled") without running again.
 *
 * Retries: a provider that retries a failed delivery sends the same id again, so a handler whose work failed calls
 * releaseReceipt, and the retry runs. Cost: one row written per delivery (WITHOUT ROWID), deleted by the maintenance
 * pass once older than RECEIPT_KEPT_MS. Stripe and agent run hooks keep their own ids; WhatsApp and Messenger dedupe
 * on the message id.
 */
import { and, eq, lt } from "drizzle-orm";
import type { DB } from "../db";
import { webhookReceipts } from "../db/schema";

export type ReceiptSource = "supabase_hook" | "resend" | "cloudflare_inbound" | "tiktok";

/** Longer than every signature window the handlers accept (5 minutes), so a replay can't outlive its receipt. */
export const RECEIPT_KEPT_MS = 10 * 60_000;

/** True the first time this source and id arrive; false for a replay. One insert, nothing else. */
export async function firstReceipt(db: DB, source: ReceiptSource, id: string, now: Date): Promise<boolean> {
  const rows = await db.insert(webhookReceipts).values({ source, receiptId: id.slice(0, 200), at: now }).onConflictDoNothing().returning({ id: webhookReceipts.receiptId });
  return rows.length > 0;
}

/** Forgets a receipt whose work failed, so the provider's retry with the same id runs. Never throws. */
export async function releaseReceipt(db: DB, source: ReceiptSource, id: string): Promise<void> {
  try { await db.delete(webhookReceipts).where(and(eq(webhookReceipts.source, source), eq(webhookReceipts.receiptId, id.slice(0, 200)))); } catch { /* the retry is answered "already handled"; rare */ }
}

/** The maintenance sweep: receipts older than RECEIPT_KEPT_MS. Returns how many went. */
export async function pruneWebhookReceipts(db: DB, now: Date): Promise<number> {
  const gone = await db.delete(webhookReceipts).where(lt(webhookReceipts.at, new Date(now.getTime() - RECEIPT_KEPT_MS))).returning({ id: webhookReceipts.receiptId });
  return gone.length;
}
