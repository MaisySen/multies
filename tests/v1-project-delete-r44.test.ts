import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

// R44: DELETE /api/v1/projects/{id} (a key could create a project and never remove it).
describe("v1 project delete", () => {
  it("a workspace key deletes a project and its tasks; read only keys and other workspaces cannot", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    const rw = (await c.post("/api/developer/keys", { name: "rw" })).body.secret;
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const h = (k: string) => ({ host: "localhost", authorization: `Bearer ${k}`, "content-type": "application/json" });
    const made = await ctx.app.request("/api/v1/projects", { method: "POST", headers: h(rw), body: JSON.stringify({ name: "Scratch" }) });
    expect(made.status).toBe(201);
    const pid = ((await made.json()) as { project: { id: string } }).project.id;
    const t = await ctx.app.request("/api/v1/tasks", { method: "POST", headers: h(rw), body: JSON.stringify({ title: "Inside", projectId: pid }) });
    expect(t.status).toBe(201);
    const tid = ((await t.json()) as { task: { id: string } }).task.id;

    expect((await ctx.app.request(`/api/v1/projects/${pid}`, { method: "DELETE", headers: h(ro) })).status).toBe(403);
    expect((await ctx.app.request(`/api/v1/projects/${pid}`, { method: "DELETE", headers: { host: "localhost" } })).status).toBe(401);

    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else");
    const evil = (await other.post("/api/developer/keys", { name: "x" })).body.secret;
    expect((await ctx.app.request(`/api/v1/projects/${pid}`, { method: "DELETE", headers: h(evil) })).status).toBe(404);

    const del = await ctx.app.request(`/api/v1/projects/${pid}`, { method: "DELETE", headers: h(rw) });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect((await ctx.app.request(`/api/v1/projects/${pid}`, { headers: h(rw) })).status).toBe(404);
    expect((await ctx.app.request(`/api/v1/tasks/${tid}`, { headers: h(rw) })).status).toBe(404);
    const list = (await (await ctx.app.request("/api/v1/projects", { headers: h(rw) })).json()) as { projects: { id: string }[] };
    expect(list.projects.some((p) => p.id === pid)).toBe(false);
  });
});
