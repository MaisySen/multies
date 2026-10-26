/**
 * R27 (DF-3 slice 2): AI agent members work on tasks themselves, with a run log. A run is one agent's go at one
 * task: it starts (or is queued by a person or a workspace key), records ordered steps (note, tool, comment,
 * status_change), and finishes with a status and a result. The run shows on the task and every start and finish
 * writes an audit entry naming the agent and the task. ADR 0008, "Slice 2: agent runs".
 *
 * D1 cost: one table, steps kept as a JSON array appended in place with json_insert, so a step is one row write and
 * touches no index. Starting writes the row and two index entries, finishing the row and one index entry; each also
 * writes one audit row. The same service backs the app (agent-runs-r27.ts), REST (v1-r27-agent-runs.ts) and MCP
 * (mcp-r27-agent-runs.ts).
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { agentRuns, members, projects, projectStatuses, taskComments, tasks, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { inChunks } from "../../lib/sql-chunks";
import { audit } from "../audit";
import { assertWritable, sortableId, type SuiteActor } from "./common";
import { defaultColor } from "./agent-members-r26";
import { addComment, mentionedMembers, resolveTaskId, updateTask } from "./tasks";

export const RUN_STEPS_MAX = 200;
export const RUN_STEP_TEXT_MAX = 1000;
export const RUN_RESULT_MAX = 4000;
export const RUN_LIST_MAX = 200;
export const RUN_STEP_KINDS = ["note", "tool", "comment", "status_change"] as const;
export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStepKind = (typeof RUN_STEP_KINDS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type FinishStatus = "succeeded" | "failed" | "cancelled";
const ACTIVE: RunStatus[] = ["queued", "running"];

type Row = typeof agentRuns.$inferSelect;
export interface RunStep { at: string; kind: RunStepKind; text: string }
export interface AgentRun {
  id: string; taskId: string; task: { ref: string; title: string } | null;
  agent: { userId: string; name: string; avatarColor: string; isAgent: true };
  status: RunStatus; startedAt: string | null; finishedAt: string | null; durationMs: number | null;
  result: string | null; stepCount: number; steps: RunStep[]; createdAt: string; updatedAt: string;
}

const bad = (message: string) => new HttpError(422, "validation_failed", message);
const forbid = (code: string, message: string) => new HttpError(403, code, message);

/** The task with its reference (OPS-12), if this workspace has it and it is not deleted. */
async function taskFor(deps: Deps, orgId: string, idOrRef: string) {
  const id = await resolveTaskId(deps, orgId, idOrRef);
  const t = await deps.db.select({ id: tasks.id, title: tasks.title, notes: tasks.notes, projectId: tasks.projectId, status: tasks.status, assigneeType: tasks.assigneeType, assigneeId: tasks.assigneeId, key: projects.key, number: tasks.number })
    .from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.orgId, orgId), eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!t) throw notFound("Task");
  return { ...t, ref: `${t.key ?? "TSK"}-${t.number}` };
}

/** An agent member of this workspace (members.kind = 'agent'), or null. */
async function agentMember(deps: Deps, orgId: string, userId: string) {
  if (!userId) return null;
  const r = await deps.db.select({ userId: members.userId, kind: members.kind, disabledAt: members.disabledAt, avatarColor: members.avatarColor, name: users.name })
    .from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), eq(members.userId, userId))).get();
  return r && r.kind === "agent" ? r : null;
}

/** The acting agent member when the caller is one (its own key), else null. */
async function actingAgent(deps: Deps, a: SuiteActor) {
  if (a.system || a.agentId || !a.userId) return null;
  return agentMember(deps, a.orgId, a.userId);
}

function parseSteps(s: string): RunStep[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v as RunStep[] : []; } catch { return []; }
}

async function present(deps: Deps, orgId: string, rows: Row[], withSteps = true): Promise<AgentRun[]> {
  if (!rows.length) return [];
  const agentIds = [...new Set(rows.map((r) => r.agentUserId))];
  const taskIds = [...new Set(rows.map((r) => r.taskId))];
  const [agents, ts] = await Promise.all([
    inChunks(agentIds, (ids) => deps.db.select({ userId: users.id, name: users.name, avatarColor: members.avatarColor }).from(users)
      .leftJoin(members, and(eq(members.userId, users.id), eq(members.organizationId, orgId))).where(inArray(users.id, ids))),
    inChunks(taskIds, (ids) => deps.db.select({ id: tasks.id, title: tasks.title, number: tasks.number, key: projects.key }).from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId)).where(and(eq(tasks.orgId, orgId), inArray(tasks.id, ids)))),
  ]);
  const am = new Map(agents.map((x) => [x.userId, x]));
  const tm = new Map(ts.map((x) => [x.id, x]));
  return rows.map((r) => {
    const ag = am.get(r.agentUserId);
    const t = tm.get(r.taskId);
    const end = r.finishedAt ?? null;
    return {
      id: r.id, taskId: r.taskId, task: t ? { ref: `${t.key ?? "TSK"}-${t.number}`, title: t.title } : null,
      agent: { userId: r.agentUserId, name: ag?.name ?? "Removed agent", avatarColor: ag?.avatarColor ?? defaultColor(r.agentUserId), isAgent: true as const },
      status: r.status, startedAt: r.startedAt ? r.startedAt.toISOString() : null, finishedAt: end ? end.toISOString() : null,
      durationMs: r.startedAt && end ? Math.max(0, end.getTime() - r.startedAt.getTime()) : null,
      result: r.result, stepCount: r.stepCount, steps: withSteps ? parseSteps(r.steps) : [],
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    };
  });
}

async function runRow(deps: Deps, orgId: string, id: string) {
  const r = await deps.db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, id))).get();
  if (!r) throw notFound("Run");
  // A deleted task hides its runs.
  const t = await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, r.taskId), isNull(tasks.deletedAt))).get();
  if (!t) throw notFound("Run");
  return r;
}

/** Whether the agent is assigned to the task, or named on it (<@member:id> or @Name in the notes or a comment). */
async function agentOnTask(deps: Deps, orgId: string, t: Awaited<ReturnType<typeof taskFor>>, agentUserId: string) {
  if (t.assigneeType === "member" && t.assigneeId === agentUserId) return true;
  const comments = await deps.db.select({ body: taskComments.body }).from(taskComments)
    .where(and(eq(taskComments.taskId, t.id), isNull(taskComments.deletedAt))).orderBy(desc(taskComments.createdAt)).limit(200);
  const text = [t.notes ?? "", ...comments.map((c) => c.body)].filter((x) => x.includes("@")).join("\n");
  if (!text) return false;
  return (await mentionedMembers(deps, orgId, text)).includes(agentUserId);
}

async function writeAudit(deps: Deps, a: SuiteActor, action: string, run: { id: string; agentUserId: string; status: string }, agentName: string, t: { id: string; ref: string; title: string }) {
  const byAgent = !!a.userId && a.userId === run.agentUserId;
  await audit(deps.db, {
    orgId: a.orgId, actorUserId: a.userId || null, actorEmail: a.email ?? null, action, targetType: "task", targetId: t.id,
    metadata: { runId: run.id, agentUserId: run.agentUserId, agentName, taskRef: t.ref, taskTitle: t.title.slice(0, 140), status: run.status, byAgent, via: a.apiKeyId ? "api" : "app" },
  });
}

export interface StartRunInput { agentUserId?: string; moveToDoing?: boolean; note?: string }

/**
 * Starts a run. An agent member's own key starts its run on a task it is assigned to or mentioned on, or claims a
 * run queued for it. A person or a full workspace key queues a run for a named agent member (the explicit allowance).
 */
export async function startRun(deps: Deps, a: SuiteActor, taskIdOrRef: string, input: StartRunInput = {}) {
  assertWritable(a);
  if (a.agentId) throw forbid("agent_member_only", "Only an AI agent member's key can run tasks. Mail agent keys can't.");
  const t = await taskFor(deps, a.orgId, taskIdOrRef);
  const me = await actingAgent(deps, a);
  const now = deps.now();
  const note = input.note?.trim();
  if (note && note.length > RUN_STEP_TEXT_MAX) throw bad(`A step is at most ${RUN_STEP_TEXT_MAX} characters.`);

  let agentUserId: string;
  let agentName: string;
  let status: RunStatus;
  if (me) {
    if (input.agentUserId && input.agentUserId !== me.userId) throw forbid("not_this_agent", "An agent's key can only start its own runs.");
    agentUserId = me.userId; agentName = me.name; status = "running";
  } else {
    if (!input.agentUserId) throw bad("Name the agent member to queue a run for (agentUserId).");
    const ag = await agentMember(deps, a.orgId, input.agentUserId);
    if (!ag) throw bad("agentUserId is not an AI agent member of this workspace.");
    if (ag.disabledAt) throw new HttpError(409, "agent_paused", "That agent is paused. Resume it first.");
    agentUserId = ag.userId; agentName = ag.name; status = "queued";
  }

  const active = await deps.db.select().from(agentRuns)
    .where(and(eq(agentRuns.taskId, t.id), eq(agentRuns.agentUserId, agentUserId), inArray(agentRuns.status, ACTIVE))).get();
  let id: string;
  if (active && (active.status === "running" || !me)) {
    throw new HttpError(409, "run_in_progress", `${agentName} already has a ${active.status} run on ${t.ref}. Finish it first.`);
  }
  const firstSteps = JSON.stringify(note ? [{ at: now.toISOString(), kind: "note", text: note }] : []);
  if (active) {
    // The agent claims the run a person queued for it.
    id = active.id;
    await deps.db.update(agentRuns).set({
      status: "running", startedAt: now, updatedAt: now,
      ...(note ? { steps: sql`json_insert(${agentRuns.steps}, '$[#]', json(${JSON.stringify({ at: now.toISOString(), kind: "note", text: note })}))`, stepCount: sql`${agentRuns.stepCount} + 1` } : {}),
    }).where(eq(agentRuns.id, id));
  } else {
    if (me && !(await agentOnTask(deps, a.orgId, t, agentUserId))) {
      throw forbid("agent_not_on_task", `${agentName} isn't assigned to or mentioned on ${t.ref}. Assign it, mention it, or have a person queue a run for it.`);
    }
    id = sortableId("run", now.getTime());
    try {
      await deps.db.insert(agentRuns).values({
        id, orgId: a.orgId, taskId: t.id, agentUserId, status, startedAt: status === "running" ? now : null,
        steps: firstSteps, stepCount: note ? 1 : 0, createdByUserId: a.userId || null, createdAt: now, updatedAt: now,
      });
    } catch (err) {
      // Two starts at once: the partial unique index keeps one.
      if (String((err as Error)?.message ?? err).toLowerCase().includes("unique")) throw new HttpError(409, "run_in_progress", `${agentName} already has a run on ${t.ref}.`);
      throw err;
    }
  }
  await writeAudit(deps, a, status === "running" ? "agent_run.started" : "agent_run.queued", { id, agentUserId, status }, agentName, t);
  if (me && input.moveToDoing && t.status !== "doing") await updateTask(deps, a, t.id, { status: "doing" });
  return (await present(deps, a.orgId, [await runRow(deps, a.orgId, id)]))[0];
}

/** Appends one step. Only the run's own agent; a queued run becomes running on its first step. */
export async function addRunStep(deps: Deps, a: SuiteActor, runId: string, input: { kind?: string; text: string }) {
  assertWritable(a);
  const r = await runRow(deps, a.orgId, runId);
  const me = await actingAgent(deps, a);
  if (!me || me.userId !== r.agentUserId) throw forbid("not_this_agent", "Only the run's own agent can add steps.");
  const kind = (input.kind ?? "note") as RunStepKind;
  if (!RUN_STEP_KINDS.includes(kind)) throw bad(`kind is one of ${RUN_STEP_KINDS.join(", ")}.`);
  const text = (input.text ?? "").trim();
  if (!text) throw bad("A step needs text.");
  if (text.length > RUN_STEP_TEXT_MAX) throw bad(`A step is at most ${RUN_STEP_TEXT_MAX} characters.`);
  if (!ACTIVE.includes(r.status)) throw new HttpError(409, "run_finished", `This run is ${r.status}.`);
  if (r.stepCount >= RUN_STEPS_MAX) throw new HttpError(422, "run_step_limit", `A run holds at most ${RUN_STEPS_MAX} steps. Finish it and start a new one.`);
  const now = deps.now();
  const step: RunStep = { at: now.toISOString(), kind, text };
  // One statement: the cap and the status are checked by the same write, so two steps at once can't pass the cap.
  const res = await deps.db.update(agentRuns).set({
    steps: sql`json_insert(${agentRuns.steps}, '$[#]', json(${JSON.stringify(step)}))`,
    stepCount: sql`${agentRuns.stepCount} + 1`, updatedAt: now,
    ...(r.status === "queued" ? { status: "running" as const, startedAt: now } : {}),
  }).where(and(eq(agentRuns.id, r.id), inArray(agentRuns.status, ACTIVE), sql`${agentRuns.stepCount} < ${RUN_STEPS_MAX}`)).returning({ n: agentRuns.stepCount });
  if (!res.length) throw new HttpError(409, "run_changed", "The run finished or filled up meanwhile.");
  return { runId: r.id, step, stepCount: res[0].n };
}

export interface FinishRunInput { status: FinishStatus; result?: string | null; moveTo?: "done" | "review" | null; comment?: boolean }

/**
 * Finishes a run with succeeded, failed or cancelled and a result summary. The run's agent can finish it; a person
 * or a workspace key can only cancel it. The agent can move the task to done or to a review status and post the
 * result as its own comment on the task.
 */
export async function finishRun(deps: Deps, a: SuiteActor, runId: string, input: FinishRunInput) {
  assertWritable(a);
  if (a.agentId) throw forbid("agent_member_only", "Only an AI agent member's key can run tasks. Mail agent keys can't.");
  const r = await runRow(deps, a.orgId, runId);
  const me = await actingAgent(deps, a);
  const own = !!me && me.userId === r.agentUserId;
  if (me && !own) throw forbid("not_this_agent", "Only the run's own agent can finish it.");
  if (!own && input.status !== "cancelled") throw forbid("cancel_only", "A person or a workspace key can only cancel a run.");
  if (!["succeeded", "failed", "cancelled"].includes(input.status)) throw bad("status is succeeded, failed or cancelled.");
  if (!ACTIVE.includes(r.status)) throw new HttpError(409, "run_finished", `This run is already ${r.status}.`);
  const result = input.result?.trim() || null;
  if (result && result.length > RUN_RESULT_MAX) throw bad(`A result is at most ${RUN_RESULT_MAX} characters.`);
  if ((input.moveTo || input.comment) && !own) throw forbid("not_this_agent", "Only the run's own agent can move the task or comment.");
  if (input.comment && !result) throw bad("Write a result to post it as a comment.");
  const t = await taskFor(deps, a.orgId, r.taskId);
  // Check the review status before writing anything.
  let reviewStatusId: string | null = null;
  if (input.moveTo === "review") {
    const sts = await deps.db.select({ id: projectStatuses.id, name: projectStatuses.name }).from(projectStatuses)
      .where(and(eq(projectStatuses.projectId, t.projectId), isNull(projectStatuses.deletedAt)));
    reviewStatusId = sts.find((s) => /review/i.test(s.name))?.id ?? null;
    if (!reviewStatusId) throw bad(`${t.ref}'s project has no review status. Use moveTo "done" or add a status named "In review".`);
  }
  const now = deps.now();
  const res = await deps.db.update(agentRuns).set({ status: input.status, finishedAt: now, startedAt: r.startedAt ?? now, result, updatedAt: now })
    .where(and(eq(agentRuns.id, r.id), inArray(agentRuns.status, ACTIVE))).returning({ id: agentRuns.id });
  if (!res.length) throw new HttpError(409, "run_finished", "This run finished meanwhile.");
  const agentName = me?.name ?? (await agentMember(deps, a.orgId, r.agentUserId))?.name ?? "Removed agent";
  await writeAudit(deps, a, "agent_run.finished", { id: r.id, agentUserId: r.agentUserId, status: input.status }, agentName, t);
  let comment: unknown = null;
  if (own && input.comment && result) comment = await addComment(deps, a, t.id, result);
  if (own && input.moveTo === "done" && t.status !== "done") await updateTask(deps, a, t.id, { status: "done" });
  if (own && reviewStatusId) await updateTask(deps, a, t.id, { statusId: reviewStatusId });
  const run = (await present(deps, a.orgId, [await runRow(deps, a.orgId, r.id)]))[0];
  return comment ? { run, comment } : { run };
}

export async function getRun(deps: Deps, a: SuiteActor, runId: string) {
  return (await present(deps, a.orgId, [await runRow(deps, a.orgId, runId)]))[0];
}

/** A task's runs, newest first. */
export async function listTaskRuns(deps: Deps, a: SuiteActor, taskIdOrRef: string, opts: { limit?: number } = {}) {
  const t = await taskFor(deps, a.orgId, taskIdOrRef);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), RUN_LIST_MAX);
  const rows = await deps.db.select().from(agentRuns).where(and(eq(agentRuns.orgId, a.orgId), eq(agentRuns.taskId, t.id)))
    .orderBy(desc(agentRuns.createdAt)).limit(limit);
  return { taskId: t.id, ref: t.ref, runs: await present(deps, a.orgId, rows) };
}

/** Runs across the workspace, newest first, by agent and status; steps are left out (open a run for them). */
export async function listRuns(deps: Deps, a: SuiteActor, opts: { agentUserId?: string; status?: string; limit?: number } = {}) {
  if (opts.status && !RUN_STATUSES.includes(opts.status as RunStatus)) throw bad(`status is one of ${RUN_STATUSES.join(", ")}.`);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), RUN_LIST_MAX);
  const rows = await deps.db.select().from(agentRuns)
    .where(and(eq(agentRuns.orgId, a.orgId), opts.agentUserId ? eq(agentRuns.agentUserId, opts.agentUserId) : undefined, opts.status ? eq(agentRuns.status, opts.status as RunStatus) : undefined))
    .orderBy(desc(agentRuns.createdAt)).limit(limit);
  return { runs: await present(deps, a.orgId, rows, false) };
}
