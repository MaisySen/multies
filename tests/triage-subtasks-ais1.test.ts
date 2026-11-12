import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { tasks } from "@/server/db/schema";

/**
 * AIS1 review (rows 35 and 66): a key's or an AI app's subtasks wait in Triage with their parent (a copy, a template, an
 * import). A Triage decision on the parent takes its subtasks with it: accept brings them in, decline and merge remove
 * them, and Undo puts them back the way they were. Before the fix the decisions changed only the parent's row, so the
 * subtasks stayed in the queue, or stayed pending under a deleted task.
 */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

async function mcpWith(token: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchViaApp }));
  return client;
}
const key = async () => (await c.post("/api/developer/keys", { name: "Bot" })).body.secret as string;
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const kidsOf = (id: string) => ctx.deps.db.select().from(tasks).where(eq(tasks.parentId, id)).all();
const count = async () => (await c.get("/api/triage/count")).body.count as number;

async function copyWithSubtasks() {
  const p = (await c.post("/api/projects", { name: "Launch" })).body.project.id as string;
  const parent = (await c.post("/api/tasks", { title: "Open the shop", projectId: p })).body.task;
  for (const title of ["Get the keys", "Stock the shelves"]) await c.post("/api/tasks", { title, projectId: p, parentId: parent.id });
  const m = await mcpWith(await key());
  const copy = data(await m.callTool({ name: "duplicate_task", arguments: { taskId: parent.id, subtasks: true } }));
  await m.close();
  const copied = (copy.task ?? copy) as { id: string; triage: unknown };
  expect(copied.triage).toMatchObject({ state: "pending" });
  return { p, copyId: copied.id };
}

describe("AIS1 review: a Triage decision on a key's task takes its subtasks with it", () => {
  it("accepting the copied parent brings its subtasks in too", async () => {
    const { p, copyId } = await copyWithSubtasks();
    expect(await count()).toBe(3); // the parent and both subtasks wait
    expect((await c.post(`/api/triage/${copyId}/accept`, {})).status).toBe(200);
    expect(await count()).toBe(0);
    const kids = await kidsOf(copyId);
    expect(kids.map((k) => [k.title, k.triageState, !!k.deletedAt]).sort()).toEqual([["Get the keys", null, false], ["Stock the shelves", null, false]]);
    const board = (await c.get(`/api/tasks?projectId=${p}&includeSubtasks=true`)).body.tasks as { title: string }[];
    expect(board.filter((t) => t.title === "Get the keys")).toHaveLength(2); // the original's and the copy's
  });

  it("declining the copied parent removes its subtasks with it", async () => {
    const { copyId } = await copyWithSubtasks();
    expect((await c.post(`/api/triage/${copyId}/decline`, {})).status).toBe(200);
    const kids = await kidsOf(copyId);
    expect(kids).toHaveLength(2);
    expect(kids.filter((k) => k.triageState === "pending" && !k.deletedAt)).toHaveLength(0);
    expect(kids.every((k) => !!k.deletedAt)).toBe(true);
    expect(await count()).toBe(0);
  });

  it("Undo of a decline brings the subtasks back waiting; Undo of an accept puts them back in the queue", async () => {
    const { copyId } = await copyWithSubtasks();
    expect((await c.post(`/api/triage/${copyId}/action`, { action: "decline" })).status).toBe(200);
    expect((await c.post(`/api/triage/${copyId}/action`, { action: "restore" })).status).toBe(200);
    let kids = await kidsOf(copyId);
    expect(kids.map((k) => [k.triageState, !!k.deletedAt])).toEqual([["pending", false], ["pending", false]]);
    expect(await count()).toBe(3);

    expect((await c.post(`/api/triage/${copyId}/action`, { action: "accept" })).status).toBe(200);
    expect(await count()).toBe(0);
    expect((await c.post(`/api/triage/${copyId}/action`, { action: "restore" })).status).toBe(200);
    kids = await kidsOf(copyId);
    expect(kids.map((k) => k.triageState)).toEqual(["pending", "pending"]);
    expect(await count()).toBe(3);
  });

  it("merging the copied parent removes its subtasks, and a subtask deleted before stays deleted after Undo", async () => {
    const { p, copyId } = await copyWithSubtasks();
    const target = (await c.post("/api/tasks", { title: "Shop opening", projectId: p })).body.task;
    const [first] = await kidsOf(copyId);
    expect((await c.del(`/api/tasks/${first.id}`)).status).toBe(200); // a person removes one subtask first
    expect((await c.post(`/api/triage/${copyId}/merge`, { targetId: target.id })).status).toBe(200);
    expect((await kidsOf(copyId)).every((k) => !!k.deletedAt)).toBe(true);
    expect(await count()).toBe(0);
    expect((await c.post(`/api/triage/${copyId}/action`, { action: "restore" })).status).toBe(200);
    const kids = await kidsOf(copyId);
    expect(kids.find((k) => k.id === first.id)?.deletedAt).toBeTruthy();
    expect(kids.filter((k) => !k.deletedAt).map((k) => k.triageState)).toEqual(["pending"]);
  });

  it("a task template with subtasks used by an AI app: accepting the task brings its subtasks", async () => {
    const p = (await c.post("/api/projects", { name: "Support" })).body.project.id as string;
    const m = await mcpWith(await key());
    const tpl = data(await m.callTool({ name: "create_template", arguments: { kind: "task", name: "Callback", data: { title: "Call the customer back", subtasks: ["Find the number", "Write notes"] } } }));
    const used = data(await m.callTool({ name: "use_template", arguments: { templateId: tpl.template.id, projectId: p } }));
    await m.close();
    expect(used.task.triage).toMatchObject({ state: "pending" });
    expect(await count()).toBe(3);
    expect((await c.post(`/api/triage/${used.task.id}/accept`, {})).status).toBe(200);
    expect(await count()).toBe(0);
    expect((await kidsOf(used.task.id)).map((k) => k.triageState)).toEqual([null, null]);
  });

  it("bulk deciding the parent and its subtasks together reports every one done", async () => {
    const { copyId } = await copyWithSubtasks();
    const ids = [copyId, ...(await kidsOf(copyId)).map((k) => k.id)];
    const r = await c.post("/api/triage/bulk", { ids, action: "accept" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ done: 3, failed: 0 });
    expect(await count()).toBe(0);

    // A bulk accept's options reach every item it names, a subtask after its parent included; one it doesn't name
    // comes in with its parent unchanged.
    const opts = await copyWithSubtasks();
    const [named, unnamed] = await kidsOf(opts.copyId);
    const o = await c.post("/api/triage/bulk", { ids: [opts.copyId, named.id], action: "accept", accept: { priority: "high" } });
    expect(o.body).toMatchObject({ done: 2, failed: 0 });
    const after = new Map((await kidsOf(opts.copyId)).map((k) => [k.id, k]));
    expect([after.get(named.id)?.priority, after.get(named.id)?.triageState]).toEqual(["high", null]);
    expect([after.get(unnamed.id)?.priority, after.get(unnamed.id)?.triageState]).toEqual(["none", null]);

    const second = await copyWithSubtasks();
    const ids2 = [second.copyId, ...(await kidsOf(second.copyId)).map((k) => k.id)];
    const d = await c.post("/api/triage/bulk", { ids: ids2, action: "decline" });
    expect(d.body).toMatchObject({ done: 3, failed: 0 });
    expect((await kidsOf(second.copyId)).every((k) => !!k.deletedAt)).toBe(true);
  });
});
