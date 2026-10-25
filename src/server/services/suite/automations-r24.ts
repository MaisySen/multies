/**
 * R24.4 The automation engine's newer triggers and actions, beside the older rules in automations.ts.
 *
 * Triggers: task_created, assignee_changed, due_passed (from the cron, once per task per due date),
 * meeting_ended and chat_message_posted (with a keyword). status_changed rules with the newer
 * conditions or actions run here too. Actions: post_to_channel, assign_task (a member, the project
 * lead, or in turn), set_status, add_label, set_priority, create_subtask_checklist, plus notify and
 * create_task. Each run counts against the plan's monthly allowance like every other rule.
 *
 * Loops: an action's own change runs as an automation actor one level deeper; nothing runs past
 * MAX_DEPTH, and one rule acts on one task at most once a minute (kept in memory per isolate).
 * Posts made by a rule never trigger chat rules.
 */
import { and, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { automations, chatChannels, members, organizations, projects, projectStatuses, tasks, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { notify } from "./notify";
import { ran, takeRun, type AutomationRow } from "./automations";
import type { SuiteActor } from "./common";
import type { Category, Priority, Task } from "./tasks";

export const R24_TRIGGERS = ["task_created", "assignee_changed", "due_passed", "meeting_ended", "chat_message_posted"] as const;
export const R24_ACTIONS = ["post_to_channel", "assign_task", "set_status", "add_label", "set_priority", "create_subtask_checklist"] as const;
export const TASK_TRIGGERS = ["task_created", "status_changed", "assignee_changed", "due_passed"] as const;
export type R24Trigger = (typeof R24_TRIGGERS)[number];
export type R24Action = (typeof R24_ACTIONS)[number];
type TaskTrigger = (typeof TASK_TRIGGERS)[number];

const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
const TYPES = ["task", "story", "bug", "epic"] as const;
const CATEGORIES = ["todo", "doing", "done"] as const;
/** Conditions the newer task rules understand; a status_changed rule using any of them runs here. */
const R24_CONDITIONS = ["priority", "type", "label", "inSprint", "unassigned", "toStatusName", "category"];

export const MAX_DEPTH = 3;
export const DUE_PASSED_BUDGET = 25;
const DUE_PASSED_RULES = 50;

const bad = (message: string) => new HttpError(422, "validation_failed", message);
const has = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** True when a rule needs this engine (a newer trigger, action, condition or notify target). */
export function isR24Rule(r: { trigger: string; action: string; conditions?: Record<string, unknown>; actionConfig?: Record<string, unknown> }) {
  if (has(R24_TRIGGERS, r.trigger) || has(R24_ACTIONS, r.action)) return true;
  if (r.actionConfig?.to === "lead") return true;
  return r.trigger === "status_changed" && R24_CONDITIONS.some((k) => r.conditions?.[k] !== undefined);
}

/* ------------------------------------------------------------------ loop guard */

const depthOf = new WeakMap<object, number>();
const recent = new Map<string, number>();

function ruleActor(orgId: string, name: string, depth: number): SuiteActor {
  const a: SuiteActor = { orgId, userId: "", email: "automation", name: `Automation: ${name}`, system: true };
  depthOf.set(a, depth);
  return a;
}
export const depthFor = (actor?: SuiteActor | null) => (actor ? depthOf.get(actor) ?? 0 : 0);

/** One rule acts on one thing at most once a minute in this isolate. */
function seenRecently(ruleId: string, entityId: string, now: number) {
  const key = `${ruleId}:${entityId}`;
  const at = recent.get(key);
  if (at !== undefined && now - at < 60_000) return true;
  if (recent.size > 2000) for (const [k, v] of recent) if (now - v >= 60_000) recent.delete(k);
  recent.set(key, now);
  return false;
}
/** For tests. */
export function resetLoopGuard() { recent.clear(); }

/* ------------------------------------------------------------------ validation */

async function memberIn(deps: Deps, orgId: string, userId: unknown) {
  if (typeof userId !== "string" || !userId) return false;
  return !!(await deps.db.select({ u: members.userId }).from(members).where(and(eq(members.organizationId, orgId), eq(members.userId, userId))).get());
}
async function projectIn(deps: Deps, orgId: string, id: unknown) {
  if (typeof id !== "string" || !id) return false;
  return !!(await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, id), isNull(projects.deletedAt))).get());
}
/** Rules post only in public channels of the workspace: everyone there can already read them. */
async function publicChannel(deps: Deps, orgId: string, id: unknown) {
  if (typeof id !== "string" || !id) return null;
  const c = await deps.db.select().from(chatChannels).where(and(eq(chatChannels.orgId, orgId), eq(chatChannels.id, id))).get();
  return c && c.kind === "channel" && !c.isPrivate && !c.archived && !c.deletedAt ? c : null;
}

const ACTIONS_FOR: Record<string, readonly string[]> = {
  task_created: ["notify", "create_task", ...R24_ACTIONS], status_changed: ["notify", "create_task", ...R24_ACTIONS],
  assignee_changed: ["notify", "create_task", ...R24_ACTIONS], due_passed: ["notify", "create_task", ...R24_ACTIONS],
  meeting_ended: ["notify", "create_task", "post_to_channel"], chat_message_posted: ["notify", "create_task", "post_to_channel"],
  email_received: ["create_task", "notify", "assign_thread", "post_to_channel"], due_soon: ["notify"],
};

/**
 * Checks a rule that uses the newer triggers, actions or conditions, and returns its clean
 * conditions and action settings. Ids from another workspace are refused like ids that do not exist.
 */
export async function validateR24Rule(deps: Deps, orgId: string, i: { trigger: string; action: string; conditions?: Record<string, unknown>; actionConfig?: Record<string, unknown> }) {
  const c = { ...(i.conditions ?? {}) };
  const a = { ...(i.actionConfig ?? {}) };
  if (!(ACTIONS_FOR[i.trigger] ?? []).includes(i.action)) throw bad("That action does not go with that trigger.");
  const taskTrigger = has(TASK_TRIGGERS, i.trigger);
  if (taskTrigger) {
    if (c.projectId !== undefined && !(await projectIn(deps, orgId, c.projectId))) throw bad("Pick a project in this workspace.");
    if (c.priority !== undefined && !has(PRIORITIES, c.priority)) throw bad("Pick a priority: none, low, medium, high or urgent.");
    if (c.type !== undefined && !has(TYPES, c.type)) throw bad("Pick a type: task, story, bug or epic.");
    if (c.toCategory !== undefined && !has(CATEGORIES, c.toCategory)) throw bad("Pick to do, doing or done.");
    if (c.category !== undefined && !has(CATEGORIES, c.category)) throw bad("Pick to do, doing or done.");
    if (c.label !== undefined && (typeof c.label !== "string" || !c.label.trim() || c.label.length > 40)) throw bad("A label is 1 to 40 characters.");
    if (c.toStatusName !== undefined && (typeof c.toStatusName !== "string" || !c.toStatusName.trim() || c.toStatusName.length > 60)) throw bad("A status name is 1 to 60 characters.");
    for (const k of ["inSprint", "unassigned"]) if (c[k] !== undefined && typeof c[k] !== "boolean") throw bad(`${k} is true or false.`);
  }
  if (i.trigger === "chat_message_posted") {
    if (typeof c.keyword !== "string" || !c.keyword.trim() || c.keyword.length > 60) throw bad("Say which word to look for in chat (1 to 60 characters).");
    c.keyword = c.keyword.trim();
    if (c.channelId !== undefined && !(await publicChannel(deps, orgId, c.channelId))) throw bad("Pick a public channel in this workspace.");
  }
  if (i.trigger === "meeting_ended" && c.titleContains !== undefined && (typeof c.titleContains !== "string" || c.titleContains.length > 100)) throw bad("Words in the title are up to 100 characters.");
  switch (i.action) {
    case "notify": {
      const to = a.to ?? "assignee";
      const ok = taskTrigger ? ["assignee", "creator", "admins", "lead"] : ["admins"];
      if (!(typeof to === "string" && (ok.includes(to) || (await memberIn(deps, orgId, to))))) throw bad(taskTrigger ? "Notify the assignee, the creator, the project lead, the admins or a member of this workspace." : "Notify the admins or a member of this workspace.");
      a.to = to;
      break;
    }
    case "create_task":
      if (a.projectId !== undefined && !(await projectIn(deps, orgId, a.projectId))) throw bad("Pick a project in this workspace.");
      if (!taskTrigger && a.projectId === undefined && i.trigger !== "email_received") throw bad("Pick the project for the new task.");
      if (a.priority !== undefined && !has(PRIORITIES, a.priority)) throw bad("Pick a priority: none, low, medium, high or urgent.");
      if (a.title !== undefined && (typeof a.title !== "string" || a.title.length > 200)) throw bad("A title is up to 200 characters.");
      break;
    case "post_to_channel":
      if (!(await publicChannel(deps, orgId, a.channelId))) throw bad("Pick a public channel in this workspace.");
      if (i.trigger === "chat_message_posted" && c.channelId && c.channelId === a.channelId) throw bad("Post in a different channel from the one the rule watches.");
      if (a.message !== undefined && (typeof a.message !== "string" || !a.message.trim() || a.message.length > 1000)) throw bad("The message is 1 to 1,000 characters.");
      break;
    case "assign_task": {
      const mode = a.mode ?? (a.memberId ? "member" : undefined);
      if (mode === "member") { if (!(await memberIn(deps, orgId, a.memberId))) throw bad("Pick a member of this workspace."); }
      else if (mode === "round_robin") {
        const ids = Array.isArray(a.memberIds) ? [...new Set(a.memberIds as unknown[])] : [];
        if (ids.length < 1 || ids.length > 20) throw bad("Pick 1 to 20 people to share tasks between.");
        for (const id of ids) if (!(await memberIn(deps, orgId, id))) throw bad("Pick members of this workspace.");
        a.memberIds = ids;
        a.next = Number.isInteger(a.next) ? a.next : 0;
      } else if (mode !== "lead") throw bad("Assign to a member, the project lead or in turn.");
      a.mode = mode;
      break;
    }
    case "set_status":
      if (a.statusName === undefined && a.category === undefined && a.statusId === undefined) throw bad("Pick the status to move to.");
      if (a.category !== undefined && !has(CATEGORIES, a.category)) throw bad("Pick to do, doing or done.");
      if (a.statusName !== undefined && (typeof a.statusName !== "string" || !a.statusName.trim() || a.statusName.length > 60)) throw bad("A status name is 1 to 60 characters.");
      if (a.statusId !== undefined && (typeof a.statusId !== "string" || !(await deps.db.select({ id: projectStatuses.id }).from(projectStatuses).where(and(eq(projectStatuses.orgId, orgId), eq(projectStatuses.id, a.statusId))).get()))) throw bad("Pick a status in this workspace.");
      break;
    case "add_label":
      if (typeof a.label !== "string" || !a.label.trim() || a.label.length > 40) throw bad("A label is 1 to 40 characters.");
      a.label = a.label.trim();
      break;
    case "set_priority":
      if (!has(PRIORITIES, a.priority)) throw bad("Pick a priority: none, low, medium, high or urgent.");
      break;
    case "create_subtask_checklist": {
      const items = Array.isArray(a.items) ? (a.items as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];
      if (!items.length || items.length > 10 || items.some((x) => x.length > 200)) throw bad("A checklist has 1 to 10 items of up to 200 characters.");
      a.items = items;
      break;
    }
  }
  return { conditions: c, actionConfig: a };
}

/* ------------------------------------------------------------------ running */

export interface RunContext {
  actor?: SuiteActor | null;
  /** status_changed: the category the task moved from. */
  from?: Category | null;
  task?: Task;
  meeting?: { id: string; title: string };
  message?: { id: string; text: string; channelId: string; channelName: string; author: string; authorId: string | null };
  email?: { messageId: string; threadId: string; from: string; subject: string };
}

/** {name} variables in a message or a title. Unknown names stay as written. */
export function fillTemplate(text: string, vars: Record<string, string>) {
  return text.replace(/\{([a-z.]+)\}/gi, (m, k: string) => (k in vars ? vars[k] : m));
}

async function variables(deps: Deps, ctx: RunContext) {
  const v: Record<string, string> = {};
  const t = ctx.task;
  if (t) {
    const p = await deps.db.select({ name: projects.name }).from(projects).where(eq(projects.id, t.projectId)).get();
    Object.assign(v, { "task.title": t.title, "task.ref": t.ref, "task.url": `${deps.config.appUrl}/app/tasks?task=${t.id}`, assignee: t.assignee?.name ?? "no one", project: p?.name ?? "", "task.status": t.statusName, "task.priority": t.priority });
  }
  if (ctx.meeting) v["meeting.title"] = ctx.meeting.title;
  if (ctx.message) Object.assign(v, { "message.text": ctx.message.text.slice(0, 500), channel: ctx.message.channelName, author: ctx.message.author });
  if (ctx.email) Object.assign(v, { "email.from": ctx.email.from, "email.subject": ctx.email.subject || "(no subject)" });
  return v;
}

function matchesTask(trigger: string, c: Record<string, unknown>, t: Task, from: Category | null | undefined) {
  if (c.projectId && c.projectId !== t.projectId) return false;
  if (c.priority && c.priority !== t.priority) return false;
  if (c.type && c.type !== t.type) return false;
  if (c.label && !t.labels.some((l) => l.toLowerCase() === String(c.label).toLowerCase())) return false;
  if (c.inSprint === true && !t.sprintId) return false;
  if (c.inSprint === false && t.sprintId) return false;
  if (c.unassigned === true && t.assignee) return false;
  if (c.category && c.category !== t.status) return false;
  if (trigger === "status_changed") {
    if (c.toCategory && c.toCategory !== t.status) return false;
    if (c.toStatusId && c.toStatusId !== t.statusId) return false;
    if (c.toStatusName && String(c.toStatusName).toLowerCase() !== t.statusName.toLowerCase()) return false;
    if (from === t.status && !c.toStatusId && !c.toStatusName) return false;
  }
  return true;
}

async function leadOf(deps: Deps, orgId: string, projectId: string) {
  const p = await deps.db.select({ owner: projects.ownerUserId }).from(projects).where(and(eq(projects.id, projectId), eq(projects.orgId, orgId))).get();
  return p?.owner && (await memberIn(deps, orgId, p.owner)) ? p.owner : null;
}

async function targets(deps: Deps, orgId: string, to: string, t?: Task) {
  if (to === "assignee") return t?.assignee?.type === "member" ? [t.assignee.id] : [];
  if (to === "creator") return t?.createdBy.type === "member" && t.createdBy.id ? [t.createdBy.id] : [];
  if (to === "lead") { const l = t ? await leadOf(deps, orgId, t.projectId) : null; return l ? [l] : []; }
  if (to === "admins") return (await deps.db.select({ u: members.userId }).from(members).where(and(eq(members.organizationId, orgId), inArray(members.role, ["owner", "admin"])))).map((r) => r.u);
  return (await memberIn(deps, orgId, to)) ? [to] : [];
}

/** Does one rule's action. Returns a new action config to save (the round robin pointer), if any. */
async function act(deps: Deps, r: AutomationRow, ctx: RunContext, depth: number): Promise<string | undefined> {
  const orgId = r.orgId;
  const cfg = JSON.parse(r.actionConfig) as Record<string, unknown>;
  const actor = ruleActor(orgId, r.name, depth + 1);
  const t = ctx.task;
  const tasksMod = await import("./tasks");
  switch (r.action) {
    case "notify": {
      const title = t ? `${r.name}: ${t.ref} ${t.title}` : ctx.meeting ? `${r.name}: ${ctx.meeting.title}` : ctx.message ? `${r.name}: ${ctx.message.author} in #${ctx.message.channelName}: ${ctx.message.text.slice(0, 120)}` : r.name;
      const entity = t ? { entityType: "task", entityId: t.id } : ctx.meeting ? { entityType: "meeting", entityId: ctx.meeting.id } : ctx.message ? { entityType: "chat_message", entityId: ctx.message.id } : { entityType: "message", entityId: ctx.email?.messageId ?? "" };
      for (const u of await targets(deps, orgId, String(cfg.to ?? "assignee"), t)) await notify(deps, orgId, u, { type: "automation.rule", ...entity, title: title.slice(0, 200) });
      return;
    }
    case "create_task": {
      const vars = await variables(deps, ctx);
      const title = fillTemplate(String(cfg.title ?? (t ? "Follow up: {task.title}" : ctx.message ? "{message.text}" : ctx.meeting ? "Follow up: {meeting.title}" : "Follow up")), vars).slice(0, 200);
      await tasksMod.createTask(deps, actor, {
        title, projectId: (cfg.projectId as string | undefined) ?? t?.projectId, priority: cfg.priority as Priority | undefined,
        assignee: tasksMod.parseAssignee((cfg.assignee as string | undefined) ?? null) ?? (t?.assignee ? { type: t.assignee.type, id: t.assignee.id } : null),
        due: cfg.dueInDays ? new Date(deps.now().getTime() + Number(cfg.dueInDays) * 86_400_000).toISOString() : undefined,
        notes: ctx.message ? `From chat in #${ctx.message.channelName} by ${ctx.message.author}.` : undefined,
      });
      return;
    }
    case "post_to_channel": {
      const c = await publicChannel(deps, orgId, cfg.channelId);
      if (!c) throw new Error("The channel is gone or private now.");
      const body = fillTemplate(String(cfg.message ?? (t ? "{task.ref} {task.title}" : r.name)), await variables(deps, ctx)).slice(0, 4000);
      const { postMessage } = await import("./chat");
      await postMessage(deps, actor, c.id, { body });
      return;
    }
    case "assign_task": {
      if (!t) return;
      let who: string | null = null;
      let next: string | undefined;
      if (cfg.mode === "member") who = (await memberIn(deps, orgId, cfg.memberId)) ? String(cfg.memberId) : null;
      else if (cfg.mode === "lead") { who = await leadOf(deps, orgId, t.projectId); if (!who) throw new Error("The project has no lead. Set one on the project."); }
      else if (cfg.mode === "round_robin") {
        const ids = (cfg.memberIds as string[]) ?? [];
        const i = Number(cfg.next ?? 0) % Math.max(1, ids.length);
        who = ids[i] && (await memberIn(deps, orgId, ids[i])) ? ids[i] : null;
        next = JSON.stringify({ ...cfg, next: (i + 1) % Math.max(1, ids.length) });
      }
      if (!who) throw new Error("No one to assign to.");
      if (t.assignee?.type === "member" && t.assignee.id === who) return next;
      await tasksMod.updateTask(deps, actor, t.id, { assignee: { type: "member", id: who } });
      return next;
    }
    case "set_status": {
      if (!t) return;
      const sts = await deps.db.select().from(projectStatuses).where(and(eq(projectStatuses.projectId, t.projectId), isNull(projectStatuses.deletedAt))).orderBy(projectStatuses.position);
      const s = (cfg.statusId ? sts.find((x) => x.id === cfg.statusId) : undefined)
        ?? (cfg.statusName ? sts.find((x) => x.name.toLowerCase() === String(cfg.statusName).toLowerCase()) : undefined)
        ?? (cfg.category ? sts.find((x) => x.category === cfg.category) : undefined);
      if (!s) throw new Error("The task's project has no such status.");
      if (s.id === t.statusId) return;
      await tasksMod.updateTask(deps, actor, t.id, { statusId: s.id });
      return;
    }
    case "add_label": {
      if (!t) return;
      const label = String(cfg.label);
      if (t.labels.some((l) => l.toLowerCase() === label.toLowerCase())) return;
      await tasksMod.updateTask(deps, actor, t.id, { labels: [...t.labels, label] });
      return;
    }
    case "set_priority":
      if (!t || t.priority === cfg.priority) return;
      await tasksMod.updateTask(deps, actor, t.id, { priority: cfg.priority as Priority });
      return;
    case "create_subtask_checklist":
      if (!t) return;
      for (const title of (cfg.items as string[]) ?? []) await tasksMod.createTask(deps, actor, { title, parentId: t.id, projectId: t.projectId });
      return;
  }
}

/** Runs the given rules for one event: checks, the loop guard, the allowance, then the action. */
async function runRules(deps: Deps, orgId: string, rules: AutomationRow[], ctx: RunContext, entityId: string, match: (c: Record<string, unknown>) => boolean) {
  const depth = depthFor(ctx.actor);
  if (depth >= MAX_DEPTH) return 0;
  let runs = 0;
  for (const r of rules) {
    if (!match(JSON.parse(r.conditions) as Record<string, unknown>)) continue;
    if (seenRecently(r.id, entityId, deps.now().getTime())) continue;
    if (!(await takeRun(deps, orgId))) { await ran(deps, r, "Monthly automation runs used up."); continue; }
    try {
      await ran(deps, r, undefined, await act(deps, r, ctx, depth));
      runs++;
    } catch (err) {
      await ran(deps, r, err instanceof Error ? err.message.slice(0, 300) : "Failed");
    }
  }
  return runs;
}

async function enabledRules(deps: Deps, orgId: string, trigger: string) {
  return deps.db.select().from(automations).where(and(eq(automations.orgId, orgId), eq(automations.trigger, trigger as AutomationRow["trigger"]), eq(automations.enabled, true), isNull(automations.deletedAt)));
}

/** A task event (created, assigned, moved): one read of the workspace's rules for it, then the matches. */
export async function runTaskEvent(deps: Deps, actor: SuiteActor, trigger: TaskTrigger, task: Task, opts: { from?: Category | null; rules?: AutomationRow[] } = {}) {
  if (task.triage) return 0;
  if (depthFor(actor) >= MAX_DEPTH) return 0;
  const rules = opts.rules ?? (await enabledRules(deps, actor.orgId, trigger)).filter((r) => trigger !== "status_changed" || isR24Rule({ trigger: r.trigger, action: r.action, conditions: JSON.parse(r.conditions), actionConfig: JSON.parse(r.actionConfig) }));
  if (!rules.length) return 0;
  return runRules(deps, actor.orgId, rules, { actor, task, from: opts.from }, task.id, (c) => matchesTask(trigger, c, task, opts.from));
}

/** A meeting was marked ended. */
export async function runMeetingEnded(deps: Deps, actor: SuiteActor, meeting: { id: string; title: string }) {
  const rules = await enabledRules(deps, actor.orgId, "meeting_ended");
  if (!rules.length) return 0;
  return runRules(deps, actor.orgId, rules, { actor, meeting }, meeting.id, (c) => !c.titleContains || meeting.title.toLowerCase().includes(String(c.titleContains).toLowerCase()));
}

/** A chat message was posted by a person or an agent. Posts by rules never come here. */
export async function runChatPosted(deps: Deps, actor: SuiteActor, message: NonNullable<RunContext["message"]>) {
  if (actor.system) return 0;
  const rules = await enabledRules(deps, actor.orgId, "chat_message_posted");
  if (!rules.length) return 0;
  const text = message.text.toLowerCase();
  const word = (k: string) => new RegExp(`(^|[^a-z0-9])${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(text);
  return runRules(deps, actor.orgId, rules, { actor, message }, message.id, (c) => (!c.channelId || c.channelId === message.channelId) && typeof c.keyword === "string" && word(c.keyword));
}

/** Email rules whose action is newer (post_to_channel), from runEmailAutomations. */
export async function runEmailRule(deps: Deps, r: AutomationRow, email: NonNullable<RunContext["email"]>) {
  return act(deps, r, { email }, 0);
}

/**
 * From the cron: open tasks whose due date has passed. Each rule acts on a task once per due date
 * (the key rides on the task's reminderSentFor, like due date reminders). Nothing runs when the
 * day's write budget reads warn or shed; an idle pass with no rules writes nothing.
 */
export async function runDuePassed(deps: Deps) {
  const rules = (await deps.db.select({ rule: automations }).from(automations)
    .innerJoin(organizations, eq(organizations.id, automations.orgId))
    .where(and(eq(automations.trigger, "due_passed" as AutomationRow["trigger"]), eq(automations.enabled, true), isNull(automations.deletedAt), eq(organizations.isDemo, false)))
    .orderBy(sql`${automations.lastRunAt} IS NOT NULL`, automations.lastRunAt).limit(DUE_PASSED_RULES)).map((x) => x.rule);
  if (!rules.length) return { fired: 0, paused: false };
  const { writeBudget } = await import("../write-budget");
  const level = (await writeBudget(deps)).level;
  if (level === "warn" || level === "shed") return { fired: 0, paused: true };
  const now = deps.now();
  // Only tasks late by less than 30 days: older ones are not news, and the scan stays small.
  const since = new Date(now.getTime() - 30 * 86_400_000);
  let budget = DUE_PASSED_BUDGET;
  let fired = 0;
  const { getTask } = await import("./tasks");
  for (const r of rules) {
    if (budget <= 0) break;
    const c = JSON.parse(r.conditions) as Record<string, unknown>;
    const late = await deps.db.select().from(tasks).where(and(eq(tasks.orgId, r.orgId), isNull(tasks.deletedAt), isNull(tasks.triageState), ne(tasks.status, "done"),
      lt(tasks.dueAt, now), gte(tasks.dueAt, since), typeof c.projectId === "string" ? eq(tasks.projectId, c.projectId) : undefined)).limit(200);
    for (const row of late) {
      if (budget <= 0) break;
      const key = `${r.id}:passed:${row.dueAt!.toISOString()}`;
      if (row.reminderSentFor?.split(",").includes(key)) continue;
      const task = await getTask(deps, { orgId: r.orgId, userId: "", email: "", name: "", system: true }, row.id);
      if (!matchesTask("due_passed", c, task, null)) continue;
      budget--;
      // The marker first, so a failed action is not retried every 15 minutes.
      await deps.db.update(tasks).set({ reminderSentFor: [row.reminderSentFor, key].filter(Boolean).join(",").slice(-1000) }).where(eq(tasks.id, row.id));
      fired += await runRules(deps, r.orgId, [r], { task }, task.id, () => true);
    }
  }
  return { fired, paused: false };
}

/** Names of users, for the recipes picker on other surfaces. */
export async function userNames(deps: Deps, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  return new Map((await deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
}
