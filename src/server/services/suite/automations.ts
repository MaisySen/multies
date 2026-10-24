/**
 * Automations: simple "when this happens, do that" rules. They run inside Multies with no
 * AI and never send outside the business: the actions are making a task and notifying a
 * teammate. Runs count against the plan's monthly allowance.
 */
import { and, asc, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { automations, members, organizations, tasks, usageCounters } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { getPlan } from "../plans";
import { assertWritable, createdBy, recordWrite, sortableId, type SuiteActor } from "./common";
import { notify } from "./notify";
import type { Category, Priority, Task } from "./tasks";

export type Trigger = "email_received" | "status_changed" | "due_soon";
export type Action = "create_task" | "notify";
export interface EmailConditions { from?: string; subjectContains?: string; mailboxId?: string }
export interface StatusConditions { projectId?: string; toCategory?: Category; toStatusId?: string }
export interface DueConditions { hoursBefore?: number; projectId?: string }
export interface CreateTaskConfig { projectId?: string; assignee?: string | null; priority?: Priority; dueInDays?: number; title?: string }
export interface NotifyConfig { to: "assignee" | "creator" | "admins" | string }

type Row = typeof automations.$inferSelect;
function present(r: Row) {
  return {
    id: r.id, name: r.name, trigger: r.trigger, conditions: JSON.parse(r.conditions) as Record<string, unknown>, action: r.action,
    actionConfig: JSON.parse(r.actionConfig) as Record<string, unknown>, enabled: r.enabled, runCount: r.runCount,
    lastRunAt: r.lastRunAt?.toISOString() ?? null, lastError: r.lastError, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}
export type Automation = ReturnType<typeof present>;

/** Ready-made rules people can add in one click. */
export const RECIPES = [
  { key: "vip_email_task", name: "When an email arrives from a client, make a task", trigger: "email_received" as const, conditions: { from: "@client.com.au" }, action: "create_task" as const, actionConfig: { priority: "high", dueInDays: 1 } },
  { key: "invoice_email_task", name: "When an email mentions an invoice, make a task", trigger: "email_received" as const, conditions: { subjectContains: "invoice" }, action: "create_task" as const, actionConfig: { dueInDays: 3 } },
  { key: "done_notify", name: "When a task is done, tell whoever made it", trigger: "status_changed" as const, conditions: { toCategory: "done" }, action: "notify" as const, actionConfig: { to: "creator" } },
  { key: "due_reminder", name: "Remind the assignee a day before a task is due", trigger: "due_soon" as const, conditions: { hoursBefore: 24 }, action: "notify" as const, actionConfig: { to: "assignee" } },
];

export async function listAutomations(deps: Deps, orgId: string) {
  const rows = await deps.db.select().from(automations).where(and(eq(automations.orgId, orgId), isNull(automations.deletedAt))).orderBy(automations.createdAt);
  return rows.map(present);
}

export interface AutomationInput { name: string; trigger: Trigger; conditions?: Record<string, unknown>; action: Action; actionConfig?: Record<string, unknown>; enabled?: boolean }

function validate(i: Pick<AutomationInput, "trigger" | "action" | "conditions" | "actionConfig">) {
  if (i.trigger === "due_soon" && i.action !== "notify") throw new HttpError(422, "validation_failed", "Due date rules can only notify.");
  const c = i.conditions ?? {};
  if (i.trigger === "email_received" && !c.from && !c.subjectContains && !c.mailboxId) throw new HttpError(422, "validation_failed", "Say which emails: a sender, words in the subject or a mailbox.");
  if (i.trigger === "due_soon") { const h = Number(c.hoursBefore ?? 24); if (!(h >= 1 && h <= 24 * 14)) throw new HttpError(422, "validation_failed", "Remind between 1 hour and 14 days before."); }
}

export async function createAutomation(deps: Deps, actor: SuiteActor, input: AutomationInput) {
  assertWritable(actor);
  validate(input);
  const now = deps.now();
  const id = sortableId("aut", now.getTime());
  await deps.db.insert(automations).values({ id, orgId: actor.orgId, name: input.name.trim(), trigger: input.trigger, conditions: JSON.stringify(input.conditions ?? {}), action: input.action, actionConfig: JSON.stringify(input.actionConfig ?? {}), enabled: input.enabled ?? true, ...createdBy(actor), createdAt: now, updatedAt: now });
  await recordWrite(deps, actor, { entityType: "automation", entityId: id, op: "create", verb: "created", data: { name: input.name } });
  return present((await deps.db.select().from(automations).where(eq(automations.id, id)).get())!);
}

export async function updateAutomation(deps: Deps, actor: SuiteActor, id: string, patch: Partial<AutomationInput>) {
  assertWritable(actor);
  const r = await deps.db.select().from(automations).where(and(eq(automations.id, id), eq(automations.orgId, actor.orgId), isNull(automations.deletedAt))).get();
  if (!r) throw notFound("Automation");
  const next = { trigger: patch.trigger ?? r.trigger, action: patch.action ?? r.action, conditions: patch.conditions ?? JSON.parse(r.conditions), actionConfig: patch.actionConfig ?? JSON.parse(r.actionConfig) };
  validate(next);
  await deps.db.update(automations).set({
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), trigger: next.trigger, action: next.action,
    conditions: JSON.stringify(next.conditions), actionConfig: JSON.stringify(next.actionConfig),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), updatedAt: deps.now(), version: r.version + 1,
  }).where(eq(automations.id, id));
  return present((await deps.db.select().from(automations).where(eq(automations.id, id)).get())!);
}

export async function deleteAutomation(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  // Another workspace's id (or one already deleted) is a 404, not a silent success.
  const r = await deps.db.select({ id: automations.id }).from(automations).where(and(eq(automations.id, id), eq(automations.orgId, actor.orgId), isNull(automations.deletedAt))).get();
  if (!r) throw notFound("Automation");
  await deps.db.update(automations).set({ deletedAt: deps.now() }).where(and(eq(automations.id, id), eq(automations.orgId, actor.orgId)));
  return { ok: true };
}

const period = (d: Date) => d.toISOString().slice(0, 7);

/** Counts one run; false when the month's allowance is used up. */
async function takeRun(deps: Deps, orgId: string) {
  const plan = await getPlan(deps.db, orgId);
  const p = period(deps.now());
  const cur = await deps.db.select().from(usageCounters).where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.period, p), eq(usageCounters.metric, "automation_runs"))).get();
  if ((cur?.count ?? 0) >= plan.limits.automationRunsMonthly) return false;
  await deps.db.insert(usageCounters).values({ orgId, period: p, metric: "automation_runs", count: 1 })
    .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.period, usageCounters.metric], set: { count: sql`${usageCounters.count} + 1` } });
  return true;
}

export async function automationUsage(deps: Deps, orgId: string) {
  const plan = await getPlan(deps.db, orgId);
  const cur = await deps.db.select().from(usageCounters).where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.period, period(deps.now())), eq(usageCounters.metric, "automation_runs"))).get();
  return { used: cur?.count ?? 0, limit: plan.limits.automationRunsMonthly };
}

async function ran(deps: Deps, r: Row, error?: string) {
  await deps.db.update(automations).set({ runCount: sql`${automations.runCount} + 1`, lastRunAt: deps.now(), lastError: error ?? null }).where(eq(automations.id, r.id));
}

const systemActor = (orgId: string, name: string): SuiteActor => ({ orgId, userId: "", email: "automation", name: `Automation: ${name}`, system: true });

export function matchesEmail(c: EmailConditions, m: { from: string; subject: string; mailboxId: string }) {
  const from = m.from.toLowerCase();
  if (c.mailboxId && c.mailboxId !== m.mailboxId) return false;
  if (c.from) {
    const want = c.from.trim().toLowerCase();
    const ok = want.startsWith("@") ? from.endsWith(want) : want.includes("@") ? from === want : from.includes(want);
    if (!ok) return false;
  }
  if (c.subjectContains && !m.subject.toLowerCase().includes(c.subjectContains.trim().toLowerCase())) return false;
  return true;
}

async function admins(deps: Deps, orgId: string) {
  return (await deps.db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, orgId), or(eq(members.role, "owner"), eq(members.role, "admin"))))).map((r) => r.userId);
}

async function notifyTargets(deps: Deps, orgId: string, cfg: NotifyConfig, task?: Pick<Task, "assignee" | "createdBy">) {
  if (cfg.to === "assignee") return task?.assignee?.type === "member" ? [task.assignee.id] : [];
  if (cfg.to === "creator") return task?.createdBy.type === "member" && task.createdBy.id ? [task.createdBy.id] : [];
  if (cfg.to === "admins") return admins(deps, orgId);
  const m = await deps.db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, orgId), eq(members.userId, cfg.to))).get();
  return m ? [m.userId] : [];
}

/** New mail: rules with trigger email_received. */
export async function runEmailAutomations(deps: Deps, orgId: string, m: { messageId: string; threadId: string; mailboxId: string; from: string; subject: string }) {
  const rules = await deps.db.select().from(automations).where(and(eq(automations.orgId, orgId), eq(automations.trigger, "email_received"), eq(automations.enabled, true), isNull(automations.deletedAt)));
  let runs = 0;
  for (const r of rules) {
    if (!matchesEmail(JSON.parse(r.conditions) as EmailConditions, m)) continue;
    if (!(await takeRun(deps, orgId))) { await ran(deps, r, "Monthly automation runs used up."); continue; }
    try {
      const actor = systemActor(orgId, r.name);
      if (r.action === "create_task") {
        const cfg = JSON.parse(r.actionConfig) as CreateTaskConfig;
        const { createTaskFromThread, parseAssignee } = await import("./tasks");
        await createTaskFromThread(deps, actor, {
          messageId: m.messageId, projectId: cfg.projectId, priority: cfg.priority, assignee: parseAssignee(cfg.assignee ?? null),
          due: cfg.dueInDays ? new Date(deps.now().getTime() + cfg.dueInDays * 86_400_000).toISOString() : undefined,
          ...(cfg.title ? { title: cfg.title.replace("{subject}", m.subject) } : {}),
        });
      } else {
        for (const u of await notifyTargets(deps, orgId, JSON.parse(r.actionConfig) as NotifyConfig)) await notify(deps, orgId, u, { type: "automation.email", entityType: "message", entityId: m.messageId, title: `${r.name}: ${m.subject || "(no subject)"}` });
      }
      await ran(deps, r);
      runs++;
    } catch (err) {
      await ran(deps, r, err instanceof Error ? err.message.slice(0, 300) : "Failed");
    }
  }
  return runs;
}

/** A task changed status: rules with trigger status_changed. */
export async function runStatusAutomations(deps: Deps, orgId: string, task: Task, from: Category | null) {
  const rules = await deps.db.select().from(automations).where(and(eq(automations.orgId, orgId), eq(automations.trigger, "status_changed"), eq(automations.enabled, true), isNull(automations.deletedAt)));
  for (const r of rules) {
    const c = JSON.parse(r.conditions) as StatusConditions;
    if (c.projectId && c.projectId !== task.projectId) continue;
    if (c.toCategory && c.toCategory !== task.status) continue;
    if (c.toStatusId && c.toStatusId !== task.statusId) continue;
    if (from === task.status && !c.toStatusId) continue;
    if (!(await takeRun(deps, orgId))) { await ran(deps, r, "Monthly automation runs used up."); continue; }
    try {
      if (r.action === "notify") {
        for (const u of await notifyTargets(deps, orgId, JSON.parse(r.actionConfig) as NotifyConfig, task)) await notify(deps, orgId, u, { type: "automation.status", entityType: "task", entityId: task.id, title: `${task.ref} is now ${task.statusName}: ${task.title}` });
      } else {
        const cfg = JSON.parse(r.actionConfig) as CreateTaskConfig;
        const { createTask, parseAssignee } = await import("./tasks");
        await createTask(deps, systemActor(orgId, r.name), {
          title: (cfg.title ?? "Follow up: {title}").replace("{title}", task.title), projectId: cfg.projectId ?? task.projectId, priority: cfg.priority,
          assignee: parseAssignee(cfg.assignee ?? null) ?? (task.assignee ? { type: task.assignee.type, id: task.assignee.id } : null),
          due: cfg.dueInDays ? new Date(deps.now().getTime() + cfg.dueInDays * 86_400_000).toISOString() : undefined,
          source: task.source?.threadId ? { threadId: task.source.threadId } : undefined,
        });
      }
      await ran(deps, r);
    } catch (err) {
      await ran(deps, r, err instanceof Error ? err.message.slice(0, 300) : "Failed");
    }
  }
}

/** From maintenance (every few minutes): due date reminders. Each task is reminded once per due date. */
/**
 * Each reminder costs about a dozen queries (the task, its watchers, the notification, the
 * run counter), and the Workers limit on calls per invocation is shared with the rest of
 * maintenance. One run sends at most REMINDER_BUDGET reminders and looks at most RULE_BUDGET
 * rules, least recently run first, so the next run (five minutes later) picks up the rest.
 * Demo workspaces are sample data and get no reminders. Sentry MYMAIL-API-C was this step
 * passing the limit once many demo workspaces each had a due date rule.
 */
export const REMINDER_BUDGET = 25;
export const RULE_BUDGET = 50;

export async function runDueReminders(deps: Deps) {
  const rules = (await deps.db.select({ rule: automations }).from(automations)
    .innerJoin(organizations, eq(organizations.id, automations.orgId))
    .where(and(eq(automations.trigger, "due_soon"), eq(automations.enabled, true), isNull(automations.deletedAt), eq(organizations.isDemo, false)))
    .orderBy(sql`${automations.lastRunAt} IS NOT NULL`, asc(automations.lastRunAt))
    .limit(RULE_BUDGET)).map((x) => x.rule);
  let sent = 0;
  let budget = REMINDER_BUDGET;
  const now = deps.now();
  for (const r of rules) {
    if (budget <= 0) break;
    const c = JSON.parse(r.conditions) as DueConditions;
    const until = new Date(now.getTime() + Number(c.hoursBefore ?? 24) * 3_600_000);
    const due = await deps.db.select().from(tasks).where(and(eq(tasks.orgId, r.orgId), isNull(tasks.deletedAt), ne(tasks.status, "done"), gte(tasks.dueAt, now), lte(tasks.dueAt, until),
      c.projectId ? eq(tasks.projectId, c.projectId) : undefined)).limit(200);
    for (const t of due) {
      const key = `${r.id}:${t.dueAt!.toISOString()}`;
      if (t.reminderSentFor?.split(",").includes(key)) continue;
      if (budget <= 0) break;
      if (!(await takeRun(deps, r.orgId))) break;
      budget--;
      const { getTask } = await import("./tasks");
      const task = await getTask(deps, { orgId: r.orgId, userId: "", email: "", name: "", system: true }, t.id);
      for (const u of await notifyTargets(deps, r.orgId, JSON.parse(r.actionConfig) as NotifyConfig, task)) {
        await notify(deps, r.orgId, u, { type: "task.due_soon", entityType: "task", entityId: t.id, title: `${task.ref} is due soon: ${t.title}` });
        sent++;
      }
      await deps.db.update(tasks).set({ reminderSentFor: [t.reminderSentFor, key].filter(Boolean).join(",").slice(-1000) }).where(eq(tasks.id, t.id));
      await ran(deps, r);
    }
  }
  return { sent };
}
