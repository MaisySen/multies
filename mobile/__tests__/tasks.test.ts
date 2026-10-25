import { SampleTransport } from "@/sample/transport";
import { endpoints } from "@/api/endpoints";
import { dayFrom, dueLabel, nextMonday, nextStatus, senderName, sortTasks } from "@/lib/tasks";
import { extractPushData, routeForPush, describePush, fallbackText } from "@/lib/push-events";
import { bytes, initials, parseRecipients, quoteForReply, shortDate, timeLeft } from "@/lib/format";
import type { Task } from "@/api/types";

describe("tasks in the sample workspace (same routes as /api/tasks)", () => {
  const api = () => endpoints(new SampleTransport());

  it("lists tasks with refs, statuses and assignees", async () => {
    const { tasks } = await api().tasks();
    expect(tasks.length).toBe(5);
    expect(tasks.every((t) => /^OPS-\d+$/.test(t.ref))).toBe(true);
    expect(tasks.find((t) => t.assignee?.type === "agent")?.assignee?.name).toBe("Invoice chaser");
  });

  it("makes a task from an email in one call, linked to the thread", async () => {
    const a = api();
    const { task } = await a.taskFromEmail({ messageId: "msg_4" });
    expect(task.title).toBe("Quote for the Surry Hills kiosk fit out");
    expect(task.source).toMatchObject({ messageId: "msg_4", threadId: "thr_4", from: "Jordan Blake" });
    expect(task.notes.length).toBeGreaterThan(10);
    const detail = await a.task(task.ref);
    expect(detail.thread.map((m) => m.id)).toContain("msg_4");
    expect((await a.tasks({ threadId: "thr_4" })).tasks.map((t) => t.id)).toContain(task.id);
  });

  it("moves a task to done, bumps its version and rejects a stale version", async () => {
    const a = api();
    const { task } = await a.createTask({ title: "  Chase INV-1051  " });
    expect(task.title).toBe("Chase INV-1051");
    expect(task.status).toBe("todo");
    const { task: done } = await a.updateTask(task.id, { status: "done", version: task.version });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    expect(done.version).toBe(task.version + 1);
    await expect(a.updateTask(task.id, { title: "x", version: task.version })).rejects.toMatchObject({ status: 409 });
  });

  it("assigns, comments, adds subtasks and deletes", async () => {
    const a = api();
    const { task } = await a.createTask({ title: "Order cups" });
    await a.updateTask(task.id, { assigneeId: "agent:agt_support", priority: "high", due: dayFrom(1) });
    await a.addComment(task.id, "Ask for the compostable ones.");
    await a.createTask({ title: "Get two quotes", parentId: task.id });
    const d = await a.task(task.id);
    expect(d.task.assignee?.name).toBe("Support triage");
    expect(d.comments[0].body).toBe("Ask for the compostable ones.");
    expect(d.subtasks).toHaveLength(1);
    expect(d.task.subtasks).toEqual({ total: 1, done: 0 });
    expect((await a.tasks()).tasks.some((t) => t.parentId)).toBe(false);
    await a.deleteTask(task.id);
    await expect(a.task(task.id)).rejects.toMatchObject({ status: 404 });
  });

  it("needs a title", async () => {
    await expect(api().createTask({ title: " " })).rejects.toThrow("Give the task a title.");
  });

  it("filters by assignee and answers the push and project routes", async () => {
    const a = api();
    expect((await a.tasks({ assignee: "me" })).tasks.every((t) => t.assigneeId === "member:usr_sample")).toBe(true);
    expect((await a.projects()).projects[0].statuses.map((s) => s.category)).toEqual(["todo", "doing", "done"]);
    expect(await a.registerPushDevice("ExponentPushToken[abcdefghijkl]", "android")).toEqual({ ok: true, enabled: false });
    expect((await a.assignees()).assignees.length).toBe(4);
  });
});

describe("task helpers", () => {
  it("cycles status", () => {
    expect(["todo", "doing", "done"].map((s) => nextStatus(s as never))).toEqual(["doing", "done", "todo"]);
  });
  it("words due dates", () => {
    const now = new Date("2026-10-24T10:00:00");
    expect(dueLabel(null, now)).toBeNull();
    expect(dueLabel("2026-10-24", now)).toEqual({ text: "Due today", tone: "warn" });
    expect(dueLabel("2026-10-25", now)?.text).toBe("Due tomorrow");
    expect(dueLabel("2026-10-21T00:00:00.000Z", now)).toEqual({ text: "Overdue 3 days", tone: "bad" });
    expect(dueLabel("2026-10-30", now)?.text).toMatch(/^Due Fri,? 30 Oct/);
  });
  it("shows the sender's name from a From header", () => {
    expect(senderName("Alex Rivera <founders@northwind.test>")).toBe("Alex Rivera");
    expect(senderName("\"Li Chen\" <li@greenroof.com.au>")).toBe("Li Chen");
    expect(senderName("<orders@bondi.au>")).toBe("orders@bondi.au");
    expect(senderName("Sam Patel")).toBe("Sam Patel");
    expect(senderName(null)).toBe("");
  });
  it("picks next Monday", () => {
    expect(nextMonday(new Date("2026-10-24T10:00:00"))).toBe("2026-10-26");
    expect(nextMonday(new Date("2026-10-26T10:00:00"))).toBe("2026-11-02");
  });
  it("sorts urgent first, then by due date", () => {
    const t = (id: string, priority: Task["priority"], due: string | null) => ({ id, priority, due, position: 0 }) as Task;
    expect(sortTasks([t("a", "low", "2026-10-01"), t("b", "urgent", null), t("c", "low", "2026-09-01")]).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});

describe("server push (data only: type and id)", () => {
  it("finds { type, id } in every shape a push arrives in", () => {
    expect(extractPushData({ type: "task.assigned", id: "tsk_1" })).toEqual({ type: "task.assigned", id: "tsk_1" });
    expect(extractPushData({ data: { dataString: JSON.stringify({ type: "message.received", id: "msg_1" }) } })).toEqual({ type: "message.received", id: "msg_1" });
    expect(extractPushData({ notification: null, data: { body: { type: "approval.requested", id: "apr_1" } } })).toEqual({ type: "approval.requested", id: "apr_1" });
    expect(extractPushData({ nothing: 1 })).toBeNull();
  });
  it("routes each type to its screen", () => {
    expect(routeForPush({ type: "message.received", id: "msg_1" })).toBe("/thread/msg_1");
    // A mention in a shared inbox thread opens the thread through its newest message; without one, the notifications inbox.
    expect(routeForPush({ type: "thread_mention", id: "thr_1", mid: "msg_9" })).toBe("/thread/msg_9");
    expect(routeForPush({ type: "thread_mention", id: "thr_1" })).toBe("/notifications");
    expect(extractPushData({ data: { type: "thread_mention", id: "thr_1", mid: "msg_9" } })).toEqual({ type: "thread_mention", id: "thr_1", mid: "msg_9" });
    expect(fallbackText("thread_mention")).toEqual({ title: "You were mentioned on an email thread", body: "Tap to open the thread.", channel: "mail" });
    expect(routeForPush({ type: "approval.requested", id: "apr_1" })).toBe("/approval/apr_1");
    for (const type of ["task.assigned", "task.commented", "task.email_reply", "task.due_soon"]) expect(routeForPush({ type, id: "tsk_9" })).toBe("/task/tsk_9");
    expect(routeForPush({ type: "automation.status", id: "aut_1" })).toBeNull();
  });
  it("writes the notification from the fetched item, and falls back when it can't", async () => {
    const a = endpoints(new SampleTransport());
    expect(await describePush(a, { type: "message.received", id: "msg_1" })).toMatchObject({ title: "New email from Sam Patel", body: "Wholesale order for Saturday markets", channel: "mail" });
    expect((await describePush(a, { type: "approval.requested", id: "apr_1" })).body).toMatch(/Tap to review/);
    const { tasks } = await a.tasks();
    const chase = tasks.find((t) => t.title.startsWith("Chase"))!;
    expect(await describePush(a, { type: "task.commented", id: chase.id })).toMatchObject({ title: `New comment on ${chase.ref}`, channel: "tasks" });
    expect((await describePush(a, { type: "task.email_reply", id: chase.id })).body).toMatch(/^Li Chen: /);
    expect(await describePush(a, { type: "task.assigned", id: "tsk_missing" })).toEqual(fallbackText("task.assigned"));
    expect(await describePush(null, { type: "message.received", id: "msg_1" })).toEqual(fallbackText("message.received"));
  });
});

describe("formatting for en-AU", () => {
  it("parses recipient lists", () => {
    expect(parseRecipients("a@b.au, <c@d.com.au>; e@f.au\n")).toEqual(["a@b.au", "c@d.com.au", "e@f.au"]);
  });
  it("makes initials", () => {
    expect(initials("Mia Nguyen")).toBe("MN");
    expect(initials("sam.patel@bondi.au")).toBe("SP");
  });
  it("quotes replies", () => {
    expect(quoteForReply("Hi\nThere", "Sam", "2026-10-23T01:00:00Z")).toContain("> Hi\n> There");
  });
  it("formats sizes and time left", () => {
    expect(bytes(2048)).toBe("2 KB");
    expect(bytes(5 * 1024 ** 3)).toBe("5.00 GB");
    expect(timeLeft(new Date(Date.now() + 5 * 3_600_000).toISOString())).toBe("expires in 5 h");
    expect(timeLeft(new Date(Date.now() - 1000).toISOString())).toBe("expires soon");
  });
  it("shows the time for today and a date otherwise", () => {
    const now = new Date("2026-10-24T10:00:00");
    expect(shortDate(new Date("2026-10-24T08:05:00").toISOString(), now)).toMatch(/8:05/);
    expect(shortDate(new Date("2026-09-01T08:05:00").toISOString(), now)).toMatch(/1 Sept|1 Sep/);
  });
});
