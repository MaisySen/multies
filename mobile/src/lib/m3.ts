/**
 * M3 (1.10.11): Goals, Forms, Time and Automations on the phone, from the web app's own endpoints
 * (GET /api/goals, /api/forms, /api/forms/:id/responses, /api/time, PATCH /api/automations/:id).
 * Pure data and functions (no React), so the screens stay small and the rules are tested.
 */
import type { TimeEntry } from "@/api/types";

export type Health = "on_track" | "at_risk" | "off_track";
export interface KeyResult { id: string; name: string; kind: string; unit: string | null; start: number | null; target: number | null; current: number | null; progress: number; tasks: { total: number; done: number } | null }
export interface Goal { id: string; name: string; description: string; owner: { id: string; name: string } | null; due: string | null; health: Health | null; progress: number; keyResults: KeyResult[]; children: Goal[] }
export interface GoalsResponse { goals: Goal[]; summary?: { goals: number; progress: number } }

export interface Form { id: string; name: string; description: string | null; url: string; enabled: boolean; submitCount: number; lastSubmitAt: string | null }
export interface FormsResponse { forms: Form[] }
export interface FormResponses { fields: { id: string; label: string; type: string }[]; responses: { id: string; answers: Record<string, string>; createdAt: string }[]; total: number }

export interface Automation { id: string; name: string; trigger: string; action: string; enabled: boolean; runCount: number; lastRunAt: string | null; lastError: string | null }
export interface AutomationsResponse { automations: Automation[] }

const clamp = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);
export const pct = clamp;

/** Every goal with its depth, parents first, so a flat list shows the tree. */
export function flattenGoals(goals: Goal[] | undefined, depth = 0, out: { goal: Goal; depth: number; parent: string | null }[] = [], parent: string | null = null): { goal: Goal; depth: number; parent: string | null }[] {
  for (const g of goals ?? []) { out.push({ goal: g, depth, parent }); if (depth < 4) flattenGoals(g.children, depth + 1, out, g.name); }
  return out;
}

export const HEALTH: Record<Health, { label: string; tone: "ok" | "warn" | "bad" }> = {
  on_track: { label: "On track", tone: "ok" }, at_risk: { label: "At risk", tone: "warn" }, off_track: { label: "Off track", tone: "bad" },
};

/** "3 of 5 tasks", "$12,000 of $20,000", "40 of 100 %". */
export function krLine(k: KeyResult): string {
  if (k.tasks) return `${k.tasks.done} of ${k.tasks.total} ${k.tasks.total === 1 ? "task" : "tasks"}`;
  const n = (v: number | null) => (v == null ? "0" : v.toLocaleString("en-AU", { maximumFractionDigits: 2 }));
  if (k.unit === "AUD") return `$${n(k.current)} of $${n(k.target)}`;
  if (k.unit === "%") return `${n(k.current)}% of ${n(k.target)}%`;
  return `${n(k.current)} of ${n(k.target)}${k.unit ? ` ${k.unit}` : ""}`;
}

/** The first answers of a response, labelled, for a card (layout blocks and empty answers skipped). */
export function responsePreview(r: FormResponses["responses"][number], fields: FormResponses["fields"], max = 3): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const f of fields) {
    const v = r.answers?.[f.id];
    if (v == null || String(v).trim() === "") continue;
    out.push({ label: f.label || "Answer", value: String(v).replace(/\s+/g, " ").slice(0, 200) });
    if (out.length >= max) break;
  }
  return out;
}

/** Time entries grouped by local day, newest day first, each with its total. */
export function entriesByDay(entries: TimeEntry[] | undefined, now: number): { day: string; title: string; seconds: number; data: TimeEntry[] }[] {
  const groups = new Map<string, TimeEntry[]>();
  for (const e of entries ?? []) {
    const d = new Date(e.startedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const today = new Date(now); const y = new Date(now - 86400000);
  const k = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, data]) => ({
    day,
    title: day === k(today) ? "Today" : day === k(y) ? "Yesterday" : new Date(`${day}T12:00:00`).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "short" }),
    seconds: data.reduce((a, e) => a + (e.seconds || 0), 0),
    data: [...data].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)),
  }));
}

/** Monday 00:00 local of the week holding now, as an ISO string. */
export function weekStart(now: number): string {
  const d = new Date(now); const back = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - back);
  return d.toISOString();
}

const TRIGGER: Record<string, string> = {
  email_received: "When an email arrives", status_changed: "When a task changes status", due_soon: "When a task is due soon",
  task_created: "When a task is made", assignee_changed: "When a task is reassigned", due_passed: "When a task is overdue",
  meeting_ended: "When a meeting ends", chat_message_posted: "When a chat message is posted",
};
const ACTION: Record<string, string> = {
  create_task: "make a task", notify: "send a notification", assign_thread: "assign the email", post_to_channel: "post in a channel",
  assign_task: "assign the task", set_status: "set the status", add_label: "add a label", set_priority: "set the priority",
  create_subtask_checklist: "add a checklist",
};
const human = (s: string) => s.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
/** "When an email arrives, make a task". */
export function automationLine(a: Pick<Automation, "trigger" | "action">): string {
  const t = TRIGGER[a.trigger] ?? human(a.trigger || "When something happens");
  const act = ACTION[a.action] ?? human(a.action || "do something").toLowerCase();
  return `${t}, ${act}`;
}
