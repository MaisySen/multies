import { describe, expect, it } from "vitest";
import { parseSortValue, PHONE_SORTS, sortTasks, sortValue } from "@/web/lib/task-sort-par1";
import { TABLE_COLUMNS } from "@/web/pages/app/work/table";
import type { Task } from "@/web/pages/app/work/data";

const task = (o: Partial<Task>) => ({ id: o.title, title: "x", priority: "none", due: null, start: null, points: null, labels: [], updatedAt: "2026-11-01", projectId: "p", statusId: "s1", status: "todo", assignee: null, ...o }) as unknown as Task;
const ctx = { projects: new Map(), people: [], statusesFor: () => [] };
const keyFor = (id: string) => { const c = TABLE_COLUMNS.find((x) => x.id === id); return c?.sortKey ? (t: Task) => c.sortKey!(t, ctx) : null; };

describe("PAR1 phone task list sort", () => {
  const list = [task({ title: "b", due: "2026-11-09", priority: "low" }), task({ title: "A", due: null, priority: "urgent" }), task({ title: "c", due: "2026-11-04", priority: "high" })];
  it("sorts by the table's own column keys, empty due dates last, stable", () => {
    expect(sortTasks(list, { id: "title", desc: false }, keyFor).map((t) => t.title)).toEqual(["A", "b", "c"]);
    expect(sortTasks(list, { id: "due", desc: false }, keyFor).map((t) => t.title)).toEqual(["c", "b", "A"]);
    expect(sortTasks(list, { id: "priority", desc: false }, keyFor).map((t) => t.title)).toEqual(["A", "c", "b"]);
    expect(sortTasks(list, { id: "title", desc: true }, keyFor).map((t) => t.title)).toEqual(["c", "b", "A"]);
    expect(sortTasks(list, null, keyFor)).toBe(list);
    expect(sortTasks(list, { id: "field:x", desc: false }, keyFor)).toBe(list);
  });
  it("every phone sort choice is a column the table sorts by", () => {
    for (const o of PHONE_SORTS) if (o.value) expect(keyFor(parseSortValue(o.value).sort!), o.value).not.toBeNull();
  });
  it("round trips the picker value through the address", () => {
    expect(parseSortValue("due:desc")).toEqual({ sort: "due", dir: "desc" });
    expect(parseSortValue("due")).toEqual({ sort: "due", dir: "asc" });
    expect(parseSortValue("")).toEqual({ sort: null, dir: null });
    expect(sortValue({ id: "due", desc: true })).toBe("due:desc");
    expect(sortValue(null)).toBe("");
  });
});
