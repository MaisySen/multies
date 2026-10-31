import { describe, expect, it } from "vitest";
import { dueBucket, groupTasks, isGroupBy, type GroupTask } from "../src/web/lib/task-groups-r84";
import { applyFormat, mentionAt, mentionHandle, renderNotes } from "../src/web/lib/task-text-r84";

const base: GroupTask = { id: "t", projectId: "p1", statusId: "s1", statusName: "To do", statusColor: "gray", status: "todo", assignee: null, priority: "none", due: null, labels: [] };
const task = (over: Partial<GroupTask>): GroupTask => ({ ...base, ...over });
const ctx = {
  projects: [{ id: "p1", name: "Launch", statuses: [{ id: "s1", name: "To do", color: "gray" }, { id: "s2", name: "Doing", color: "blue" }, { id: "s3", name: "Done", color: "green" }] }, { id: "p2", name: "Ops", statuses: [] }],
  tags: [{ name: "client", color: "#16a34a" }, { name: "launch", color: "#2563eb" }],
  fields: [{ id: "f1", name: "Stage", type: "select", options: [{ id: "o1", label: "Brief", color: "" }, { id: "o2", label: "Build", color: "" }] }, { id: "f2", name: "Signed", type: "checkbox", options: [] }],
  people: [{ id: "member:u1", name: "Olive Ng" }],
  now: new Date("2026-10-31T10:00:00"),
};

describe("R84 task groups", () => {
  it("knows which group values are allowed", () => {
    expect(isGroupBy("status")).toBe(true);
    expect(isGroupBy("field:f1")).toBe(true);
    expect(isGroupBy("field:")).toBe(false);
    expect(isGroupBy("epic")).toBe(false);
    expect(isGroupBy(null)).toBe(false);
  });
  it("groups by status in workflow order, merging same names across projects", () => {
    const g = groupTasks([task({ id: "a", status: "done", statusId: "s3", statusName: "Done" }), task({ id: "b" }), task({ id: "c", projectId: "p2", statusId: "x", statusName: "To do" }), task({ id: "d", status: "doing", statusId: "s2", statusName: "Doing" })], "status", ctx);
    expect(g.map((x) => [x.label, x.tasks.map((t) => t.id)])).toEqual([["To do", ["b", "c"]], ["Doing", ["d"]], ["Done", ["a"]]]);
  });
  it("groups by priority with urgent first and by assignee with Nobody last", () => {
    const tasks = [task({ id: "a", priority: "low" }), task({ id: "b", priority: "urgent", assignee: { type: "member", id: "u1", name: "Olive Ng" } }), task({ id: "c" })];
    expect(groupTasks(tasks, "priority", ctx).map((x) => x.label)).toEqual(["Urgent", "Low", "No priority"]);
    expect(groupTasks(tasks, "assignee", ctx).map((x) => x.label)).toEqual(["Olive Ng", "Nobody"]);
  });
  it("buckets due dates", () => {
    const now = ctx.now;
    expect(dueBucket("2026-10-30", false, now).label).toBe("Overdue");
    expect(dueBucket("2026-10-30", true, now).label).toBe("Earlier");
    expect(dueBucket("2026-10-31", false, now).label).toBe("Today");
    expect(dueBucket("2026-11-01", false, now).label).toBe("Tomorrow");
    expect(dueBucket("2026-11-05", false, now).label).toBe("Next 7 days");
    expect(dueBucket("2026-12-25", false, now).label).toBe("Later");
    expect(dueBucket(null, false, now).label).toBe("No due date");
  });
  it("groups by first tag in workspace order, with colours", () => {
    const g = groupTasks([task({ id: "a", labels: ["launch", "client"] }), task({ id: "b", labels: ["launch"] }), task({ id: "c" })], "tag", ctx);
    expect(g.map((x) => [x.label, x.color, x.tasks.length])).toEqual([["client", "#16a34a", 1], ["launch", "#2563eb", 1], ["No tag", undefined, 1]]);
  });
  it("groups by a dropdown or checkbox field", () => {
    const tasks = [task({ id: "a", fields: { f1: "o2", f2: true } }), task({ id: "b", fields: { f1: "o1" } }), task({ id: "c" })];
    expect(groupTasks(tasks, "field:f1", ctx).map((x) => x.label)).toEqual(["Brief", "Build", "No stage"]);
    expect(groupTasks(tasks, "field:f2", ctx).map((x) => x.label)).toEqual(["Ticked", "No signed"]);
    expect(groupTasks(tasks, "project", ctx).map((x) => x.label)).toEqual(["Launch"]);
  });
});

describe("R84 description editor helpers", () => {
  it("wraps the selection in bold, and toggles a bullet list per line", () => {
    expect(applyFormat("ship it now", 5, 7, "bold")).toEqual({ text: "ship **it** now", start: 7, end: 9 });
    const r = applyFormat("one\ntwo", 0, 7, "bullets");
    expect(r.text).toBe("- one\n- two");
    expect(applyFormat(r.text, 0, r.text.length, "bullets").text).toBe("one\ntwo");
    expect(applyFormat("a\nb", 0, 3, "numbers").text).toBe("1. a\n2. b");
    expect(applyFormat("x", 1, 1, "link").text).toBe("x[link](https://)");
  });
  it("renders safe markdown: escapes HTML, lists, checks, links and mentions", () => {
    const html = renderNotes("<script>x</script> **bold**\n- [x] done\n- [ ] open\n1. first\nSee https://example.com and @olive");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('type="checkbox" disabled aria-label="Done" checked');
    expect(html).toMatch(/<ol>\s*<li>first<\/li>/);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<span class="mention">@olive</span>');
    expect(renderNotes("[x](javascript:alert(1))")).not.toContain("href");
  });
  it("finds the @word at the caret and the handle to insert", () => {
    expect(mentionAt("hi @ol", 6)).toEqual({ start: 3, query: "ol" });
    expect(mentionAt("mail me@x", 9)).toBeNull();
    const people = [{ type: "member", id: "member:1", name: "Olive Ng", email: "olive@acme.io" }, { type: "member", id: "member:2", name: "Olive Park", email: "opark@acme.io" }, { type: "member", id: "member:3", name: "Sam Lee", email: "sam@acme.io" }] as never[];
    expect(mentionHandle(people[0]!, people)).toBe("olive");
    expect(mentionHandle(people[2]!, people)).toBe("Sam");
  });
});
