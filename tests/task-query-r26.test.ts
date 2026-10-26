import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client, d1Violations } from "./helpers";
import { dateRange, looksLikeQuery, parseTaskQuery, QUERY_MAX_VALUES, suggest, TaskQueryError } from "@/shared/task-query";

/** R26 (MB-86): the task query language: parser, server filter, REST, MCP and the D1 variable limit. */
const err = (q: string) => { try { parseTaskQuery(q); } catch (e) { return e as TaskQueryError; } throw new Error(`no error for ${q}`); };

describe("task query parser", () => {
  it("reads every key and operator", () => {
    const { terms, plain } = parseTaskQuery('assignee:me status:doing label:bug priority:>=high due:<7d sprint:current type:bug project:MB "free text" -label:wontfix created:>2026-10-01 updated:<=today points:>=3 has:subtasks is:overdue title:login');
    expect(plain).toBe(false);
    expect(terms.map((t) => (t.kind === "text" ? `text=${t.value}` : `${t.negate ? "-" : ""}${t.key}${t.op}${t.values.join(",")}`))).toEqual([
      "assignee=me", "status=doing", "label=bug", "priority>=high", "due<7d", "sprint=current", "type=bug", "project=MB", "text=free text",
      "-label=wontfix", "created>2026-10-01", "updated<=today", "points>=3", "has=subtasks", "is=overdue", "title=login",
    ]);
    expect(parseTaskQuery("points:<2").terms[0]).toMatchObject({ op: "<" });
    expect(parseTaskQuery("due:>-3d").terms[0]).toMatchObject({ op: ">", values: ["-3d"] });
    expect(parseTaskQuery("due:=2026-11-02").terms[0]).toMatchObject({ op: "=", values: ["2026-11-02"] });
  });

  it("handles quoting, commas and negation", () => {
    const t = parseTaskQuery('label:"needs review",bug -"hello world" assignee:"Maya Lee" -status:done').terms;
    expect(t[0]).toMatchObject({ key: "label", values: ["needs review", "bug"] });
    expect(t[1]).toMatchObject({ kind: "text", value: "hello world", negate: true });
    expect(t[2]).toMatchObject({ key: "assignee", values: ["Maya Lee"] });
    expect(t[3]).toMatchObject({ key: "status", negate: true });
    expect(parseTaskQuery('title:"say \\"hi\\""').terms[0]).toMatchObject({ values: ['say "hi"'] });
  });

  it("keeps plain words as plain search, like the old box", () => {
    expect(parseTaskQuery("re: invoice for march")).toEqual({ plain: true, terms: [{ kind: "text", value: "re: invoice for march", negate: false, pos: 1 }] });
    expect(parseTaskQuery("  ").terms).toEqual([]);
    expect(looksLikeQuery("status:done")).toBe(true);
    expect(looksLikeQuery("http://x.io")).toBe(false);
  });

  it("names the problem and the character position", () => {
    expect(err("status:done foo:bar")).toMatchObject({ position: 13 });
    expect(err("status:done foo:bar").message).toMatch(/Unknown key "foo"/);
    expect(err('label:bug title:"abc')).toMatchObject({ position: 17 });
    expect(err("status:")).toMatchObject({ position: 1 });
    expect(err("label:<x").message).toMatch(/label does not take </);
    expect(err("priority:hgh").message).toMatch(/priority takes/);
    expect(err("due:2026-02-31").message).toMatch(/not a real date/);
    expect(err("due:soon").message).toMatch(/due takes a date/);
    expect(err("points:many").message).toMatch(/points takes a number/);
    expect(err("has:wings").message).toMatch(/has takes/);
    expect(err("is:lost").message).toMatch(/is takes/);
    expect(err("type:saga").message).toMatch(/type takes/);
    expect(err("status:todo,").message).toMatch(/empty value/);
    expect(err("due:<7d,8d").message).toMatch(/takes one value/);
    expect(err(`assignee:${Array.from({ length: 11 }, (_, i) => `p${i}`).join(",")}`).message).toMatch(/too many values to run at once/);
    expect(err(`label:${Array.from({ length: QUERY_MAX_VALUES + 1 }, (_, i) => `l${i}`).join(",")}`).message).toMatch(/at most 30 values/);
    expect(err("x".repeat(501)).message).toMatch(/at most 500 characters/);
  });

  it("turns dates into ranges", () => {
    const now = new Date("2026-10-26T09:30:00Z");
    expect(dateRange("today", now)).toMatchObject({ from: new Date("2026-10-26T00:00:00Z"), to: new Date("2026-10-27T00:00:00Z"), instant: false });
    expect(dateRange("7d", now).from).toEqual(new Date("2026-11-02T09:30:00Z"));
    expect(dateRange("7d", now, true).from).toEqual(new Date("2026-10-19T09:30:00Z"));
    expect(dateRange("2w", now).from).toEqual(new Date("2026-11-09T09:30:00Z"));
    expect(dateRange("2026-10-01", now)).toMatchObject({ from: new Date("2026-10-01T00:00:00Z"), instant: false });
  });

  it("suggests keys, then values", () => {
    expect(suggest("pri", 3).items[0]).toMatchObject({ insert: "priority:" });
    expect(suggest("status:do", 9).items.map((i) => i.label)).toEqual(["doing", "done", "todo"]);
    expect(suggest("assignee:ma", 11, { assignee: ["Maya Lee", "Max"] }).items.map((i) => i.insert)).toEqual(['assignee:"Maya Lee" ', "assignee:Max "]);
    expect(suggest("-lab", 4).items[0].insert).toBe("-label:");
  });
});

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let ids: Record<string, string>;
let me: string;

beforeEach(async () => {
  ctx = await makeTestApp();
  ctx.deps.now = () => new Date("2026-10-26T09:00:00Z");
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  me = (await c.get("/api/account/me")).body.user.id;
  const mb = (await c.post("/api/projects", { name: "Multies build", key: "MB" })).body.project;
  const ops = (await c.post("/api/projects", { name: "Ops", key: "OPS" })).body.project;
  const sprint = (await c.post("/api/sprints", { projectId: mb.id, startAt: "2026-10-20", endAt: "2026-11-02" })).body.sprint;
  await c.post(`/api/sprints/${sprint.id}/start`);
  const doing = mb.statuses.find((s: { category: string }) => s.category === "doing").id;
  const mk = async (title: string, extra: Record<string, unknown>) => (await c.post("/api/tasks", { title, projectId: mb.id, ...extra })).body.task.id as string;
  ids = {
    loginBug: await mk("Login page crashes", { type: "bug", labels: ["bug"], priority: "high", assignee: `member:${me}`, due: "2026-10-28", statusId: doing, sprintId: sprint.id, points: 3 }),
    wontfix: await mk("Old browser glitch", { type: "bug", labels: ["bug", "wontfix"], priority: "low", due: "2026-10-20" }),
    docs: await mk("Write the API docs", { notes: "free text lives here", priority: "urgent", points: 5 }),
    ops: (await c.post("/api/tasks", { title: "Rotate keys", projectId: ops.id, labels: ["security"], due: "2026-12-01" })).body.task.id,
  };
  await c.post("/api/tasks", { title: "Sub of docs", parentId: ids.docs });
  await c.post(`/api/tasks/${ids.docs}/checklist`, { title: "Outline" });
});

const find = async (q: string) => {
  const r = await c.get(`/api/tasks?q=${encodeURIComponent(q)}`);
  if (r.status !== 200) throw new Error(`${q}: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body.tasks as { id: string; title: string }[]).map((t) => t.title).sort();
};

describe("task query on the server", () => {
  it("filters a seeded workspace", async () => {
    expect(await find("assignee:me status:doing label:bug priority:high due:<7d sprint:current type:bug project:MB")).toEqual(["Login page crashes"]);
    expect(await find("label:bug -label:wontfix")).toEqual(["Login page crashes"]);
    expect(await find("is:overdue")).toEqual(["Old browser glitch"]);
    expect(await find('"free text"')).toEqual(["Write the API docs"]);
    expect(await find("points:>=3")).toEqual(["Login page crashes", "Write the API docs"]);
    expect(await find("points:none project:MB")).toEqual(["Old browser glitch"]);
    expect(await find("has:subtasks")).toEqual(["Write the API docs"]);
    expect(await find("has:checklist")).toEqual(["Write the API docs"]);
    expect(await find("project:ops")).toEqual(["Rotate keys"]);
    expect(await find("priority:>=high")).toEqual(["Login page crashes", "Write the API docs"]);
    expect(await find("-assignee:me project:MB")).toEqual(["Old browser glitch", "Write the API docs"]);
    expect(await find("assignee:olive")).toEqual(["Login page crashes"]);
    expect(await find("assignee:none due:none")).toEqual(["Write the API docs"]);
    expect(await find('status:"in progress"')).toEqual(["Login page crashes"]);
    expect(await find("sprint:none project:MB")).toEqual(["Old browser glitch", "Write the API docs"]);
    expect(await find("created:>2026-10-01 created:<=today type:task")).toEqual(["Rotate keys", "Write the API docs"]);
    expect(await find("due:2026-10-28")).toEqual(["Login page crashes"]);
    expect(await find("is:subtask")).toEqual(["Sub of docs"]);
    expect(await find("title:docs")).toEqual(["Write the API docs"]);
    expect(await find("Login")).toEqual(["Login page crashes"]); // plain words, as before
  });

  it("answers 400 with the position for a bad query, in the app and over REST", async () => {
    const r = await c.get(`/api/tasks?q=${encodeURIComponent("status:done foo:bar")}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: "bad_query", details: { position: 13 } });
    const key = (await c.post("/api/developer/keys", { name: "k", scope: "read" })).body.secret;
    const v1 = await ctx.app.request(`/api/v1/tasks?q=${encodeURIComponent("label:<x")}`, { headers: { authorization: `Bearer ${key}`, host: "localhost" } });
    expect(v1.status).toBe(400);
    expect(((await v1.json()) as { error: { message: string } }).error.message).toMatch(/at character 1/);
    const ok = await ctx.app.request(`/api/v1/tasks?q=${encodeURIComponent("label:bug -label:wontfix")}`, { headers: { authorization: `Bearer ${key}`, host: "localhost" } });
    expect(((await ok.json()) as { tasks: { title: string }[] }).tasks.map((t) => t.title)).toEqual(["Login page crashes"]);
  });

  it("never reads another workspace's tasks, even by name", async () => {
    const eve = new Client(ctx.app);
    await eve.signup("eve@evil.io", "Eve");
    await eve.post("/api/projects", { name: "Multies build", key: "MB" });
    const r = await eve.get(`/api/tasks?q=${encodeURIComponent("project:MB label:bug")}`);
    expect(r.body.tasks).toEqual([]);
    expect((await eve.get(`/api/tasks?q=${encodeURIComponent("assignee:olive")}`)).body.tasks).toEqual([]);
  });

  it("stays under D1's 100 variables with the most values a query can hold, and with a long list of tasks", async () => {
    d1Violations.length = 0;
    // Names are the costliest values (a member or agent subquery each): the most a query can hold (10) must fit.
    const many = Array.from({ length: 10 }, (_, i) => `"person ${i}"`).join(",");
    const r = await c.get(`/api/tasks?q=${encodeURIComponent(`assignee:${many}`)}`);
    expect(r.status).toBe(200);
    const mixed = await c.get(`/api/tasks?q=${encodeURIComponent('status:a,b,c project:x,y sprint:s1 "free" label:z due:<7d created:>2026-01-01 points:>=1 -assignee:me')}`);
    expect(mixed.status).toBe(200);
    // 150 tasks with checklists: the list reads their counts in chunks (sql-chunks).
    const projectId = (await c.post("/api/projects", { name: "Bulk", key: "BLK" })).body.project.id;
    const made = await c.post("/api/tasks/bulk", { projectId, titles: Array.from({ length: 150 }, (_, i) => `Bulk ${i}`) });
    if (made.status >= 300) for (let i = 0; i < 150; i++) await c.post("/api/tasks", { title: `Bulk ${i}`, projectId });
    const list = (await c.get(`/api/tasks?q=${encodeURIComponent("project:BLK")}&limit=1000`)).body.tasks as { id: string }[];
    expect(list.length).toBe(150);
    for (const t of list.slice(0, 120)) await c.post(`/api/tasks/${t.id}/checklist`, { title: "Check" });
    const again = (await c.get(`/api/tasks?q=${encodeURIComponent("project:BLK has:checklist")}&limit=1000`)).body.tasks as { checklist: { total: number } }[];
    expect(again.length).toBe(120);
    expect(again.every((t) => t.checklist.total === 1)).toBe(true);
    expect(d1Violations).toEqual([]);
  });
});

describe("search_tasks over MCP", () => {
  it("finds tasks with a query and explains a bad one", async () => {
    const key = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const r = await mcp.callTool({ name: "search_tasks", arguments: { q: "label:bug -label:wontfix" } });
    const body = JSON.parse((r as { content: { text: string }[] }).content[0].text);
    expect(body.tasks.map((t: { ref: string }) => t.ref)).toEqual(["MB-1"]);
    const bad = await mcp.callTool({ name: "search_tasks", arguments: { q: "status:done colour:red" } });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/Unknown key/);
  });
});
