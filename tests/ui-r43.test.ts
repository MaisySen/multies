import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { windowRange, WINDOW_FROM } from "@/web/lib/use-windowed-list";
import { PhoneTaskList } from "@/web/pages/app/work/tasks-phone-r41";
import { TaskTable } from "@/web/pages/app/work/table";
import { Board } from "@/web/pages/app/work/board";
import type { Project, Task } from "@/web/pages/app/work/data";

/** R43 (MB-210): long task lists render a window of rows, not every row. */
const project = { id: "p1", name: "Big", key: "BIG", statuses: [{ id: "s1", name: "To do", category: "todo", color: "#8a8f98", position: 0 }] } as unknown as Project;
const many = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `t${i}`, ref: `BIG-${i + 1}`, title: `Task number ${i + 1}`, projectId: "p1", statusId: "s1", status: "todo", statusName: "To do", statusColor: "#8a8f98",
  type: "task", priority: "none", labels: [], assignee: null, assigneeId: null, due: null, start: null, points: null, parentId: null, fields: {}, subtasks: { total: 0, done: 0 }, checklist: { total: 0, done: 0 }, commentCount: 0,
})) as unknown as Task[];
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
const wrap = (el: ReturnType<typeof createElement>) => renderToString(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client: new QueryClient() }, el)));

describe("R43 list windowing", () => {
  it("windowRange covers the viewport plus overscan and clamps at both ends", () => {
    expect(windowRange(5000, 40, 0, 800, 8)).toEqual([0, 28]);
    expect(windowRange(5000, 40, 40_000, 800, 8)).toEqual([992, 1028]);
    expect(windowRange(5000, 40, 199_900, 800, 8)).toEqual([4989, 5000]);
    expect(windowRange(10, 40, 0, 800, 8)).toEqual([0, 10]);
    expect(windowRange(5000, 40, -500, 800, 8)).toEqual([0, 16]); // list still below the fold
  });

  it("a 5,000 task phone list renders a window of cards with spacers, not 5,000 rows", () => {
    const html = wrap(createElement(PhoneTaskList, { tasks: many(5000), projects: [project], onOpen: () => {} }));
    const rows = count(html, /data-testid="phone-task-row"/g);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(60);
    expect(html).toContain('aria-setsize="5000"');
    expect(html).toMatch(/<li aria-hidden="true" style="height:\d+px"><\/li><\/ul>/);
  });

  it("a short list renders every row and no spacer", () => {
    const html = wrap(createElement(PhoneTaskList, { tasks: many(WINDOW_FROM - 1), projects: [project], onOpen: () => {} }));
    expect(count(html, /data-testid="phone-task-row"/g)).toBe(WINDOW_FROM - 1);
    expect(html).not.toContain('aria-hidden="true" style="height');
  });

  it("a 5,000 task table renders a window of rows, keeps the row count for screen readers", () => {
    const html = wrap(createElement(TaskTable, { tasks: many(5000), projects: [project], onOpen: () => {}, projectId: "p1" }));
    const rows = count(html, /data-task-id="/g);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(60);
    expect(html).toContain('aria-rowcount="5001"');
    expect(html).toContain('data-testid="win-pad-bottom"');
  });

  it("a 500 card board column renders a window of cards (R44: windowed, the R43 Show more cap is gone)", () => {
    const html = wrap(createElement(Board, { project, tasks: many(500), onOpen: () => {}, onMove: () => {}, onAdd: () => {} }));
    const cards = count(html, />Task number \d+</g);
    expect(cards).toBeGreaterThan(0);
    expect(cards).toBeLessThanOrEqual(40);
    expect(html).not.toContain('data-testid="board-show-more"');
    expect(html).toContain('aria-setsize="500"');
  });
});
