/**
 * R28 (DF-3 slice 3): triggers that queue agent runs. A workspace admin makes a trigger for a named AI agent member:
 * kind "schedule" (every N hours, at least 1, or daily at HH:MM in the trigger's zone, optionally on some weekdays)
 * or kind "webhook" (a public URL that takes a POST signed with HMAC-SHA256 over `${timestamp}.${body}`). Firing
 * queues a run (status queued) on the trigger's task, or on a new task made in its project from a title template;
 * the agent picks queued runs up with its own key (GET /v1/agents/me/runs?status=queued, then the slice 2 start,
 * steps and finish). Multies itself never calls an AI. ADR 0008, "Slice 3: triggers".
 *
 * Limits: 20 triggers per workspace; a webhook fires at most once a minute (429); an agent has at most 3 queued
 * runs waiting (429 and an agent_trigger.refused audit entry); a webhook body is at most 32 KB (413); a disabled
 * trigger answers 404 to its webhook; the agent must be an active (not paused, not removed) member.
 *
 * D1 cost: the cron pass reads due triggers with one query on a partial index that holds only enabled schedule
 * rows (an idle pass writes nothing). A fire writes the trigger row once (claim, next run, counters), the run row
 * and one audit row; a new task adds the task's own writes. A refused fire writes the audit row (and, on a
 * schedule, the next run time). A bad signature, a stale or replayed timestamp and a webhook over its rate are
 * sampled (R29): at most one agent_trigger.refused row per trigger every 10 minutes (one indexed read of the
 * trigger's recent refusals per such request), so the trigger's History shows that senders are failing without a
 * flood of unsigned requests spending the D1 write budget.
 *
 * History (R29): the trigger's last 50 fires and refusals, newest first, read from audit_logs through
 * audit_target_idx (target_id, created_at), a partial index on agent trigger rows only (other audit inserts pay no
 * extra write); a bounded range read, never a scan of the workspace's audit log.
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { agentRuns, agentTriggers, auditLogs, members, organizations, projects, tasks, users } from "../../db/schema";
import { decryptSecret, encryptSecret, hmacSha256Hex, randomToken, safeEqual } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { inChunks } from "../../lib/sql-chunks";
import { audit } from "../audit";
import { sortableId, type SuiteActor } from "./common";
import { DAYS, validTimezone, zonedDate, zonedTime, type Day } from "./scheduling";
import { createTask, resolveTaskId } from "./tasks";

export const TRIGGERS_PER_WORKSPACE = 20;
export const QUEUED_RUNS_PER_AGENT = 3;
export const WEBHOOK_BODY_MAX = 32 * 1024;
export const WEBHOOK_WINDOW_SECONDS = 300;
export const WEBHOOK_MIN_INTERVAL_MS = 60_000;
export const TRIGGER_INSTRUCTIONS_MAX = 4000;
export const TRIGGER_TITLE_MAX = 200;
export const DUE_BATCH = 50;
export const SIGNATURE_HEADER = "x-multies-signature";
export const TIMESTAMP_HEADER = "x-multies-timestamp";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

type Row = typeof agentTriggers.$inferSelect;
export type TriggerKind = "schedule" | "webhook";
export type FireSource = "schedule" | "webhook" | "manual";

export interface TriggerInput {
  agentUserId?: string; name?: string; kind?: TriggerKind; enabled?: boolean;
  taskId?: string | null; projectId?: string | null; titleTemplate?: string | null; instructions?: string | null;
  everyHours?: number | null; dailyAt?: string | null; days?: Day[] | null; timezone?: string | null;
}

export interface AgentTrigger {
  id: string; name: string; kind: TriggerKind; enabled: boolean;
  agent: { userId: string; name: string; active: boolean };
  task: { id: string; ref: string; title: string } | null;
  project: { id: string; name: string } | null;
  titleTemplate: string | null; instructions: string | null;
  schedule: { everyHours: number; timezone: string } | { dailyAt: string; days: Day[] | null; timezone: string } | null;
  webhook: { url: string; secretHint: string | null; signatureHeader: string; timestampHeader: string } | null;
  nextRunAt: string | null; lastFiredAt: string | null; fireCount: number; createdAt: string; updatedAt: string;
}

const bad = (message: string) => new HttpError(422, "validation_failed", message);

function assertAdmin(a: SuiteActor) {
  if (a.agentId) throw new HttpError(403, "agent_key_scope", "Agent keys can't manage triggers.");
  if (a.scope === "read") throw new HttpError(403, "read_only_key", "This key is read only.");
  if (!a.system && (a.role === "member" || !a.role)) throw new HttpError(403, "forbidden", "Only workspace admins can manage agent triggers.");
}

// ------------------------------------------------------------------ schedule maths

export interface ScheduleSpec { everyHours?: number | null; dailyAt?: string | null; days?: readonly Day[] | null; timezone: string }

/**
 * The first run strictly after `from`. Every N hours counts from `from`; daily at HH:MM is the wall clock time in
 * the zone (DST safe), on the listed weekdays when there are any. Null when the spec names neither.
 */
export function nextRunAfter(spec: ScheduleSpec, from: Date): Date | null {
  if (spec.everyHours) return new Date(from.getTime() + Math.max(1, Math.floor(spec.everyHours)) * 3_600_000);
  if (!spec.dailyAt || !HHMM.test(spec.dailyAt)) return null;
  const minutes = Number(spec.dailyAt.slice(0, 2)) * 60 + Number(spec.dailyAt.slice(3, 5));
  const today = zonedDate(from, spec.timezone);
  const days = spec.days?.length ? new Set(spec.days) : null;
  for (let i = 0; i < 9; i++) {
    const cal = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const day = DAYS[cal.getUTCDay()];
    if (days && !days.has(day)) continue;
    const at = zonedTime(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), minutes, spec.timezone);
    if (at.getTime() > from.getTime()) return at;
  }
  return null;
}

/** A title from the template: {trigger}, {date} (YYYY-MM-DD in the zone) and {datetime} (YYYY-MM-DD HH:MM). */
export function renderTitle(template: string, ctx: { trigger: string; at: Date; timezone: string }) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(ctx.at).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const out = template.replace(/\{trigger\}/g, ctx.trigger).replace(/\{datetime\}/g, `${date} ${p.hour}:${p.minute}`).replace(/\{date\}/g, date);
  return out.replace(/\s+/g, " ").trim().slice(0, TRIGGER_TITLE_MAX) || ctx.trigger;
}

// ------------------------------------------------------------------ signature

/** The signature a sender puts in X-Multies-Signature: "sha256=" and the hex HMAC-SHA256 of `${timestamp}.${body}`. */
export async function signWebhook(secret: string, timestamp: number | string, body: string) {
  return `sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export type SignatureCheck = { ok: true; timestamp: number } | { ok: false; code: "missing_signature" | "bad_timestamp" | "stale_signature" | "bad_signature"; message: string };

/** Checks the timestamp is within the 5 minute window and the signature matches, comparing in constant time. */
export async function verifyWebhookSignature(secret: string, headers: { timestamp?: string | null; signature?: string | null }, body: string, now: Date): Promise<SignatureCheck> {
  const sig = (headers.signature ?? "").trim();
  const tsRaw = (headers.timestamp ?? "").trim();
  if (!sig || !tsRaw) return { ok: false, code: "missing_signature", message: `Send ${TIMESTAMP_HEADER} (unix seconds) and ${SIGNATURE_HEADER} (sha256=hex HMAC of "timestamp.body").` };
  if (!/^\d{9,11}$/.test(tsRaw)) return { ok: false, code: "bad_timestamp", message: `${TIMESTAMP_HEADER} is unix time in seconds.` };
  const ts = Number(tsRaw);
  if (Math.abs(now.getTime() / 1000 - ts) > WEBHOOK_WINDOW_SECONDS) return { ok: false, code: "stale_signature", message: "The timestamp is more than 5 minutes from now. Sign each request when you send it." };
  const expected = await signWebhook(secret, ts, body);
  const given = sig.startsWith("sha256=") ? sig : `sha256=${sig}`;
  if (!safeEqual(given.toLowerCase(), expected)) return { ok: false, code: "bad_signature", message: "The signature doesn't match. Sign the raw body with the trigger's secret." };
  return { ok: true, timestamp: ts };
}

// ------------------------------------------------------------------ reads

async function agentMember(deps: Deps, orgId: string, userId: string) {
  if (!userId) return null;
  const r = await deps.db.select({ userId: members.userId, kind: members.kind, disabledAt: members.disabledAt, name: users.name })
    .from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), eq(members.userId, userId))).get();
  return r && r.kind === "agent" ? r : null;
}

async function taskFor(deps: Deps, orgId: string, idOrRef: string) {
  const id = await resolveTaskId(deps, orgId, idOrRef).catch(() => null);
  if (!id) return null;
  const t = await deps.db.select({ id: tasks.id, title: tasks.title, key: projects.key, number: tasks.number })
    .from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.orgId, orgId), eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  return t ? { id: t.id, title: t.title, ref: `${t.key ?? "TSK"}-${t.number}` } : null;
}

async function projectFor(deps: Deps, orgId: string, id: string) {
  return deps.db.select({ id: projects.id, name: projects.name }).from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, id), isNull(projects.deletedAt), isNull(projects.archivedAt))).get();
}

function parseDays(s: string | null): Day[] | null {
  if (!s) return null;
  try { const v = JSON.parse(s); return Array.isArray(v) && v.length ? v.filter((d) => (DAYS as readonly string[]).includes(d)) as Day[] : null; } catch { return null; }
}

export function webhookUrl(appUrl: string, id: string) {
  return `${appUrl.replace(/\/$/, "")}/api/hooks/agent-runs/${id}`;
}

async function present(deps: Deps, orgId: string, rows: Row[]): Promise<AgentTrigger[]> {
  if (!rows.length) return [];
  const agentIds = [...new Set(rows.map((r) => r.agentUserId))];
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter((x): x is string => !!x))];
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => !!x))];
  const [ags, ts, ps] = await Promise.all([
    inChunks(agentIds, (ids) => deps.db.select({ userId: members.userId, kind: members.kind, disabledAt: members.disabledAt, name: users.name }).from(members)
      .innerJoin(users, eq(users.id, members.userId)).where(and(eq(members.organizationId, orgId), inArray(members.userId, ids)))), // D1: inside inChunks (chunks of 90)
    inChunks(taskIds, (ids) => deps.db.select({ id: tasks.id, title: tasks.title, number: tasks.number, key: projects.key, deletedAt: tasks.deletedAt }).from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId)).where(and(eq(tasks.orgId, orgId), inArray(tasks.id, ids)))), // D1: inside inChunks (chunks of 90)
    inChunks(projectIds, (ids) => deps.db.select({ id: projects.id, name: projects.name }).from(projects)
      .where(and(eq(projects.orgId, orgId), inArray(projects.id, ids)))), // D1: inside inChunks (chunks of 90)
  ]);
  const am = new Map(ags.map((x) => [x.userId, x]));
  const tm = new Map(ts.filter((x) => !x.deletedAt).map((x) => [x.id, x]));
  const pm = new Map(ps.map((x) => [x.id, x]));
  return rows.map((r) => {
    const ag = am.get(r.agentUserId);
    const t = r.taskId ? tm.get(r.taskId) : undefined;
    const p = r.projectId ? pm.get(r.projectId) : undefined;
    return {
      id: r.id, name: r.name, kind: r.kind, enabled: r.enabled,
      agent: { userId: r.agentUserId, name: ag?.name ?? "Removed agent", active: !!ag && ag.kind === "agent" && !ag.disabledAt },
      task: t ? { id: t.id, ref: `${t.key ?? "TSK"}-${t.number}`, title: t.title } : null,
      project: p ? { id: p.id, name: p.name } : null,
      titleTemplate: r.titleTemplate, instructions: r.instructions,
      schedule: r.kind !== "schedule" ? null : r.everyHours ? { everyHours: r.everyHours, timezone: r.timezone } : { dailyAt: r.dailyAt ?? "09:00", days: parseDays(r.days), timezone: r.timezone },
      webhook: r.kind === "webhook" ? { url: webhookUrl(deps.config.appUrl, r.id), secretHint: r.secretHint, signatureHeader: SIGNATURE_HEADER, timestampHeader: TIMESTAMP_HEADER } : null,
      nextRunAt: r.kind === "schedule" && r.enabled && r.nextRunAt ? r.nextRunAt.toISOString() : null,
      lastFiredAt: r.lastFiredAt ? r.lastFiredAt.toISOString() : null, fireCount: r.fireCount,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    };
  });
}

async function triggerRow(deps: Deps, orgId: string, id: string) {
  const r = await deps.db.select().from(agentTriggers).where(and(eq(agentTriggers.orgId, orgId), eq(agentTriggers.id, id))).get();
  if (!r) throw notFound("Trigger");
  return r;
}

export async function listTriggers(deps: Deps, a: SuiteActor, opts: { agentUserId?: string } = {}) {
  assertAdmin(a);
  const rows = await deps.db.select().from(agentTriggers)
    .where(and(eq(agentTriggers.orgId, a.orgId), opts.agentUserId ? eq(agentTriggers.agentUserId, opts.agentUserId) : undefined))
    .orderBy(asc(agentTriggers.createdAt)).limit(TRIGGERS_PER_WORKSPACE * 2);
  return { triggers: await present(deps, a.orgId, rows), limit: TRIGGERS_PER_WORKSPACE };
}

export async function getTrigger(deps: Deps, a: SuiteActor, id: string) {
  assertAdmin(a);
  return (await present(deps, a.orgId, [await triggerRow(deps, a.orgId, id)]))[0];
}

// ------------------------------------------------------------------ writes

async function writeAudit(deps: Deps, a: SuiteActor | null, orgId: string, action: string, t: Pick<Row, "id" | "name" | "kind" | "agentUserId">, extra: Record<string, unknown> = {}) {
  await audit(deps.db, {
    at: deps.now(), orgId, actorUserId: a?.userId || null, actorEmail: a?.email ?? null, action, targetType: "agent_trigger", targetId: t.id,
    metadata: { triggerId: t.id, triggerName: t.name, kind: t.kind, agentUserId: t.agentUserId, via: a ? (a.apiKeyId ? "api" : "app") : t.kind, ...extra },
  });
}

const cleanText = (s: string | null | undefined, max: number, what: string) => {
  if (s === undefined) return undefined;
  const v = (s ?? "").trim();
  if (v.length > max) throw bad(`${what} is at most ${max} characters.`);
  return v || null;
};

/** Validates and normalises the target and the schedule; returns the columns to write. */
async function resolveFields(deps: Deps, orgId: string, kind: TriggerKind, cur: Partial<Row>, input: TriggerInput) {
  const out: Partial<typeof agentTriggers.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = (input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) throw bad("Give the trigger a name.");
    out.name = name;
  }
  if (input.agentUserId !== undefined) {
    const ag = await agentMember(deps, orgId, input.agentUserId);
    if (!ag) throw bad("agentUserId is not an AI agent member of this workspace.");
    out.agentUserId = ag.userId;
  }
  if (input.taskId !== undefined) {
    if (input.taskId) {
      const t = await taskFor(deps, orgId, input.taskId);
      if (!t) throw notFound("Task");
      out.taskId = t.id; out.projectId = null;
    } else out.taskId = null;
  }
  if (input.projectId !== undefined && !out.taskId) {
    if (input.projectId) {
      const p = await projectFor(deps, orgId, input.projectId);
      if (!p) throw notFound("Project");
      out.projectId = p.id; out.taskId = null;
    } else out.projectId = null;
  }
  const title = cleanText(input.titleTemplate, TRIGGER_TITLE_MAX, "A title template");
  if (title !== undefined) out.titleTemplate = title;
  const ins = cleanText(input.instructions, TRIGGER_INSTRUCTIONS_MAX, "Instructions");
  if (ins !== undefined) out.instructions = ins;
  const taskId = out.taskId !== undefined ? out.taskId : cur.taskId;
  const projectId = out.projectId !== undefined ? out.projectId : cur.projectId;
  if (!taskId && !projectId) throw bad("Name a task (taskId), or a project (projectId) for a new task each time.");
  if (input.timezone !== undefined && input.timezone !== null) {
    if (!validTimezone(input.timezone)) throw bad("timezone is an IANA zone like Australia/Sydney.");
    out.timezone = input.timezone;
  }
  if (kind === "schedule") {
    const touched = input.everyHours !== undefined || input.dailyAt !== undefined || input.days !== undefined;
    if (touched) {
      const every = input.everyHours ?? null;
      const daily = input.dailyAt ?? null;
      if (every !== null && daily !== null) throw bad("Pick one: everyHours or dailyAt.");
      if (every !== null) {
        if (!Number.isInteger(every) || every < 1 || every > 24 * 31) throw bad("everyHours is a whole number of hours from 1 to 744.");
        out.everyHours = every; out.dailyAt = null; out.days = null;
      } else if (daily !== null) {
        if (!HHMM.test(daily)) throw bad("dailyAt is a time like 09:00.");
        const days = input.days?.length ? [...new Set(input.days)] : null;
        if (days && days.some((d) => !(DAYS as readonly string[]).includes(d))) throw bad(`days are ${DAYS.join(", ")}.`);
        out.dailyAt = daily; out.everyHours = null; out.days = days ? JSON.stringify(DAYS.filter((d) => days.includes(d))) : null;
      } else if (input.days !== undefined && cur.dailyAt) {
        const days = input.days?.length ? [...new Set(input.days)] : null;
        if (days && days.some((d) => !(DAYS as readonly string[]).includes(d))) throw bad(`days are ${DAYS.join(", ")}.`);
        out.days = days ? JSON.stringify(DAYS.filter((d) => days.includes(d))) : null;
      } else throw bad("A schedule trigger needs everyHours (1 or more) or dailyAt (HH:MM).");
    } else if (!cur.everyHours && !cur.dailyAt) throw bad("A schedule trigger needs everyHours (1 or more) or dailyAt (HH:MM).");
  } else if (input.everyHours != null || input.dailyAt != null) throw bad("everyHours and dailyAt are for schedule triggers.");
  return out;
}

function scheduleOf(r: Pick<Row, "everyHours" | "dailyAt" | "days" | "timezone">): ScheduleSpec {
  return { everyHours: r.everyHours, dailyAt: r.dailyAt, days: parseDays(r.days), timezone: r.timezone };
}

/** Creates a trigger. A webhook trigger's secret is returned once, here. */
export async function createTrigger(deps: Deps, a: SuiteActor, input: TriggerInput, opts: { id?: string; retry?: boolean } = {}) {
  assertAdmin(a);
  if (opts.id && opts.retry) {
    // R54 (MB-239): a retry under the same Idempotency-Key whose first attempt committed gets that trigger back, with
    // the webhook secret it was made with (the first answer, which would have shown it once, never arrived). No
    // second secret is minted. One read, only on a retry.
    const hit = await deps.db.select().from(agentTriggers).where(and(eq(agentTriggers.orgId, a.orgId), eq(agentTriggers.id, opts.id))).get();
    if (hit) {
      const trigger = (await present(deps, a.orgId, [hit]))[0];
      return hit.secretEnc ? { trigger, secret: await decryptSecret(deps.config.appSecret, hit.secretEnc) } : { trigger };
    }
  }
  const kind = input.kind;
  if (kind !== "schedule" && kind !== "webhook") throw bad("kind is schedule or webhook.");
  if (!input.agentUserId) throw bad("Name the agent member (agentUserId).");
  if (input.name === undefined) throw bad("Give the trigger a name.");
  const [{ n }] = await deps.db.select({ n: count() }).from(agentTriggers).where(eq(agentTriggers.orgId, a.orgId));
  if (n >= TRIGGERS_PER_WORKSPACE) throw new HttpError(409, "trigger_limit", `A workspace holds at most ${TRIGGERS_PER_WORKSPACE} triggers. Delete one first.`);
  const org = await deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, a.orgId)).get();
  const fields = await resolveFields(deps, a.orgId, kind, {}, input);
  const now = deps.now();
  const timezone = fields.timezone ?? org?.tz ?? "UTC";
  const id = opts.id ?? sortableId("trg", now.getTime());
  let secret: string | null = null;
  let secretEnc: string | null = null;
  if (kind === "webhook") { secret = `mtw_${randomToken(24)}`; secretEnc = await encryptSecret(deps.config.appSecret, secret); }
  const enabled = input.enabled ?? true;
  const row: typeof agentTriggers.$inferInsert = {
    id, orgId: a.orgId, agentUserId: fields.agentUserId!, name: fields.name!, kind, enabled,
    taskId: fields.taskId ?? null, projectId: fields.projectId ?? null, titleTemplate: fields.titleTemplate ?? null, instructions: fields.instructions ?? null,
    everyHours: fields.everyHours ?? null, dailyAt: fields.dailyAt ?? null, days: fields.days ?? null, timezone,
    nextRunAt: null, secretEnc, secretHint: secret ? secret.slice(-4) : null,
    createdByUserId: a.userId || null, createdAt: now, updatedAt: now,
  };
  if (kind === "schedule" && enabled) row.nextRunAt = nextRunAfter(scheduleOf({ everyHours: row.everyHours ?? null, dailyAt: row.dailyAt ?? null, days: row.days ?? null, timezone }), now);
  await deps.db.insert(agentTriggers).values(row);
  await writeAudit(deps, a, a.orgId, "agent_trigger.created", { id, name: row.name, kind, agentUserId: row.agentUserId });
  const trigger = (await present(deps, a.orgId, [await triggerRow(deps, a.orgId, id)]))[0];
  return secret ? { trigger, secret } : { trigger };
}

/** Edits a trigger (name, on or off, target, instructions, schedule). The kind can't change. */
export async function updateTrigger(deps: Deps, a: SuiteActor, id: string, input: TriggerInput) {
  assertAdmin(a);
  const cur = await triggerRow(deps, a.orgId, id);
  if (input.kind && input.kind !== cur.kind) throw bad("A trigger's kind can't change. Make a new trigger.");
  const fields = await resolveFields(deps, a.orgId, cur.kind, cur, input);
  if (input.enabled !== undefined) fields.enabled = input.enabled;
  const changed = Object.keys(fields).filter((k) => (fields as Record<string, unknown>)[k] !== (cur as Record<string, unknown>)[k]);
  if (!changed.length) return getTrigger(deps, a, id);
  const now = deps.now();
  const next = { ...cur, ...fields };
  if (next.kind === "schedule") {
    const scheduleChanged = ["everyHours", "dailyAt", "days", "timezone", "enabled"].some((k) => changed.includes(k));
    if (scheduleChanged) fields.nextRunAt = next.enabled ? nextRunAfter(scheduleOf(next), now) : null;
  }
  await deps.db.update(agentTriggers).set({ ...fields, updatedAt: now }).where(and(eq(agentTriggers.orgId, a.orgId), eq(agentTriggers.id, id)));
  await writeAudit(deps, a, a.orgId, "agent_trigger.updated", next, { changed });
  return getTrigger(deps, a, id);
}

export async function deleteTrigger(deps: Deps, a: SuiteActor, id: string) {
  assertAdmin(a);
  const cur = await triggerRow(deps, a.orgId, id);
  await deps.db.delete(agentTriggers).where(and(eq(agentTriggers.orgId, a.orgId), eq(agentTriggers.id, id)));
  await writeAudit(deps, a, a.orgId, "agent_trigger.deleted", cur);
  return { deleted: true, id };
}

/** A new webhook secret, returned once; the old one stops working at once. */
export async function rotateTriggerSecret(deps: Deps, a: SuiteActor, id: string) {
  assertAdmin(a);
  const cur = await triggerRow(deps, a.orgId, id);
  if (cur.kind !== "webhook") throw bad("Only webhook triggers have a secret.");
  const secret = `mtw_${randomToken(24)}`;
  await deps.db.update(agentTriggers).set({ secretEnc: await encryptSecret(deps.config.appSecret, secret), secretHint: secret.slice(-4), lastHookTs: null, updatedAt: deps.now() })
    .where(and(eq(agentTriggers.orgId, a.orgId), eq(agentTriggers.id, id)));
  await writeAudit(deps, a, a.orgId, "agent_trigger.secret_rotated", cur);
  return { trigger: await getTrigger(deps, a, id), secret };
}

// ------------------------------------------------------------------ history (R29)

export const HISTORY_LIMIT = 50;
export const REFUSAL_SAMPLE_MS = 10 * 60_000;
const HISTORY_ACTIONS = ["agent_trigger.fired", "agent_trigger.refused"] as const;

export interface TriggerHistoryEntry {
  id: string; at: string; outcome: "fired" | "refused"; source: FireSource | null;
  reason: string | null; message: string | null;
  run: { id: string; taskId: string | null; taskRef: string | null } | null;
  actor: { userId: string | null; email: string | null } | null;
  /** True for a sampled webhook refusal (bad signature, stale, replayed, over its rate): at most one per 10 minutes. */
  sampled: boolean;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const parseMeta = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
};
const SOURCES: readonly FireSource[] = ["schedule", "webhook", "manual"];

/**
 * A trigger's recent fires and refusals, newest first (at most 50). Admins only, scoped to the actor's workspace
 * (another workspace's trigger is a 404). One bounded read on audit_target_idx.
 */
export async function triggerHistory(deps: Deps, a: SuiteActor, id: string, opts: { limit?: number } = {}) {
  assertAdmin(a);
  const t = await triggerRow(deps, a.orgId, id);
  const limit = Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(Number(opts.limit) || HISTORY_LIMIT)));
  const rows = await deps.db.select().from(auditLogs)
    // The literal target_type matches audit_target_idx's partial WHERE (a bound parameter would not).
    .where(and(eq(auditLogs.targetId, t.id), sql`${auditLogs.targetType} = 'agent_trigger'`, eq(auditLogs.orgId, a.orgId), inArray(auditLogs.action, [...HISTORY_ACTIONS])))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(limit);
  const entries: TriggerHistoryEntry[] = rows.map((r) => {
    const m = parseMeta(r.metadata);
    const source = SOURCES.includes(m.source as FireSource) ? (m.source as FireSource) : null;
    const runId = str(m.runId);
    return {
      id: r.id, at: r.createdAt.toISOString(), outcome: r.action === "agent_trigger.fired" ? "fired" : "refused", source,
      reason: str(m.reason), message: str(m.message),
      run: runId ? { id: runId, taskId: str(m.taskId), taskRef: str(m.taskRef) } : null,
      actor: r.actorUserId || r.actorEmail ? { userId: r.actorUserId, email: r.actorEmail } : null,
      sampled: m.sampled === true,
    };
  });
  return { triggerId: t.id, entries, limit };
}

/**
 * Records a webhook refusal that happens before a fire (signature, timestamp, replay, rate), at most once per
 * trigger every 10 minutes: one indexed read of the trigger's latest refusal, and a write only when there is none.
 */
async function sampleWebhookRefusal(deps: Deps, t: Row, code: string, message: string) {
  try {
    const since = new Date(deps.now().getTime() - REFUSAL_SAMPLE_MS);
    const recent = await deps.db.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.targetId, t.id), sql`${auditLogs.targetType} = 'agent_trigger'`, gt(auditLogs.createdAt, since), eq(auditLogs.action, "agent_trigger.refused"), sql`json_extract(${auditLogs.metadata}, '$.sampled') = 1`))
      .limit(1).get();
    if (recent) return;
    await writeAudit(deps, null, t.orgId, "agent_trigger.refused", t, { source: "webhook", reason: code, message, sampled: true });
  } catch (err) {
    deps.log?.warn("agent_trigger.sample_failed", { triggerId: t.id, error: err });
  }
}

// ------------------------------------------------------------------ firing

export class TriggerRefused extends HttpError {}

const triggerActor = (t: Row): SuiteActor => ({ orgId: t.orgId, userId: "", email: "", name: `Trigger: ${t.name}`, system: true, role: "admin" });

/** How many queued runs the agent has waiting (the partial index holds only queued rows). */
async function queuedCount(deps: Deps, orgId: string, agentUserId: string) {
  const [{ n }] = await deps.db.select({ n: count() }).from(agentRuns)
    .where(and(eq(agentRuns.agentUserId, agentUserId), eq(agentRuns.status, "queued"), eq(agentRuns.orgId, orgId)));
  return n;
}

interface FireOptions { source: FireSource; payload?: unknown; hookTs?: number; actor?: SuiteActor | null }

/**
 * Fires a trigger: checks the agent, its queue and the target, claims the trigger row (so two passes or two
 * requests at once fire once), then queues the run. Refusals throw a TriggerRefused after an audit entry.
 */
export async function fireTrigger(deps: Deps, t: Row, opts: FireOptions) {
  const now = deps.now();
  const refuse = async (status: 409 | 429, code: string, message: string, claim?: Partial<typeof agentTriggers.$inferInsert>) => {
    if (claim) await deps.db.update(agentTriggers).set(claim).where(eq(agentTriggers.id, t.id));
    await writeAudit(deps, opts.actor ?? null, t.orgId, "agent_trigger.refused", t, { source: opts.source, reason: code, message });
    return new TriggerRefused(status, code, message);
  };
  const nextRun = t.kind === "schedule" && t.enabled ? nextRunAfter(scheduleOf(t), now) : t.nextRunAt;
  const scheduleClaim = opts.source === "schedule" ? { nextRunAt: nextRun } : undefined;

  const ag = await agentMember(deps, t.orgId, t.agentUserId);
  if (!ag) throw await refuse(409, "agent_not_member", "The trigger's agent is no longer a member of this workspace.", scheduleClaim);
  if (ag.disabledAt) throw await refuse(409, "agent_paused", `${ag.name} is paused. Resume it to run triggers.`, scheduleClaim);
  if ((await queuedCount(deps, t.orgId, t.agentUserId)) >= QUEUED_RUNS_PER_AGENT) {
    throw await refuse(429, "agent_queue_full", `${ag.name} already has ${QUEUED_RUNS_PER_AGENT} queued runs waiting. It needs to pick them up first.`, scheduleClaim);
  }
  let task = t.taskId ? await taskFor(deps, t.orgId, t.taskId) : null;
  if (t.taskId) {
    if (!task) throw await refuse(409, "task_missing", "The trigger's task was deleted. Point the trigger at another task or a project.", scheduleClaim);
    const active = await deps.db.select({ id: agentRuns.id, status: agentRuns.status }).from(agentRuns)
      .where(and(eq(agentRuns.taskId, task.id), eq(agentRuns.agentUserId, t.agentUserId), sql`${agentRuns.status} in ('queued', 'running')`)).get();
    if (active) throw await refuse(409, "run_in_progress", `${ag.name} already has a ${active.status} run on ${task.ref}.`, scheduleClaim);
  } else if (!t.projectId || !(await projectFor(deps, t.orgId, t.projectId))) {
    throw await refuse(409, "project_missing", "The trigger's project was deleted or archived. Point the trigger at another project.", scheduleClaim);
  }

  // The claim: one write that also guards against a double fire.
  const guard = opts.source === "schedule"
    ? (t.nextRunAt ? eq(agentTriggers.nextRunAt, t.nextRunAt) : isNull(agentTriggers.nextRunAt))
    : opts.source === "webhook"
      ? and(sql`(${agentTriggers.lastFiredAt} is null or ${agentTriggers.lastFiredAt} <= ${now.getTime() - WEBHOOK_MIN_INTERVAL_MS})`, sql`(${agentTriggers.lastHookTs} is null or ${agentTriggers.lastHookTs} < ${opts.hookTs ?? 0})`)
      : undefined;
  const claimed = await deps.db.update(agentTriggers).set({
    lastFiredAt: now, fireCount: sql`${agentTriggers.fireCount} + 1`, updatedAt: now,
    ...(opts.source === "schedule" ? { nextRunAt: nextRun } : {}),
    ...(opts.source === "webhook" ? { lastHookTs: opts.hookTs ?? null } : {}),
  }).where(and(eq(agentTriggers.id, t.id), eq(agentTriggers.enabled, true), guard)).returning({ id: agentTriggers.id });
  if (!claimed.length) {
    if (opts.source === "webhook") throw new TriggerRefused(429, "trigger_rate_limited", "This trigger fired less than a minute ago. Try again in a minute.");
    throw new TriggerRefused(409, "trigger_changed", "The trigger fired or changed meanwhile.");
  }

  if (!task) {
    const title = renderTitle(t.titleTemplate || "{trigger} {date}", { trigger: t.name, at: now, timezone: t.timezone });
    const made = await createTask(deps, triggerActor(t), { title, projectId: t.projectId!, assignee: { type: "member", id: t.agentUserId }, notes: t.instructions ?? undefined });
    task = { id: made.id, ref: made.ref, title: made.title };
  }
  const input = JSON.stringify({ source: opts.source, triggerId: t.id, triggerName: t.name, instructions: t.instructions ?? null, ...(opts.payload !== undefined ? { payload: opts.payload } : {}) });
  const step = { at: now.toISOString(), kind: "note", text: `Queued by the trigger "${t.name}" (${opts.source}).` };
  const runId = sortableId("run", now.getTime());
  try {
    await deps.db.insert(agentRuns).values({
      id: runId, orgId: t.orgId, taskId: task.id, agentUserId: t.agentUserId, status: "queued", startedAt: null,
      steps: JSON.stringify([step]), stepCount: 1, createdByUserId: opts.actor?.userId || null, createdAt: now, updatedAt: now, triggerId: t.id, input,
    });
  } catch (err) {
    if (String((err as Error)?.message ?? err).toLowerCase().includes("unique")) throw await refuse(409, "run_in_progress", `${ag.name} already has a run on ${task.ref}.`);
    throw err;
  }
  await writeAudit(deps, opts.actor ?? null, t.orgId, "agent_trigger.fired", t, { source: opts.source, runId, taskId: task.id, taskRef: task.ref, agentName: ag.name });
  return { runId, taskId: task.id, taskRef: task.ref, agentUserId: t.agentUserId, status: "queued" as const };
}

/** "Run now" from the app or the API: queues a run as if the trigger fired (the queue and agent limits apply). */
export async function runTriggerNow(deps: Deps, a: SuiteActor, id: string) {
  assertAdmin(a);
  const t = await triggerRow(deps, a.orgId, id);
  if (!t.enabled) throw new HttpError(409, "trigger_disabled", "Turn the trigger on first.");
  return { fired: await fireTrigger(deps, t, { source: "manual", actor: a }) };
}

/**
 * The cron pass: one read of due schedule triggers (partial index), then one fire each. A refused fire still moves
 * the next run on, so a full queue is retried at the next slot rather than every pass.
 */
export async function runDueTriggers(deps: Deps) {
  const now = deps.now();
  const due = await deps.db.select().from(agentTriggers)
    .where(and(eq(agentTriggers.enabled, true), eq(agentTriggers.kind, "schedule"), lte(agentTriggers.nextRunAt, now)))
    .orderBy(asc(agentTriggers.nextRunAt)).limit(DUE_BATCH);
  let fired = 0, refused = 0;
  for (const t of due) {
    try { await fireTrigger(deps, t, { source: "schedule" }); fired++; } catch (err) {
      refused++;
      if (!(err instanceof TriggerRefused)) deps.log?.warn("agent_trigger.fire_failed", { triggerId: t.id, error: err });
    }
  }
  return { due: due.length, fired, refused };
}

/** The public webhook: POST /api/hooks/agent-runs/:id with a signed body. */
export async function handleTriggerWebhook(deps: Deps, id: string, headers: { timestamp?: string | null; signature?: string | null; contentLength?: string | null }, readBody: () => Promise<ArrayBuffer>) {
  const notFoundErr = new HttpError(404, "not_found", "No such trigger.");
  if (!/^trg_[0-9a-z]{10,40}$/.test(id)) throw notFoundErr;
  const t = await deps.db.select().from(agentTriggers).where(eq(agentTriggers.id, id)).get();
  if (!t || t.kind !== "webhook" || !t.enabled || !t.secretEnc) throw notFoundErr;
  const tooBig = new HttpError(413, "payload_too_large", `A trigger webhook body is at most ${WEBHOOK_BODY_MAX / 1024} KB.`);
  if (Number(headers.contentLength ?? 0) > WEBHOOK_BODY_MAX) throw tooBig;
  const buf = await readBody();
  if (buf.byteLength > WEBHOOK_BODY_MAX) throw tooBig;
  const body = new TextDecoder().decode(buf);
  const now = deps.now();
  const secret = await decryptSecret(deps.config.appSecret, t.secretEnc);
  const check = await verifyWebhookSignature(secret, headers, body, now);
  if (!check.ok) {
    await sampleWebhookRefusal(deps, t, check.code, check.message);
    throw new HttpError(401, check.code, check.message);
  }
  if (t.lastHookTs !== null && check.timestamp <= t.lastHookTs) {
    const msg = "This request (or an older one) was already accepted. Sign each request with a new timestamp.";
    await sampleWebhookRefusal(deps, t, "replayed", msg);
    throw new HttpError(409, "replayed", msg);
  }
  const rateMsg = "This trigger fired less than a minute ago. Try again in a minute.";
  if (t.lastFiredAt && now.getTime() - t.lastFiredAt.getTime() < WEBHOOK_MIN_INTERVAL_MS) {
    await sampleWebhookRefusal(deps, t, "trigger_rate_limited", rateMsg);
    throw new TriggerRefused(429, "trigger_rate_limited", rateMsg);
  }
  let payload: unknown = undefined;
  if (body.trim()) { try { payload = JSON.parse(body); } catch { payload = body; } }
  try {
    return await fireTrigger(deps, t, { source: "webhook", payload, hookTs: check.timestamp });
  } catch (err) {
    // A lost claim (two requests at once) is a rate refusal that fireTrigger does not audit; sample it too.
    if (err instanceof TriggerRefused && err.code === "trigger_rate_limited") await sampleWebhookRefusal(deps, t, "trigger_rate_limited", rateMsg);
    throw err;
  }
}

/** The agent's own runs (its key), newest first, e.g. status=queued to pick up work a trigger queued. */
export async function listMyRuns(deps: Deps, a: SuiteActor, opts: { status?: string; limit?: number } = {}) {
  if (a.system || a.agentId || !a.userId) throw new HttpError(403, "agent_member_only", "Use an AI agent member's own key to read its runs.");
  const me = await agentMember(deps, a.orgId, a.userId);
  if (!me) throw new HttpError(403, "agent_member_only", "Use an AI agent member's own key to read its runs.");
  const { listRuns } = await import("./agent-runs");
  return listRuns(deps, a, { agentUserId: me.userId, status: opts.status, limit: opts.limit });
}
