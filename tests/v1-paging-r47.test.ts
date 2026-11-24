import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

/** R47: cursor paging on the public GET /api/v1/tasks and /api/v1/projects/{id}/tasks. */
describe("public task list paging", () => {
  it("walks every task page by page with next, then next is null", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    // AIS1: a key's task waits in Triage when the project uses it (new projects do); this project has it off and the
    // calls name it (Round 2: a key's task that names no project always waits).
    const projectId = (await c.post("/api/projects", { name: "Work", triage: false })).body.project.id as string;
    const key = (await c.post("/api/developer/keys", { name: "rw" })).body.secret as string;
    const h = { host: "localhost", authorization: `Bearer ${key}` };
    const made: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await ctx.app.request("/api/v1/tasks", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ title: `Task ${i}`, projectId }) });
      expect(r.status).toBe(201);
      made.push(((await r.json()) as { task: { id: string } }).task.id);
    }
    const seen: string[] = [];
    let url = "/api/v1/tasks?limit=3";
    let pages = 0;
    for (;;) {
      const r = await ctx.app.request(url, { headers: h });
      expect(r.status).toBe(200);
      const b = (await r.json()) as { tasks: { id: string }[]; next: string | null; changeCursor?: number };
      expect(b.changeCursor).toBeUndefined();
      pages++;
      seen.push(...b.tasks.map((t) => t.id));
      if (!b.next) break;
      expect(b.tasks).toHaveLength(3);
      url = `/api/v1/tasks?limit=3&cursor=${encodeURIComponent(b.next)}`;
    }
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort()).toEqual([...made].sort());
    // Without a cursor and with room for all: one page, next null (the old answer plus next).
    const all = (await (await ctx.app.request("/api/v1/tasks", { headers: h })).json()) as { tasks: unknown[]; next: string | null };
    expect(all.tasks).toHaveLength(7);
    expect(all.next).toBeNull();
    // The nested path pages the same way.
    const listed = (await (await ctx.app.request("/api/v1/tasks?limit=1", { headers: h })).json() as { tasks: { projectId: string }[] }).tasks[0].projectId;
    expect(listed).toBe(projectId);
    const p1 = (await (await ctx.app.request(`/api/v1/projects/${listed}/tasks?limit=4`, { headers: h })).json()) as { tasks: unknown[]; next: string | null };
    expect(p1.tasks).toHaveLength(4);
    expect(p1.next).toBeTruthy();
    const p2 = (await (await ctx.app.request(`/api/v1/projects/${listed}/tasks?limit=4&cursor=${encodeURIComponent(p1.next!)}`, { headers: h })).json()) as { tasks: unknown[]; next: string | null };
    expect(p2.tasks).toHaveLength(3);
    expect(p2.next).toBeNull();
    // A made up cursor and an unknown parameter are refused.
    expect((await ctx.app.request("/api/v1/tasks?cursor=nonsense", { headers: h })).status).toBe(400);
    expect((await ctx.app.request("/api/v1/tasks?page=2", { headers: h })).status).toBe(400);
  });

  it("documents cursor and next in the API description", async () => {
    const ctx = await makeTestApp();
    const spec = (await (await ctx.app.request("/api/v1/openapi.json", { headers: { host: "localhost" } })).json()) as { paths: Record<string, { get?: { parameters?: { name: string }[]; description?: string } }> };
    const get = spec.paths["/tasks"].get!;
    expect(get.parameters!.map((p) => p.name)).toContain("cursor");
    expect(get.description).toContain("Paging (R47)");
    expect(spec.paths["/projects/{id}/tasks"].get!.parameters!.map((p) => p.name)).toContain("cursor");
  });
});
