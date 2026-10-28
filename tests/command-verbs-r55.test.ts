import { describe, expect, it } from "vitest";
import { typedActionChange } from "@/web/lib/commands/typed-action";
import type { Project, Task } from "@/web/pages/app/work/data";
import { landingStatus, matchStatus, parseCommand, projectChoices, resolveCommand, statusChoices, type CmdPerson, type CmdProject, type CmdStatus, type ParsedCommand } from "@/shared/command-actions";
import { makeTestApp, Client } from "./helpers";

/** R55: more command menu verbs (status, labels on and off, move to another project; snooze and archive say no). */
const NOW = new Date("2026-10-28T10:00:00Z");
const people: CmdPerson[] = [{ id: "u1", type: "member", name: "Asha Rao", email: "asha@example.com" }];
const ctx = { people, me: people[0], now: NOW, timeZone: "UTC" };
const p = (s: string, extra: Record<string, unknown> = {}) => parseCommand(s, { ...ctx, ...extra });
const statuses: CmdStatus[] = [
  { id: "s1", name: "Backlog", category: "todo", position: 0 },
  { id: "s2", name: "In progress", category: "doing", position: 1 },
  { id: "s3", name: "In review", category: "doing", position: 2 },
  { id: "s4", name: "Done", category: "done", position: 3 },
];
const web: CmdProject = { id: "p2", name: "Website", key: "WEB", statuses: [
  { id: "w1", name: "Ideas", category: "todo", position: 0 }, { id: "w2", name: "Building", category: "doing", position: 1 }, { id: "w3", name: "Review", category: "doing", position: 2 }, { id: "w4", name: "Shipped", category: "done", position: 3 },
] };
const projects: CmdProject[] = [
  { id: "p1", name: "Multies", key: "MB", statuses },
  web,
  { id: "p3", name: "Revenue ops", key: "REV", statuses: [{ id: "r1", name: "Open", category: "todo", position: 0 }] },
  { id: "p4", name: "Blue Harbor move", key: "BHM", statuses: [{ id: "b1", name: "To do", category: "todo", position: 0 }] },
  { id: "p5", name: "Old stuff", key: "OLD", archived: true, statuses: [] },
];
const task = { ref: "MB-12", labels: ["design", "later"], statusId: "s1", assigneeId: null, projectId: "p1", category: "doing" };
const known = ["design", "later", "urgent", "qa"];
const run = (s: string, extra: Record<string, unknown> = {}) => resolveCommand(p(s, extra) as ParsedCommand, task, statuses, NOW, { projects, knownLabels: known });

describe("parse: the new verbs", () => {
  it("status forms", () => {
    expect(p("MB-12 done")?.clauses).toEqual([{ kind: "done" }]);
    expect(p("mark MB-12 in progress")?.clauses).toEqual([{ kind: "status", query: "in progress" }]);
    expect(p("move MB-12 to review")).toEqual({ ref: "MB-12", clauses: [{ kind: "status", query: "review" }], moves: [0] });
  });
  it("labels: label, +add -remove, unlabel and untag", () => {
    expect(p("label MB-12 urgent")?.clauses).toEqual([{ kind: "label", label: "urgent" }]);
    expect(p("MB-12 +urgent -later")?.clauses).toEqual([{ kind: "label", label: "urgent" }, { kind: "unlabel", label: "later" }]);
    expect(p("unlabel MB-12 urgent")?.clauses).toEqual([{ kind: "unlabel", label: "urgent" }]);
    expect(p("untag MB-12 qa")?.clauses).toEqual([{ kind: "unlabel", label: "qa" }]);
  });
  it("move to a project, also written as project", () => {
    expect(p("move MB-12 to project Website")?.clauses).toEqual([{ kind: "project", query: "Website" }]);
    expect(p("move MB-12 to the Website project")?.clauses).toEqual([{ kind: "project", query: "Website" }]);
    // A name ending in a verb word stays one name.
    expect(p("move MB-12 to Blue Harbor move")?.clauses).toEqual([{ kind: "status", query: "Blue Harbor move" }]);
  });
  it("snooze and archive are read (to say no), only with a ref", () => {
    expect(p("snooze MB-12 until Mon 9am")?.clauses).toEqual([{ kind: "unsupported", verb: "snooze" }]);
    expect(p("snooze MB-12 2d")?.clauses).toEqual([{ kind: "unsupported", verb: "snooze" }]);
    expect(p("archive MB-12")?.clauses).toEqual([{ kind: "unsupported", verb: "archive" }]);
    expect(p("archive", { defaultRef: "MB-7" })).toBeNull();
    expect(p("snooze until monday", { defaultRef: "MB-7" })).toBeNull();
  });
  it("the focused task with no ref", () => {
    expect(p("done", { defaultRef: "MB-7" })).toEqual({ ref: "MB-7", clauses: [{ kind: "done" }] });
    expect(p("label urgent", { defaultRef: "MB-7" })).toEqual({ ref: "MB-7", clauses: [{ kind: "label", label: "urgent" }] });
    expect(p("+urgent -later", { defaultRef: "MB-7" })?.clauses).toEqual([{ kind: "label", label: "urgent" }, { kind: "unlabel", label: "later" }]);
    expect(p("move to Website", { defaultRef: "MB-7" })?.moves).toEqual([0]);
    expect(p("unlabel qa", { defaultRef: "MB-7" })?.ref).toBe("MB-7");
    // Plain words stay a search, with or without a focused task.
    expect(p("urgent bugs", { defaultRef: "MB-7" })).toBeNull();
    expect(p("+urgent")).toBeNull();
  });
});

describe("resolve: status", () => {
  it("fuzzy but never a guess", () => {
    expect(run("MB-12 status progress").status?.id).toBe("s2");
    expect(run("mark MB-12 in rev").status?.id).toBe("s3");
    const two = run("mark MB-12 in");
    expect(two.status).toBeUndefined();
    expect(two.problems).toEqual(['"in" matches In progress, In review. Type more of the name.']);
    expect(run("MB-12 done")).toMatchObject({ preview: "MB-12: mark Done", status: { id: "s4" } });
    expect(statusChoices("doing", statuses).map((s) => s.id)).toEqual(["s2"]);
    expect(matchStatus("in", statuses)).toBeNull();
  });
  it("move to a status of its own project stays a status change", () => {
    expect(run("move MB-12 to review")).toMatchObject({ preview: "MB-12: status In review", status: { id: "s3" } });
    expect(run("move MB-12 to review").project).toBeUndefined();
  });
});

describe("resolve: labels", () => {
  it("adds and removes against the task's labels, and says when a label is new", () => {
    expect(run("MB-12 +urgent -later")).toMatchObject({ preview: "MB-12: label urgent, remove label later", labels: ["design", "urgent"], problems: [] });
    expect(run("label MB-12 Design")).toMatchObject({ preview: "MB-12: label design", labels: ["design", "later"] });
    expect(run("label MB-12 brandnew")).toMatchObject({ preview: "MB-12: label brandnew (a new label)", labels: ["design", "later", "brandnew"], problems: [] });
    expect(run("unlabel MB-12 LATER").labels).toEqual(["design"]);
    expect(run("unlabel MB-12 qa").problems).toEqual(['MB-12 has no label "qa".']);
  });
});

describe("resolve: move to another project", () => {
  it("names the project and the status it lands in (same category, else the first)", () => {
    const r = run("move MB-12 to Website");
    expect(r.project).toEqual({ id: "p2", name: "Website", key: "WEB" });
    expect(r.status?.id).toBe("w2"); // the task is in a doing status: the first doing status there
    expect(r.preview).toBe("MB-12: move to Website (status Building)");
    expect(run("move MB-12 to web").project?.id).toBe("p2"); // the key, any case
    expect(run("move MB-12 to project rev").project?.id).toBe("p3");
    expect(landingStatus(projects[2], "doing")?.id).toBe("r1");
  });
  it("a status typed with the move is read in the new project", () => {
    const r = run("move MB-12 to Website status shipped");
    expect(r).toMatchObject({ preview: "MB-12: move to Website, status Shipped", status: { id: "w4" }, problems: [] });
    expect(run("move MB-12 to Website status backlog").problems).toEqual(['This project has no status called "backlog".']);
  });
  it("ambiguity and unknowns show in the row, not a guess", () => {
    // "re" starts the status In review? no: "In review" word "review" starts with "re"; and the project Revenue ops.
    expect(run("move MB-12 to re").problems[0]).toBe('"re" could be the status In review or the project Revenue ops. Type more of the name.');
    expect(run("move MB-12 to nowhere").problems).toEqual(['No status or project called "nowhere".']);
    expect(run("move MB-12 to project old").problems).toEqual(['No other project called "old".']); // archived is left out
    expect(run("move MB-12 to project Multies").problems).toEqual(['No other project called "Multies".']);
    expect(projectChoices("blue harbor move", projects, "p1").map((x) => x.id)).toEqual(["p4"]);
    expect(run("move MB-12 to Blue Harbor move").project?.id).toBe("p4");
  });
});

describe("resolve: snooze and archive", () => {
  it("say plainly that tasks have neither, and change nothing", () => {
    expect(run("snooze MB-12 2d")).toMatchObject({ preview: "MB-12: snooze", problems: ['Tasks can\'t be snoozed. Set a due date instead, like "MB-12 due Mon".'] });
    expect(run("archive MB-12").problems).toEqual(['Tasks can\'t be archived. Mark it done instead, like "MB-12 done".']);
    for (const t of [run("snooze MB-12 2d").problems[0], run("move MB-12 to re").problems[0], run("label MB-12 x").preview]) expect(t).not.toMatch(/[\u2013\u2014]| - /);
  });
});

describe("typedActionChange: move", () => {
  it("one patch with the project and status, Undo sends the old project, status and sprint", () => {
    const t = { id: "t1", ref: "MB-12", projectId: "p1", labels: ["design"], statusId: "s1", statusName: "Backlog", statusColor: "#888", status: "doing", sprintId: "sp1" } as unknown as Task;
    const r = run("move MB-12 to Website");
    const c = typedActionChange(t, r, projects[0] as unknown as Project, projects as unknown as Project[]);
    expect(c.patch).toEqual({ projectId: "p2", statusId: "w2" });
    expect(c.view).toMatchObject({ projectId: "p2", statusId: "w2", statusName: "Building", status: "doing" });
    expect(c.undoPatch).toEqual({ projectId: "p1", statusId: "s1", sprintId: "sp1" });
    const l = typedActionChange(t, run("MB-12 +qa -design"), projects[0] as unknown as Project);
    expect(l.patch).toEqual({ labels: ["later", "qa"] });
  });
});

describe("server: a move and its Undo keep the ref", () => {
  it("moving back gives the old number when it is free", async () => {
    const app = await makeTestApp();
    const c = new Client(app.app);
    await c.signup("owner@acme.io", "Olive Owner");
    const ops = (await c.post("/api/projects", { name: "Ops", key: "OPS" })).body.project;
    const mb = (await c.post("/api/projects", { name: "Build", key: "MB" })).body.project;
    const t1 = (await c.post("/api/tasks", { title: "Rotate keys", projectId: ops.id })).body.task;
    await c.post("/api/tasks", { title: "Renew cert", projectId: ops.id });
    expect(t1.ref).toBe("OPS-1");
    const moved = (await c.patch(`/api/tasks/${t1.id}`, { projectId: mb.id })).body.task;
    expect(moved.ref).toBe("MB-1");
    const back = (await c.patch(`/api/tasks/${t1.id}`, { projectId: ops.id, statusId: t1.statusId })).body.task;
    expect(back.ref).toBe("OPS-1");
    expect(back.statusId).toBe(t1.statusId);
    expect((await c.get("/api/tasks/OPS-1")).body.task.id).toBe(t1.id);
    expect((await c.get("/api/tasks/MB-1")).body.task.id).toBe(t1.id); // the ref it had in Build still opens it
    // A new task in Ops takes the next number, not OPS-1 again.
    expect((await c.post("/api/tasks", { title: "Next", projectId: ops.id })).body.task.ref).toBe("OPS-3");
  });
  it("a taken number is not reused: the task gets a new one", async () => {
    const app = await makeTestApp();
    const c = new Client(app.app);
    await c.signup("owner@acme.io", "Olive Owner");
    const ops = (await c.post("/api/projects", { name: "Ops", key: "OPS" })).body.project;
    const mb = (await c.post("/api/projects", { name: "Build", key: "MB" })).body.project;
    const t1 = (await c.post("/api/tasks", { title: "A", projectId: ops.id })).body.task;
    const t2 = (await c.post("/api/tasks", { title: "B", projectId: mb.id })).body.task;
    await c.patch(`/api/tasks/${t1.id}`, { projectId: mb.id }); // OPS-1 to MB-2
    await c.patch(`/api/tasks/${t2.id}`, { projectId: ops.id }); // MB-1 to OPS-2
    await c.patch(`/api/tasks/${t1.id}`, { projectId: ops.id }); // OPS-1 is free: back to OPS-1
    expect((await c.get(`/api/tasks/${t1.id}`)).body.task.ref).toBe("OPS-1");
    const again = (await c.patch(`/api/tasks/${t2.id}`, { projectId: mb.id })).body.task; // MB-1 is free too
    expect(again.ref).toBe("MB-1");
  });
});
