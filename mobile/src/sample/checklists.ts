import { ApiError } from "@/api/errors";
import type { ChecklistItem, Task } from "@/api/types";
import type { SampleWork } from "./tasks";

/** R27: checklists and the task query language in the sample workspace, shaped like the server's (R26). */

export function seedChecklists(work: SampleWork, at: string) {
  const bas = work.tasks.find((t) => t.title.startsWith("Lodge the September quarter BAS"));
  if (!bas) return;
  const titles: [string, boolean][] = [["Export the stall takings from Square", true], ["Check GST on the Marrickville takings", true], ["Match the bank feed", false], ["Lodge on the ATO portal", false], ["File the receipt", false]];
  work.checklists = titles.map(([title, done], n) => ({ id: `chk_s${n + 1}`, taskId: bas.id, title, done, position: n + 1, assignee: null, due: null, createdAt: at, updatedAt: at }));
  work.chkSeq = titles.length;
  refreshCounts(work);
}

function items(work: SampleWork, taskId: string): ChecklistItem[] {
  return (work.checklists ?? []).filter((i) => i.taskId === taskId).sort((a, b) => a.position - b.position);
}

function refreshCounts(work: SampleWork) {
  for (const t of work.tasks) {
    const list = items(work, t.id);
    t.checklist = { total: list.length, done: list.filter((i) => i.done).length };
  }
}

function view(work: SampleWork, taskId: string) {
  const list = items(work, taskId);
  return { taskId, items: list, total: list.length, done: list.filter((i) => i.done).length };
}

/** Answers /tasks/:id/checklist and /checklist-items/:id. Undefined when the path is something else. */
export function checklistRoute(work: SampleWork, method: string, parts: string[], body: unknown, findTask: (idOrRef: string) => Task): unknown {
  const now = new Date().toISOString();
  if (parts[0] === "tasks" && parts[2] === "checklist") {
    const t = findTask(decodeURIComponent(parts[1]));
    if (parts[3] === "reorder" && method === "POST") {
      const ids = ((body as { ids?: string[] })?.ids ?? []);
      const list = items(work, t.id);
      if (ids.length !== list.length || !list.every((i) => ids.includes(i.id))) throw new ApiError(400, "bad_request", "Send every item id once.");
      ids.forEach((id, n) => { const it = list.find((i) => i.id === id)!; it.position = n + 1; });
      return view(work, t.id);
    }
    if (parts.length === 3 && method === "GET") return view(work, t.id);
    if (parts.length === 3 && method === "POST") {
      const title = String((body as { title?: string })?.title ?? "").trim();
      if (!title) throw new ApiError(400, "bad_request", "Give the item a name.");
      const list = items(work, t.id);
      const pos = list.reduce((m, i) => Math.max(m, i.position), 0) + 1;
      work.chkSeq = (work.chkSeq ?? 0) + 1;
      const it: ChecklistItem = { id: `chk_s${work.chkSeq}`, taskId: t.id, title, done: false, position: pos, assignee: null, due: null, createdAt: now, updatedAt: now };
      work.checklists = [...(work.checklists ?? []), it];
      refreshCounts(work);
      return { items: [it] };
    }
    return undefined;
  }
  if (parts[0] === "checklist-items" && parts[1]) {
    const it = (work.checklists ?? []).find((i) => i.id === decodeURIComponent(parts[1]));
    if (!it) throw new ApiError(404, "not_found", "Checklist item not found.");
    if (method === "PATCH") {
      const p = (body ?? {}) as { title?: string; done?: boolean };
      if (p.title !== undefined) { if (!p.title.trim()) throw new ApiError(400, "bad_request", "Give the item a name."); it.title = p.title.trim(); }
      if (p.done !== undefined) it.done = !!p.done;
      it.updatedAt = now;
      refreshCounts(work);
      return { item: it };
    }
    if (method === "DELETE") {
      work.checklists = (work.checklists ?? []).filter((i) => i.id !== it.id);
      refreshCounts(work);
      return { ok: true };
    }
  }
  return undefined;
}

const KEYS = new Set(["assignee", "status", "label", "priority", "due", "is", "has", "title"]);

/**
 * A small slice of the server's task query language for the sample workspace: assignee:me|none,
 * status, label, priority, due:<Nd / overdue, is:overdue|open|done, has:checklist, and free text.
 * An unknown key answers 400 bad_query with the 1 based position, as the server does.
 */
export function filterByQuery(list: Task[], q: string, today = new Date()): Task[] {
  const re = /(-?)([a-z]+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/gi;
  const day = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const tests: ((t: Task) => boolean)[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const [, neg, rawKey, rawVal, quoted, word] = m;
    if (rawKey) {
      const key = rawKey.toLowerCase();
      const val = rawVal.replace(/^"|"$/g, "").toLowerCase();
      if (!KEYS.has(key)) throw new ApiError(400, "bad_query", `Unknown key "${key}".`, { position: m.index + 1 + neg.length });
      let f: (t: Task) => boolean;
      switch (key) {
        case "assignee": f = (t) => (val === "me" ? t.assigneeId === "member:usr_sample" : val === "none" ? !t.assigneeId : (t.assignee?.name ?? "").toLowerCase().includes(val)); break;
        case "status": f = (t) => (val === "open" ? t.status !== "done" : t.status === val || t.statusName.toLowerCase() === val); break;
        case "label": f = (t) => t.labels.some((l) => l.toLowerCase() === val); break;
        case "priority": f = (t) => t.priority === val; break;
        case "due": {
          const n = /^<(\d+)d$/.exec(val);
          f = n ? (t) => !!t.due && t.due.slice(0, 10) <= day(Number(n[1])) : val === "none" ? (t) => !t.due : (t) => t.due?.slice(0, 10) === val;
          break;
        }
        case "is": f = (t) => (val === "overdue" ? !!t.due && t.status !== "done" && t.due.slice(0, 10) < day(0) : val === "done" ? t.status === "done" : val === "open" ? t.status !== "done" : val === "unassigned" ? !t.assigneeId : false); break;
        case "has": f = (t) => (val === "checklist" ? !!t.checklist?.total : val === "due" ? !!t.due : val === "labels" ? t.labels.length > 0 : val === "subtasks" ? t.subtasks.total > 0 : false); break;
        default: f = (t) => t.title.toLowerCase().includes(val);
      }
      tests.push(neg ? (t) => !f(t) : f);
    } else {
      const text = (quoted ?? word).toLowerCase();
      tests.push((t) => `${t.title} ${t.notes} ${t.ref}`.toLowerCase().includes(text));
    }
  }
  return list.filter((t) => tests.every((f) => f(t)));
}
