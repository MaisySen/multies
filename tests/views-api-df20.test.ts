import { describe, it, expect } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";

/** DF-20: saved views can be made, listed and removed with an API key (REST and MCP), not only a browser session. */
describe("saved views in the public API", () => {
  it("a workspace key creates, lists and deletes a shared view; read only keys and bad input are refused", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    const projectId = (await c.post("/api/projects", { name: "Build" })).body.project.id as string;
    const rw = (await c.post("/api/developer/keys", { name: "rw" })).body.secret;
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const req = (key: string | null, method: string, path: string, body?: unknown) => ctx.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

    expect((await req(null, "GET", "/views")).status).toBe(401);
    const made = await req(rw, "POST", "/views", { name: "Build board", view: "sprints", projectId, filters: { status: "doing" } });
    expect(made.status).toBe(201);
    const view = ((await made.json()) as { view: { id: string; name: string; view: string; shared: boolean; filters: Record<string, string> } }).view;
    expect(view).toMatchObject({ name: "Build board", view: "sprints", shared: true, filters: { status: "doing" } });

    // The person sees it in the app's own list too.
    const inApp = (await c.get(`/api/tasks/views?projectId=${projectId}`)).body.views as { id: string }[];
    expect(inApp.map((v) => v.id)).toContain(view.id);

    const listed = (await (await req(ro, "GET", `/views?projectId=${projectId}`)).json()) as { views: { id: string }[] };
    expect(listed.views.map((v) => v.id)).toEqual([view.id]);
    expect((await req(ro, "POST", "/views", { name: "Nope", view: "list" })).status).toBe(403);
    expect((await req(rw, "POST", "/views", { name: "", view: "list" })).status).toBe(422);
    expect((await req(rw, "POST", "/views", { name: "Bad", view: "gallery" })).status).toBe(422);
    expect((await req(rw, "POST", "/views", { name: "Elsewhere", view: "list", projectId: "prj_nope" })).status).toBe(404);

    expect((await req(rw, "DELETE", `/views/${view.id}`)).status).toBe(200);
    expect((await req(rw, "DELETE", "/views/viw_nope")).status).toBe(404);
    expect(((await (await req(rw, "GET", "/views")).json()) as { views: unknown[] }).views).toEqual([]);
  });

  it("MCP create_saved_view, list_saved_views and delete_saved_view; a read only key can list but not create", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
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
    const made = text(await mcp.callTool({ name: "create_saved_view", arguments: { name: "Owner asks", view: "list", filters: { label: "owner-ask" } } }));
    expect(made.view).toMatchObject({ name: "Owner asks", view: "list", shared: true });
    const roMcp = await connect(ro);
    expect(text(await roMcp.callTool({ name: "list_saved_views", arguments: {} })).views).toHaveLength(1);
    expect((await roMcp.callTool({ name: "create_saved_view", arguments: { name: "No", view: "list" } })).isError).toBe(true);
    expect((await roMcp.callTool({ name: "delete_saved_view", arguments: { viewId: made.view.id } })).isError).toBe(true);
    await roMcp.close();
    expect((await mcp.callTool({ name: "delete_saved_view", arguments: { viewId: made.view.id } })).isError).toBeFalsy();
    expect(text(await mcp.callTool({ name: "list_saved_views", arguments: {} })).views).toEqual([]);
    await mcp.close();
  });
});
