import { ApiError } from "@/api/errors";
import type { Assignee, AssigneeId, Message, Project, Task, TaskComment, TaskCreate, TaskDetail, TaskPatch, TaskStatus } from "@/api/types";
import { latestOnly } from "./latest-text";

/**
 * Work management for the sample workspace: the same routes and shapes as /api/tasks, kept in
 * memory on the phone so "Explore with sample data" works with no server and no connection.
 */
export interface SampleWork { project: Project; tasks: Task[]; comments: TaskComment[]; assignees: Assignee[]; seq: number }

const STATUS_IDS: Record<TaskStatus, { id: string; name: string; color: string }> = {
  todo: { id: "sts_todo", name: "To do", color: "#8a8f98" },
  doing: { id: "sts_doing", name: "In progress", color: "#f5a524" },
  done: { id: "sts_done", name: "Done", color: "#2fbf71" },
};

export function sampleWork(now: number, messages: Message[]): SampleWork {
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const day = (d: number) => { const x = new Date(now); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
  const assignees: Assignee[] = [
    { id: "member:usr_sample", type: "member", name: "Mia Nguyen", email: "mia@harbourcoffee.com.au" },
    { id: "member:usr_josh", type: "member", name: "Josh Tran", email: "josh@harbourcoffee.com.au" },
    { id: "agent:agt_invoice", type: "agent", name: "Invoice chaser", email: "accounts-agent@harbourcoffee.com.au" },
    { id: "agent:agt_support", type: "agent", name: "Support triage", email: "support-agent@harbourcoffee.com.au" },
  ];
  const project: Project = {
    id: "prj_ops", name: "Operations", key: "OPS", color: "#ff6a3d",
    statuses: (["todo", "doing", "done"] as TaskStatus[]).map((c, i) => ({ id: STATUS_IDS[c].id, name: STATUS_IDS[c].name, category: c, color: STATUS_IDS[c].color, position: i })),
  };
  const work: SampleWork = { project, tasks: [], comments: [], assignees, seq: 0 };
  const add = (t: Partial<Task> & Pick<Task, "title">, minutesAgo: number) =>
    create(work, { title: t.title, notes: t.notes, status: t.status, due: t.due, priority: t.priority, labels: t.labels, assigneeId: t.assigneeId }, ago(minutesAgo), t.source ?? null);
  const src = (id: string) => {
    const m = messages.find((x) => x.id === id)!;
    return { threadId: m.threadId, messageId: m.id, from: m.from.name ?? m.from.address, subject: m.subject };
  };
  add({ title: "Lodge the September quarter BAS", status: "todo", due: day(4), priority: "high", labels: ["tax"], assigneeId: "member:usr_sample", source: src("msg_2"),
    notes: "Due 28 October. Check the GST on the Marrickville stall takings first." }, 50);
  add({ title: "Confirm Saturday wholesale order with Bondi Bakehouse", status: "doing", due: day(1), priority: "medium", labels: ["wholesale"], assigneeId: "member:usr_josh", source: src("msg_1"),
    notes: "12 kg house blend, 4 kg decaf. Invoice goes to accounts@bondibakehouse.com.au." }, 6);
  add({ title: "Chase INV-1042 with Green Roof Cafe", status: "doing", due: day(-1), priority: "urgent", labels: ["invoices"], assigneeId: "agent:agt_invoice", source: src("msg_3") }, 75);
  add({ title: "Compare fit out quotes for the Surry Hills kiosk", status: "todo", due: day(9), priority: "low", labels: ["kiosk"], source: src("msg_4") }, 170);
  add({ title: "Order stall signage for Marrickville Markets", status: "done", priority: "none", assigneeId: "member:usr_sample", source: src("msg_6") }, 60 * 28);
  const chase = work.tasks.find((t) => t.title.startsWith("Chase"))!;
  work.comments.push({ id: "cmt_1", taskId: chase.id, body: "Li says the remittance is attached. Check it against the bank feed before closing.", author: { type: "member", id: "usr_sample", name: "Mia Nguyen" }, createdAt: ago(70) });
  chase.commentCount = 1;
  return work;
}

function statusOf(project: Project, status: TaskStatus) {
  const s = project.statuses.find((x) => x.category === status)!;
  return { statusId: s.id, statusName: s.name, statusColor: s.color, status };
}

function assigneeOf(work: SampleWork, id: AssigneeId | null | undefined): Pick<Task, "assignee" | "assigneeId"> {
  if (!id) return { assignee: null, assigneeId: null };
  const a = work.assignees.find((x) => x.id === id);
  if (!a) throw new ApiError(422, "bad_assignee", "That person or agent isn't in this workspace.");
  return { assignee: { type: a.type, id: a.id.split(":")[1], name: a.name, email: a.email }, assigneeId: a.id };
}

function create(work: SampleWork, input: TaskCreate, at: string, source: Task["source"]): Task {
  const title = input.title?.trim();
  if (!title) throw new ApiError(422, "validation_error", "Give the task a title.");
  const number = ++work.seq;
  const status = input.status ?? "todo";
  const t: Task = {
    id: `tsk_s${number}`, ref: `${work.project.key}-${number}`, projectId: work.project.id, number, title, notes: input.notes ?? "",
    ...statusOf(work.project, status), ...assigneeOf(work, input.assigneeId),
    priority: input.priority ?? "none", labels: input.labels ?? [], start: null, due: input.due ?? null, parentId: input.parentId ?? null,
    position: number * 1000, source, subtasks: { total: 0, done: 0 }, commentCount: 0, completedAt: status === "done" ? at : null,
    createdBy: { type: "member", id: "usr_sample" }, createdAt: at, updatedAt: at, version: 1,
  };
  work.tasks.unshift(t);
  if (t.parentId) refreshSubtasks(work, t.parentId);
  return t;
}

function refreshSubtasks(work: SampleWork, parentId: string) {
  const p = work.tasks.find((x) => x.id === parentId);
  if (!p) return;
  const kids = work.tasks.filter((x) => x.parentId === parentId);
  p.subtasks = { total: kids.length, done: kids.filter((k) => k.status === "done").length };
}

function find(work: SampleWork, idOrRef: string): Task {
  const t = work.tasks.find((x) => x.id === idOrRef || x.ref.toLowerCase() === idOrRef.toLowerCase());
  if (!t) throw new ApiError(404, "not_found", "Task not found.");
  return t;
}

/** Answers the task routes. Returns undefined when the path isn't one of them. */
export function taskRoute(work: SampleWork, messages: Message[], method: string, parts: string[], params: Record<string, string>, body: unknown): unknown {
  const [root, a, b] = parts;
  const now = new Date().toISOString();
  if (root === "projects" && method === "GET" && !a) {
    return { projects: [{ ...work.project, counts: Object.fromEntries((["todo", "doing", "done"] as TaskStatus[]).map((s) => [s, work.tasks.filter((t) => t.status === s && !t.parentId).length])) }] };
  }
  if (root === "changes" && method === "GET") return { changes: [], cursor: Number(params.since ?? 0), more: false };
  if (root === "notifications") return method === "GET" ? { notifications: [] } : { marked: 0 };
  if (root === "push") {
    if (method === "GET") return { enabled: false, devices: [] };
    return method === "POST" ? { ok: true, enabled: false } : { ok: true };
  }
  if (root !== "tasks") return undefined;

  if (!a && method === "GET") {
    const f = params;
    let list = work.tasks.filter((t) => (f.includeSubtasks === "true" ? true : !t.parentId));
    if (f.status) list = list.filter((t) => t.status === f.status);
    if (f.threadId) list = list.filter((t) => t.source?.threadId === f.threadId);
    if (f.assignee === "me") list = list.filter((t) => t.assigneeId === "member:usr_sample");
    else if (f.assignee === "none") list = list.filter((t) => !t.assigneeId);
    else if (f.assignee) list = list.filter((t) => t.assigneeId === f.assignee);
    if (f.q) list = list.filter((t) => `${t.title} ${t.notes} ${t.ref}`.toLowerCase().includes(String(f.q).toLowerCase()));
    return { tasks: list };
  }
  if (!a && method === "POST") {
    const input = body as TaskCreate;
    const m = input.source?.messageId ? messages.find((x) => x.id === input.source!.messageId) : undefined;
    return { task: create(work, input, now, m ? { threadId: m.threadId, messageId: m.id, from: m.from.name ?? m.from.address, subject: m.subject } : null) };
  }
  if (a === "from-email" && method === "POST") {
    const input = body as { messageId?: string; threadId?: string; title?: string; notes?: string; due?: string; priority?: Task["priority"] };
    const inThread = messages.filter((x) => (input.messageId ? x.id === input.messageId : x.threadId === input.threadId));
    const pick = input.messageId ? inThread[0] : [...inThread].sort((x, y) => y.date.localeCompare(x.date))[0];
    if (!pick) throw new ApiError(404, "not_found", "Message not found.");
    const newest = messages.filter((x) => x.threadId === pick.threadId).sort((x, y) => y.date.localeCompare(x.date))[0];
    const title = (input.title ?? pick.subject.replace(/^(re|fwd?):\s*/i, "")) || "Follow up";
    return { task: create(work, { title, notes: input.notes ?? latestOnly(newest.text).slice(0, 2000), due: input.due, priority: input.priority }, now,
      { threadId: pick.threadId, messageId: pick.id, from: pick.from.name ?? pick.from.address, subject: pick.subject }) };
  }
  if (a === "assignees" && method === "GET") return { assignees: work.assignees };
  if (!a) return undefined;

  const t = find(work, decodeURIComponent(a));
  if (b === "comments" && method === "POST") {
    const text = String((body as { body?: string })?.body ?? "").trim();
    if (!text) throw new ApiError(422, "validation_error", "Write a comment first.");
    const c: TaskComment = { id: `cmt_s${work.comments.length + 2}`, taskId: t.id, body: text, author: { type: "member", id: "usr_sample", name: "Mia Nguyen" }, createdAt: now };
    work.comments.push(c);
    t.commentCount++;
    return { comment: c };
  }
  if (method === "GET") {
    const thread = t.source?.threadId ? messages.filter((m) => m.threadId === t.source!.threadId && m.folder !== "drafts").sort((x, y) => x.date.localeCompare(y.date)) : [];
    const detail: TaskDetail = {
      task: t,
      subtasks: work.tasks.filter((x) => x.parentId === t.id),
      comments: work.comments.filter((c) => c.taskId === t.id),
      thread: thread.map((m) => ({ id: m.id, mailboxId: m.mailboxId, direction: m.folder === "sent" ? "outbound" : "inbound", from: { address: m.from.address, name: m.from.name ?? null }, subject: m.subject, date: m.date, latestText: latestOnly(m.text), byAgent: !!m.sentByAgentId })),
      activity: [], docs: [], contacts: [],
    };
    return detail;
  }
  if (method === "PATCH") {
    const p = body as TaskPatch;
    if (p.version !== undefined && p.version !== t.version) throw new ApiError(409, "version_conflict", "Someone else changed this task. Showing the latest.");
    if (p.title !== undefined) { if (!p.title.trim()) throw new ApiError(422, "validation_error", "Give the task a title."); t.title = p.title.trim(); }
    if (p.notes !== undefined) t.notes = p.notes;
    if (p.status) { Object.assign(t, statusOf(work.project, p.status)); t.completedAt = p.status === "done" ? now : null; }
    if (p.due !== undefined) t.due = p.due;
    if (p.priority) t.priority = p.priority;
    if (p.labels) t.labels = p.labels;
    if (p.assigneeId !== undefined) Object.assign(t, assigneeOf(work, p.assigneeId));
    if (p.position !== undefined) t.position = p.position;
    t.version++;
    t.updatedAt = now;
    if (t.parentId) refreshSubtasks(work, t.parentId);
    return { task: t };
  }
  if (method === "DELETE") {
    work.tasks = work.tasks.filter((x) => x.id !== t.id && x.parentId !== t.id);
    if (t.parentId) refreshSubtasks(work, t.parentId);
    return { ok: true };
  }
  return undefined;
}
