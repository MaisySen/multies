/**
 * R32: web push to browsers. A browser opts in from Settings, Notifications; its subscription is
 * stored here and the same events that buzz a phone (pushToUsers) also reach the person's browsers.
 * Per type settings apply before this is called (notify checks the category's "push" switch).
 * Off unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { webPushSubscriptions } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import { buildWebPushRequest, isAllowedEndpoint } from "../../lib/web-push";
import { sortableId } from "./common";
import { deferrableWrite } from "../write-priority";

/** Browsers per person; the oldest goes when a new one joins past this. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
/** Failed sends in a row before a subscription is dropped. */
export const MAX_FAILURES = 5;
/** last_ok_at is written at most this often per subscription (D1 writes are budgeted). */
export const LAST_OK_EVERY_MS = 60 * 60_000;

export interface WebPushEvent { type: string; id: string; mid?: string; title?: string }

export function webPushEnabled(deps: Deps): boolean {
  return !!deps.config.webPush;
}

/**
 * D1 write budget: saving or removing a subscription is ESSENTIAL (the person asked for it, one row, rare).
 * It must go through even when the daily write meter holds back non-essential writes.
 */
export async function saveSubscription(deps: Deps, auth: { userId: string; orgId: string }, input: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string }) {
  if (!deps.config.webPush) throw new HttpError(409, "web_push_off", "Browser notifications aren't set up on this server.");
  if (!isAllowedEndpoint(input.endpoint)) throw new HttpError(422, "invalid_endpoint", "That isn't a browser push address.");
  const now = deps.now();
  const existing = await deps.db.select({ id: webPushSubscriptions.id }).from(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, input.endpoint)).get();
  const id = existing?.id ?? sortableId("wps", now.getTime());
  await deps.db.insert(webPushSubscriptions).values({ id, orgId: auth.orgId, userId: auth.userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: input.userAgent?.slice(0, 200) ?? null, createdAt: now, failures: 0 })
    .onConflictDoUpdate({ target: webPushSubscriptions.endpoint, set: { orgId: auth.orgId, userId: auth.userId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: input.userAgent?.slice(0, 200) ?? null, failures: 0 } });
  // Keep the newest few browsers per person.
  const rows = await deps.db.select({ id: webPushSubscriptions.id }).from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, auth.userId)).orderBy(sql`${webPushSubscriptions.createdAt} desc`, sql`${webPushSubscriptions.id} desc`);
  const extra = rows.slice(MAX_SUBSCRIPTIONS_PER_USER).map((r) => r.id);
  if (extra.length) await deps.db.delete(webPushSubscriptions).where(inIds(webPushSubscriptions.id, extra));
  return { ok: true, id };
}

export async function deleteSubscription(deps: Deps, auth: { userId: string }, endpoint: string) {
  await deps.db.delete(webPushSubscriptions).where(and(eq(webPushSubscriptions.endpoint, endpoint), eq(webPushSubscriptions.userId, auth.userId)));
  return { ok: true };
}

export async function listSubscriptions(deps: Deps, auth: { userId: string; orgId: string }) {
  const rows = await deps.db.select().from(webPushSubscriptions).where(and(eq(webPushSubscriptions.userId, auth.userId), eq(webPushSubscriptions.orgId, auth.orgId)));
  // The endpoint is a capability for that browser: show only its host.
  return rows.map((r) => ({ id: r.id, host: safeHost(r.endpoint), userAgent: r.userAgent, createdAt: r.createdAt.toISOString(), lastOkAt: r.lastOkAt?.toISOString() ?? null }));
}

function safeHost(endpoint: string) {
  try { return new URL(endpoint).host; } catch { return ""; }
}

const DEFAULT_TITLES: Record<string, string> = {
  "message.received": "New mail",
  thread_mention: "You were mentioned on a thread",
  "task.assigned": "A task was assigned to you",
  "chat.mention": "You were mentioned in chat",
};

/** The path a click opens. Mirrors linkFor in notify.ts for the types phones also get. */
export function webPushUrl(e: WebPushEvent): string {
  const id = encodeURIComponent(e.id);
  if (e.type === "message.received") return `/app/mail?m=${id}`;
  if (e.type === "thread_mention") return e.mid ? `/app/inbox?thread=${id}&m=${encodeURIComponent(e.mid)}` : `/app/inbox?thread=${id}`;
  if (e.type.startsWith("task") || e.type.startsWith("comment")) return `/app/tasks?task=${id}`;
  if (e.type.startsWith("chat")) return "/app/chat";
  if (e.type.startsWith("approval")) return "/app/approvals";
  if (e.type.startsWith("meeting")) return `/app/meetings/${id}`;
  if (e.type.startsWith("goal")) return `/app/goals?goal=${id}`;
  return "/app/notifications";
}

/** What a browser receives: no message text, only a title, what to open, and a tag so a thread's alerts stack. */
export function webPushPayload(e: WebPushEvent) {
  return {
    type: e.type,
    id: e.id,
    ...(e.mid ? { mid: e.mid } : {}),
    title: (e.title?.trim() || DEFAULT_TITLES[e.type] || "Multies").slice(0, 120),
    body: "Open in Multies",
    url: webPushUrl(e),
    tag: `${e.type.split(".")[0]}:${e.id}`.slice(0, 64),
  };
}

/** Sends to every browser these people subscribed. Never throws; each failure is counted on its row. */
export async function webPushToUsers(deps: Deps, orgId: string, userIds: string[], event: WebPushEvent, timeoutMs = 3000) {
  const keys = deps.config.webPush;
  if (!keys || !userIds.length) return { sent: 0, removed: 0, failed: 0 };
  const subs = await deps.db.select().from(webPushSubscriptions).where(and(eq(webPushSubscriptions.orgId, orgId), inIds(webPushSubscriptions.userId, [...new Set(userIds)])));
  if (!subs.length) return { sent: 0, removed: 0, failed: 0 };
  const payload = webPushPayload(event);
  const now = deps.now();
  const gone: string[] = [];
  const okStale: string[] = [];
  const failed: { id: string; failures: number }[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      const req = await buildWebPushRequest(s, payload, keys, { topic: payload.tag.replace(/[^A-Za-z0-9]/g, ""), urgency: "normal" });
      const res = await deps.fetch(req.url, { ...req.init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404 || res.status === 410) gone.push(s.id);
      else if (res.ok) { if (s.failures > 0 || !s.lastOkAt || now.getTime() - s.lastOkAt.getTime() > LAST_OK_EVERY_MS) okStale.push(s.id); }
      else failed.push({ id: s.id, failures: s.failures + 1 });
    } catch {
      failed.push({ id: s.id, failures: s.failures + 1 });
    }
  }));
  // D1 write budget: everything below is DEFERRABLE bookkeeping per send (last_ok_at, failure counts).
  // Nothing here is a per-send log row; last_ok_at is written at most hourly per browser, and when the write
  // meter holds back non-essential writes these wait for a later send. The push itself costs no D1 write.
  const drop = [...gone, ...failed.filter((f) => f.failures >= MAX_FAILURES).map((f) => f.id)];
  if (drop.length) await deps.db.delete(webPushSubscriptions).where(inIds(webPushSubscriptions.id, drop));
  // Bookkeeping goes through the write meter (services/write-priority.ts): coalesced near the daily budget,
  // skipped when writes are being shed. Dropping a dead endpoint above stays: it saves every later send.
  if (okStale.length) await deferrableWrite(deps, "last_used", `webpush-ok:${okStale.join(",")}`, () => deps.db.update(webPushSubscriptions).set({ lastOkAt: now, failures: 0 }).where(inIds(webPushSubscriptions.id, okStale)));
  const bump = failed.filter((f) => f.failures < MAX_FAILURES).map((f) => f.id);
  if (bump.length) await deferrableWrite(deps, "last_used", `webpush-fail:${bump.join(",")}:${now.getTime()}`, () => deps.db.update(webPushSubscriptions).set({ failures: sql`${webPushSubscriptions.failures} + 1` }).where(inIds(webPushSubscriptions.id, bump)));
  return { sent: subs.length - gone.length - failed.length, removed: drop.length, failed: failed.length };
}
