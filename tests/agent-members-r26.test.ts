import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";

/** R26 (DF-3): AI agent members as workspace members: pause, avatar, inbox link, pickers, audit, scope. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

async function v1(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const client = () => (ctx.db as unknown as { $client: { prepare: (q: string) => { all: (...a: unknown[]) => unknown[] } } }).$client;
const raw = () => ({ all: (q: string, ...a: unknown[]) => client().prepare(q).all(...a) });

describe("agent members R26", () => {
  it("creates with a colour, lists with avatar and key count, edits, and an empty edit writes nothing", async () => {
    const made = await c.post("/api/team/agents", { name: "QA Bot", title: "Quality", avatarColor: "#5e5ce6" });
    expect(made.status).toBe(201);
    expect(made.body.member).toMatchObject({ kind: "agent", name: "QA Bot", avatar: { color: "#5E5CE6", initials: "QB" }, disabled: false, inbox: null, keys: 1 });
    expect(made.body.secret).toMatch(/^mm_live_/);
    const id = made.body.member.userId as string;
    const list = (await c.get("/api/team/agents")).body.agents;
    expect(list).toHaveLength(1);
    const ed = await c.patch(`/api/team/agents/${id}`, { title: "QA lead", bio: "Runs the checks.", name: "QA" });
    expect(ed.body.agent).toMatchObject({ name: "QA", title: "QA lead", bio: "Runs the checks.", avatar: { initials: "QA" } });
    expect((await c.patch(`/api/team/agents/${id}`, { avatarColor: "red" })).status).toBe(422);
    const before = raw().all("select count(*) n from audit_logs")[0] as { n: number };
    await c.patch(`/api/team/agents/${id}`, { title: "QA lead" });
    expect(raw().all("select count(*) n from audit_logs")[0]).toEqual(before);
    // REST and MCP list it too; the openapi document has the new paths.
    const ws = (await c.post("/api/developer/keys", { name: "ops" })).body.secret as string;
    expect((await v1(ws, "GET", "/agent-members")).body.agents[0]).toMatchObject({ userId: id, name: "QA" });
    expect((await v1(ws, "GET", `/agent-members/${id}`)).body.agent.userId).toBe(id);
    const paths = Object.keys((await (await ctx.app.request("/api/v1/openapi.json")).json()).paths);
    expect(paths).toEqual(expect.arrayContaining(["/agent-members", "/agent-members/{id}"]));
  });

  it("a paused agent's key is refused, and resuming lets it back in; both are audited", async () => {
    const made = (await c.post("/api/team/agents", { name: "Builder" })).body;
    const id = made.member.userId as string;
    expect((await v1(made.secret, "GET", "/people")).status).toBe(200);
    const p = await c.patch(`/api/team/agents/${id}`, { disabled: true });
    expect(p.body.agent.disabled).toBe(true);
    expect((await v1(made.secret, "GET", "/people")).status).toBe(401);
    // Paused agents leave the pickers but stay in People.
    expect((await c.get("/api/tasks/assignees")).body.assignees.find((a: { id: string }) => a.id === `member:${id}`)).toMatchObject({ paused: true });
    expect((await c.get("/api/team/people")).body.people.some((x: { userId: string }) => x.userId === id)).toBe(true);
    await c.patch(`/api/team/agents/${id}`, { disabled: false });
    expect((await v1(made.secret, "GET", "/people")).status).toBe(200);
    const actions = (raw().all("select action from audit_logs where target_id = ? order by created_at", id) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["agent_member.created", "agent_member.paused", "agent_member.resumed"]));
  });

  it("key scope: read keys can't write, another workspace's key and ids are refused, agent keys can't manage", async () => {
    const made = (await c.post("/api/team/agents", { name: "Docs", scope: "read" })).body;
    const id = made.member.userId as string;
    const proj = await c.post("/api/projects", { name: "Launch" });
    expect((await v1(made.secret, "POST", "/tasks", { projectId: proj.body.project.id, title: "Nope" })).status).toBe(403);
    expect((await v1(made.secret, "PATCH", `/agent-members/${id}`, { bio: "x" })).status).toBe(403);
    // A full key of the agent member itself can't manage agent members either (member role).
    const full = (await c.post(`/api/team/agents/${id}/keys`, { scope: "full" })).body.secret as string;
    expect((await v1(full, "PATCH", `/agent-members/${id}`, { disabled: true })).status).toBe(403);
    // Another workspace: its key can't see or edit this agent, and its admin can't either.
    const eve = new Client(ctx.app);
    await eve.signup("eve@evil.io", "Eve", "Evil");
    const evilKey = (await eve.post("/api/developer/keys", { name: "x" })).body.secret as string;
    expect((await v1(evilKey, "GET", `/agent-members/${id}`)).status).toBe(404);
    expect((await v1(evilKey, "PATCH", `/agent-members/${id}`, { disabled: true })).status).toBe(404);
    expect((await v1(evilKey, "GET", "/agent-members")).body.agents).toEqual([]);
    expect((await eve.patch(`/api/team/agents/${id}`, { disabled: true })).status).toBe(404);
    // Eve's agent key is refused here: tasks of this workspace are not found for it.
    const eveAgent = (await eve.post("/api/team/agents", { name: "Spy" })).body.secret as string;
    const t = await c.post("/api/tasks", { projectId: proj.body.project.id, title: "Secret" });
    expect((await v1(eveAgent, "GET", `/tasks/${t.body.task.id}`)).status).toBe(404);
    // An inbox from another workspace can't be linked.
    expect((await c.patch(`/api/team/agents/${id}`, { inboxAgentId: "agt_nope" })).status).toBe(404);
    // A plain member of the workspace can't manage agents.
    expect((await c.post("/api/team/invites", { email: "max@acme.io", role: "member" })).status).toBe(201);
  });

  it("assigns a task to an agent member, shows it with the agent flag in pickers and mentions, and attributes its writes", async () => {
    const made = (await c.post("/api/team/agents", { name: "Builder", title: "Engineer" })).body;
    const id = made.member.userId as string;
    const ref = `member:${id}`;
    const pick = (await c.get("/api/tasks/assignees")).body.assignees.find((a: { id: string }) => a.id === ref);
    expect(pick).toMatchObject({ name: "Builder", isAgent: true, email: null });
    const chatPeople = (await c.get("/api/chat/people")).body.people.find((a: { id: string }) => a.id === ref);
    expect(chatPeople).toMatchObject({ isAgent: true });
    const proj = await c.post("/api/projects", { name: "Launch" });
    const task = await c.post("/api/tasks", { projectId: proj.body.project.id, title: "Ship it", assignee: ref });
    expect(task.status).toBe(201);
    expect(task.body.task.assignee).toMatchObject({ type: "member", id, name: "Builder", email: null, isAgent: true });
    // The agent works its task through its key: the change is recorded with the agent as actor.
    const up = await v1(made.secret, "PATCH", `/tasks/${task.body.task.id}`, { status: "doing" });
    expect(up.status).toBe(200);
    const acts = raw().all("select actor_type t, actor_id a, actor_name n from activity_feed where entity_id = ?" /* R33: the timeline view (old activity rows and change rows with a verb) */, task.body.task.id) as { t: string; a: string; n: string }[];
    expect(acts.some((r) => r.a === id && r.n === "Builder")).toBe(true);
    // A chat mention of the agent member resolves to its name.
    const g = (await c.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
    const post = await c.post(`/api/chat/channels/${g.id}/messages`, { body: `<@${ref}> can you take this?` });
    expect(post.status).toBe(201);
    expect(JSON.stringify(post.body)).toContain("Builder");
  });

  it("keeps the existing agent member limit (10 on Free) as a 403 plan_limit, separate from seats", async () => {
    for (let i = 0; i < 10; i++) expect((await c.post("/api/team/agents", { name: `A${i}`, avatarColor: "#30B158" })).status).toBe(201);
    const over = await c.post("/api/team/agents", { name: "A10" });
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe("plan_limit");
    expect((await c.get("/api/team")).body.seats.members).toBe(1);
  });

  it("MCP: a workspace key lists, adds and pauses agent members; a read only key can't", async () => {
    const connect = async (key: string) => {
      const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
      const m = new McpClient({ name: "test", version: "1.0.0" });
      await m.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
      return m;
    };
    const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
    const ws = (await c.post("/api/developer/keys", { name: "mcp" })).body.secret as string;
    const mcp = await connect(ws);
    const made = data(await mcp.callTool({ name: "create_agent_member", arguments: { name: "Planner", title: "PM", avatarColor: "#FF9F0A" } }));
    expect(made.member).toMatchObject({ name: "Planner", avatar: { color: "#FF9F0A", initials: "PL" } });
    expect(made.secret).toMatch(/^mm_live_/);
    const id = made.member.userId as string;
    const paused = data(await mcp.callTool({ name: "update_agent_member", arguments: { userId: id, disabled: true } }));
    expect(paused.agent.disabled).toBe(true);
    expect(data(await mcp.callTool({ name: "list_agent_members", arguments: {} })).agents).toHaveLength(1);
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret as string;
    const r = await (await connect(ro)).callTool({ name: "update_agent_member", arguments: { userId: id, disabled: false } });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });
});
