import { describe, it, expect } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { NO_LANE, bucketLanes, cellId, columnTotals, limitLabel, limitState, normaliseLimits, parseCellId, wouldExceed } from "../src/shared/board-lanes";

/** R34 (MB-186): board swimlanes and WIP limits: grouping, limit logic, session API, v1 and MCP. */
describe("board lanes (pure)", () => {
  const cards = [
    { id: "a", position: 2, lane: "u1", col: "todo" },
    { id: "b", position: 1, lane: "u1", col: "todo" },
    { id: "c", position: 1, lane: "u2", col: "doing" },
    { id: "d", position: 1, lane: "ghost", col: "doing" },
    { id: "e", position: 1, lane: "u1", col: "gone" },
  ];
  const lanes = [{ id: "u1", name: "Ann" }, { id: "u2", name: "Bo" }, { id: "u3", name: "Cy" }, { id: NO_LANE, name: "No assignee" }];
  it("buckets lanes x columns, keeps empty lanes, sorts by position, unknown lanes go last", () => {
    const b = bucketLanes(cards, lanes, ["todo", "doing"], (t) => t.lane, (t) => t.col);
    expect(Object.keys(b)).toEqual(["u1", "u2", "u3", NO_LANE]);
    expect(b.u1!.todo!.map((t) => t.id)).toEqual(["b", "a"]);
    expect(b.u2!.doing!.map((t) => t.id)).toEqual(["c"]);
    expect(b.u3).toEqual({ todo: [], doing: [] });
    expect(b[NO_LANE]!.doing!.map((t) => t.id)).toEqual(["d"]);
    expect(columnTotals(b, ["todo", "doing"])).toEqual({ todo: 2, doing: 2 });
  });
  it("drops unknown lanes when there is no 'no value' lane", () => {
    const b = bucketLanes(cards, lanes.slice(0, 2), ["doing"], (t) => t.lane, (t) => t.col);
    expect(columnTotals(b, ["doing"])).toEqual({ doing: 1 });
  });
  it("limit state, label and the over-limit drop check", () => {
    expect(limitState(3, undefined)).toBe("ok");
    expect(limitState(4, { max: 5 })).toBe("ok");
    expect(limitState(5, { max: 5 })).toBe("at");
    expect(limitState(6, { max: 5 })).toBe("over");
    expect(limitState(1, { min: 2, max: 5 })).toBe("under");
    expect(limitLabel(4, { max: 5 })).toBe("4 / 5");
    expect(limitLabel(4, { min: 2 })).toBe("4 (min 2)");
    expect(limitLabel(4, undefined)).toBe("4");
    expect(wouldExceed(2, { max: 1 })).toBe(true);
    expect(wouldExceed(1, { max: 1 })).toBe(false);
    expect(wouldExceed(9, { min: 1 })).toBe(false);
  });
  it("normalises limits and refuses bad ones", () => {
    expect(normaliseLimits({ a: { max: 5, min: 0 }, b: { max: null }, c: null })).toEqual({ a: { max: 5 } });
    expect(() => normaliseLimits({ a: { max: 1.5 } })).toThrow(/whole number/);
    expect(() => normaliseLimits({ a: { max: 2, min: 3 } })).toThrow(/above its maximum/);
    expect(() => normaliseLimits([1])).toThrow();
    expect(() => normaliseLimits({ a: { max: 1000 } })).toThrow();
  });
  it("cell ids round trip", () => {
    expect(parseCellId(cellId("u1", "st_1"))).toEqual({ lane: "u1", col: "st_1" });
    expect(parseCellId("col:x")).toBeNull();
  });
});

describe("board settings API", () => {
  it("session: defaults, swimlanes, one column limit, clearing, validation, other workspace", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    const p = (await c.post("/api/projects", { name: "Build" })).body.project as { id: string; statuses: { id: string }[] };
    const doing = p.statuses[1]!.id;
    expect((await c.get(`/api/projects/${p.id}/board`)).body.board).toEqual({ projectId: p.id, swimlanes: "none", limits: {} });
    expect((await c.put(`/api/projects/${p.id}/board`, { swimlanes: "assignee" })).body.board.swimlanes).toBe("assignee");
    const lim = await c.put(`/api/projects/${p.id}/board`, { column: { id: doing, max: 3 } });
    expect(lim.body.board).toMatchObject({ swimlanes: "assignee", limits: { [doing]: { max: 3 } } });
    expect((await c.put(`/api/projects/${p.id}/board`, { column: { id: doing, min: 1 } })).body.board.limits[doing]).toEqual({ max: 3, min: 1 });
    expect((await c.put(`/api/projects/${p.id}/board`, { column: { id: doing, max: null, min: null } })).body.board.limits).toEqual({});
    expect((await c.put(`/api/projects/${p.id}/board`, { swimlanes: "colour" })).status).toBe(422);
    expect((await c.put(`/api/projects/${p.id}/board`, { limits: { [doing]: { max: 2, min: 5 } } })).status).toBe(422);
    expect((await c.get(`/api/projects/prj_nope/board`)).status).toBe(404);
    const other = new Client(ctx.app);
    await other.signup("x@other.io", "Xavier Other");
    expect((await other.get(`/api/projects/${p.id}/board`)).status).toBe(404);
    expect((await other.put(`/api/projects/${p.id}/board`, { swimlanes: "epic" })).status).toBe(404);
  });

  it("v1 GET and PUT /projects/{id}/board; read only keys can read but not change", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    const p = (await c.post("/api/projects", { name: "Build" })).body.project as { id: string; statuses: { id: string }[] };
    const rw = (await c.post("/api/developer/keys", { name: "rw" })).body.secret;
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const req = (key: string | null, method: string, path: string, body?: unknown) => ctx.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    expect((await req(null, "GET", `/projects/${p.id}/board`)).status).toBe(401);
    const put = await req(rw, "PUT", `/projects/${p.id}/board`, { swimlanes: "priority", limits: { [p.statuses[1]!.id]: { max: 4 } } });
    expect(put.status).toBe(200);
    const got = (await (await req(ro, "GET", `/projects/${p.id}/board`)).json()) as { board: { swimlanes: string; limits: Record<string, { max?: number }> } };
    expect(got.board).toMatchObject({ swimlanes: "priority", limits: { [p.statuses[1]!.id]: { max: 4 } } });
    expect((await req(ro, "PUT", `/projects/${p.id}/board`, { swimlanes: "none" })).status).toBe(403);
    expect((await req(rw, "PUT", `/projects/${p.id}/board`, { swimlanes: "colour" })).status).toBe(422);
    // The app reads what the key wrote.
    expect((await c.get(`/api/projects/${p.id}/board`)).body.board.swimlanes).toBe("priority");
  });

  it("MCP get_board_settings and set_board_settings; read only keys can read only", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    const p = (await c.post("/api/projects", { name: "Build" })).body.project as { id: string; statuses: { id: string }[] };
    const rw = (await c.post("/api/developer/keys", { name: "rw" })).body.secret;
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const connect = async (key: string) => {
      const m = new McpClient({ name: "test", version: "1.0.0" });
      await m.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
      return m;
    };
    const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0].text);
    const mcp = await connect(rw);
    const col = p.statuses[1]!.id;
    const set = text(await mcp.callTool({ name: "set_board_settings", arguments: { projectId: p.id, swimlanes: "epic", column: { id: col, max: 2 } } }));
    expect(set.board).toMatchObject({ swimlanes: "epic", limits: { [col]: { max: 2 } } });
    const roMcp = await connect(ro);
    expect(text(await roMcp.callTool({ name: "get_board_settings", arguments: { projectId: p.id } })).board.swimlanes).toBe("epic");
    expect((await roMcp.callTool({ name: "set_board_settings", arguments: { projectId: p.id, swimlanes: "none" } })).isError).toBe(true);
    await roMcp.close();
    await mcp.close();
  });
});
