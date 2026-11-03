import { describe, expect, it } from "vitest";
import { parseSortValue, sortTasks, sortValue } from "@/web/lib/task-sort-par1";
import type { Task } from "@/web/pages/app/work/data";

const task = (o: Partial<Task>) => ({ id: o.title, title: "x", priority: "none", due: null, updatedAt: "2026-11-01", projectId: "p", statusId: "s1", assignee: null, ...o }) as unknown as Task;

describe("PAR1 phone task list sort", () => {
  const list = [task({ title: "b", due: "2026-11-09", priority: "low" }), task({ title: "A", due: null, priority: "urgent" }), task({ title: "c", due: "2026-11-04", priority: "high" })];
  it("sorts by the list's column keys, empty due dates last, stable", () => {
    expect(sortTasks(list, { id: "title", desc: false }).map((t) => t.title)).toEqual(["A", "b", "c"]);
    expect(sortTasks(list, { id: "due", desc: false }).map((t) => t.title)).toEqual(["c", "b", "A"]);
    expect(sortTasks(list, { id: "priority", desc: false }).map((t) => t.title)).toEqual(["A", "c", "b"]);
    expect(sortTasks(list, { id: "title", desc: true }).map((t) => t.title)).toEqual(["c", "b", "A"]);
    expect(sortTasks(list, null)).toBe(list);
    expect(sortTasks(list, { id: "field:x", desc: false })).toBe(list);
  });
  it("round trips the picker value through the address", () => {
    expect(parseSortValue("updated:desc")).toEqual({ sort: "updated", dir: "desc" });
    expect(parseSortValue("due")).toEqual({ sort: "due", dir: "asc" });
    expect(parseSortValue("")).toEqual({ sort: null, dir: null });
    expect(sortValue({ id: "updated", desc: true })).toBe("updated:desc");
    expect(sortValue(null)).toBe("");
  });
});
