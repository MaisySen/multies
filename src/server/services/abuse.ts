/**
 * Outbound abuse controls: a transparent, rule-based spam score for each message a
 * workspace sends to outside addresses, plus operator actions (suspend, send caps).
 *
 * Scores (sum of rule points):
 *   0 to 5   sent normally
 *   6 to 9   sent, and flagged for operator review in the abuse queue
 *   10 and up held: not sent, the sender sees why, and the event is flagged
 * A new workspace with three held messages in a day is suspended automatically until
 * an operator reviews it. Rules follow common filter signals (SpamAssassin style)
 * and the Spam Act 2003: bulk commercial mail needs an unsubscribe option.
 */
import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import type { Deps } from "../context";
import { abuseEvents, deliveries, organizations } from "../db/schema";
import { newId } from "../lib/crypto";

export const SPAM_FLAG_AT = 6;
export const SPAM_HOLD_AT = 10;

const PHRASES = [
  "viagra", "cialis", "casino", "lottery", "you have won", "winner", "act now", "100% free", "risk free", "risk-free",
  "click here", "limited time offer", "wire transfer", "bitcoin giveaway", "crypto giveaway", "double your", "guaranteed income",
  "make money fast", "work from home and earn", "verify your account immediately", "your account will be suspended", "nigerian prince",
];
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|cutt\.ly|rebrand\.ly|shorturl\.at)\//i;

export interface ScoreInput {
  subject: string;
  text: string;
  html?: string;
  recipients: number;
  workspaceAgeDays: number;
  /** Outbound deliveries and their bounce and complaint counts over the last 7 days. */
  recent: { sent: number; bounced: number; complained: number };
}

export interface Score { score: number; reasons: string[] }

export function scoreOutbound(i: ScoreInput): Score {
  const reasons: string[] = [];
  let score = 0;
  const add = (pts: number, why: string) => { score += pts; reasons.push(`${why} (+${pts})`); };
  const body = `${i.text}\n${i.html ?? ""}`;
  const lower = `${i.subject}\n${body}`.toLowerCase();

  if (i.recipients > 50) add(3, "more than 50 recipients in one message");
  else if (i.recipients > 20) add(1, "more than 20 recipients in one message");
  if (i.workspaceAgeDays < 3 && i.recipients > 10) add(3, "new workspace sending to many people");

  const letters = i.subject.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 10 && letters === letters.toUpperCase()) add(2, "subject in capitals");
  if (/!{3,}/.test(i.subject + i.text)) add(1, "repeated exclamation marks");

  const hits = PHRASES.filter((p) => lower.includes(p));
  if (hits.length) add(Math.min(6, hits.length * 2), `spam phrases: ${hits.slice(0, 3).join(", ")}`);

  const links = body.match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
  if (links.length > 10) add(2, "more than 10 links");
  if (links.some((l) => SHORTENERS.test(`${l}/`))) add(2, "link shortener");
  if (i.html && mismatchedLinks(i.html)) add(3, "link text shows a different site than the link goes to");

  if (i.recipients > 20 && !/unsubscribe|opt out|opt-out/i.test(body)) add(2, "bulk message without an unsubscribe option (Spam Act 2003)");

  if (i.recent.sent >= 20 && i.recent.bounced / i.recent.sent > 0.1) add(3, "high bounce rate this week");
  if (i.recent.complained > 0) add(2, "spam complaints this week");
  return { score, reasons };
}

/** True when an anchor's visible text is a URL on a different host than its href. */
export function mismatchedLinks(html: string): boolean {
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    const shown = text.match(/^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?:[/\s]|$)/i)?.[1];
    if (!shown) continue;
    try {
      const real = new URL(m[1]).hostname.toLowerCase();
      const s = shown.toLowerCase();
      if (real !== s && !real.endsWith(`.${s}`) && !s.endsWith(`.${real}`)) return true;
    } catch { /* not an absolute URL */ }
  }
  return false;
}

export async function recentOutboundStats(deps: Deps, orgId: string) {
  const since = new Date(deps.now().getTime() - 7 * 86_400_000);
  const row = await deps.db.select({
    sent: sql<number>`count(*)`,
    bounced: sql<number>`sum(case when ${deliveries.status} = 'bounced' then 1 else 0 end)`,
    complained: sql<number>`sum(case when ${deliveries.status} = 'complained' then 1 else 0 end)`,
  }).from(deliveries).where(and(eq(deliveries.orgId, orgId), eq(deliveries.direction, "outbound"), gte(deliveries.createdAt, since))).get();
  return { sent: Number(row?.sent ?? 0), bounced: Number(row?.bounced ?? 0), complained: Number(row?.complained ?? 0) };
}

export async function recordAbuse(deps: Deps, orgId: string, kind: string, score: number, detail: string) {
  await deps.db.insert(abuseEvents).values({ id: newId("abu"), orgId, kind, score, detail, createdAt: deps.now() });
}

/** Suspends a new workspace that keeps tripping the hold threshold. Returns true when it did. */
export async function maybeAutoSuspend(deps: Deps, orgId: string, workspaceAgeDays: number): Promise<boolean> {
  if (workspaceAgeDays >= 7) return false;
  const since = new Date(deps.now().getTime() - 86_400_000);
  const held = await deps.db.select({ n: count() }).from(abuseEvents)
    .where(and(eq(abuseEvents.orgId, orgId), eq(abuseEvents.kind, "outbound_held"), gte(abuseEvents.createdAt, since))).get();
  if ((held?.n ?? 0) < 3) return false;
  await deps.db.update(organizations).set({ suspendedAt: deps.now(), suspendedReason: "Automatic: repeated messages held by the spam filter. An operator will review it." })
    .where(and(eq(organizations.id, orgId), isNull(organizations.suspendedAt)));
  await recordAbuse(deps, orgId, "auto_suspended", held?.n ?? 0, "Three or more held messages within 24 hours on a workspace under 7 days old.");
  deps.log?.warn("abuse.auto_suspended", { org: orgId });
  return true;
}
