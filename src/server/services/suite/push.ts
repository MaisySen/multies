/**
 * Push to phones through Expo's push service (free; it fans out to APNs and FCM).
 * Off unless PUSH_ENABLED=1. A payload carries only an event type and an id, never mail
 * content: the app fetches the item through the normal API, so permissions live in one place.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Deps } from "../../context";
import { pushDevices } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { enqueue, registerJob } from "../jobs";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,}\]$/;

export function pushPayload(event: { type: string; id: string }) {
  return { type: event.type, id: event.id };
}

export async function registerDevice(deps: Deps, auth: { userId: string; orgId: string }, input: { token: string; platform: "ios" | "android" }) {
  if (!TOKEN_RE.test(input.token)) throw new HttpError(422, "invalid_push_token", "That isn't an Expo push token.");
  const now = deps.now();
  await deps.db.insert(pushDevices).values({ token: input.token, userId: auth.userId, orgId: auth.orgId, platform: input.platform, createdAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: pushDevices.token, set: { userId: auth.userId, orgId: auth.orgId, platform: input.platform, lastSeenAt: now } });
  return { ok: true, enabled: deps.config.push.enabled };
}

export async function unregisterDevice(deps: Deps, auth: { userId: string }, token: string) {
  await deps.db.delete(pushDevices).where(and(eq(pushDevices.token, token), eq(pushDevices.userId, auth.userId)));
  return { ok: true };
}

export async function listDevices(deps: Deps, auth: { userId: string; orgId: string }) {
  const rows = await deps.db.select().from(pushDevices).where(and(eq(pushDevices.userId, auth.userId), eq(pushDevices.orgId, auth.orgId)));
  return rows.map((d) => ({ token: `${d.token.slice(0, 22)}...`, platform: d.platform, lastSeenAt: d.lastSeenAt.toISOString() }));
}

/** Queues a push to these people's phones. Never slows the caller: it runs from the job queue. */
export async function pushToUsers(deps: Deps, orgId: string, userIds: string[], event: { type: string; id: string }) {
  if (!deps.config.push.enabled || !userIds.length) return;
  const devices = await deps.db.select({ token: pushDevices.token }).from(pushDevices).where(and(eq(pushDevices.orgId, orgId), inArray(pushDevices.userId, [...new Set(userIds)])));
  if (!devices.length) return;
  const job: PushJob = { orgId, tokens: devices.map((d) => d.token), event: pushPayload(event) };
  // Try once now (a phone buzzes within seconds); on any failure the job queue retries it.
  try { await sendPushNow(deps, job, 3000); } catch { await enqueue(deps, "push.send", job, { orgId, maxAttempts: 4, delayMs: 30_000 }); }
}

export interface PushJob { orgId: string; tokens: string[]; event: { type: string; id: string } }

export async function sendPushNow(deps: Deps, job: PushJob, timeoutMs = 10_000) {
  const channelId = job.event.type.startsWith("approval") ? "approvals" : job.event.type.startsWith("message") || job.event.type.startsWith("mail") ? "mail" : "tasks";
  const body = job.tokens.map((to) => ({ to, data: job.event, channelId, sound: "default", priority: "high", _contentAvailable: true }));
  const res = await deps.fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...(deps.config.push.expoAccessToken ? { authorization: `Bearer ${deps.config.push.expoAccessToken}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Expo push answered ${res.status}`);
  const out = (await res.json().catch(() => ({}))) as { data?: { status: string; details?: { error?: string } }[] };
  // Forget phones Expo says are gone.
  const gone = (out.data ?? []).map((r, i) => (r.status === "error" && r.details?.error === "DeviceNotRegistered" ? job.tokens[i] : null)).filter(Boolean) as string[];
  if (gone.length) await deps.db.delete(pushDevices).where(inArray(pushDevices.token, gone));
  return { sent: job.tokens.length - gone.length, removed: gone.length };
}

registerJob("push.send", async (deps, payload) => { await sendPushNow(deps, payload as PushJob); });
