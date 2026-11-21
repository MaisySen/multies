/**
 * OPS1 (operator console, "Agents and AI"): the cross-workspace data layer for agent runs, agent triggers, the send
 * approvals backlog, AI usage by workspace and workspace AI keys the provider refused. Pure functions over Deps; the
 * route layer adds the permission guard, the reason and the platform audit.
 *
 * Never returned: run results, steps and inputs, trigger instructions and title templates, webhook secrets or their
 * hints, approval payloads (the message), AI keys or their hints. Paging follows the console contract in ./jobs.ts.
 */
import { and, eq, gte, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { agentRuns, agents, agentTriggers, aiKeys, aiUsageDaily, organizations, sendApprovals, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { containsAny } from "../../lib/like-search";
import { inIds } from "../../lib/sql-chunks";
import { newestRows } from "./recent-rows";
import { cancelRun, RUN_CANCEL_REASON_MAX, RUN_STATUSES, type RunStatus } from "../suite/agent-runs";
import { updateTrigger } from "../suite/agent-triggers";
import type { SuiteActor } from "../suite/common";
import { DAY_MS, iso, ms, pageParts, windowStart, type ConsolePage, type ConsolePageResult, type SortDef } from "./jobs";

/** The operator acting (from the console session). Mutations run as this person, with workspace-admin rights. */
export interface ConsoleOperator { userId: string; email: string; name?: string | null }

function actorFor(op: ConsoleOperator, orgId: string): SuiteActor {
  return { orgId, userId: op.userId, email: op.email, name: op.name || op.email, role: "admin" };
}

// ------------------------------------------------------------------ agent runs

/** Runs older than this that are still queued or running count as long-running. */
export const LONG_RUNNING_MS = 30 * 60_000;
/** At most this many long-running runs are looked up for one list (they are active runs, so few). */
export const LONG_RUNNING_MAX = 500;
/**
 * The literal conditions of the partial indexes the run lists read (SQLite only uses a partial index when the query
 * repeats its WHERE): agent_runs_failed_created_idx (0177) and agent_runs_active_uq (queued or running).
 */
const RUN_FAILED_SQL = sql`${agentRuns.status} = 'failed'`;
const RUN_ACTIVE_SQL = sql`${agentRuns.status} IN ('queued', 'running')`;

/** `attention` (the default) is failed runs plus queued or running ones past LONG_RUNNING_MS. */
export type AgentRunStatusFilter = RunStatus | "attention" | "long_running" | "all";
export const AGENT_RUN_STATUS_FILTERS: readonly AgentRunStatusFilter[] = [...RUN_STATUSES, "attention", "long_running", "all"];

export const AGENT_RUN_SORT_FIELDS = ["createdAt", "updatedAt"] as const;
export type AgentRunSortField = (typeof AGENT_RUN_SORT_FIELDS)[number];
const AGENT_RUN_SORTS: Record<AgentRunSortField, SortDef> = {
  createdAt: { expr: agentRuns.createdAt, kind: "number" },
  updatedAt: { expr: agentRuns.updatedAt, kind: "number" },
};

export interface AgentRunFilters {
  status?: AgentRunStatusFilter;
  orgId?: string;
  /** Days back from now on created_at, 1..90 (default 7). */
  days?: number;
  /** Workspace name or id, or the agent's name, contains this (case blind). */
  q?: string;
}

/** A trimmed search (at most 100 characters), or undefined when empty. */
function searchOf(q: string | undefined): string | undefined {
  const t = (q ?? "").trim().slice(0, 100);
  return t || undefined;
}

export interface ConsoleAgentRun {
  id: string; orgId: string; workspaceName: string | null;
  taskId: string; agentUserId: string; agentName: string | null;
  status: RunStatus; triggerId: string | null; createdByUserId: string | null; stepCount: number;
  startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string;
  /** Finished runs: how long they took. Active runs: how long they have been going (from start, or from queueing). */
  durationMs: number | null;
  /** Queued or running for longer than LONG_RUNNING_MS. */
  longRunning: boolean;
}

/**
 * Agent runs across workspaces inside a created_at window (default 7 days), by default the ones that need a look.
 * D1: failed runs come from the partial agent_runs_failed_created_idx (0177); long-running ones are found first among
 * the active runs through the partial agent_runs_active_uq (queued or running, so few), then fetched by id. With a
 * workspace, agent_runs_creator_td6_idx (org_id, ...) narrows by org_id. Any other status across every workspace has
 * no index (a full one would cost row writes on every run's status change), so it looks at the newest
 * RECENT_ROWS_CAP runs only (recent-rows.ts).
 */
export async function listAgentRuns(deps: Deps, filters: AgentRunFilters, page: ConsolePage<AgentRunSortField>): Promise<ConsolePageResult<ConsoleAgentRun>> {
  const status = filters.status ?? "attention";
  if (!AGENT_RUN_STATUS_FILTERS.includes(status)) throw new HttpError(422, "validation_failed", `status is one of ${AGENT_RUN_STATUS_FILTERS.join(", ")}.`);
  const p = pageParts(page, AGENT_RUN_SORTS, agentRuns.id);
  const now = deps.now().getTime();
  const since = windowStart(deps, filters.days, 7);
  const longBefore = now - LONG_RUNNING_MS;
  const q = searchOf(filters.q);
  const longRunning = or(
    and(eq(agentRuns.status, "running"), sql`coalesce(${agentRuns.startedAt}, ${agentRuns.createdAt}) <= ${longBefore}`),
    and(eq(agentRuns.status, "queued"), lte(agentRuns.createdAt, new Date(longBefore))),
  );
  const longIds = status === "attention" || status === "long_running"
    ? (await deps.db.select({ id: agentRuns.id }).from(agentRuns)
      .where(and(RUN_ACTIVE_SQL, longRunning, gte(agentRuns.createdAt, since), filters.orgId ? eq(agentRuns.orgId, filters.orgId) : undefined))
      .limit(LONG_RUNNING_MAX)).map((r) => r.id)
    : [];
  const failedRecent = and(RUN_FAILED_SQL, gte(agentRuns.createdAt, since));
  // With no long-running run the condition is the failed one alone, so SQLite reads only the partial index.
  const statusCond = status === "attention" ? (longIds.length ? or(failedRecent, inIds(agentRuns.id, longIds)) : failedRecent)
    : status === "long_running" ? inIds(agentRuns.id, longIds)
      : status === "failed" ? RUN_FAILED_SQL
        : and(status === "all" ? undefined : eq(agentRuns.status, status), filters.orgId ? undefined : newestRows(agentRuns));
  const rows = await deps.db.select({
    id: agentRuns.id, orgId: agentRuns.orgId, workspaceName: organizations.name, taskId: agentRuns.taskId,
    agentUserId: agentRuns.agentUserId, agentName: users.name, status: agentRuns.status, triggerId: agentRuns.triggerId,
    createdByUserId: agentRuns.createdByUserId, stepCount: agentRuns.stepCount, startedAt: agentRuns.startedAt, finishedAt: agentRuns.finishedAt,
    createdAt: agentRuns.createdAt, updatedAt: agentRuns.updatedAt,
  }).from(agentRuns)
    .leftJoin(organizations, eq(organizations.id, agentRuns.orgId))
    .leftJoin(users, eq(users.id, agentRuns.agentUserId))
    .where(and(
      gte(agentRuns.createdAt, since), filters.orgId ? eq(agentRuns.orgId, filters.orgId) : undefined, statusCond,
      q ? containsAny([organizations.name, agentRuns.orgId, users.name], q) : undefined,
      p.after,
    ))
    .orderBy(...p.orderBy).limit(p.take);
  return p.finish(rows, (r) => ({ v: p.field === "updatedAt" ? ms(r.updatedAt) : ms(r.createdAt), id: r.id }), (r) => {
    const active = r.status === "queued" || r.status === "running";
    const from = r.status === "running" ? r.startedAt ?? r.createdAt : r.status === "queued" ? r.createdAt : r.startedAt;
    const to = active ? now : r.finishedAt ? ms(r.finishedAt) : null;
    return {
      id: r.id, orgId: r.orgId, workspaceName: r.workspaceName ?? null, taskId: r.taskId,
      agentUserId: r.agentUserId, agentName: r.agentName ?? null, status: r.status, triggerId: r.triggerId ?? null,
      createdByUserId: r.createdByUserId ?? null, stepCount: r.stepCount,
      startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!,
      durationMs: from && to !== null ? Math.max(0, to - ms(from)) : null,
      longRunning: active && !!from && now - ms(from) > LONG_RUNNING_MS,
    };
  });
}

export interface CancelAgentRunResult { id: string; orgId: string; previousStatus: RunStatus; status: RunStatus }

/**
 * Cancels a queued or running run through services/suite/agent-runs.ts cancelRun, acting as the operator with
 * workspace-admin rights: the run's own rules apply (409 run_finished for a finished run; an already cancelled run
 * answers unchanged) and the workspace's audit log gets its usual agent_run.cancelled entry naming the operator.
 */
export async function cancelAgentRun(deps: Deps, op: ConsoleOperator, runId: string, reason?: string | null): Promise<CancelAgentRunResult> {
  const row = await deps.db.select({ orgId: agentRuns.orgId, status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, runId)).get();
  if (!row) throw notFound("Run");
  const why = typeof reason === "string" ? reason.trim().slice(0, RUN_CANCEL_REASON_MAX) || null : null;
  const { run } = await cancelRun(deps, actorFor(op, row.orgId), runId, { reason: why });
  return { id: runId, orgId: row.orgId, previousStatus: row.status, status: run.status };
}

// ------------------------------------------------------------------ agent triggers

export const AGENT_TRIGGER_SORT_FIELDS = ["createdAt", "updatedAt", "fireCount"] as const;
export type AgentTriggerSortField = (typeof AGENT_TRIGGER_SORT_FIELDS)[number];
const AGENT_TRIGGER_SORTS: Record<AgentTriggerSortField, SortDef> = {
  createdAt: { expr: agentTriggers.createdAt, kind: "number" },
  updatedAt: { expr: agentTriggers.updatedAt, kind: "number" },
  fireCount: { expr: agentTriggers.fireCount, kind: "number" },
};

export interface AgentTriggerFilters {
  enabled?: boolean; orgId?: string; kind?: "schedule" | "webhook";
  /** Trigger name, workspace name or id, or agent name contains this (case blind). */
  q?: string;
}

export interface ConsoleAgentTrigger {
  id: string; orgId: string; workspaceName: string | null;
  name: string; kind: "schedule" | "webhook"; enabled: boolean;
  agentUserId: string; agentName: string | null;
  nextRunAt: string | null; lastFiredAt: string | null; fireCount: number;
  createdAt: string; updatedAt: string;
}

/**
 * Agent triggers across workspaces. D1: with a workspace, agent_triggers_org_idx (org_id). Across workspaces it scans
 * agent_triggers, which a workspace caps at TRIGGERS_PER_WORKSPACE (20) rows; agent_triggers_due_idx is partial
 * (enabled schedules) and does not serve this list (index missing for a cross-workspace enabled filter).
 */
export async function listAgentTriggers(deps: Deps, filters: AgentTriggerFilters, page: ConsolePage<AgentTriggerSortField>): Promise<ConsolePageResult<ConsoleAgentTrigger>> {
  if (filters.kind && filters.kind !== "schedule" && filters.kind !== "webhook") throw new HttpError(422, "validation_failed", "kind is schedule or webhook.");
  const p = pageParts(page, AGENT_TRIGGER_SORTS, agentTriggers.id);
  const rows = await deps.db.select({
    id: agentTriggers.id, orgId: agentTriggers.orgId, workspaceName: organizations.name, name: agentTriggers.name, kind: agentTriggers.kind,
    enabled: agentTriggers.enabled, agentUserId: agentTriggers.agentUserId, agentName: users.name, nextRunAt: agentTriggers.nextRunAt,
    lastFiredAt: agentTriggers.lastFiredAt, fireCount: agentTriggers.fireCount, createdAt: agentTriggers.createdAt, updatedAt: agentTriggers.updatedAt,
  }).from(agentTriggers)
    .leftJoin(organizations, eq(organizations.id, agentTriggers.orgId))
    .leftJoin(users, eq(users.id, agentTriggers.agentUserId))
    .where(and(
      filters.enabled === undefined ? undefined : eq(agentTriggers.enabled, filters.enabled),
      filters.orgId ? eq(agentTriggers.orgId, filters.orgId) : undefined,
      filters.kind ? eq(agentTriggers.kind, filters.kind) : undefined,
      searchOf(filters.q) ? containsAny([agentTriggers.name, organizations.name, agentTriggers.orgId, users.name], searchOf(filters.q)!) : undefined,
      p.after,
    )).orderBy(...p.orderBy).limit(p.take);
  return p.finish(rows, (r) => ({ v: p.field === "fireCount" ? r.fireCount : p.field === "updatedAt" ? ms(r.updatedAt) : ms(r.createdAt), id: r.id }), (r) => ({
    id: r.id, orgId: r.orgId, workspaceName: r.workspaceName ?? null, name: r.name, kind: r.kind, enabled: r.enabled,
    agentUserId: r.agentUserId, agentName: r.agentName ?? null,
    nextRunAt: r.kind === "schedule" && r.enabled ? iso(r.nextRunAt) : null, lastFiredAt: iso(r.lastFiredAt), fireCount: r.fireCount,
    createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!,
  }));
}

export interface SetTriggerPausedResult { id: string; orgId: string; enabled: boolean; changed: boolean; nextRunAt: string | null }

/**
 * Pauses (enabled = false) or resumes a trigger through services/suite/agent-triggers.ts updateTrigger, acting as the
 * operator with workspace-admin rights: resuming a schedule recomputes its next run, and the workspace's audit log
 * gets its usual agent_trigger.updated entry naming the operator. No change, no write.
 */
export async function setAgentTriggerPaused(deps: Deps, op: ConsoleOperator, triggerId: string, paused: boolean): Promise<SetTriggerPausedResult> {
  const row = await deps.db.select({ orgId: agentTriggers.orgId, enabled: agentTriggers.enabled }).from(agentTriggers).where(eq(agentTriggers.id, triggerId)).get();
  if (!row) throw notFound("Trigger");
  const t = await updateTrigger(deps, actorFor(op, row.orgId), triggerId, { enabled: !paused });
  return { id: triggerId, orgId: row.orgId, enabled: t.enabled, changed: row.enabled !== t.enabled, nextRunAt: t.nextRunAt };
}

// ------------------------------------------------------------------ send approvals backlog

export const SEND_APPROVAL_SORT_FIELDS = ["createdAt", "expiresAt"] as const;
export type SendApprovalSortField = (typeof SEND_APPROVAL_SORT_FIELDS)[number];
const SEND_APPROVAL_SORTS: Record<SendApprovalSortField, SortDef> = {
  createdAt: { expr: sendApprovals.createdAt, kind: "number" },
  expiresAt: { expr: sendApprovals.expiresAt, kind: "number" },
};

export interface ConsolePendingApproval {
  id: string; orgId: string; workspaceName: string | null;
  agentId: string; agentName: string | null; mailboxId: string;
  createdAt: string; expiresAt: string;
  /** How long it has waited for a person. */
  ageMs: number;
  /** Past its expiry and not yet swept by maintenance. */
  overdue: boolean;
}

/**
 * Agent sends waiting for a person's approval, oldest first by default. Pending rows expire (maintenance marks them
 * expired), so the set is bounded. D1: with a workspace, send_approvals_org_status_idx (org_id, status, created_at)
 * serves it exactly; across workspaces the partial send_approvals_pending_created_idx (0177) holds only pending rows.
 */
export async function listPendingSendApprovals(deps: Deps, filters: { orgId?: string; q?: string }, page: ConsolePage<SendApprovalSortField>): Promise<ConsolePageResult<ConsolePendingApproval>> {
  const p = pageParts(page, SEND_APPROVAL_SORTS, sendApprovals.id);
  const now = deps.now().getTime();
  const rows = await deps.db.select({
    id: sendApprovals.id, orgId: sendApprovals.orgId, workspaceName: organizations.name, agentId: sendApprovals.agentId, agentName: agents.name,
    mailboxId: sendApprovals.mailboxId, createdAt: sendApprovals.createdAt, expiresAt: sendApprovals.expiresAt,
  }).from(sendApprovals)
    .leftJoin(organizations, eq(organizations.id, sendApprovals.orgId))
    .leftJoin(agents, eq(agents.id, sendApprovals.agentId))
    .where(and(
      // The partial index's own condition, written as a literal so SQLite can use it.
      sql`${sendApprovals.status} = 'pending'`, filters.orgId ? eq(sendApprovals.orgId, filters.orgId) : undefined,
      searchOf(filters.q) ? containsAny([organizations.name, sendApprovals.orgId, agents.name], searchOf(filters.q)!) : undefined,
      p.after,
    ))
    .orderBy(...p.orderBy).limit(p.take);
  return p.finish(rows, (r) => ({ v: p.field === "expiresAt" ? ms(r.expiresAt) : ms(r.createdAt), id: r.id }), (r) => ({
    id: r.id, orgId: r.orgId, workspaceName: r.workspaceName ?? null, agentId: r.agentId, agentName: r.agentName ?? null, mailboxId: r.mailboxId,
    createdAt: iso(r.createdAt)!, expiresAt: iso(r.expiresAt)!, ageMs: Math.max(0, now - ms(r.createdAt)), overdue: ms(r.expiresAt) <= now,
  }));
}

// ------------------------------------------------------------------ AI usage by workspace

export const AI_USAGE_SORT_FIELDS = ["units", "calls"] as const;
export type AiUsageSortField = (typeof AI_USAGE_SORT_FIELDS)[number];
const AI_USAGE_SORTS: Record<AiUsageSortField, SortDef> = {
  units: { expr: sql`sum(${aiUsageDaily.units})`, kind: "number" },
  calls: { expr: sql`sum(${aiUsageDaily.calls})`, kind: "number" },
};

export interface AiUsageWorkspace { orgId: string; workspaceName: string | null; units: number; calls: number; days: number }
export interface AiUsageTop extends ConsolePageResult<AiUsageWorkspace> {
  /** The UTC days counted, inclusive. */
  window: { from: string; to: string };
  /** The whole account over the same days (the meter's org_id "*" rows). */
  account: { units: number; calls: number };
}

/**
 * Workspaces by AI meter use over the last `days` UTC days (1..90, default 7), heaviest first. D1: the primary key
 * (day, org_id) serves the day range; the grouping and the keyset run on the aggregate (HAVING).
 */
export async function aiUsageTopWorkspaces(deps: Deps, filters: { days?: number }, page: ConsolePage<AiUsageSortField>): Promise<AiUsageTop> {
  const p = pageParts(page, AI_USAGE_SORTS, aiUsageDaily.orgId);
  const days = Number.isFinite(filters.days) ? Math.min(Math.max(Math.trunc(filters.days as number), 1), 90) : 7;
  const to = deps.now().toISOString().slice(0, 10);
  const from = new Date(deps.now().getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const [rows, total] = await Promise.all([
    deps.db.select({
      orgId: aiUsageDaily.orgId, workspaceName: organizations.name,
      units: sql<number>`sum(${aiUsageDaily.units})`, calls: sql<number>`sum(${aiUsageDaily.calls})`, days: sql<number>`count(*)`,
    }).from(aiUsageDaily).leftJoin(organizations, eq(organizations.id, aiUsageDaily.orgId))
      .where(and(gte(aiUsageDaily.day, from), ne(aiUsageDaily.orgId, "*")))
      .groupBy(aiUsageDaily.orgId, organizations.name).having(p.after).orderBy(...p.orderBy).limit(p.take),
    deps.db.select({ units: sql<number>`coalesce(sum(${aiUsageDaily.units}), 0)`, calls: sql<number>`coalesce(sum(${aiUsageDaily.calls}), 0)` })
      .from(aiUsageDaily).where(and(gte(aiUsageDaily.day, from), eq(aiUsageDaily.orgId, "*"))).get(),
  ]);
  const page1 = p.finish(rows, (r) => ({ v: Number(p.field === "calls" ? r.calls : r.units), id: r.orgId }), (r) => ({
    orgId: r.orgId, workspaceName: r.workspaceName ?? null, units: Number(r.units), calls: Number(r.calls), days: Number(r.days),
  }));
  return { ...page1, window: { from, to }, account: { units: Number(total?.units ?? 0), calls: Number(total?.calls ?? 0) } };
}

// ------------------------------------------------------------------ AI keys the provider refused

export const AI_KEY_PROBLEM_SORT_FIELDS = ["problemAt", "updatedAt"] as const;
export type AiKeyProblemSortField = (typeof AI_KEY_PROBLEM_SORT_FIELDS)[number];
const AI_KEY_PROBLEM_SORTS: Record<AiKeyProblemSortField, SortDef> = {
  problemAt: { expr: sql`coalesce(${aiKeys.problemAt}, ${aiKeys.updatedAt})`, kind: "number" },
  updatedAt: { expr: aiKeys.updatedAt, kind: "number" },
};

export type AiKeyProblem = "key_refused" | "no_credit" | "model_unavailable";
export interface ConsoleAiKeyProblem {
  orgId: string; workspaceName: string | null;
  provider: string; model: string; problem: AiKeyProblem;
  problemAt: string | null; updatedAt: string;
}

/**
 * Workspace AI keys the provider last refused (bad key, no credit, model gone). The key and its hint are never read.
 * D1: no index on ai_keys.problem, so this scans ai_keys (one row per workspace that saved a key; index missing:
 * ai_keys(problem_at) where problem is not null).
 */
export async function listAiKeyProblems(deps: Deps, filters: { problem?: AiKeyProblem; q?: string }, page: ConsolePage<AiKeyProblemSortField>): Promise<ConsolePageResult<ConsoleAiKeyProblem>> {
  const p = pageParts(page, AI_KEY_PROBLEM_SORTS, aiKeys.orgId);
  const rows = await deps.db.select({
    orgId: aiKeys.orgId, workspaceName: organizations.name, provider: aiKeys.provider, model: aiKeys.model, problem: aiKeys.problem,
    problemAt: aiKeys.problemAt, updatedAt: aiKeys.updatedAt,
  }).from(aiKeys).leftJoin(organizations, eq(organizations.id, aiKeys.orgId))
    .where(and(
      isNotNull(aiKeys.problem), filters.problem ? eq(aiKeys.problem, filters.problem) : undefined,
      searchOf(filters.q) ? containsAny([organizations.name, aiKeys.orgId], searchOf(filters.q)!) : undefined,
      p.after,
    ))
    .orderBy(...p.orderBy).limit(p.take);
  return p.finish(rows, (r) => ({ v: p.field === "updatedAt" ? ms(r.updatedAt) : ms(r.problemAt ?? r.updatedAt), id: r.orgId }), (r) => ({
    orgId: r.orgId, workspaceName: r.workspaceName ?? null, provider: r.provider, model: r.model.slice(0, 120), problem: r.problem as AiKeyProblem,
    problemAt: iso(r.problemAt), updatedAt: iso(r.updatedAt)!,
  }));
}
