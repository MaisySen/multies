import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { meter } from "./d1-meter";

/** R33: rows written per action, table by table (docs/runbooks/d1-daily-limits.md, R33 table). */
describe("R33 measure", () => {
  it("prints per action rows by table", async () => {
    const ctx = await makeTestApp();
    const u = new Client(ctx.app);
    await u.signup("owner@acme.test", "Olive Owner");
    const me = (await u.get("/api/account/me")).body;
    const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
    const projectId = (await u.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
    const p2 = (await u.post("/api/projects", { name: "Other", key: "OTH" })).body.project.id;
    const { createTask, updateTask } = await import("@/server/services/suite/tasks");
    await createTask(ctx.deps, actor, { title: "Warm", projectId });
    const take = meter(ctx.db);
    const out: Record<string, unknown> = {};
    const t = await createTask(ctx.deps, actor, { title: "Ship it", projectId });
    out.create = [take.byTable(), take()];
    await updateTask(ctx.deps, actor, t.id, { status: "in_progress" } as never);
    out.status = [take.byTable(), take()];
    await updateTask(ctx.deps, actor, t.id, { title: "Ship it now" } as never);
    out.title = [take.byTable(), take()];
    await updateTask(ctx.deps, actor, t.id, { projectId: p2 } as never);
    out.move = [take.byTable(), take()];
    const r = await u.post(`/api/tasks/${t.id}/comments`, { body: "hi there" });
    out.comment = [r.status, take.byTable(), take()];
    const a = await createTask(ctx.deps, actor, { title: "A", projectId });
    const b = await createTask(ctx.deps, actor, { title: "B", projectId });
    take();
    const bm = await u.post(`/api/tasks/bulk`, { ids: [a.id, b.id], patch: { projectId: p2 } });
    out.bulk = [bm.status, JSON.stringify(bm.body).slice(0, 200), take.byTable(), take()];
    const { createDoc, updateDoc } = await import("@/server/services/suite/docs");
    const { postMessage } = await import("@/server/services/suite/chat");
    const d = await createDoc(ctx.deps, actor, { title: "Doc", text: "a" });
    const g = ((await u.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    await postMessage(ctx.deps, actor, g.id, { body: "warm" });
    take();
    await updateDoc(ctx.deps, actor, d.id, { text: "hello world" });
    out.docSave = [take.byTable(), take()];
    await createDoc(ctx.deps, actor, { title: "Doc2", text: "b" });
    out.docCreate = [take.byTable(), take()];
    await postMessage(ctx.deps, actor, g.id, { body: "hello" });
    out.chat = [take.byTable(), take()];
    console.log("R33MEASURE " + JSON.stringify(out));
    const total = (k: string) => { const v = out[k] as unknown[]; return v[v.length - 1]; };
    expect([total("create"), total("title"), total("move"), total("docSave")]).toEqual([16, 7, 19, 6]); // T1F (0138): create +1, the newest first search index entry. // R49 (0087/0088): a create joins its project status bucket (+4 on this meter), a move leaves one bucket and joins another (+8). // R40 (0082): a create adds 2 entries to the two task list indexes. R34: a move keeps the old ref (1 entity_links row and its 2 index entries)
  });
});
