import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { createTask, getTask, updateTask } from "@/server/services/suite/tasks";
import { createAutomation, listAutomations, runEmailAutomations } from "@/server/services/suite/automations";
import { enableRecipe, listRecipes } from "@/server/services/suite/automation-recipes";
import { fillTemplate, isR24Rule, resetLoopGuard, runDuePassed, validateR24Rule } from "@/server/services/suite/automations-r24";
import { AUTOMATION_RECIPES, fillRecipe } from "@/shared/automation-recipes";
import { resetWriteBudgetCache } from "@/server/services/write-budget";
import { notifications, tasks as tasksTable } from "@/server/db/schema";
import type { SuiteActor } from "@/server/services/suite/common";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let actor: SuiteActor;
let me: string;
let mate: { id: string; client: Client };
let pid: string;
let chan: string;

function analytics(rows: number) {
  return (async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: rows }, dimensions: { databaseId: "prod" } }] }] } }, errors: null }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

async function setup(env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  resetLoopGuard();
  resetWriteBudgetCache();
  ctx = await makeTestApp(env, fetchImpl ? { fetch: fetchImpl } : {});
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const body = (await c.get("/api/account/me")).body;
  actor = { orgId: body.organization.id, userId: body.user.id, email: body.user.email, name: body.user.name, role: "owner" };
  me = body.user.id;
  const invite = await c.post("/api/team/invites", { email: "max@acme.io", role: "member" });
  const m = new Client(ctx.app);
  await m.signup("max@acme.io", "Max Member", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  mate = { id: (await m.get("/api/account/me")).body.user.id, client: m };
  pid = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  chan = (await c.post("/api/chat/channels", { name: "engineering" })).body.channel.id;
}

const messagesIn = async (channelId: string, cl: Client = c) => ((await cl.get(`/api/chat/channels/${channelId}/messages`)).body.messages as { body: string; authorName?: string }[]).map((m) => m.body);
const notesFor = async (userId: string) => ctx.db.select().from(notifications).where(eq(notifications.userId, userId));
const rule = (input: Parameters<typeof createAutomation>[2]) => createAutomation(ctx.deps, actor, input);

describe("recipe library", () => {
  beforeEach(() => setup());

  it("has 24 to 30 recipes over five categories with unique keys, plain copy and known icons", () => {
    expect(AUTOMATION_RECIPES.length).toBeGreaterThanOrEqual(24);
    expect(AUTOMATION_RECIPES.length).toBeLessThanOrEqual(30);
    expect(new Set(AUTOMATION_RECIPES.map((r) => r.key)).size).toBe(AUTOMATION_RECIPES.length);
    expect(new Set(AUTOMATION_RECIPES.map((r) => r.category))).toEqual(new Set(["Tasks", "Mail", "Chat", "Meetings", "Sprints"]));
    for (const r of AUTOMATION_RECIPES) {
      expect(r.name.length).toBeLessThanOrEqual(120);
      expect(r.description).toMatch(/\.$/);
      expect(`${r.name}${r.description}`).not.toMatch(/[\u2013\u2014]/);
      expect(r.icon).toMatch(/^[A-Z][A-Za-z]+$/);
      expect(r.rules.length).toBeGreaterThan(0);
    }
  });

  it("every recipe validates against the engine and turns on with its blanks filled", async () => {
    const blanks = { channelId: chan, projectId: pid, memberIds: [me, mate.id], from: "@client.com.au", keyword: "todo" };
    for (const r of AUTOMATION_RECIPES) {
      const out = await enableRecipe(ctx.deps, actor, r.key, blanks);
      expect(out.automations.length, r.key).toBe(r.rules.length);
      for (const a of out.automations) expect(a.conditions.recipe).toBe(r.key);
    }
    const listed = await listRecipes(ctx.deps, actor);
    expect(listed.recipes.every((r) => r.on && r.added)).toBe(true);
    // Turning one on again switches its rules back on instead of making more.
    const done = listed.recipes.find((r) => r.key === "done_post_channel")!;
    await c.patch(`/api/automations/${done.automationIds[0]}`, { enabled: false });
    expect((await listRecipes(ctx.deps, actor)).recipes.find((r) => r.key === "done_post_channel")!.on).toBe(false);
    const again = await enableRecipe(ctx.deps, actor, "done_post_channel", { channelId: chan });
    expect(again.created).toBe(false);
    expect((await listAutomations(ctx.deps, actor.orgId)).length).toBe(AUTOMATION_RECIPES.reduce((n, r) => n + r.rules.length, 0));
  });

  it("checks blanks: missing ones, another workspace's channel, project and member, and private channels are refused", async () => {
    await expect(enableRecipe(ctx.deps, actor, "done_post_channel", {})).rejects.toMatchObject({ status: 422 });
    await expect(enableRecipe(ctx.deps, actor, "new_task_round_robin", { projectId: pid })).rejects.toMatchObject({ status: 422 });
    await expect(enableRecipe(ctx.deps, actor, "nope", {})).rejects.toMatchObject({ status: 404 });
    expect(() => fillRecipe(AUTOMATION_RECIPES.find((r) => r.key === "client_email_task")!, { from: 5 })).toThrow(/Check/);
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve");
    const theirChan = (await other.post("/api/chat/channels", { name: "theirs" })).body.channel.id;
    const theirProject = (await other.post("/api/projects", { name: "Theirs", key: "THR" })).body.project.id;
    const eve = (await other.get("/api/account/me")).body.user.id;
    await expect(enableRecipe(ctx.deps, actor, "done_post_channel", { channelId: theirChan })).rejects.toMatchObject({ status: 422 });
    await expect(enableRecipe(ctx.deps, actor, "project_new_post", { projectId: theirProject, channelId: chan })).rejects.toMatchObject({ status: 422 });
    await expect(enableRecipe(ctx.deps, actor, "new_task_round_robin", { projectId: pid, memberIds: [me, eve] })).rejects.toMatchObject({ status: 422 });
    const priv = (await c.post("/api/chat/channels", { name: "secret", private: true })).body.channel.id;
    await expect(enableRecipe(ctx.deps, actor, "done_post_channel", { channelId: priv })).rejects.toMatchObject({ status: 422 });
    // The plain CRUD checks the same way.
    expect((await c.post("/api/automations", { name: "x", trigger: "task_created", action: "post_to_channel", actionConfig: { channelId: theirChan } })).status).toBe(422);
    expect((await c.post("/api/automations", { name: "x", trigger: "meeting_ended", action: "set_priority", actionConfig: { priority: "high" } })).status).toBe(422);
    expect((await c.post("/api/automations", { name: "x", trigger: "chat_message_posted", action: "notify", actionConfig: { to: "admins" } })).status).toBe(422);
    expect((await listAutomations(ctx.deps, actor.orgId)).length).toBe(0);
  });

  it("only admins turn recipes on: members, read only keys and agent keys are refused", async () => {
    expect((await mate.client.post("/api/automations/recipes/assigned_notify/enable", {})).status).toBe(403);
    expect((await mate.client.get("/api/automations/recipes")).body.canManage).toBe(false);
    await expect(enableRecipe(ctx.deps, { ...actor, scope: "read" }, "assigned_notify")).rejects.toMatchObject({ status: 403 });
    await expect(enableRecipe(ctx.deps, { ...actor, agentId: "agt_1" }, "assigned_notify")).rejects.toMatchObject({ status: 403 });
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const h = { host: "localhost", authorization: `Bearer ${ro}`, "content-type": "application/json" };
    expect((await ctx.app.request("/api/v1/automations/recipes", { headers: h })).status).toBe(200);
    expect((await ctx.app.request("/api/v1/automations/recipes/assigned_notify/enable", { method: "POST", headers: h, body: "{}" })).status).toBe(403);
    expect((await c.post("/api/automations/recipes/assigned_notify/enable", {})).status).toBe(200);
  });
});

describe("new triggers and actions", () => {
  beforeEach(() => setup());

  it("status Done posts in a channel with the variables filled", async () => {
    await enableRecipe(ctx.deps, actor, "done_post_channel", { channelId: chan });
    const t = await createTask(ctx.deps, actor, { title: "Ship the site", projectId: pid, assignee: { type: "member", id: mate.id } });
    await updateTask(ctx.deps, actor, t.id, { status: "done" });
    const msgs = await messagesIn(chan);
    expect(msgs.some((m) => m.startsWith(`Done: ${t.ref} Ship the site (Max Member) `) && m.includes(`/app/tasks?task=${t.id}`))).toBe(true);
    expect(fillTemplate("{task.title} {nope}", { "task.title": "A" })).toBe("A {nope}");
  });

  it("task_created: an urgent task posts; a bug gets high priority, a post and a checklist", async () => {
    await enableRecipe(ctx.deps, actor, "urgent_post_channel", { channelId: chan });
    await enableRecipe(ctx.deps, actor, "bug_high_post", { channelId: chan });
    await enableRecipe(ctx.deps, actor, "bug_checklist");
    await createTask(ctx.deps, actor, { title: "Server down", projectId: pid, priority: "urgent" });
    const bug = await createTask(ctx.deps, actor, { title: "Login fails", projectId: pid, type: "bug" });
    const now = await getTask(ctx.deps, actor, bug.id);
    expect(now.priority).toBe("high");
    expect(now.subtasks.total).toBe(3);
    const msgs = await messagesIn(chan);
    expect(msgs.some((m) => m.startsWith("Urgent: ") && m.includes("Server down in Launch"))).toBe(true);
    expect(msgs.some((m) => m.startsWith(`New bug: ${bug.ref} Login fails`))).toBe(true);
    // A plain task matches none of them.
    const plain = await createTask(ctx.deps, actor, { title: "Plain", projectId: pid });
    expect((await getTask(ctx.deps, actor, plain.id)).priority).toBe("none");
  });

  it("assignee_changed notifies the assignee; set_status and add_label move and tag the task", async () => {
    await enableRecipe(ctx.deps, actor, "assigned_notify");
    await rule({ name: "Tag", trigger: "assignee_changed", conditions: {}, action: "add_label", actionConfig: { label: "owned" } });
    await rule({ name: "Start", trigger: "assignee_changed", conditions: { category: "todo" }, action: "set_status", actionConfig: { statusName: "In progress" } });
    const t = await createTask(ctx.deps, actor, { title: "Write copy", projectId: pid });
    await updateTask(ctx.deps, actor, t.id, { assignee: { type: "member", id: mate.id } });
    expect((await notesFor(mate.id)).some((n) => n.type === "automation.rule" && n.title.includes("Write copy"))).toBe(true);
    const now = await getTask(ctx.deps, actor, t.id);
    expect(now.labels).toEqual(["owned"]);
    expect(now.statusName).toBe("In progress");
  });

  it("assign_task: to the project lead, to one member, and round robin in turn", async () => {
    await c.patch(`/api/projects/${pid}`, { ownerId: mate.id });
    await rule({ name: "Lead", trigger: "task_created", conditions: { priority: "high" }, action: "assign_task", actionConfig: { mode: "lead" } });
    const hi = await createTask(ctx.deps, actor, { title: "Big", projectId: pid, priority: "high" });
    expect((await getTask(ctx.deps, actor, hi.id)).assignee?.id).toBe(mate.id);
    await rule({ name: "One", trigger: "task_created", conditions: { type: "story" }, action: "assign_task", actionConfig: { mode: "member", memberId: me } });
    const st = await createTask(ctx.deps, actor, { title: "Story", projectId: pid, type: "story" });
    expect((await getTask(ctx.deps, actor, st.id)).assignee?.id).toBe(me);
    await enableRecipe(ctx.deps, actor, "new_task_round_robin", { projectId: pid, memberIds: [me, mate.id] });
    const got: string[] = [];
    for (const n of [1, 2, 3]) got.push((await getTask(ctx.deps, actor, (await createTask(ctx.deps, actor, { title: `RR ${n}`, projectId: pid })).id)).assignee!.id);
    expect(got).toEqual([me, mate.id, me]);
  });

  it("conditions on task triggers: project, priority, type and label", async () => {
    const other = (await c.post("/api/projects", { name: "Other", key: "OTH" })).body.project.id;
    await rule({ name: "Only Launch customer bugs", trigger: "task_created", conditions: { projectId: pid, type: "bug", label: "customer" }, action: "set_priority", actionConfig: { priority: "urgent" } });
    const a = await createTask(ctx.deps, actor, { title: "A", projectId: pid, type: "bug", labels: ["Customer"] });
    const b = await createTask(ctx.deps, actor, { title: "B", projectId: other, type: "bug", labels: ["customer"] });
    const d = await createTask(ctx.deps, actor, { title: "D", projectId: pid, type: "task", labels: ["customer"] });
    expect((await getTask(ctx.deps, actor, a.id)).priority).toBe("urgent");
    expect((await getTask(ctx.deps, actor, b.id)).priority).toBe("none");
    expect((await getTask(ctx.deps, actor, d.id)).priority).toBe("none");
    expect(isR24Rule({ trigger: "status_changed", action: "notify", conditions: { toCategory: "done" }, actionConfig: { to: "assignee" } })).toBe(false);
    expect(isR24Rule({ trigger: "status_changed", action: "notify", conditions: { priority: "high" }, actionConfig: {} })).toBe(true);
    await expect(validateR24Rule(ctx.deps, actor.orgId, { trigger: "task_created", action: "set_priority", conditions: { priority: "huge" }, actionConfig: { priority: "high" } })).rejects.toMatchObject({ status: 422 });
  });

  it("In review notifies the creator (a move inside the doing category still counts)", async () => {
    await enableRecipe(ctx.deps, actor, "review_notify_creator");
    const t = await mate.client.post("/api/tasks", { title: "Draft", projectId: pid });
    const taskId = t.body.task.id;
    await updateTask(ctx.deps, actor, taskId, { status: "doing" });
    const project = (await c.get(`/api/projects/${pid}`)).body.project as { statuses: { id: string; name: string }[] };
    await updateTask(ctx.deps, actor, taskId, { statusId: project.statuses.find((s) => s.name === "In review")!.id });
    expect((await notesFor(mate.id)).filter((n) => n.type === "automation.rule").length).toBe(1);
  });

  it("due_passed fires once per task per due date, skips done tasks, and fires again for a new due date", async () => {
    await enableRecipe(ctx.deps, actor, "due_passed_notify");
    const late = await createTask(ctx.deps, actor, { title: "Late", projectId: pid, assignee: { type: "member", id: mate.id }, due: new Date(Date.now() - 3600_000).toISOString() });
    const fin = await createTask(ctx.deps, actor, { title: "Finished", projectId: pid, assignee: { type: "member", id: mate.id }, due: new Date(Date.now() - 3600_000).toISOString() });
    await updateTask(ctx.deps, actor, fin.id, { status: "done" });
    await createTask(ctx.deps, actor, { title: "Future", projectId: pid, assignee: { type: "member", id: mate.id }, due: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await runDuePassed(ctx.deps)).fired).toBe(1);
    resetLoopGuard();
    expect((await runDuePassed(ctx.deps)).fired).toBe(0);
    expect((await notesFor(mate.id)).filter((n) => n.type === "automation.rule").length).toBe(1);
    await updateTask(ctx.deps, actor, late.id, { due: new Date(Date.now() - 1800_000).toISOString() });
    resetLoopGuard();
    expect((await runDuePassed(ctx.deps)).fired).toBe(1);
  });

  it("due_passed to the project lead, and a lead missing is recorded on the rule", async () => {
    await enableRecipe(ctx.deps, actor, "due_passed_lead");
    const t = await createTask(ctx.deps, actor, { title: "Late", projectId: pid, due: new Date(Date.now() - 3600_000).toISOString() });
    await runDuePassed(ctx.deps);
    expect((await listAutomations(ctx.deps, actor.orgId))[0].lastError).toMatch(/no lead/);
    await c.patch(`/api/projects/${pid}`, { ownerId: me });
    await updateTask(ctx.deps, actor, t.id, { due: new Date(Date.now() - 1800_000).toISOString() });
    resetLoopGuard();
    await runDuePassed(ctx.deps);
    expect((await getTask(ctx.deps, actor, t.id)).assignee?.id).toBe(me);
  });

  it("meeting_ended makes a follow up task; a chat keyword makes a task and the rule's own posts never loop", async () => {
    await enableRecipe(ctx.deps, actor, "meeting_ended_task", { projectId: pid });
    const made = await c.post("/api/meetings", { title: "Weekly sync", startsAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const m = (made.body.meeting ?? made.body) as { id: string };
    expect((await c.patch(`/api/meetings/${m.id}`, { status: "ended" })).status).toBe(200);
    await c.patch(`/api/meetings/${m.id}`, { status: "ended" });
    let list = (await c.get(`/api/tasks?projectId=${pid}`)).body.tasks as { title: string }[];
    expect(list.filter((t) => t.title === "Send notes and next steps: Weekly sync")).toHaveLength(1);

    await enableRecipe(ctx.deps, actor, "chat_keyword_task", { keyword: "todo", projectId: pid });
    await rule({ name: "Echo", trigger: "chat_message_posted", conditions: { keyword: "todo" }, action: "post_to_channel", actionConfig: { channelId: chan, message: "todo noted: {message.text}" } });
    const general = (await c.post("/api/chat/channels", { name: "random" })).body.channel as { id: string };
    await c.post(`/api/chat/channels/${general.id}/messages`, { body: "todo: order the banners" });
    await c.post(`/api/chat/channels/${general.id}/messages`, { body: "nothing to see (todos are not a word match)" });
    list = (await c.get(`/api/tasks?projectId=${pid}`)).body.tasks;
    expect(list.filter((t) => t.title === "todo: order the banners")).toHaveLength(1);
    // The echo posted once in #engineering and that post (which also says todo) made no task and no echo.
    expect((await messagesIn(chan)).filter((b) => b.startsWith("todo noted"))).toHaveLength(1);
    expect(list.filter((t) => t.title.startsWith("todo noted"))).toHaveLength(0);
  });

  it("email rules can post in a channel", async () => {
    await enableRecipe(ctx.deps, actor, "email_post_channel", { from: "@client.com.au", channelId: chan });
    await runEmailAutomations(ctx.deps, actor.orgId, { messageId: "m1", threadId: "t1", mailboxId: "mb", from: "amy@client.com.au", subject: "Quote" });
    await runEmailAutomations(ctx.deps, actor.orgId, { messageId: "m2", threadId: "t2", mailboxId: "mb", from: "spam@else.com", subject: "Hi" });
    expect((await messagesIn(chan)).filter((b) => b.startsWith("New email from"))).toEqual(["New email from amy@client.com.au: Quote"]);
  });

  it("guards loops: rules that undo each other stop within the depth limit, once a minute per task", async () => {
    await rule({ name: "Back to do", trigger: "status_changed", conditions: { toCategory: "doing", priority: "none" }, action: "set_status", actionConfig: { category: "todo" } });
    await rule({ name: "Back to doing", trigger: "status_changed", conditions: { toCategory: "todo", priority: "none" }, action: "set_status", actionConfig: { category: "doing" } });
    const t = await createTask(ctx.deps, actor, { title: "Ping pong", projectId: pid });
    await updateTask(ctx.deps, actor, t.id, { status: "doing" });
    const runs = (await listAutomations(ctx.deps, actor.orgId)).reduce((n, r) => n + r.runCount, 0);
    expect(runs).toBeGreaterThan(0);
    expect(runs).toBeLessThanOrEqual(3);
    // Inside the minute the same rule does not act on the same task again.
    await updateTask(ctx.deps, actor, t.id, { status: "doing" });
    expect((await listAutomations(ctx.deps, actor.orgId)).reduce((n, r) => n + r.runCount, 0)).toBe(runs);
  });

  it("counts runs against the plan like other rules", async () => {
    await enableRecipe(ctx.deps, actor, "urgent_post_channel", { channelId: chan });
    const before = (await c.get("/api/automations")).body.usage.used;
    await createTask(ctx.deps, actor, { title: "U", projectId: pid, priority: "urgent" });
    expect((await c.get("/api/automations")).body.usage.used).toBe(before + 1);
  });
});

describe("due_passed and the write budget", () => {
  it("pauses at warn and shed, writes nothing when there are no rules", async () => {
    await setup({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acc" }, analytics(65_000));
    expect(await runDuePassed(ctx.deps)).toEqual({ fired: 0, paused: false });
    await enableRecipe(ctx.deps, actor, "due_passed_notify");
    const t = await createTask(ctx.deps, actor, { title: "Late", projectId: pid, assignee: { type: "member", id: mate.id }, due: new Date(Date.now() - 3600_000).toISOString() });
    expect(await runDuePassed(ctx.deps)).toEqual({ fired: 0, paused: true });
    const row = await ctx.db.select().from(tasksTable).where(and(eq(tasksTable.id, t.id))).get();
    expect(row!.reminderSentFor).toBeNull();
  });
});

describe("REST and MCP", () => {
  beforeEach(() => setup());

  it("lists and enables through /api/v1 and MCP; read only keys can list but not enable; another workspace's key sees its own state", async () => {
    const full = (await c.post("/api/developer/keys", { name: "full" })).body.secret;
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const h = (k: string) => ({ host: "localhost", authorization: `Bearer ${k}`, "content-type": "application/json" });
    const list = await (await ctx.app.request("/api/v1/automations/recipes", { headers: h(ro) })).json() as { recipes: { key: string; on: boolean }[] };
    expect(list.recipes.length).toBe(AUTOMATION_RECIPES.length);
    const res = await ctx.app.request("/api/v1/automations/recipes/done_post_channel/enable", { method: "POST", headers: h(full), body: JSON.stringify({ blanks: { channelId: chan } }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { automations: unknown[] }).automations).toHaveLength(1);
    const bad = await ctx.app.request("/api/v1/automations/recipes/done_post_channel/enable", { method: "POST", headers: h(full), body: JSON.stringify({ blanks: {} }) });
    expect(bad.status).toBe(422);
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve");
    const evil = (await other.post("/api/developer/keys", { name: "k" })).body.secret;
    const theirs = await (await ctx.app.request("/api/v1/automations/recipes", { headers: h(evil) })).json() as { recipes: { key: string; on: boolean }[] };
    expect(theirs.recipes.find((r) => r.key === "done_post_channel")!.on).toBe(false);
    expect((await ctx.app.request("/api/v1/automations/recipes/done_post_channel/enable", { method: "POST", headers: h(evil), body: JSON.stringify({ blanks: { channelId: chan } }) })).status).toBe(422);

    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${full}` } }, fetch: fetchViaApp }));
    const r = await mcp.callTool({ name: "list_automation_recipes", arguments: { category: "Chat" } });
    const parsed = JSON.parse((r.content as { text: string }[])[0].text) as { recipes: { category: string }[] };
    expect(parsed.recipes.length).toBeGreaterThan(0);
    expect(parsed.recipes.every((x) => x.category === "Chat")).toBe(true);
    const on = await mcp.callTool({ name: "enable_automation_recipe", arguments: { key: "assigned_notify" } });
    expect(on.isError).toBeFalsy();
    await mcp.close();
    const roMcp = new McpClient({ name: "test", version: "1.0.0" });
    await roMcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${ro}` } }, fetch: fetchViaApp }));
    expect((await roMcp.callTool({ name: "list_automation_recipes", arguments: {} })).isError).toBeFalsy();
    expect((await roMcp.callTool({ name: "enable_automation_recipe", arguments: { key: "high_notify_lead" } })).isError).toBe(true);
    await roMcp.close();
    expect((await listRecipes(ctx.deps, actor)).recipes.filter((x) => x.on).map((x) => x.key).sort()).toEqual(["assigned_notify", "done_post_channel"]);
  });
});
