/**
 * R90: the flow engine. A run walks the graph one step at a time. Every step is claimed by inserting its
 * (run, node, attempt) row first; the unique index means a step attempt runs once even when two passes
 * race. Waits and approvals park the run (status waiting or waiting_approval); the maintenance pass
 * resumes due waits, a person decides approvals, and a failed run can be retried from its failed step.
 * Each run counts against the plan's monthly automation allowance, like rules.
 */
import { inIds } from "@/server/lib/sql-chunks";
import { and, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { chatChannels, flowDigestItems, flowRuns, flowRunSteps, flows, flowWatches, members, organizations, users, webhookEndpoints } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import {
  ACTION_LABEL, KIND_LABEL, MAX_FLOWS, MAX_WATCHES, TASK_ONLY_ACTIONS, TRIGGER_FIELDS, WATCH_EVERY, evaluateCondition, fillPlaceholders, logJson, nextNode,
  nodeById, redact, stepBackoff, triggerNode, validateGraph, waitUntil,
  type Branch, type ConditionConfig, type FlowAction, type FlowGraph, type FlowNode, type FlowTrigger,
} from "@/shared/flows";
import type { SuiteActor } from "./common";

type FlowRow = typeof flows.$inferSelect;
type RunRow = typeof flowRuns.$inferSelect;
type StepRow = typeof flowRunSteps.$inferSelect;

const bad = (message: string) => new HttpError(422, "validation_failed", message);
const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found.`);
/** Steps one pass walks before it hands the rest to the next maintenance pass. */
export const STEPS_PER_PASS = 25;

export function assertFlows(deps: Deps) {
  if (deps.config.flows === false) throw new HttpError(404, "not_found", "Not found.");
}

export function parseGraph(raw: string): FlowGraph {
  try { const g = JSON.parse(raw) as FlowGraph; return { nodes: Array.isArray(g.nodes) ? g.nodes : [], edges: Array.isArray(g.edges) ? g.edges : [] }; } catch { return { nodes: [], edges: [] }; }
}

function presentFlow(f: FlowRow, watch?: typeof flowWatches.$inferSelect | null) {
  return {
    id: f.id, name: f.name, description: f.description, trigger: f.triggerKind, graph: parseGraph(f.graph), enabled: f.enabled, runCount: f.runCount,
    lastRunAt: f.lastRunAt?.toISOString() ?? null, lastStatus: f.lastStatus, updatedAt: f.updatedAt.toISOString(), createdAt: f.createdAt.toISOString(),
    watch: watch ? { url: watch.url, lastCheckedAt: watch.lastCheckedAt?.toISOString() ?? null, nextCheckAt: watch.nextCheckAt?.toISOString() ?? null, lastError: watch.lastError } : null,
  };
}

function presentRun(r: RunRow, flowName?: string) {
  return {
    id: r.id, flowId: r.flowId, flowName: flowName ?? null, status: r.status, currentNode: r.currentNode, error: r.error,
    trigger: JSON.parse(r.triggerData) as Record<string, unknown>, resumeAt: r.resumeAt?.toISOString() ?? null,
    startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

function presentStep(s: StepRow) {
  const parse = (v: string | null) => { if (v === null) return null; try { return JSON.parse(v) as unknown; } catch { return v; } };
  return { id: s.id, nodeId: s.nodeId, attempt: s.attempt, kind: s.kind, label: s.label, status: s.status, input: parse(s.input), output: parse(s.output), error: s.error, startedAt: s.startedAt.toISOString(), finishedAt: s.finishedAt?.toISOString() ?? null };
}

async function getFlowRow(deps: Deps, orgId: string, id: string) {
  const f = await deps.db.select().from(flows).where(and(eq(flows.id, id), eq(flows.orgId, orgId), isNull(flows.deletedAt))).get();
  if (!f) throw notFound("Flow");
  return f;
}

// ---------------------------------------------------------------- CRUD

export async function listFlows(deps: Deps, orgId: string) {
  assertFlows(deps);
  const rows = await deps.db.select().from(flows).where(and(eq(flows.orgId, orgId), isNull(flows.deletedAt))).orderBy(desc(flows.updatedAt)).limit(MAX_FLOWS);
  const { automationUsage } = await import("./automations");
  return { flows: rows.map((f) => presentFlow(f)), usage: await automationUsage(deps, orgId) };
}

export async function getFlow(deps: Deps, orgId: string, id: string) {
  assertFlows(deps);
  const f = await getFlowRow(deps, orgId, id);
  const w = await deps.db.select().from(flowWatches).where(eq(flowWatches.flowId, f.id)).get();
  return { flow: presentFlow(f, w) };
}

/** Server side checks the graph cannot make alone: the things it names belong to this workspace. */
async function checkReferences(deps: Deps, orgId: string, g: FlowGraph) {
  for (const n of g.nodes) {
    const c = n.config;
    if (n.kind === "trigger") {
      const t = c.trigger as FlowTrigger;
      if (t === "page_changed" || t === "feed_item") {
        const { checkWatchUrl } = await import("./flow-watch");
        // A blank address is a draft (a template just added); validateGraph keeps the flow off until it is filled.
        if (String(c.url ?? "").trim()) checkWatchUrl(deps, String(c.url));
        if (c.every !== undefined && !(WATCH_EVERY as readonly number[]).includes(Number(c.every))) throw bad("Pick how often to check.");
      }
    }
    if (n.kind === "action") {
      const a = c.action as FlowAction;
      if (a === "post_to_channel") {
        if (!c.channelId) continue;
        const ch = await deps.db.select({ id: chatChannels.id }).from(chatChannels).where(and(eq(chatChannels.id, String(c.channelId)), eq(chatChannels.orgId, orgId), eq(chatChannels.isPrivate, false))).get();
        if (!ch) throw bad("That channel is gone or private.");
      }
      if (a === "send_webhook") {
        if (!c.endpointId) continue;
        const e = await deps.db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(and(eq(webhookEndpoints.id, String(c.endpointId)), eq(webhookEndpoints.orgId, orgId))).get();
        if (!e) throw bad("That webhook is gone.");
      }
      if (a === "notify" && c.to && c.to !== "admins" && c.to !== "assignee") {
        const m = await deps.db.select({ id: members.userId }).from(members).where(and(eq(members.organizationId, orgId), eq(members.userId, String(c.to)))).get();
        if (!m) throw bad("That person is not in this workspace.");
      }
    }
    if (n.kind === "approval" && c.approver) {
      const m = await deps.db.select({ id: members.userId }).from(members).where(and(eq(members.organizationId, orgId), eq(members.userId, String(c.approver)))).get();
      if (!m) throw bad("The approver is not in this workspace.");
    }
  }
}

function checkShape(input: { name?: string; graph?: FlowGraph }) {
  if (input.name !== undefined && !input.name.trim()) throw bad("Give the flow a name.");
  if (input.graph && JSON.stringify(input.graph).length > 60_000) throw bad("The flow is too big to save.");
}

export async function createFlow(deps: Deps, actor: SuiteActor, input: { name: string; description?: string; graph: FlowGraph }) {
  assertFlows(deps);
  checkShape(input);
  const [{ n }] = await deps.db.select({ n: sql<number>`count(*)` }).from(flows).where(and(eq(flows.orgId, actor.orgId), isNull(flows.deletedAt)));
  if (n >= MAX_FLOWS) throw bad(`A workspace can have up to ${MAX_FLOWS} flows. Delete one you no longer use.`);
  const t = triggerNode(input.graph);
  if (!t) throw bad("Pick a trigger to start the flow.");
  await checkReferences(deps, actor.orgId, input.graph);
  const id = newId("flw");
  const now = deps.now();
  await deps.db.insert(flows).values({
    id, orgId: actor.orgId, name: input.name.trim().slice(0, 80), description: input.description?.slice(0, 300) ?? null, triggerKind: String(t.config.trigger ?? "manual"),
    graph: JSON.stringify(input.graph), enabled: false, createdByType: "member", createdById: actor.userId || null, createdAt: now, updatedAt: now,
  });
  return getFlow(deps, actor.orgId, id);
}

export async function updateFlow(deps: Deps, actor: SuiteActor, id: string, patch: { name?: string; description?: string | null; graph?: FlowGraph; enabled?: boolean }) {
  assertFlows(deps);
  checkShape(patch);
  const f = await getFlowRow(deps, actor.orgId, id);
  const graph = patch.graph ?? parseGraph(f.graph);
  const enabled = patch.enabled ?? f.enabled;
  if (patch.graph) await checkReferences(deps, actor.orgId, graph);
  if (enabled) {
    const problems = validateGraph(graph);
    if (problems.length) throw bad(`Fix this before turning the flow on: ${problems[0].message}`);
  }
  const t = triggerNode(graph);
  const triggerKind = String(t?.config.trigger ?? f.triggerKind);
  await deps.db.update(flows).set({
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 80) } : {}),
    ...(patch.description !== undefined ? { description: patch.description?.slice(0, 300) ?? null } : {}),
    graph: JSON.stringify(graph), enabled, triggerKind, updatedAt: deps.now(), version: sql`${flows.version} + 1`,
  }).where(eq(flows.id, f.id));
  await syncWatch(deps, actor.orgId, f.id, enabled ? t : undefined);
  return getFlow(deps, actor.orgId, id);
}

export async function deleteFlow(deps: Deps, actor: SuiteActor, id: string) {
  assertFlows(deps);
  const f = await getFlowRow(deps, actor.orgId, id);
  await deps.db.update(flows).set({ deletedAt: deps.now(), enabled: false }).where(eq(flows.id, f.id));
  await deps.db.delete(flowWatches).where(eq(flowWatches.flowId, f.id));
  await deps.db.update(flowRuns).set({ status: "cancelled", finishedAt: deps.now(), error: "The flow was deleted." }).where(and(eq(flowRuns.flowId, f.id), inArray(flowRuns.status, ["waiting", "waiting_approval"])));
  return { ok: true };
}

/** A page or feed trigger keeps one watch row; anything else (or a flow switched off) keeps none. */
async function syncWatch(deps: Deps, orgId: string, flowId: string, t: FlowNode | undefined) {
  const kind = t?.config.trigger === "page_changed" ? "page" : t?.config.trigger === "feed_item" ? "feed" : null;
  const existing = await deps.db.select().from(flowWatches).where(eq(flowWatches.flowId, flowId)).get();
  if (!kind || !t) { if (existing) await deps.db.delete(flowWatches).where(eq(flowWatches.id, existing.id)); return; }
  const url = String(t.config.url ?? "").trim();
  const selector = kind === "page" ? (String(t.config.selector ?? "").trim() || null) : null;
  const every = (WATCH_EVERY as readonly number[]).includes(Number(t.config.every)) ? Number(t.config.every) : 360;
  if (existing) {
    const changed = existing.url !== url || existing.selector !== selector || existing.kind !== kind;
    await deps.db.update(flowWatches).set({ url, selector, kind, everyMinutes: every, ...(changed ? { lastHash: null, lastText: null, seen: "[]", failCount: 0, lastError: null, nextCheckAt: deps.now() } : {}) }).where(eq(flowWatches.id, existing.id));
    return;
  }
  const [{ n }] = await deps.db.select({ n: sql<number>`count(*)` }).from(flowWatches).where(eq(flowWatches.orgId, orgId));
  if (n >= MAX_WATCHES) throw bad(`A workspace can watch up to ${MAX_WATCHES} pages and feeds.`);
  await deps.db.insert(flowWatches).values({ id: newId("fwt"), orgId, flowId, kind, url, selector, everyMinutes: every, nextCheckAt: deps.now(), createdAt: deps.now() });
}

// ---------------------------------------------------------------- runs

const flowActors = new WeakSet<object>();
/** The actor a flow's actions run as. Changes it makes count one level deeper for the loop guard. */
async function flowActor(orgId: string, name: string): Promise<SuiteActor> {
  const { ruleActorAt } = await import("./automations-r24");
  const a = ruleActorAt(orgId, `Flow: ${name}`, 1);
  flowActors.add(a);
  return a;
}
export const isFlowActor = (a?: SuiteActor | null) => !!a && flowActors.has(a);

/**
 * Starts one run of a flow for one trigger event. The dedupe key makes the same event start one run only
 * (a second call returns null). Returns the run id.
 */
export async function startRun(deps: Deps, f: FlowRow, triggerData: Record<string, unknown>, dedupeKey: string, opts: { force?: boolean } = {}): Promise<string | null> {
  if (!f.enabled && !opts.force) return null;
  const id = newId("frn");
  const now = deps.now();
  const inserted = await deps.db.insert(flowRuns).values({ id, orgId: f.orgId, flowId: f.id, dedupeKey: dedupeKey.slice(0, 200), triggerData: logJson(triggerData), startedAt: now, status: "running" })
    .onConflictDoNothing().returning({ id: flowRuns.id });
  if (!inserted.length) return null;
  const { takeRun } = await import("./automations");
  if (!(await takeRun(deps, f.orgId))) {
    await finish(deps, id, f.id, "failed", "Monthly automation runs used up. They start again next month, or upgrade for more.");
    return id;
  }
  await deps.db.update(flows).set({ runCount: sql`${flows.runCount} + 1`, lastRunAt: now, lastStatus: "running" }).where(eq(flows.id, f.id));
  const g = parseGraph(f.graph);
  const t = triggerNode(g);
  if (t) await deps.db.insert(flowRunSteps).values({ id: newId("fst"), orgId: f.orgId, runId: id, nodeId: t.id, attempt: 1, kind: "trigger", label: KIND_LABEL.trigger, status: "succeeded", output: logJson(triggerData), startedAt: now, finishedAt: now }).onConflictDoNothing();
  await advance(deps, id, t ? nextNode(g, t.id, "next") : null);
  return id;
}

async function finish(deps: Deps, runId: string, flowId: string, status: "succeeded" | "failed" | "cancelled", error: string | null, currentNode: string | null = null) {
  await deps.db.update(flowRuns).set({ status, error, finishedAt: deps.now(), resumeAt: null, currentNode }).where(eq(flowRuns.id, runId));
  await deps.db.update(flows).set({ lastStatus: status }).where(eq(flows.id, flowId));
}

async function runVars(deps: Deps, run: RunRow) {
  const steps = await deps.db.select({ nodeId: flowRunSteps.nodeId, output: flowRunSteps.output, status: flowRunSteps.status, attempt: flowRunSteps.attempt }).from(flowRunSteps).where(eq(flowRunSteps.runId, run.id));
  const out: Record<string, unknown> = {};
  for (const s of steps.sort((a, b) => a.attempt - b.attempt)) if (s.status === "succeeded" && s.output) { try { out[s.nodeId] = JSON.parse(s.output); } catch { /* kept as unreadable */ } }
  return { trigger: JSON.parse(run.triggerData) as Record<string, unknown>, steps: out, run: { id: run.id } };
}

/** Runs from `start` until the flow ends, parks, fails, or the pass budget is used. */
export async function advance(deps: Deps, runId: string, start: string | null): Promise<void> {
  const run = await deps.db.select().from(flowRuns).where(eq(flowRuns.id, runId)).get();
  if (!run || run.status !== "running") return;
  const f = await deps.db.select().from(flows).where(eq(flows.id, run.flowId)).get();
  if (!f || f.deletedAt) { await deps.db.update(flowRuns).set({ status: "cancelled", finishedAt: deps.now(), error: "The flow was deleted." }).where(eq(flowRuns.id, runId)); return; }
  const g = parseGraph(f.graph);
  const vars = await runVars(deps, run);
  let current = start;
  for (let n = 0; n < STEPS_PER_PASS; n++) {
    const node = nodeById(g, current);
    if (!node) { await finish(deps, runId, f.id, "succeeded", null); return; }
    const prior = await deps.db.select({ attempt: flowRunSteps.attempt, status: flowRunSteps.status, output: flowRunSteps.output }).from(flowRunSteps).where(and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.nodeId, node.id))).orderBy(desc(flowRunSteps.attempt)).limit(1);
    // A step that already succeeded (a race, or a resume after a crash) is followed, not run again.
    if (prior[0]?.status === "succeeded") {
      const branch = ((prior[0].output ? JSON.parse(prior[0].output) : {}) as { branch?: Branch }).branch ?? "next";
      current = nextNode(g, node.id, branch);
      continue;
    }
    const attempt = (prior[0]?.attempt ?? 0) + 1;
    const stepId = newId("fst");
    const claimed = await deps.db.insert(flowRunSteps).values({ id: stepId, orgId: f.orgId, runId, nodeId: node.id, attempt, kind: node.kind, label: (node.label || KIND_LABEL[node.kind]).slice(0, 80), status: "running", startedAt: deps.now() })
      .onConflictDoNothing().returning({ id: flowRunSteps.id });
    if (!claimed.length) return; // another pass holds this step
    await deps.db.update(flowRuns).set({ currentNode: node.id }).where(eq(flowRuns.id, runId));
    const done = async (status: StepRow["status"], output: unknown, error: string | null = null, input?: unknown) => {
      await deps.db.update(flowRunSteps).set({ status, output: output === undefined ? null : logJson(output), input: input === undefined ? null : logJson(input), error, finishedAt: status === "waiting" ? null : deps.now() }).where(eq(flowRunSteps.id, stepId));
    };
    switch (node.kind) {
      case "trigger": { await done("succeeded", vars.trigger); current = nextNode(g, node.id, "next"); continue; }
      case "stop": { await done("succeeded", { branch: "next" }); await finish(deps, runId, f.id, "succeeded", null); return; }
      case "condition": {
        const yes = evaluateCondition(node.config as unknown as ConditionConfig, vars);
        await done("succeeded", { result: yes ? "yes" : "no", branch: yes ? "yes" : "no" }, null, { rules: (node.config as Record<string, unknown>).rules ?? [] });
        current = nextNode(g, node.id, yes ? "yes" : "no");
        continue;
      }
      case "wait": {
        const at = new Date(waitUntil(deps.now().getTime(), node.config));
        await done("waiting", { until: at.toISOString() });
        await deps.db.update(flowRuns).set({ status: "waiting", resumeAt: at }).where(eq(flowRuns.id, runId));
        return;
      }
      case "approval": {
        const note = fillPlaceholders(String(node.config.note ?? `${f.name} needs your OK.`), vars).slice(0, 500);
        await done("waiting", { asked: note, approver: node.config.approver ?? "admins" });
        await deps.db.update(flowRuns).set({ status: "waiting_approval" }).where(eq(flowRuns.id, runId));
        await askApproval(deps, f, runId, node, note);
        return;
      }
      case "action": {
        const action = node.config.action as FlowAction;
        try {
          const actor = await flowActor(f.orgId, f.name);
          const res = await runAction(deps, f, runId, node, vars, actor);
          await done("succeeded", { ...res.output, branch: "next" }, null, res.input);
          vars.steps[node.id] = res.output;
          current = nextNode(g, node.id, "next");
          continue;
        } catch (err) {
          const message = err instanceof Error ? err.message.slice(0, 400) : "The step failed.";
          const retryable = !(err instanceof HttpError) && !(err instanceof StepError && !err.retry);
          await done("failed", undefined, message, { action, label: ACTION_LABEL[action] ?? action });
          const errorPath = nextNode(g, node.id, "error");
          const wait = retryable && !errorPath ? stepBackoff(attempt + 1) : null;
          if (wait !== null) {
            await deps.db.update(flowRuns).set({ status: "waiting", resumeAt: new Date(deps.now().getTime() + wait), error: `${message} Trying again soon.` }).where(eq(flowRuns.id, runId));
            return;
          }
          if (errorPath) { vars.steps[node.id] = { error: message }; current = errorPath; continue; }
          await finish(deps, runId, f.id, "failed", message, node.id);
          return;
        }
      }
    }
  }
  // Budget used: the next maintenance pass carries on from here.
  await deps.db.update(flowRuns).set({ status: "waiting", resumeAt: deps.now(), currentNode: current }).where(eq(flowRuns.id, runId));
}

/** A failure that is the setup's fault (a missing channel, a bad address): retrying will not help. */
export class StepError extends Error { constructor(message: string, readonly retry = false) { super(message); } }

async function admins(deps: Deps, orgId: string) {
  return (await deps.db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, orgId), inArray(members.role, ["owner", "admin"])))).map((r) => r.userId);
}

async function askApproval(deps: Deps, f: FlowRow, runId: string, node: FlowNode, note: string) {
  const { notify } = await import("./notify");
  const who = node.config.approver ? [String(node.config.approver)] : await admins(deps, f.orgId);
  for (const u of who) await notify(deps, f.orgId, u, { type: "automation.approval", entityType: "flow_run", entityId: runId, title: `Approve: ${note}`.slice(0, 200) }).catch(() => undefined);
}

async function runAction(deps: Deps, f: FlowRow, runId: string, node: FlowNode, vars: Awaited<ReturnType<typeof runVars>>, actor: SuiteActor): Promise<{ input: unknown; output: Record<string, unknown> }> {
  const c = node.config;
  const fill = (v: unknown, fallback = "") => fillPlaceholders(String(v ?? fallback), vars);
  const action = c.action as FlowAction;
  const taskId = typeof vars.trigger.taskId === "string" ? vars.trigger.taskId : null;
  if (TASK_ONLY_ACTIONS.includes(action) && !taskId) throw new StepError("This step needs a task to start the flow.");
  switch (action) {
    case "create_task": {
      const title = fill(c.title, "Follow up: {trigger.title}").trim().slice(0, 200) || f.name;
      const input = { title, projectId: c.projectId ? String(c.projectId) : undefined, priority: c.priority as never, notes: c.notes ? fill(c.notes).slice(0, 4000) : undefined,
        due: c.dueInDays ? new Date(deps.now().getTime() + Number(c.dueInDays) * 86_400_000).toISOString() : undefined };
      const tasksMod = await import("./tasks");
      const t = await tasksMod.createTask(deps, actor, input, { id: `tsk_${runId.slice(4)}_${node.id}`.slice(0, 60) });
      return { input, output: { taskId: t.id, ref: t.ref, title: t.title } };
    }
    case "notify": {
      const { notify } = await import("./notify");
      const title = fill(c.message, `${f.name}: {trigger.title}`).slice(0, 200);
      let to: string[];
      if (!c.to || c.to === "admins") to = await admins(deps, f.orgId);
      else if (c.to === "assignee") {
        const a = vars.trigger.assigneeId;
        if (typeof a !== "string" || !a) throw new StepError("The task has no one assigned.");
        to = [a];
      } else to = [String(c.to)];
      for (const u of to) await notify(deps, f.orgId, u, { type: "automation.flow", entityType: "flow_run", entityId: runId, title });
      return { input: { to: c.to ?? "admins", message: title }, output: { notified: to.length } };
    }
    case "post_to_channel": {
      const ch = await deps.db.select({ id: chatChannels.id, name: chatChannels.name }).from(chatChannels).where(and(eq(chatChannels.id, String(c.channelId ?? "")), eq(chatChannels.orgId, f.orgId), eq(chatChannels.isPrivate, false))).get();
      if (!ch) throw new StepError("The channel is gone or private now.");
      const body = fill(c.message, "{trigger.title}").slice(0, 4000) || f.name;
      const { postMessage } = await import("./chat");
      const m = await postMessage(deps, actor, ch.id, { body }, { id: `msg_${runId.slice(4)}_${node.id}`.slice(0, 60) }) as { id?: string } | undefined;
      return { input: { channel: ch.name, message: body }, output: { messageId: m?.id ?? null, channel: ch.name } };
    }
    case "send_webhook": {
      const { queueDelivery } = await import("../developer/webhooks");
      const data = { flow: { id: f.id, name: f.name }, run: runId, trigger: redact(vars.trigger), steps: redact(vars.steps) };
      const d = await queueDelivery(deps, f.orgId, String(c.endpointId ?? ""), "flow.step", data, `${runId}:${node.id}`);
      if (!d) throw new StepError("The webhook is gone or switched off. Check Settings, Connections, Webhooks.");
      return { input: { endpoint: d.url, event: "flow.step" }, output: { deliveryId: d.id, status: d.status === "delivered" ? "delivered" : "retrying", note: d.status === "delivered" ? "Delivered" : "First try failed; it retries with backoff and shows in the webhook delivery log." } };
    }
    case "add_to_digest": {
      const every = c.every === "weekly" ? "weekly" : "daily";
      const tz = (await deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, f.orgId)).get())?.tz ?? "Australia/Sydney";
      const sendAt = new Date(nextDigestTime(deps.now().getTime(), tz, every));
      const item = { title: fill(c.title, "{trigger.title}").slice(0, 300) || f.name, link: safeLink(fill(c.link, "{trigger.link}")), summary: fill(c.summary).slice(0, 600) || null };
      await deps.db.insert(flowDigestItems).values({ id: newId("fdi"), orgId: f.orgId, flowId: f.id, nodeId: node.id, ...item, sendAt, createdAt: deps.now() });
      return { input: item, output: { queuedFor: sendAt.toISOString(), every } };
    }
    case "set_status": case "set_priority": case "add_label": {
      const { runRuleAction } = await import("./automations-r24");
      const cfg = action === "set_status" ? { statusName: c.statusName, category: c.category } : action === "set_priority" ? { priority: c.priority } : { label: c.label };
      await runRuleAction(deps, f.orgId, f.name, action, cfg, taskId!, actor);
      return { input: cfg, output: { taskId } };
    }
    default: throw new StepError("This step has no action picked.");
  }
}

function safeLink(v: string): string | null {
  const s = v.trim();
  return /^https?:\/\/\S+$/i.test(s) ? s.slice(0, 1000) : null;
}

/** The next 8 in the morning in the workspace's zone (weekly: the next Monday at 8). */
export function nextDigestTime(now: number, timeZone: string, every: "daily" | "weekly"): number {
  let fmt: Intl.DateTimeFormat;
  try { fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" }); } catch { fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" }); }
  const start = Math.ceil((now + 1) / 900_000) * 900_000;
  for (let t = start; t < now + 9 * 86_400_000; t += 900_000) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    if (Number(parts.hour) === 8 && Number(parts.minute) === 0 && (every === "daily" || parts.weekday === "Mon")) return t;
  }
  return now + 86_400_000;
}

// ---------------------------------------------------------------- people acting on runs

export async function listRuns(deps: Deps, orgId: string, q: { flowId?: string; status?: string; before?: string; limit?: number }) {
  assertFlows(deps);
  const limit = Math.min(100, Math.max(1, q.limit ?? 50));
  const conds = [eq(flowRuns.orgId, orgId)];
  if (q.flowId) conds.push(eq(flowRuns.flowId, q.flowId));
  if (q.status === "attention") conds.push(inArray(flowRuns.status, ["failed", "waiting_approval"]));
  else if (q.status) conds.push(eq(flowRuns.status, q.status as RunRow["status"]));
  if (q.before) conds.push(lt(flowRuns.startedAt, new Date(q.before)));
  const rows = await deps.db.select({ r: flowRuns, name: flows.name }).from(flowRuns).innerJoin(flows, eq(flows.id, flowRuns.flowId)).where(and(...conds)).orderBy(desc(flowRuns.startedAt)).limit(limit + 1);
  return { runs: rows.slice(0, limit).map((x) => presentRun(x.r, x.name)), more: rows.length > limit };
}

export async function getRun(deps: Deps, orgId: string, runId: string) {
  assertFlows(deps);
  const row = await deps.db.select({ r: flowRuns, f: flows }).from(flowRuns).innerJoin(flows, eq(flows.id, flowRuns.flowId)).where(and(eq(flowRuns.id, runId), eq(flowRuns.orgId, orgId))).get();
  if (!row) throw notFound("Run");
  const steps = await deps.db.select().from(flowRunSteps).where(eq(flowRunSteps.runId, runId)).orderBy(flowRunSteps.startedAt, flowRunSteps.attempt).limit(200);
  return { run: presentRun(row.r, row.f.name), graph: parseGraph(row.f.graph), steps: steps.map(presentStep) };
}

/** Retry a failed run from the step that failed (a new attempt of that step; earlier steps are not run again). */
export async function retryRun(deps: Deps, actor: SuiteActor, runId: string) {
  assertFlows(deps);
  const run = await deps.db.select().from(flowRuns).where(and(eq(flowRuns.id, runId), eq(flowRuns.orgId, actor.orgId))).get();
  if (!run) throw notFound("Run");
  if (run.status !== "failed") throw bad("Only a failed run can be tried again.");
  const claimed = await deps.db.update(flowRuns).set({ status: "running", error: null, finishedAt: null }).where(and(eq(flowRuns.id, runId), eq(flowRuns.status, "failed"))).returning({ id: flowRuns.id });
  if (!claimed.length) throw bad("This run is already being tried again.");
  const { takeRun } = await import("./automations");
  if (!(await takeRun(deps, actor.orgId))) {
    await finish(deps, runId, run.flowId, "failed", "Monthly automation runs used up.", run.currentNode);
    throw bad("Monthly automation runs used up.");
  }
  await advance(deps, runId, run.currentNode);
  return getRun(deps, actor.orgId, runId);
}

export async function cancelRun(deps: Deps, actor: SuiteActor, runId: string) {
  assertFlows(deps);
  const done = await deps.db.update(flowRuns).set({ status: "cancelled", finishedAt: deps.now(), resumeAt: null, error: `Stopped by ${actor.name || "a person"}.` })
    .where(and(eq(flowRuns.id, runId), eq(flowRuns.orgId, actor.orgId), inArray(flowRuns.status, ["waiting", "waiting_approval", "failed"]))).returning({ id: flowRuns.id, flowId: flowRuns.flowId });
  if (!done.length) throw bad("Only a waiting or failed run can be stopped.");
  await deps.db.update(flowRunSteps).set({ status: "skipped", finishedAt: deps.now() }).where(and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.status, "waiting")));
  return getRun(deps, actor.orgId, runId);
}

/** Runs waiting for this person's OK (admins see every one; a chosen approver sees theirs). */
export async function listApprovals(deps: Deps, actor: SuiteActor & { role?: string }) {
  assertFlows(deps);
  const rows = await deps.db.select({ r: flowRuns, f: flows }).from(flowRuns).innerJoin(flows, eq(flows.id, flowRuns.flowId))
    .where(and(eq(flowRuns.orgId, actor.orgId), eq(flowRuns.status, "waiting_approval"))).orderBy(desc(flowRuns.startedAt)).limit(50);
  const out = [];
  for (const { r, f } of rows) {
    const node = nodeById(parseGraph(f.graph), r.currentNode);
    if (!node) continue;
    if (!canDecide(actor, node)) continue;
    const step = await deps.db.select({ output: flowRunSteps.output }).from(flowRunSteps).where(and(eq(flowRunSteps.runId, r.id), eq(flowRunSteps.nodeId, node.id), eq(flowRunSteps.status, "waiting"))).get();
    const asked = step?.output ? (JSON.parse(step.output) as { asked?: string }).asked ?? "" : "";
    out.push({ ...presentRun(r, f.name), asked });
  }
  return { approvals: out };
}

function canDecide(actor: { userId: string; role?: string }, node: FlowNode) {
  if (node.config.approver) return node.config.approver === actor.userId;
  return actor.role === "owner" || actor.role === "admin";
}

export async function decideApproval(deps: Deps, actor: SuiteActor & { role?: string }, runId: string, decision: "approve" | "reject", note?: string) {
  assertFlows(deps);
  const row = await deps.db.select({ r: flowRuns, f: flows }).from(flowRuns).innerJoin(flows, eq(flows.id, flowRuns.flowId)).where(and(eq(flowRuns.id, runId), eq(flowRuns.orgId, actor.orgId))).get();
  if (!row) throw notFound("Run");
  if (row.r.status !== "waiting_approval") throw bad("This run is not waiting for an OK any more.");
  const g = parseGraph(row.f.graph);
  const node = nodeById(g, row.r.currentNode);
  if (!node) throw bad("The approval step was removed from the flow.");
  if (!canDecide(actor, node)) throw new HttpError(403, "forbidden", node.config.approver ? "Only the chosen approver can decide this." : "Only admins can decide this.");
  const claimed = await deps.db.update(flowRuns).set({ status: "running" }).where(and(eq(flowRuns.id, runId), eq(flowRuns.status, "waiting_approval"))).returning({ id: flowRuns.id });
  if (!claimed.length) throw bad("Someone else just decided this.");
  const by = actor.name || actor.email;
  const cleanNote = note?.trim().slice(0, 500) || null;
  const step = await deps.db.select().from(flowRunSteps).where(and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.nodeId, node.id), eq(flowRunSteps.status, "waiting"))).get();
  const output = { ...(step?.output ? JSON.parse(step.output) as Record<string, unknown> : {}), decision: decision === "approve" ? "approved" : "rejected", by, note: cleanNote, branch: "next" };
  if (step) await deps.db.update(flowRunSteps).set({ status: decision === "approve" ? "succeeded" : "failed", output: logJson(output), finishedAt: deps.now(), error: decision === "reject" ? `Rejected by ${by}${cleanNote ? `: ${cleanNote}` : ""}` : null }).where(eq(flowRunSteps.id, step.id));
  if (decision === "reject") { await finish(deps, runId, row.f.id, "cancelled", `Rejected by ${by}${cleanNote ? `: ${cleanNote}` : "."}`, node.id); return getRun(deps, actor.orgId, runId); }
  await advance(deps, runId, nextNode(g, node.id, "next"));
  return getRun(deps, actor.orgId, runId);
}

export async function runNow(deps: Deps, actor: SuiteActor, id: string, note?: string) {
  assertFlows(deps);
  const f = await getFlowRow(deps, actor.orgId, id);
  const g = parseGraph(f.graph);
  const problems = validateGraph(g);
  if (problems.length) throw bad(`Fix this first: ${problems[0].message}`);
  const t = triggerNode(g);
  const trig = (t?.config.trigger ?? "manual") as FlowTrigger;
  const sample: Record<string, unknown> = { test: trig !== "manual", by: actor.name || actor.email };
  for (const fld of TRIGGER_FIELDS[trig] ?? []) sample[fld.key] = fld.key === "note" ? (note ?? "") : fld.key === "link" ? deps.config.appUrl : `Sample ${fld.label.toLowerCase()}`;
  const runId = await startRun(deps, f, sample, `manual:${newId("x")}`, { force: true });
  return getRun(deps, actor.orgId, runId!);
}

// ---------------------------------------------------------------- events from the rest of the app

/** What a task event hands a flow: plain fields only. */
export function taskData(deps: Deps, task: Record<string, unknown> | { id: string }): Record<string, unknown> {
  const t = task as Record<string, unknown> & { assignee?: { type?: string; id?: string } | null; status?: unknown; project?: unknown };
  const status = t.status && typeof t.status === "object" ? t.status as { name?: string; category?: string } : null;
  const project = t.project && typeof t.project === "object" ? (t.project as { name?: string }).name : undefined;
  return {
    taskId: t.id, ref: t.ref, title: t.title, priority: t.priority, status: status?.name ?? t.statusName ?? "", category: typeof t.status === "string" ? t.status : status?.category ?? "",
    project: project ?? t.projectName ?? "", projectId: t.projectId, assigneeId: t.assignee?.type === "member" ? t.assignee.id : null, labels: t.labels,
    link: `${deps.config.appUrl}/app/tasks/${String(t.ref ?? t.id)}`,
  };
}

/** One indexed read: the workspace's flows that are on for this trigger. */
async function flowsFor(deps: Deps, orgId: string, trigger: FlowTrigger) {
  if (deps.config.flows === false) return [];
  return deps.db.select().from(flows).where(and(eq(flows.orgId, orgId), eq(flows.triggerKind, trigger), eq(flows.enabled, true), isNull(flows.deletedAt))).limit(MAX_FLOWS);
}

/** Starts the matching flows for an event. Never throws: an automation problem must not break the action that caused it. */
export async function fireFlows(deps: Deps, orgId: string, trigger: FlowTrigger, data: Record<string, unknown>, dedupe: string) {
  try {
    const list = await flowsFor(deps, orgId, trigger);
    let started = 0;
    for (const f of list) {
      const t = triggerNode(parseGraph(f.graph));
      if (trigger === "form_submitted" && t?.config.formId && t.config.formId !== data.formId) continue;
      if (trigger === "status_changed" && t?.config.category && t.config.category !== data.category) continue;
      if (await startRun(deps, f, data, `${trigger}:${dedupe}`)) started++;
    }
    return started;
  } catch (err) {
    deps.reportError?.(err, { where: "fireFlows", trigger });
    return 0;
  }
}

/** Resumes waits whose time has come and runs left over from a full pass. At most `limit` per call. */
export async function resumeDueRuns(deps: Deps, limit = 20) {
  if (deps.config.flows === false) return 0;
  const due = await deps.db.select({ id: flowRuns.id, currentNode: flowRuns.currentNode, resumeAt: flowRuns.resumeAt }).from(flowRuns).where(and(eq(flowRuns.status, "waiting"), lte(flowRuns.resumeAt, deps.now()))).limit(limit);
  let n = 0;
  for (const r of due) {
    const claimed = await deps.db.update(flowRuns).set({ status: "running", resumeAt: null }).where(and(eq(flowRuns.id, r.id), eq(flowRuns.status, "waiting"))).returning({ flowId: flowRuns.flowId });
    if (!claimed.length) continue;
    const waitStep = r.currentNode ? await deps.db.select().from(flowRunSteps).where(and(eq(flowRunSteps.runId, r.id), eq(flowRunSteps.nodeId, r.currentNode), eq(flowRunSteps.status, "waiting"))).get() : undefined;
    if (waitStep) {
      await deps.db.update(flowRunSteps).set({ status: "succeeded", finishedAt: deps.now(), output: logJson({ ...JSON.parse(waitStep.output ?? "{}") as Record<string, unknown>, branch: "next" }) }).where(eq(flowRunSteps.id, waitStep.id));
      const f = await deps.db.select({ graph: flows.graph }).from(flows).where(eq(flows.id, claimed[0].flowId)).get();
      await advance(deps, r.id, f ? nextNode(parseGraph(f.graph), r.currentNode!, "next") : null);
    } else {
      await advance(deps, r.id, r.currentNode);
    }
    n++;
  }
  return n;
}

/** Sends digests that are due: one mail per digest step per person, then marks the items sent. */
export async function sendDueDigests(deps: Deps, limit = 300) {
  if (deps.config.flows === false) return 0;
  const items = await deps.db.select().from(flowDigestItems).where(and(isNull(flowDigestItems.sentAt), lte(flowDigestItems.sendAt, deps.now()))).limit(limit);
  if (!items.length) return 0;
  const groups = new Map<string, typeof items>();
  for (const it of items) { const k = `${it.flowId}|${it.nodeId}`; groups.set(k, [...(groups.get(k) ?? []), it]); }
  const { sendSystemEmail } = await import("../system-mail");
  let sent = 0;
  for (const [, list] of groups) {
    const first = list[0];
    const f = await deps.db.select().from(flows).where(eq(flows.id, first.flowId)).get();
    const node = f ? nodeById(parseGraph(f.graph), first.nodeId) : undefined;
    const ids = list.map((x) => x.id);
    if (f && node && !f.deletedAt) {
      const to = node.config.to && node.config.to !== "admins" ? [String(node.config.to)] : await admins(deps, f.orgId);
      const people = to.length ? await deps.db.select({ email: users.email }).from(users).innerJoin(members, and(eq(members.userId, users.id), eq(members.organizationId, f.orgId))).where(inIds(users.id, to)) : [];
      const subject = String(node.config.subject ?? "").trim() || `${f.name}: ${list.length} new ${list.length === 1 ? "item" : "items"}`;
      const text = list.map((x, i) => `${i + 1}. ${x.title}${x.link ? `\n   ${x.link}` : ""}${x.summary ? `\n   ${x.summary.slice(0, 300)}` : ""}`).join("\n\n");
      for (const p of people) await sendSystemEmail(deps, { to: p.email, orgId: f.orgId, template: "flow-digest", subject: subject.slice(0, 160), text: `${text}\n\nSent by the flow "${f.name}". Change it in Automations.`, action: { label: "Open the flow", url: `${deps.config.appUrl}/app/automations/flows/${f.id}` } }).catch((err) => deps.reportError?.(err, { where: "flow_digest" }));
      sent++;
    }
    await deps.db.update(flowDigestItems).set({ sentAt: deps.now() }).where(inIds(flowDigestItems.id, ids));
  }
  return sent;
}

/** Old runs go after 30 days (their steps go with them); sent digest items after 7. */
export async function pruneFlowRuns(deps: Deps) {
  const cut = new Date(deps.now().getTime() - 30 * 86_400_000);
  await deps.db.delete(flowRuns).where(and(lt(flowRuns.startedAt, cut), inArray(flowRuns.status, ["succeeded", "failed", "cancelled"])));
  await deps.db.delete(flowDigestItems).where(lt(flowDigestItems.sentAt, new Date(deps.now().getTime() - 7 * 86_400_000)));
}
