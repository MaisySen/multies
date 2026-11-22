/**
 * Outbound webhooks, signed with the Standard Webhooks spec (standardwebhooks.com)
 * using its reference library, so receivers can verify with any Standard Webhooks SDK.
 */
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import type { Deps } from "../../context";
import { mailboxes, members, users, webhookDeliveries, webhookEndpoints } from "../../db/schema";
import { sendSystemEmail } from "../system-mail";
import { decryptSecret, encryptSecret, newId, randomBytes, sha256Hex, toB64 } from "../../lib/crypto";
import { isPublicHost } from "../../lib/ssrf";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";

/**
 * OPS1 security: a webhook URL's path and query are often the secret (Slack, Discord and Teams URLs). Replaces every
 * URL with a path or query in `text` by its origin. Used on errors before they are stored or shown.
 */
export function scrubUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi, (u) => {
    try {
      const x = new URL(u);
      return x.pathname.length > 1 || x.search || x.hash || x.username || x.password ? (x.origin === "null" ? "[link]" : x.origin) : u;
    } catch {
      return "[link]";
    }
  });
}

/** OPS1 security: `message` without the endpoint's URL, and without its path or query on their own. */
export function scrubEndpointUrl(message: string, url: string): string {
  let out = scrubUrls(message);
  try {
    const x = new URL(url);
    for (const part of [url, `${x.pathname}${x.search}`, x.search, x.pathname.length > 1 ? x.pathname : ""]) {
      if (part && part.length > 1) out = out.split(part).join("[path]");
    }
  } catch { /* not a URL */ }
  return out;
}

export const WEBHOOK_EVENTS = [
  "message.received",
  "message.sent",
  "message.bounced",
  "message.complained",
  "domain.verified",
  "domain.failed",
  "approval.requested",
  "approval.decided",
  "agent.created",
  "agent.deleted",
  "task.created",
  "task.updated",
  "task.deleted",
  "task.commented",
  "project.created",
  "project.deleted",
  "doc.created",
  "doc.updated",
  "doc.deleted",
  "contact.created",
  "contact.updated",
  "deal.created",
  "deal.updated",
  "time_entry.created",
  "time_entry.updated",
  "form.submitted",
  "meeting.created",
  "meeting.updated",
  "meeting.deleted", // R52 (MB-239)
  "project.updated",
  "custom_field.created",
  "custom_field.updated",
  "custom_field.deleted",
  "task.file_added",
  "guest.invited",
  "guest.joined",
  "guest.revoked",
  "chat.channel.created",
  "chat.message.created",
  "chat.message.updated",
  "chat.message.deleted",
  "chat.mention",
  "task.recurred",
  "template.used",
  "goal.created",
  "goal.updated",
  "goal.deleted",
  "incoming_hook.received",
  "booking.created",
  "booking.cancelled",
  "triage.created",
  "triage.accepted",
  "triage.declined",
  "triage.merged",
  "comment.created",
  "comment.updated",
  "comment.deleted",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const MAX_ENDPOINTS = 10;
/** Delay before attempt n+1, after n failures. Six attempts over about nine hours. */
export const RETRY_SCHEDULE_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
const TIMEOUT_MS = 5_000;


export function validateEndpointUrl(deps: Deps, raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw badRequest("Enter a full URL, like https://example.com/webhooks/multies."); }
  const dev = deps.config.mode === "development";
  if (u.protocol !== "https:" && !(dev && u.protocol === "http:")) throw badRequest("Webhook URLs must use https.");
  if (!dev && !isPublicHost(u.hostname)) throw badRequest("Webhook URLs must point to a public address.");
  if (u.username || u.password) throw badRequest("Put credentials in your receiver, not in the URL.");
  return u.toString();
}

export function presentEndpoint(e: typeof webhookEndpoints.$inferSelect) {
  return { id: e.id, url: e.url, description: e.description, events: JSON.parse(e.events) as string[], enabled: e.enabled, disabledReason: e.disabledReason, format: e.format ?? "json", connector: e.connector ?? null, createdAt: e.createdAt };
}

export async function listEndpoints(deps: Deps, orgId: string) {
  return (await deps.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.orgId, orgId)).orderBy(asc(webhookEndpoints.createdAt))).map(presentEndpoint);
}

async function endpointInOrg(deps: Deps, orgId: string, id: string) {
  const e = await deps.db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.orgId, orgId))).get();
  if (!e) throw notFound("Webhook endpoint");
  return e;
}

export type EndpointFormat = "json" | "slack" | "discord" | "teams";

export async function createEndpoint(deps: Deps, orgId: string, input: { url: string; events: string[]; description?: string; format?: EndpointFormat; connector?: string }, opts: { id?: string; retry?: boolean } = {}) {
  if (opts.id && opts.retry) {
    // R53 (MB-239): a retry under the same Idempotency-Key whose first attempt committed gets that endpoint back with
    // the secret it was made with (the first answer, which would have shown it once, never arrived). No second
    // secret is minted. One read, only on a retry.
    const hit = await deps.db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, opts.id), eq(webhookEndpoints.orgId, orgId))).get();
    if (hit) return { endpoint: presentEndpoint(hit), secret: await decryptSecret(deps.config.appSecret, hit.secretEnc) };
  }
  const count = (await deps.db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(eq(webhookEndpoints.orgId, orgId))).length;
  if (count >= MAX_ENDPOINTS) throw conflict(`A workspace can have up to ${MAX_ENDPOINTS} webhook endpoints.`);
  const url = validateEndpointUrl(deps, input.url);
  const secret = `whsec_${toB64(randomBytes(24))}`;
  const id = opts.id ?? newId("whe");
  await deps.db.insert(webhookEndpoints).values({
    id, orgId, url, description: input.description ?? null, events: JSON.stringify(input.events),
    format: input.format ?? "json", connector: input.connector ?? null,
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
  // Slack, Discord and Teams take a chat message body, not our event; the signature headers stay for parity.
  const body = e.format && e.format !== "json" ? await chatBody(e.format, d.payload, deps.config.appName, e.url, deps.config.appUrl) : d.payload;
  let status: number | null = null;
  let error: string | null = null;
  try {
    // Endpoints saved before a stricter rule are checked again on every attempt.
    if (deps.config.mode !== "development" && !isPublicHost(new URL(e.url).hostname)) throw new Error("the URL points to a private address");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await deps.fetch(e.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Multies-Webhooks/1",
        "webhook-id": d.id,
        "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
        "webhook-signature": signature,
      },
      body,
      signal: ctrl.signal,
      redirect: "manual",
    }).finally(() => clearTimeout(timer));
    status = res.status;
    if (res.status < 200 || res.status >= 300) error = `Receiver answered ${res.status}`;
  } catch (err) {
    // OPS1 security: some runtimes put the URL in the fetch error; its path and query can be the secret.
    error = (err as Error).name === "AbortError" ? `No answer within ${TIMEOUT_MS / 1000}s` : `Could not connect: ${scrubEndpointUrl((err as Error).message, e.url)}`.slice(0, 300);
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
    .where(and(eq(webhookDeliveries.endpointId, e.id), eq(webhookDeliveries.status, "failed"), deliveryIds?.length ? inIds(webhookDeliveries.id, deliveryIds) : undefined))
    .returning({ id: webhookDeliveries.id });
  if (!e.enabled) await deps.db.update(webhookEndpoints).set({ enabled: true, disabledReason: null, consecutiveDead: 0 }).where(eq(webhookEndpoints.id, e.id));
  await Promise.all(rows.slice(0, 20).map((r) => attempt(deps, r.id)));
  return rows.length;
}

/**
 * Records an event for every enabled endpoint subscribed to it and makes the first
 * attempt right away. Never throws: webhooks must not break the action behind them.
 */
/**
 * Queues and sends one event (or several names for the same change, R51: a comment is both `task.commented` and
 * `comment.created`) to every enabled endpoint subscribed to it. One read of the endpoints either way; with no
 * endpoint subscribed it writes nothing, so an event costs no D1 write until someone listens for it.
 */
/** R52 (MB-239): a workspace's enabled endpoints, read once so a caller can decide what to collect and pass them on. */
export type WebhookTargets = (typeof webhookEndpoints.$inferSelect)[];
export async function webhookTargets(deps: Deps, orgId: string): Promise<WebhookTargets> {
  return deps.db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.enabled, true)));
}
/** R52: whether any of those endpoints takes this event. */
export function wantsEvent(targets: WebhookTargets, type: WebhookEvent): boolean {
  return targets.some((e) => { const ev = JSON.parse(e.events) as string[]; return ev.includes("*") || ev.includes(type); });
}

/** R52: past this many events in one emitMany, the rest are not sent (the caller says so in its own event). */
export const EMIT_MANY_MAX = 1000;
/** R52: deliveries attempted inside the request; the rest wait for the retry pass, which sends due ones in order. */
const EMIT_MANY_INLINE = 10;

/**
 * R52 (MB-239): many events of one type (one per deleted task) as ONE insert statement, whatever the count: the rows
 * travel as a single JSON parameter and SQLite (and D1) unpack them with json_each, so a project of 1,000 tasks costs
 * one write statement, not 1,000. With no endpoint taking the event it writes nothing. The first few deliveries are
 * attempted now; the rest are left pending and go out on the retry pass.
 */
export async function emitEventMany(deps: Deps, orgId: string, type: WebhookEvent, items: Record<string, unknown>[], targets?: WebhookTargets) {
  try {
    const list = items.slice(0, EMIT_MANY_MAX);
    const ends = (targets ?? await webhookTargets(deps, orgId)).filter((e) => wantsEvent([e], type));
    if (!ends.length || !list.length) return [];
    const now = deps.now();
    const rows = ends.flatMap((e) => list.map((data) => ({ id: newId("msg"), endpointId: e.id, payload: JSON.stringify({ type, timestamp: now.toISOString(), data }) })));
    // Write: one statement for every delivery row (the 100 bound parameter limit does not apply to one JSON value).
    await deps.db.run(sql`insert into webhook_deliveries (id, org_id, endpoint_id, event_type, payload, status, attempts, next_attempt_at, created_at)
      select json_extract(value, '$.id'), ${orgId}, json_extract(value, '$.endpointId'), ${type}, json_extract(value, '$.payload'), 'pending', 0, ${now.getTime()}, ${now.getTime()}
      from json_each(${JSON.stringify(rows)})`);
    await Promise.all(rows.slice(0, EMIT_MANY_INLINE).map((r) => attempt(deps, r.id)));
    return rows.map((r) => r.id);
  } catch (err) {
    deps.reportError?.(err, { where: "emitEventMany", type });
    return [];
  }
}

/** PRIV1b (P1): events whose payload carries a mailbox's mail (text, codes, links, recipients, subject). */
// PRIV1b (P1): bounce and complaint events carry the sender, recipient and subject too.
const PRIVATE_MAIL_EVENTS: ReadonlySet<string> = new Set(["message.received", "message.sent", "approval.requested", "message.bounced", "message.complained"]);
/** PRIV1b (P1): the event's mailbox (by id, else by its `from` address for approvals) is someone's personal mailbox. */
async function personalMailbox(deps: Deps, orgId: string, data: Record<string, unknown>) {
  const id = typeof data.mailboxId === "string" ? data.mailboxId : null;
  const address = !id && typeof data.from === "string" ? data.from.toLowerCase() : null;
  if (!id && !address) return false;
  const r = await deps.db.select({ personal: mailboxes.personal }).from(mailboxes)
    .where(and(eq(mailboxes.orgId, orgId), id ? eq(mailboxes.id, id) : eq(mailboxes.address, address!))).get();
  return !!r?.personal;
}

export async function emitEvent(deps: Deps, orgId: string, type: WebhookEvent | readonly WebhookEvent[], data: Record<string, unknown>, targets?: WebhookTargets) {
  const types: readonly WebhookEvent[] = typeof type === "string" ? [type] : type;
  try {
    const endpoints = (targets ?? await webhookTargets(deps, orgId))
      .map((e) => { const ev = JSON.parse(e.events) as string[]; return { e, want: types.filter((t) => ev.includes("*") || ev.includes(t)) }; })
      .filter((x) => x.want.length > 0);
    if (!endpoints.length) return [];
    // PRIV1b (P1): mail from or to a personal mailbox never goes to workspace webhooks or integrations (endpoints record
    // no creator, so none can be shown to open it). One indexed read, only when an endpoint takes a mail event.
    if (endpoints.some((x) => x.want.some((t) => PRIVATE_MAIL_EVENTS.has(t))) && await personalMailbox(deps, orgId, data)) {
      for (const x of endpoints) x.want = x.want.filter((t) => !PRIVATE_MAIL_EVENTS.has(t));
    }
    const ids: string[] = [];
    for (const { e, want } of endpoints) {
      for (const t of want) {
        const id = newId("msg");
        const payload = JSON.stringify({ type: t, timestamp: deps.now().toISOString(), data });
        await deps.db.insert(webhookDeliveries).values({ id, orgId, endpointId: e.id, eventType: t, payload, nextAttemptAt: deps.now() });
        ids.push(id);
      }
    }
    await Promise.all(ids.map((id) => attempt(deps, id)));
    return ids;
  } catch (err) {
    deps.reportError?.(err, { where: "emitEvent", type: types.join(",") });
    return [];
  }
}

/**
 * R90: one delivery to one endpoint from a flow step, regardless of its event filter (the person picked
 * the endpoint). Signed, retried with backoff and replayable like every delivery. The key keeps one
 * delivery per flow step: asking again returns the first one.
 */
export async function queueDelivery(deps: Deps, orgId: string, endpointId: string, type: string, data: Record<string, unknown>, key: string) {
  const e = await deps.db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.orgId, orgId))).get();
  if (!e || !e.enabled) return null;
  const id = `msg_flow_${(await sha256Hex(key)).slice(0, 24)}`;
  const existing = await deps.db.select({ status: webhookDeliveries.status }).from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).get();
  if (!existing) {
    const payload = JSON.stringify({ type, timestamp: deps.now().toISOString(), data });
    await deps.db.insert(webhookDeliveries).values({ id, orgId, endpointId: e.id, eventType: type, payload, nextAttemptAt: deps.now() }).onConflictDoNothing();
    await attempt(deps, id);
  }
  const d = await deps.db.select({ status: webhookDeliveries.status }).from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).get();
  return { id, url: e.url, status: d?.status ?? "pending" };
}

/** Sends a `webhook.test` event to one endpoint, regardless of its event filter. */
export async function sendTestEvent(deps: Deps, orgId: string, endpointId: string) {
  const e = await endpointInOrg(deps, orgId, endpointId);
  const id = newId("msg");
  const payload = JSON.stringify({ type: "webhook.test", timestamp: deps.now().toISOString(), data: { message: "Test event from Multies. If you can read this, your endpoint works." } });
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
  if (old.length) await deps.db.delete(webhookDeliveries).where(inIds(webhookDeliveries.id, old.map((o) => o.id)));
  return old.length;
}

/** Turns a stored event into the message body a chat app's incoming webhook expects. */
async function chatBody(format: Exclude<EndpointFormat, "json">, payload: string, appName: string, url: string, appUrl: string) {
  const { eventText, isTeamsWorkflowsUrl, teamsWorkflowsCard } = await import("../suite/integrations");
  const event = JSON.parse(payload) as { type: string; data?: Record<string, unknown> };
  // Teams Workflows flows read an Adaptive Card; the classic connector URLs take plain text.
  if (format === "teams" && isTeamsWorkflowsUrl(url)) return JSON.stringify(teamsWorkflowsCard(event, appName, appUrl));
  const text = eventText(event, appName);
  if (format === "discord") return JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } });
  return JSON.stringify({ text });
}
