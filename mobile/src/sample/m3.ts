/** M3 (1.10.11): sample Goals, Forms, Time and Automations for the sample workspace and screenshots. */
import type { TimeEntry } from "@/api/types";
import type { AutomationsResponse, FormResponses, FormsResponse, GoalsResponse } from "@/lib/m3";

const iso = (now: number, h: number) => new Date(now - h * 3600000).toISOString();

export function sampleM3(now: number) {
  const goals: GoalsResponse = { summary: { goals: 3, progress: 58 }, goals: [
    { id: "gl_1", name: "Grow monthly revenue to $40k", description: "", owner: { id: "u1", name: "Maya Chen" }, due: iso(now, -24 * 60), health: "on_track", progress: 64,
      keyResults: [
        { id: "kr_1", name: "New clients signed", kind: "number", unit: "clients", start: 0, target: 12, current: 8, progress: 67, tasks: null },
        { id: "kr_2", name: "Monthly recurring revenue", kind: "currency", unit: "AUD", start: 20000, target: 40000, current: 32200, progress: 61, tasks: null },
      ],
      children: [{ id: "gl_2", name: "Launch the partner programme", description: "", owner: { id: "u2", name: "Sam Ortiz" }, due: iso(now, -24 * 30), health: "at_risk", progress: 40,
        keyResults: [{ id: "kr_3", name: "Partner onboarding tasks", kind: "tasks", unit: null, start: null, target: null, current: 2, progress: 40, tasks: { total: 5, done: 2 } }], children: [] }] },
    { id: "gl_3", name: "Reply to every client within a day", description: "", owner: { id: "u1", name: "Maya Chen" }, due: null, health: "on_track", progress: 82,
      keyResults: [{ id: "kr_4", name: "Replies inside 24 hours", kind: "percent", unit: "%", start: 60, target: 95, current: 89, progress: 82, tasks: null }], children: [] },
  ] };
  const forms: FormsResponse = { forms: [
    { id: "fm_1", name: "Client intake", description: "New client details", url: "https://multies.si/f/client-intake", enabled: true, submitCount: 24, lastSubmitAt: iso(now, 3) },
    { id: "fm_2", name: "Project feedback", description: null, url: "https://multies.si/f/feedback", enabled: true, submitCount: 9, lastSubmitAt: iso(now, 50) },
    { id: "fm_3", name: "Event sign up", description: null, url: "https://multies.si/f/event", enabled: false, submitCount: 0, lastSubmitAt: null },
  ] };
  const responses: FormResponses = { total: 3, fields: [{ id: "f1", label: "Name", type: "text" }, { id: "f2", label: "Email", type: "email" }, { id: "f3", label: "What do you need help with?", type: "textarea" }],
    responses: [
      { id: "rs_1", answers: { f1: "Priya Nair", f2: "priya@example.com", f3: "Monthly bookkeeping and BAS" }, createdAt: iso(now, 3) },
      { id: "rs_2", answers: { f1: "Tom Walsh", f2: "tom@example.com", f3: "A new website for the shop" }, createdAt: iso(now, 26) },
      { id: "rs_3", answers: { f1: "Lena Fox", f2: "lena@example.com", f3: "Payroll set up for two staff" }, createdAt: iso(now, 72) },
    ] };
  const person = { type: "member" as const, id: "u1", name: "Maya Chen" };
  const entry = (id: string, h: number, secs: number, title: string, ref: string, running = false): TimeEntry => ({ id, taskId: `tsk_${id}`, task: { id: `tsk_${id}`, ref, title }, projectId: null, person,
    startedAt: iso(now, h), endedAt: running ? null : iso(now, h - secs / 3600), running, seconds: secs, note: "", billable: true, source: "timer" });
  const time: { entries: TimeEntry[] } = { entries: [
    entry("t1", 0.6, 2100, "Quarterly report draft", "OPS-12", true), entry("t2", 3, 5400, "Client call notes", "CLI-4"),
    entry("t3", 25, 7200, "Website copy review", "WEB-9"), entry("t4", 28, 3600, "Invoices for October", "FIN-3"),
  ] };
  const automations: AutomationsResponse = { automations: [
    { id: "au_1", name: "Client email to task", trigger: "email_received", action: "create_task", enabled: true, runCount: 41, lastRunAt: iso(now, 2), lastError: null },
    { id: "au_2", name: "Tell me when a task is overdue", trigger: "due_passed", action: "notify", enabled: true, runCount: 7, lastRunAt: iso(now, 20), lastError: null },
    { id: "au_3", name: "Meeting follow up", trigger: "meeting_ended", action: "create_task", enabled: false, runCount: 0, lastRunAt: null, lastError: null },
  ] };
  return { goals, forms, responses, time, automations };
}

/** The sample answers for the M3 paths, or undefined for anything else. */
export function m3Route(store: ReturnType<typeof sampleM3>, method: string, path: string, body: unknown, params: Record<string, string> = {}): unknown {
  if (method === "GET" && path === "/goals") return store.goals;
  if (method === "GET" && path === "/forms") return store.forms;
  if (method === "GET" && /^\/forms\/[^/]+\/responses$/.test(path)) return store.responses;
  // The week view only (from=, no task): the task screen keeps the sample workspace's own time entries.
  if (method === "GET" && path === "/time" && params.from && !params.taskId) return store.time;
  if (method === "GET" && path === "/automations") return store.automations;
  const m = /^\/automations\/([^/]+)$/.exec(path);
  if (method === "PATCH" && m) {
    const enabled = !!(body as { enabled?: boolean } | null)?.enabled;
    store.automations.automations = store.automations.automations.map((a) => (a.id === m[1] ? { ...a, enabled } : a));
    return { automation: store.automations.automations.find((a) => a.id === m[1]) };
  }
  return undefined;
}
