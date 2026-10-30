import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { createTask } from "@/server/services/suite/tasks";
import { getWorkload } from "@/server/services/suite/workload";
import { listCapacities, setCapacity } from "@/server/services/suite/workload-capacity";
import type { SuiteActor } from "@/server/services/suite/common";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let actor: SuiteActor;
let me: string;
let mate: { id: string; client: Client };
let pts: string;

beforeEach(async () => {
  ctx = await makeTestApp();
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
  pts = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  ctx.deps.now = () => new Date("2026-11-04T02:00:00Z");
});

const row = (w: Awaited<ReturnType<typeof getWorkload>>, name: string) => w.people.find((p) => p.name === name)!;

describe("weekly capacity per person", () => {
  it("flags over capacity against each person's stored capacity, falls back to the default, and a request capacity wins", async () => {
    await createTask(ctx.deps, actor, { title: "Big", projectId: pts, due: "2026-11-05T10:00:00Z", points: 12, assignee: { type: "member", id: me } });
    await createTask(ctx.deps, actor, { title: "Also big", projectId: pts, due: "2026-11-05T10:00:00Z", points: 12, assignee: { type: "member", id: mate.id } });
    await setCapacity(ctx.deps, actor, { person: `member:${me}`, points: 10 });
    const w = await getWorkload(ctx.deps, actor, { from: "2026-11-02", weeks: 1, tz: "UTC" });
    expect(row(w, "Olive Owner")).toMatchObject({ capacity: 10, capacitySource: "stored" });
    expect(row(w, "Olive Owner").weeks[0].over).toBe(true);
    expect(row(w, "Max Member")).toMatchObject({ capacity: 20, capacitySource: "default" });
    expect(row(w, "Max Member").weeks[0].over).toBe(false);
    expect(row(w, "Max Member").weeks[0].near).toBe(false);
    expect(w.overloaded).toEqual([{ person: "Olive Owner", id: `member:${me}`, week: "2026-11-02", load: 12, capacity: 10 }]);
    // Hours are stored apart from points; with none stored the hours default applies.
    expect(row(await getWorkload(ctx.deps, actor, { from: "2026-11-02", weeks: 1, tz: "UTC", unit: "hours" }), "Olive Owner")).toMatchObject({ capacity: 40, capacitySource: "default" });
    const req = await getWorkload(ctx.deps, actor, { from: "2026-11-02", weeks: 1, tz: "UTC", capacity: 11 });
    expect(row(req, "Max Member")).toMatchObject({ capacity: 11, capacitySource: "request" });
    expect(row(req, "Max Member").weeks[0].over).toBe(true);
  });

  it("keeps a field left out, clears with null, deletes the row when both are cleared, and validates numbers", async () => {
    const p = `member:${me}`;
    expect(await setCapacity(ctx.deps, actor, { person: p, points: 15 })).toMatchObject({ points: 15, hours: null });
    expect(await setCapacity(ctx.deps, actor, { person: p, hours: 32.5 })).toMatchObject({ points: 15, hours: 32.5 });
    expect(await setCapacity(ctx.deps, actor, { person: p, points: null })).toMatchObject({ points: null, hours: 32.5 });
    expect(await listCapacities(ctx.deps, actor.orgId)).toEqual([{ person: p, points: null, hours: 32.5 }]);
    await setCapacity(ctx.deps, actor, { person: p, hours: null });
    expect(await listCapacities(ctx.deps, actor.orgId)).toEqual([]);
    await expect(setCapacity(ctx.deps, actor, { person: p, points: 0 })).rejects.toMatchObject({ status: 422 });
    await expect(setCapacity(ctx.deps, actor, { person: p, points: 20_000 })).rejects.toMatchObject({ status: 422 });
    await expect(setCapacity(ctx.deps, actor, { person: "someone", points: 5 })).rejects.toMatchObject({ status: 422 });
    expect((await c.put("/api/workload/capacity", { person: p })).status).toBe(422);
  });

  it("lets owners set anyone's, a member only their own, and refuses other workspaces, read only keys and signed out callers", async () => {
    expect((await c.put("/api/workload/capacity", { person: `member:${mate.id}`, points: 8 })).status).toBe(200);
    expect((await mate.client.put("/api/workload/capacity", { person: `member:${mate.id}`, hours: 30 })).body).toMatchObject({ points: 8, hours: 30 });
    expect((await mate.client.put("/api/workload/capacity", { person: `member:${me}`, points: 1 })).status).toBe(403);
    const list = (await mate.client.get("/api/workload/capacity")).body;
    expect(list.defaults).toEqual({ points: 20, hours: 40 });
    expect(list.people.find((x: { person: string }) => x.person === `member:${mate.id}`)).toMatchObject({ name: "Max Member", points: 8, hours: 30 });
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else", "Else");
    const eve = (await other.get("/api/account/me")).body.user.id;
    expect((await c.put("/api/workload/capacity", { person: `member:${eve}`, points: 5 })).status).toBe(404);
    expect((await other.put("/api/workload/capacity", { person: `member:${me}`, points: 5 })).status).toBe(404);
    expect(JSON.stringify((await other.get("/api/workload/capacity")).body)).not.toContain("Max Member");
    expect((await new Client(ctx.app).put("/api/workload/capacity", { person: `member:${me}`, points: 5 })).status).toBe(401);

    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const rw = (await c.post("/api/developer/keys", { name: "rw" })).body.secret;
    const req = (key: string, method: string, body?: unknown) => ctx.app.request("/api/v1/workload/capacity", { method, headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    expect((await req(ro, "GET")).status).toBe(200);
    expect((await req(ro, "PUT", { person: `member:${me}`, points: 5 })).status).toBe(403);
    const put = await req(rw, "PUT", { person: `member:${me}`, points: 6 });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ person: `member:${me}`, points: 6 });
  });

  it("set_weekly_capacity over MCP sets it, get_workload uses it, and a read only key is refused", async () => {
    await createTask(ctx.deps, actor, { title: "Ours", projectId: pts, due: "2026-11-03T10:00:00Z", points: 7, assignee: { type: "member", id: me } });
    const rw = (await c.post("/api/developer/keys", { name: "rw" })).body.secret;
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const connect = async (key: string) => {
      const m = new McpClient({ name: "test", version: "1.0.0" });
      await m.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
      return m;
    };
    const mcp = await connect(rw);
    const set = await mcp.callTool({ name: "set_weekly_capacity", arguments: { person: `member:${me}`, points: 5 } });
    expect(set.isError).toBeFalsy();
    const w = JSON.parse(((await mcp.callTool({ name: "get_workload", arguments: { from: "2026-11-02", weeks: 1, tz: "UTC" } })).content as { text: string }[])[0].text);
    expect(w.overloaded).toEqual([{ person: "Olive Owner", id: `member:${me}`, week: "2026-11-02", load: 7, capacity: 5 }]);
    await mcp.close();
    const roMcp = await connect(ro);
    const refused = await roMcp.callTool({ name: "set_weekly_capacity", arguments: { person: `member:${me}`, points: 9 } });
    expect(refused.isError).toBe(true);
    await roMcp.close();
    expect(await listCapacities(ctx.deps, actor.orgId)).toEqual([{ person: `member:${me}`, points: 5, hours: null }]);
  });
});
