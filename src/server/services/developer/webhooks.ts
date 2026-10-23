/**
 * Outbound webhooks, signed with the Standard Webhooks spec (standardwebhooks.com)
 * using its reference library, so receivers can verify with any Standard Webhooks SDK.
 */
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import type { Deps } from "../../context";
import { members, users, webhookDeliveries, webhookEndpoints } from "../../db/schema";
import { sendSystemEmail } from "../system-mail";
import { decryptSecret, encryptSecret, newId, randomBytes, toB64 } from "../../lib/crypto";
import { badRequest, conflict, notFound } from "../../lib/errors";

export const WEBHOOK_EVENTS = [
  "message.received",
  "message.sent",
  "message.bounced",
  "message.complained",
  "domain.verified",
  "domain.failed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const MAX_ENDPOINTS = 10;
/** Delay before attempt n+1, after n failures. Six attempts over about nine hours. */
export const RETRY_SCHEDULE_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
const TIMEOUT_MS = 5_000;

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|.*\.internal$|.*\.local$)/i;

export function validateEndpointUrl(deps: Deps, raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw badRequest("Enter a full URL, like https://example.com/webhooks/mymail."); }
  const dev = deps.config.mode === "development";
  if (u.protocol !== "https:" && !(dev && u.protocol === "http:")) throw badRequest("Webhook URLs must use https.");
  if (!dev && PRIVATE_HOST.test(u.hostname)) throw badRequest("Webhook URLs must point to a public address.");
  if (u.username || u.password) throw badRequest("Put credentials in your receiver, not in the URL.");
  return u.toString();
}

export function presentEndpoint(e: typeof webhookEndpoints.$inferSelect) {
  return { id: e.id, url: e.url, description: e.description, events: JSON.parse(e.events) as string[], enabled: e.enabled, disabledReason: e.disabledReason, createdAt: e.createdAt };
}

export async function listEndpoints(deps: Deps, orgId: string) {
  return (await deps.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.orgId, orgId)).orderBy(asc(webhookEndpoints.createdAt))).map(presentEndpoint);
}

async function endpointInOrg(deps: Deps, orgId: string, id: string) {
  const e = await deps.db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.orgId, orgId))).get();
  if (!e) throw notFound("Webhook endpoint");
  return e;
}

export async function createEndpoint(deps: Deps, orgId: string, input: { url: string; events: string[]; description?: string }) {
  const count = (await deps.db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(eq(webhookEndpoints.orgId, orgId))).length;
  if (count >= MAX_ENDPOINTS) throw conflict(`A workspace can have up to ${MAX_ENDPOINTS} webhook endpoints.`);
  const url = validateEndpointUrl(deps, input.url);
  const secret = `whsec_${toB64(randomBytes(24))}`;
  const id = newId("whe");
  await deps.db.insert(webhookEndpoints).values({
    id, orgId, url, description: input.description ?? null, events: JSON.stringify(input.events),
    secretEnc: await encryptSecret(deps.config.appSecret, secret),
  });
  return { endpoint: presentEndpoint(await endpointInOrg(deps, orgId, id)), secret };
}

export async function updateEndpoint(deps: Deps, orgId: string, id: string, patch: { url?: string; events?: string[]; enabled?: boolean; description?: string | null }) {
  const e = await endpointInOrg(deps, orgId, id);
  await deps.db.update(webhookEndpoints).set({
    ...(patch.url !== undefined ? { url: validateEndpointUrl(deps, patch.url) } : {}),
    ...(patch.events !== undefined ? { events: JSON.stringify(patch.events) } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
  }).where(eq(webhookEndpoints.id, e.id));
  return presentEndpoint(await endpointInOrg(deps, orgId, id));
}

export async function deleteEndpoint(deps: Deps, orgId: string, id: string) {
  const e = await endpointInOrg(deps, orgId, id);
  await deps.db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, e.id));
  return presentEndpoint(e);
}

export async function endpointSecret(deps: Deps, orgId: string, id: string) {
  const e = await endpointInOrg(deps, orgId, id);
  return decryptSecret(deps.config.appSecret, e.secretEnc);
}

export async function listDeliveries(deps: Deps, orgId: string, endpointId: string, limit = 25) {
  await endpointInOrg(deps, orgId, endpointId);
  const rows = await deps.db.select().from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.orgId, orgId), eq(webhookDeliveries.endpointId, endpointId)))
    .orderBy(desc(webhookDeliveries.createdAt)).limit(Math.min(limit, 100));
  return rows.map((d) => ({
    id: d.id, eventType: d.eventType, status: d.status, attempts: d.attempts, responseStatus: d.responseStatus,
    lastError: d.lastError, nextAttemptAt: d.nextAttemptAt, deliveredAt: d.deliveredAt, createdAt: d.createdAt,
  }));
}

/** Sends one delivery attempt and records the outcome. */
async function attempt(deps: Deps, deliveryId: string) {
  const d = await deps.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).get();
  if (!d || d.status !== "pending") return;
  const e = await deps.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, d.endpointId)).get();
  if (!e) return;
  const secret = await decryptSecret(deps.config.appSecret, e.secretEnc);
  const now = deps.now();
  const signature = new Webhook(secret).sign(d.id, now, d.payload);
  let status: number | null = null;
  let error: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await deps.fetch(e.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "MyMail-Webhooks/1",
        "webhook-id": d.id,
        "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
        "webhook-signature": signature,
      },
      body: d.payload,
      signal: ctrl.signal,
      redirect: "manual",
    }).finally(() => clearTimeout(timer));
    status = res.status;
    if (res.status < 200 || res.status >= 300) error = `Receiver answered ${res.status}`;
  } catch (err) {
    error = (err as Error).name === "AbortError" ? `No answer within ${TIMEOUT_MS / 1000}s` : `Could not connect: ${(err as Error).message}`.slice(0, 300);
  }
  const attempts = d.attempts + 1;
  if (!error) {
    await deps.db.update(webhookDeliveries).set({ status: "delivered", attempts, responseStatus: status, lastError: null, nextAttemptAt: null, deliveredAt: now }).where(eq(webhookDeliveries.id, d.id));
    if (e.consecutiveDead) await deps.db.update(webhookEndpoints).set({ consecutiveDead: 0 }).where(eq(webhookEndpoints.id, e.id));
    return;
  }
  const delay = RETRY_SCHEDULE_MS[attempts - 1];
  const dead = delay === undefined;
  await deps.db.update(webhookDeliveries).set({
    status: dead ? "failed" : "pending", attempts, responseStatus: status, lastError: error,
    nextAttemptAt: dead ? null : new Date(now.getTime() + delay),
  }).where(eq(webhookDeliveries.id, d.id));
  if (dead && d.eventType !== "webhook.test") await onDeadLetter(deps, e, error);
}

/** Deliveries in a row that run out of retries before an endpoint is switched off. */
export const DISABLE_AFTER_DEAD = 5;

/**
 * Dead letter: the delivery stays in the log as failed (replayable from Settings,
 * Developers). An endpoint that keeps failing is disabled, as Stripe and Svix do,
 * and the workspace owners are emailed so they can fix it and switch it back on.
 */
async function onDeadLetter(deps: Deps, e: typeof webhookEndpoints.$inferSelect, error: string) {
  const n = e.consecutiveDead + 1;
  const disable = n >= DISABLE_AFTER_DEAD;
  await deps.db.update(webhookEndpoints).set({
    consecutiveDead: n,
    ...(disable ? { enabled: false, disabledReason: `Disabled after ${n} deliveries in a row failed every retry. Last error: ${error}` } : {}),
  }).where(eq(webhookEndpoints.id, e.id));
  deps.log?.warn("webhook.dead_letter", { endpoint: e.id, org: e.orgId, consecutive: n, disabled: disable });
  if (!disable) return;
  const owners = await deps.db.select({ email: users.email }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, e.orgId), inArray(members.role, ["owner", "admin"])));
  for (const o of owners) {
    await sendSystemEmail(deps, {
      to: o.email, orgId: e.orgId, template: "webhook-disabled",
      subject: `Webhook endpoint disabled: ${e.url}`,
      text: `We stopped sending events to ${e.url} because ${n} deliveries in a row failed after every retry.\n\nLast error: ${error}\n\nFix the endpoint, then switch it back on and replay the failed deliveries from Settings, Developers.`,
      action: { label: "Open developer settings", url: `${deps.config.appUrl}/app/settings/developers` },
    }).catch(() => undefined);
  }
}

/** Queues failed (dead-letter) deliveries for an endpoint to be sent again now. */
export async function replayFailed(deps: Deps, orgId: string, endpointId: string, deliveryIds?: string[]) {
  const e = await endpointInOrg(deps, orgId, endpointId);
  const rows = await deps.db.update(webhookDeliveries).set({ status: "pending", attempts: 0, nextAttemptAt: deps.now(), lastError: null })
    .where(and(eq(webhookDeliveries.endpointId, e.id), eq(webhookDeliveries.status, "failed"), deliveryIds?.length ? inArray(webhookDeliveries.id, deliveryIds) : undefined))
    .returning({ id: webhookDeliveries.id });
  if (!e.enabled) await deps.db.update(webhookEndpoints).set({ enabled: true, disabledReason: null, consecutiveDead: 0 }).where(eq(webhookEndpoints.id, e.id));
  await Promise.all(rows.slice(0, 20).map((r) => attempt(deps, r.id)));
  return rows.length;
}

/**
 * Records an event for every enabled endpoint subscribed to it and makes the first
 * attempt right away. Never throws: webhooks must not break the action behind them.
 */
export async function emitEvent(deps: Deps, orgId: string, type: WebhookEvent, data: Record<string, unknown>) {
  try {
    const endpoints = (await deps.db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.enabled, true))))
      .filter((e) => { const ev = JSON.parse(e.events) as string[]; return ev.includes("*") || ev.includes(type); });
    if (!endpoints.length) return [];
    const payload = JSON.stringify({ type, timestamp: deps.now().toISOString(), data });
    const ids: string[] = [];
    for (const e of endpoints) {
      const id = newId("msg");
      await deps.db.insert(webhookDeliveries).values({ id, orgId, endpointId: e.id, eventType: type, payload, nextAttemptAt: deps.now() });
      ids.push(id);
    }
    await Promise.all(ids.map((id) => attempt(deps, id)));
    return ids;
  } catch (err) {
    deps.reportError?.(err, { where: "emitEvent", type });
    return [];
  }
}

/** Sends a `webhook.test` event to one endpoint, regardless of its event filter. */
export async function sendTestEvent(deps: Deps, orgId: string, endpointId: string) {
  const e = await endpointInOrg(deps, orgId, endpointId);
  const id = newId("msg");
  const payload = JSON.stringify({ type: "webhook.test", timestamp: deps.now().toISOString(), data: { message: "Test event from MyMail. If you can read this, your endpoint works." } });
  await deps.db.insert(webhookDeliveries).values({ id, orgId, endpointId: e.id, eventType: "webhook.test", payload, nextAttemptAt: deps.now() });
  await attempt(deps, id);
  return (await listDeliveries(deps, orgId, e.id, 1))[0];
}

/** Retries deliveries whose next attempt is due. Called from maintenance. */
export async function retryDueDeliveries(deps: Deps, limit = 50) {
  const due = await deps.db.select({ id: webhookDeliveries.id }).from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, deps.now())))
    .orderBy(asc(webhookDeliveries.nextAttemptAt)).limit(limit);
  for (const d of due) await attempt(deps, d.id);
  return due.length;
}

/** Drops delivery history older than 30 days. */
export async function pruneDeliveries(deps: Deps) {
  const cutoff = new Date(deps.now().getTime() - 30 * 86400_000);
  const old = await deps.db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(lte(webhookDeliveries.createdAt, cutoff)).limit(500);
  if (old.length) await deps.db.delete(webhookDeliveries).where(inArray(webhookDeliveries.id, old.map((o) => o.id)));
  return old.length;
}
