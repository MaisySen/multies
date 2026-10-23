import type { KV } from "./kv";

/**
 * Tasks made from email. The web API has no tasks endpoints yet (see docs/api-gaps.md), so for
 * now they are saved on this device. The shape matches what the suite plan proposes for the API.
 */
export type TaskStatus = "todo" | "doing" | "done";
export interface Task {
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  due: string | null;
  source: { messageId: string; threadId: string; from: string; subject: string } | null;
  createdAt: string;
  updatedAt: string;
}

export const STATUSES: { id: TaskStatus; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "doing", label: "Doing" },
  { id: "done", label: "Done" },
];

const KEY = "tasks:v1";

export function taskStore(store: KV) {
  const read = async (): Promise<Task[]> => {
    const raw = await store.get(KEY);
    return raw ? (JSON.parse(raw) as Task[]) : [];
  };
  const write = (tasks: Task[]) => store.set(KEY, JSON.stringify(tasks));
  return {
    list: read,
    async create(input: Pick<Task, "title"> & Partial<Pick<Task, "notes" | "due" | "source" | "status">>): Promise<Task> {
      const title = input.title.trim();
      if (!title) throw new Error("Give the task a title.");
      const now = new Date().toISOString();
      const t: Task = { id: `tsk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title, notes: input.notes ?? "", status: input.status ?? "todo", due: input.due ?? null, source: input.source ?? null, createdAt: now, updatedAt: now };
      await write([t, ...(await read())]);
      return t;
    },
    async update(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Promise<Task> {
      const all = await read();
      const i = all.findIndex((t) => t.id === id);
      if (i < 0) throw new Error("That task no longer exists.");
      all[i] = { ...all[i], ...patch, updatedAt: new Date().toISOString() };
      await write(all);
      return all[i];
    },
    async remove(id: string) { await write((await read()).filter((t) => t.id !== id)); },
  };
}

export function nextStatus(s: TaskStatus): TaskStatus { return s === "todo" ? "doing" : s === "doing" ? "done" : "todo"; }
