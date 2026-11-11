import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { taskComments, tasks } from "@/server/db/schema";
import { oneLine, TRIAGE_COMMENT_MAX } from "@/server/services/suite/triage-comment-r33";

/** Round 33: accept or decline a Triage item with a one line comment; one Undo takes back both. */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});
async function item(title: string) {
  const project = (await c.post("/api/projects", { name: `Support ${Math.random().toString(36).slice(2, 6)}` })).body.project;
  await c.patch(`/api/projects/${project.id}`, { triage: true });
  const r = await c.post("/api/triage", { title, projectId: project.id, source: "form", from: "grace@harbourcoffee.com.au" });
  expect(r.status).toBe(201);
  return r.body.item.id as string;
}
const commentsOf = (taskId: string) => ctx.deps.db.select().from(taskComments).where(eq(taskComments.taskId, taskId)).all();
const taskRow = (id: string) => ctx.deps.db.select().from(tasks).where(eq(tasks.id, id)).get();

describe("triage accept or decline with a comment", () => {
  it("folds a comment to one line of at most 280 characters", () => {
    expect(oneLine("  Not now,\n\n  maybe   next quarter ")).toBe("Not now, maybe next quarter");
    expect(oneLine("x".repeat(400))).toHaveLength(TRIAGE_COMMENT_MAX);
    expect(oneLine(undefined)).toBe("");
  });
  it("accepts with a comment in one request, and Undo puts it back and removes the comment in one request", async () => {
    const id = await item("Espresso machine leaks");
    const r = await c.post(`/api/triage/${id}/action`, { action: "accept", comment: "Booked the technician\nfor Tuesday" });
    expect(r.status).toBe(200);
    expect(r.body.task.triage).toBeFalsy();
    expect(r.body.comment).toMatchObject({ taskId: id, body: "Booked the technician for Tuesday" });
    expect((await commentsOf(id)).map((x) => x.body)).toEqual(["Booked the technician for Tuesday"]);
    const u = await c.post(`/api/triage/${id}/action`, { action: "restore", commentId: r.body.comment.id });
    expect(u.status).toBe(200);
    expect(u.body.commentRemoved).toBe(true);
    expect((await taskRow(id))?.triageState).toBe("pending");
    expect(await commentsOf(id)).toHaveLength(0);
  });
  it("declines with a comment (it becomes the reason too), and Undo restores the item and removes the comment", async () => {
    const id = await item("Sell us your list");
    const r = await c.post(`/api/triage/${id}/action`, { action: "decline", comment: "Spam" });
    expect(r.status).toBe(200);
    expect(r.body.comment.body).toBe("Spam");
    const row = await taskRow(id);
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.triageReason).toBe("Spam");
    expect(await commentsOf(id)).toHaveLength(1);
    const u = await c.post(`/api/triage/${id}/action`, { action: "restore", commentId: r.body.comment.id });
    expect(u.body.commentRemoved).toBe(true);
    const back = await taskRow(id);
    expect(back?.deletedAt).toBeNull();
    expect(back?.triageState).toBe("pending");
    expect(await commentsOf(id)).toHaveLength(0);
  });
  it("a decline that fails leaves no comment behind; an empty comment is a plain action", async () => {
    const id = await item("Twice");
    expect((await c.post(`/api/triage/${id}/action`, { action: "decline" })).status).toBe(200);
    const again = await c.post(`/api/triage/${id}/action`, { action: "decline", comment: "again" });
    expect(again.status).toBe(404);
    expect(await commentsOf(id)).toHaveLength(0);
    const id2 = await item("Plain");
    const r = await c.post(`/api/triage/${id2}/action`, { action: "accept", comment: "   " });
    expect(r.status).toBe(200);
    expect(r.body.comment).toBeUndefined();
  });
  it("someone else cannot undo your comment away", async () => {
    const id = await item("Mine");
    const r = await c.post(`/api/triage/${id}/action`, { action: "accept", comment: "On it" });
    const invite = await c.post("/api/team/invites", { email: "sam@acme.io", role: "member" });
    const sam = new Client(ctx.app);
    await sam.signup("sam@acme.io", "Sam Mate", "");
    expect((await sam.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    const res = await sam.post(`/api/triage/${id}/action`, { action: "restore", commentId: r.body.comment.id });
    expect(res.status).toBe(403);
    expect(await commentsOf(id)).toHaveLength(1);
    expect((await taskRow(id))?.triageState).not.toBe("pending"); // nothing changed
  });
  it("the API and MCP refuse a key's accept, decline or undo with a comment, and write no comment (AIS1 row 66)", async () => {
    const key = (await c.post("/api/developer/keys", { name: "Agent" })).body.secret as string;
    const id = await item("From the API");
    const res = await ctx.app.request(`/api/v1/tasks/${id}/triage`, { method: "POST", headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ action: "decline", comment: "Duplicate of last week" }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("person_only");
    expect(await commentsOf(id)).toHaveLength(0);
    expect((await taskRow(id))?.triageState).toBe("pending");
    // A person declines with the comment; the key can't undo it.
    const done = await c.post(`/api/triage/${id}/action`, { action: "decline", comment: "Duplicate of last week" });
    const undo = await ctx.app.request(`/api/v1/tasks/${id}/triage`, { method: "POST", headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ action: "restore", commentId: done.body.comment.id }) });
    expect(undo.status).toBe(403);
    expect(await commentsOf(id)).toHaveLength(1);

    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const id2 = await item("From MCP");
    const out = await mcp.callTool({ name: "task_triage_action", arguments: { id: id2, action: "accept", comment: "Agreed" } });
    expect(out.isError).toBe(true);
    expect((out as { content: { text: string }[] }).content[0].text).toMatch(/^person_only: /);
    expect(await commentsOf(id2)).toHaveLength(0);
    await mcp.close();
  });
});
