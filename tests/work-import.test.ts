import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { categoryOf, defaultMapping, mapRows, parseLooseDate, priorityOf, readTable } from "@/server/services/work-import/parse";
import { previewImport, runImport, DAILY_TASK_CAP } from "@/server/services/work-import/service";
import { projectStatuses, taskComments, tasks, usageCounters } from "@/server/db/schema";
import { resetWriteBudgetCache } from "@/server/services/write-budget";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/import", name), "utf8");

async function owner(env: Record<string, string> = {}, opts: Parameters<typeof makeTestApp>[1] = {}) {
  const ctx = await makeTestApp(env, opts);
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Owner Person");
  const me = (await c.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id as string, userId: me.user.id as string, email: "owner@acme.io", name: "Owner Person", role: "owner" as const };
  return { ...ctx, c, me, actor };
}

describe("reading work tool exports", () => {
  it("detects each source from its headers and preselects a mapping", () => {
    const cases: [string, string, Record<string, string>][] = [
      ["trello.json", "trello", { title: "Card Name", status: "List", parent: "Parent Card", comments: "Comment" }],
      ["asana.csv", "asana", { title: "Name", status: "Section/Column", assignee: "Assignee Email", parent: "Parent task", completed: "Completed At" }],
      ["clickup.csv", "clickup", { title: "Task Name", assignee: "Assignees", parent: "Parent ID" }],
      ["monday.csv", "monday", { title: "Name", assignee: "Person", due: "Date" }],
      ["jira.csv", "jira", { title: "Summary", id: "Issue id", parent: "Parent id", statusGroup: "Status Category", comments: "Comment" }],
      ["linear.csv", "linear", { title: "Title", id: "ID", parent: "Parent issue" }],
      ["notion.csv", "notion", { title: "Name", assignee: "Assign", due: "Due" }],
    ];
    for (const [file, source, expected] of cases) {
      const t = readTable(fixture(file), file);
      expect(t.source, file).toBe(source);
      expect(defaultMapping(t), file).toMatchObject(expected);
    }
  });

  it("reads quoted fields, newlines inside quotes, doubled quotes and a byte order mark", () => {
    const t = readTable(fixture("asana.csv"));
    expect(t.headers[0]).toBe("Task ID");
    const { rows } = mapRows(t, defaultMapping(t));
    expect(rows).toHaveLength(4);
    expect(rows[0].description).toBe("Line one\nline two, with a comma");
    expect(rows[2].description).toBe('She said "hello"');
    expect(rows[0].labels).toEqual(["Launch", "Q4"]);
    expect(rows[1].category).toBe("done"); // Completed At is filled
    expect(rows[1].parent).toBe("Plan the launch");
  });

  it("maps Trello cards, lists, checklists and comments, and leaves archived cards out", () => {
    const t = readTable(fixture("trello.json"));
    const { rows } = mapRows(t, defaultMapping(t));
    expect(rows.map((r) => r.title)).toEqual(["Write the homepage copy", "Draft the headline", "Draft the footer", "Pick photos", "Set up the domain"]);
    expect(rows[0].comments).toEqual(["Owner Person: First note", "Pat Outside: Second note"]);
    expect(rows[1]).toMatchObject({ parent: "C1", status: "Done", category: "done" });
    expect(rows[3].labels).toEqual(["red"]);
  });

  it("monday title rows, Jira comments and repeated columns, ClickUp brackets", () => {
    const m = readTable(fixture("monday.csv"));
    expect(m.name).toBe("Client onboarding");
    expect(mapRows(m, defaultMapping(m)).rows.map((r) => r.title)).toEqual(["Welcome call", "Send the contract", "Collect logos"]);
    const j = readTable(fixture("jira.csv"));
    const jr = mapRows(j, defaultMapping(j)).rows;
    expect(jr[0].labels).toEqual(["frontend", "auth"]);
    expect(jr[0].comments).toEqual(["Looks good so far"]);
    expect(jr[2].comments).toEqual(["Fixed", "Confirmed"]);
    expect(jr[2].category).toBe("done");
    expect(jr[0].due?.toISOString().slice(0, 10)).toBe("2026-10-30");
    const cu = readTable(fixture("clickup.csv"));
    const cr = mapRows(cu, defaultMapping(cu)).rows;
    expect(cr[0].assignees).toEqual(["owner@acme.io"]);
    expect(cr[0].labels).toEqual(["finance"]);
    expect(cr[1].due?.toISOString().slice(0, 10)).toBe("2026-11-03");
    expect(cr[0].due?.toISOString().slice(0, 10)).toBe("2025-10-31");
  });

  it("reads the first sheet of a monday .xlsx export", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const shared = ["Client onboarding", "Name", "Person", "Status", "Date", "New clients", "Welcome call", "Owner Person", "Working on it", "Tom &amp; Jerry"];
    const sst = `<?xml version="1.0"?><sst count="${shared.length}">${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
    const c = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
    const sheet = `<?xml version="1.0"?><worksheet><sheetData>
      <row r="1">${c("A1", 0)}</row>
      <row r="2">${c("A2", 1)}${c("B2", 2)}${c("C2", 3)}${c("D2", 4)}</row>
      <row r="3">${c("A3", 5)}</row>
      <row r="4">${c("A4", 6)}${c("B4", 7)}${c("C4", 8)}<c r="D4"><v>46330</v></c></row>
      <row r="5">${c("A5", 9)}<c r="C5" t="inlineStr"><is><t>Done</t></is></c></row>
    </sheetData></worksheet>`;
    const zip = zipSync({ "xl/sharedStrings.xml": strToU8(sst), "xl/worksheets/sheet1.xml": strToU8(sheet) });
    const t = readTable(`xlsx-base64:${Buffer.from(zip).toString("base64")}`, "board.xlsx");
    expect(t).toMatchObject({ source: "monday", name: "Client onboarding", headers: ["Name", "Person", "Status", "Date"] });
    const { rows } = mapRows(t, defaultMapping(t));
    expect(rows.map((r) => [r.title, r.status, r.category])).toEqual([["Welcome call", "Working on it", "doing"], ["Tom & Jerry", "Done", "done"]]);
    expect(rows[0].due?.toISOString().slice(0, 10)).toBe("2026-11-04");
  });

  it("reads dates, statuses and priorities the way the tools write them", () => {
    const d = (s: string) => parseLooseDate(s)?.toISOString().slice(0, 10) ?? null;
    expect(d("2026-10-25")).toBe("2026-10-25");
    expect(d("25/Oct/26 10:00 AM")).toBe("2026-10-25");
    expect(d("October 25, 2026")).toBe("2026-10-25");
    expect(d("Sunday, October 25th 2026")).toBe("2026-10-25");
    expect(d("10/25/2026")).toBe("2026-10-25");
    expect(d("25/10/2026")).toBe("2026-10-25");
    expect(d("soon")).toBeNull();
    expect(categoryOf("Not started")).toBe("todo");
    expect(categoryOf("In Review")).toBe("doing");
    expect(categoryOf("Won't do")).toBe("done");
    expect(priorityOf("Highest")).toBe("urgent");
    expect(priorityOf("No priority")).toBe("none");
    expect(priorityOf("normal")).toBe("medium");
  });

  it("says plainly when a file cannot be read", () => {
    expect(() => readTable('{"hello":1}')).toThrow(/not a Trello board/);
    expect(() => readTable("PK\u0003\u0004binary", "board.xls")).toThrow(/Save it as CSV/);
    expect(() => readTable("xlsx-base64:bm90IGEgemlw")).toThrow(/could not be read/);
  });
});

describe("importing into a project", () => {
  beforeEach(() => resetWriteBudgetCache());

  it("previews the first 20 rows, then brings a Trello board in as a new project, once", async () => {
    const { c, deps } = await owner();
    const content = fixture("trello.json");
    const pv = await c.post("/api/work-imports/preview", { fileName: "trello.json", content });
    expect(pv.status).toBe(200);
    expect(pv.body).toMatchObject({ source: "trello", total: 5, subtasks: 2, alreadyImported: 0, leftToday: DAILY_TASK_CAP });
    expect(pv.body.statuses).toEqual([{ name: "Backlog", category: "todo" }, { name: "Doing", category: "doing" }, { name: "Done", category: "done" }]);
    expect(pv.body.unknownAssignees).toEqual(["Pat Outside"]);
    const run = await c.post("/api/work-imports/run", { fileName: "trello.json", content, mapping: pv.body.mapping, projectName: "Website" });
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ created: 5, alreadyThere: 0, comments: 2, stopped: null, unknownAssignees: 1 });
    const list = (await c.get(`/api/tasks?projectId=${run.body.projectId}&includeSubtasks=true`)).body.tasks as { id: string; title: string; status: string; parentId: string | null; assignee: { id: string } | null; notes: string }[];
    expect(list).toHaveLength(5);
    const home = list.find((t) => t.title === "Write the homepage copy")!;
    expect(home.assignee?.id).toBeTruthy(); // matched Owner Person by name
    expect(list.find((t) => t.title === "Draft the headline")).toMatchObject({ parentId: home.id, status: "done" });
    const photos = list.find((t) => t.title === "Pick photos")!;
    expect(photos.assignee).toBeNull();
    expect(photos.notes).toContain("Assigned in Trello: Pat Outside");
    expect(photos.status).toBe("doing");
    const sts = await deps.db.select().from(projectStatuses).where(eq(projectStatuses.projectId, run.body.projectId));
    expect(sts.sort((a, b) => a.position - b.position).map((s) => s.name)).toEqual(["Backlog", "Doing", "Done"]);
    expect(await deps.db.select().from(taskComments).where(eq(taskComments.taskId, home.id))).toHaveLength(2);

    // The same file again: nothing new, and it lands in the same project.
    const again = await c.post("/api/work-imports/run", { fileName: "trello.json", content, projectName: "Website" });
    expect(again.body).toMatchObject({ projectId: run.body.projectId, continued: true, created: 0, alreadyThere: 5, comments: 0 });
    expect((await c.get(`/api/tasks?projectId=${run.body.projectId}&includeSubtasks=true`)).body.tasks).toHaveLength(5);
    expect((await c.post("/api/work-imports/preview", { content })).body.alreadyImported).toBe(5);
  });

  it("adds missing statuses to an existing project and keeps the person's own mapping", async () => {
    const { c, deps } = await owner();
    const project = (await c.post("/api/projects", { name: "Web" })).body.project;
    const content = fixture("jira.csv");
    const run = await c.post("/api/work-imports/run", { content, projectId: project.id, mapping: { priority: null } });
    expect(run.body).toMatchObject({ created: 3, comments: 3 });
    const names = (await deps.db.select().from(projectStatuses).where(eq(projectStatuses.projectId, project.id))).map((s) => s.name);
    expect(names).toEqual(["To do", "In progress", "In review", "Done", "Closed"]); // "To Do" and "In Progress" matched the project's own
    const list = (await c.get(`/api/tasks?projectId=${project.id}&includeSubtasks=true`)).body.tasks as { title: string; priority: string; parentId: string | null; id: string; status: string }[];
    expect(list.every((t) => t.priority === "none")).toBe(true);
    const login = list.find((t) => t.title === "Login page")!;
    expect(list.find((t) => t.title === "Password reset")!.parentId).toBe(login.id);
    expect(list.find((t) => t.title === "Fix footer link")!.status).toBe("done");
  });

  it("imports every fixture without errors", async () => {
    const { c } = await owner();
    for (const f of ["asana.csv", "clickup.csv", "monday.csv", "linear.csv", "notion.csv"]) {
      const r = await c.post("/api/work-imports/run", { fileName: f, content: fixture(f) });
      expect(r.status, f).toBe(200);
      expect(r.body.created, f).toBeGreaterThan(2);
    }
    const linear = readTable(fixture("linear.csv"));
    expect(mapRows(linear, defaultMapping(linear)).rows[1].parent).toBe("ENG-1");
  });

  it("lands a 300 task Asana file with statuses, subtasks, assignees and due dates, quickly", async () => {
    const { c, deps, actor } = await owner();
    const head = "Task ID,Created At,Completed At,Last Modified,Name,Section/Column,Assignee,Assignee Email,Start Date,Due Date,Tags,Notes,Projects,Parent task";
    const sections = ["Backlog", "In progress", "Review", "Done"];
    const lines = [head];
    for (let i = 0; i < 300; i++) {
      const parent = i % 3 === 0 ? "" : `Task ${i - (i % 3)}`;
      const section = sections[i % 4];
      const done = section === "Done" ? "2026-10-20" : "";
      const email = i % 5 === 0 ? `guest${i}@outside.test` : "owner@acme.io";
      const due = `2026-11-${String((i % 28) + 1).padStart(2, "0")}`;
      lines.push(`${1300000000000000 + i},2026-10-01,${done},2026-10-02,Task ${i},${section},Someone,${email},,${due},"t${i % 2}","Notes for ${i}",Big,${parent}`);
    }
    const t0 = Date.now();
    const r = await runImport(deps, actor, { fileName: "big.csv", content: lines.join("\n"), projectName: "Big" });
    const ms = Date.now() - t0;
    expect(r).toMatchObject({ created: 300, stopped: null, left: 0, source: "asana" });
    expect(ms).toBeLessThan(10_000);
    const rows = await deps.db.select().from(tasks).where(eq(tasks.projectId, r.projectId!));
    expect(rows).toHaveLength(300);
    const sts = await deps.db.select().from(projectStatuses).where(eq(projectStatuses.projectId, r.projectId!));
    expect(sts.map((s) => [s.name, s.category])).toEqual(expect.arrayContaining([["Backlog", "todo"], ["In progress", "doing"], ["Review", "doing"], ["Done", "done"]]));
    const byTitle = new Map(rows.map((x) => [x.title, x]));
    for (let i = 0; i < 300; i++) {
      const x = byTitle.get(`Task ${i}`)!;
      expect(x.dueAt?.toISOString().slice(0, 10)).toBe(`2026-11-${String((i % 28) + 1).padStart(2, "0")}`);
      expect(x.status).toBe(i % 4 === 3 ? "done" : i % 4 === 0 ? "todo" : "doing");
      expect(x.parentId).toBe(i % 3 === 0 ? null : byTitle.get(`Task ${i - (i % 3)}`)!.id);
      if (i % 5 === 0) { expect(x.assigneeId).toBeNull(); expect(x.notes).toContain(`guest${i}@outside.test`); } else expect(x.assigneeId).toBe(actor.userId);
    }
    expect(new Set(rows.map((x) => x.number)).size).toBe(300);
    void c;
  });

  it("stops at the daily cap and carries on the next day", async () => {
    let now = new Date("2026-10-25T10:00:00Z");
    const { deps, actor } = await owner();
    deps.now = () => now;
    await deps.db.insert(usageCounters).values({ orgId: actor.orgId, period: "day:2026-10-25", metric: "work_import_tasks", count: DAILY_TASK_CAP - 2 });
    const content = fixture("trello.json");
    const first = await runImport(deps, actor, { content });
    expect(first).toMatchObject({ created: 2, left: 3, stopped: "daily_cap" });
    now = new Date("2026-10-26T10:00:00Z");
    const next = await runImport(deps, actor, { content });
    expect(next).toMatchObject({ projectId: first.projectId, created: 3, alreadyThere: 2, left: 0, stopped: null });
    const list = await deps.db.select().from(tasks).where(eq(tasks.projectId, first.projectId!));
    const parent = list.find((t) => t.title === "Write the homepage copy")!;
    expect(list.filter((t) => t.parentId === parent.id)).toHaveLength(2);
  });

  it("stops cleanly when the write budget reads warn, and a time limit run resumes", async () => {
    const answer = (rows: number) => async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: rows }, dimensions: { databaseId: "db", date: "2026-10-25" } }] }] } } }), { status: 200 });
    let rows = 70_000;
    const { deps, actor } = await owner({ CF_ANALYTICS_TOKEN: "x", CF_ACCOUNT_ID: "acc" }, { fetch: (async () => answer(rows)()) as unknown as typeof fetch });
    const content = fixture("trello.json");
    const stopped = await runImport(deps, actor, { content, projectName: "Budget" });
    expect(stopped).toMatchObject({ projectId: null, created: 0, left: 5, stopped: "write_budget" });
    rows = 1_000;
    resetWriteBudgetCache();
    const part = await runImport(deps, actor, { content }, { batchSize: 2, maxMs: 0 });
    expect(part).toMatchObject({ created: 2, stopped: "time" });
    const rest = await runImport(deps, actor, { content });
    expect(rest).toMatchObject({ projectId: part.projectId, continued: true, created: 3, alreadyThere: 2, stopped: null });
  });

  it("only signed in members of the workspace can import, read only keys cannot, and keys are per workspace", async () => {
    const { app, deps, actor } = await owner();
    const anon = new Client(app);
    expect((await anon.post("/api/work-imports/preview", { content: fixture("notion.csv") })).status).toBe(401);
    await expect(previewImport(deps, { ...actor, scope: "read" }, { content: fixture("notion.csv") })).rejects.toMatchObject({ status: 403 });
    await expect(runImport(deps, { ...actor, scope: "read" }, { content: fixture("notion.csv") })).rejects.toMatchObject({ status: 403 });
    const mine = await runImport(deps, actor, { content: fixture("notion.csv") });
    // Another workspace: cannot aim at this project, and its own import of the same file makes its own tasks.
    const other = new Client(app);
    await other.signup("other@else.io", "Other Owner", "Else");
    expect((await other.post("/api/work-imports/run", { content: fixture("notion.csv"), projectId: mine.projectId })).status).toBe(404);
    const theirs = await other.post("/api/work-imports/run", { content: fixture("notion.csv") });
    expect(theirs.body).toMatchObject({ created: 3, alreadyThere: 0 });
    expect(theirs.body.projectId).not.toBe(mine.projectId);
    expect((await other.post("/api/work-imports/preview", { content: "Name\n" })).status).toBe(200);
    expect((await other.post("/api/work-imports/preview", { content: '{"x":1}' })).status).toBe(422);
  });

  it("works on the v1 API with a workspace key, and a read only key cannot import", async () => {
    const { app, c } = await owner();
    const full = (await c.post("/api/developer/keys", { name: "Import" })).body.secret as string;
    const read = (await c.post("/api/developer/keys", { name: "Read", scope: "read" })).body.secret as string;
    const call = (key: string, path: string, b: unknown) => app.request(`/api/v1${path}`, { method: "POST", headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(b) });
    const content = fixture("linear.csv");
    const pv = await call(full, "/work-imports/preview", { content });
    expect(pv.status).toBe(200);
    expect(await pv.json()).toMatchObject({ source: "linear", total: 3 });
    expect((await call(read, "/work-imports/run", { content })).status).toBe(403);
    const run = await call(full, "/work-imports/run", { content, projectName: "API import" });
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ created: 3, projectName: "API import" });
    expect((await call(full, "/work-imports/run", { nothing: true })).status).toBe(422);
  });
});
