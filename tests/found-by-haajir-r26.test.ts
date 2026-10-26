import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

/**
 * R26: bugs Haajir found through the API. MB-77: task comments and chat messages can be read back,
 * edited (author only, with an edited mark) and deleted. MB-72: GET /tasks filters by sprint and
 * answers 400 to unknown query parameters instead of silently ignoring them.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let key: string;

async function v1(k: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${k}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@haajir.test", "Olive Owner");
  key = (await owner.post("/api/developer/keys", { name: "Release notes" })).body.secret;
});

async function taskWithComment() {
  const proj = (await v1(key, "POST", "/projects", { name: "MVP build", key: "MVP" })).body.project;
  const task = (await v1(key, "POST", "/tasks", { projectId: proj.id, title: "Quick register" })).body.task;
  const comment = (await v1(key, "POST", `/tasks/${task.id}/comments`, { body: "Shipped with 216 unit tests." })).body.comment;
  return { proj, task, comment };
}

describe("MB-77: task comments read back, edit and delete", () => {
  it("lists a task's comments, by id or by reference, and edits one with an edited mark", async () => {
    const { task, comment } = await taskWithComment();
    const list = await v1(key, "GET", `/tasks/${task.id}/comments`);
    expect(list.status).toBe(200);
    expect(list.body.comments).toHaveLength(1);
    expect(list.body.comments[0]).toMatchObject({ id: comment.id, body: "Shipped with 216 unit tests.", editedAt: null });
    expect((await v1(key, "GET", `/tasks/${task.ref}/comments`)).body.comments).toHaveLength(1);

    const fixed = await v1(key, "PATCH", `/comments/${comment.id}`, { body: "Shipped with 214 unit tests." });
    expect(fixed.status).toBe(200);
    expect(fixed.body.comment.body).toBe("Shipped with 214 unit tests.");
    expect(fixed.body.comment.editedAt).toEqual(expect.any(String));
    const one = await v1(key, "GET", `/comments/${comment.id}`);
    expect(one.body.comment).toMatchObject({ body: "Shipped with 214 unit tests.", editedAt: expect.any(String) });
    // The app's task detail shows the edit too.
    const detail = await owner.get(`/api/tasks/${task.id}`);
    expect(JSON.stringify(detail.body)).toContain("214 unit tests");
  });

  it("only the author edits; an admin can delete; empty bodies are refused", async () => {
    const { task, comment } = await taskWithComment();
    const agent = (await owner.post("/api/team/agents", { name: "QA" })).body;
    expect((await v1(agent.secret, "PATCH", `/comments/${comment.id}`, { body: "hijack" })).status).toBe(403);
    expect((await v1(agent.secret, "DELETE", `/comments/${comment.id}`)).status).toBe(403);
    const mine = (await v1(agent.secret, "POST", `/tasks/${task.id}/comments`, { body: "QA passed" })).body.comment;
    expect((await v1(agent.secret, "PATCH", `/comments/${mine.id}`, { body: "QA passed on 1e45d52" })).status).toBe(200);
    expect((await v1(key, "PATCH", `/comments/${comment.id}`, { body: "   " })).status).toBe(422);
    // The owner's key may delete anyone's comment.
    expect((await v1(key, "DELETE", `/comments/${mine.id}`)).status).toBe(200);
    expect((await v1(key, "GET", `/comments/${mine.id}`)).status).toBe(404);
    expect((await v1(key, "GET", `/tasks/${task.id}/comments`)).body.comments.map((c: { id: string }) => c.id)).toEqual([comment.id]);
  });

  it("read only keys can read but not edit; another workspace gets 404", async () => {
    const { task, comment } = await taskWithComment();
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    expect((await v1(ro, "GET", `/tasks/${task.id}/comments`)).status).toBe(200);
    const r = await v1(ro, "PATCH", `/comments/${comment.id}`, { body: "x" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("read_only_key");
    const other = new Client(ctx.app);
    await other.signup("other@else.test", "Other Owner");
    const otherKey = (await other.post("/api/developer/keys", { name: "Other" })).body.secret;
    expect((await v1(otherKey, "GET", `/tasks/${task.id}/comments`)).status).toBe(404);
    expect((await v1(otherKey, "GET", `/comments/${comment.id}`)).status).toBe(404);
    expect((await v1(otherKey, "PATCH", `/comments/${comment.id}`, { body: "x" })).status).toBe(404);
    expect((await v1(otherKey, "DELETE", `/comments/${comment.id}`)).status).toBe(404);
  });
});

describe("MB-77: chat messages read back, edit and delete", () => {
  async function post(body: string, k = key) {
    const ch = (await v1(key, "POST", "/chat/channels", { name: "releases" })).body;
    const channelId = ch.channel?.id ?? ch.id;
    return { channelId, message: (await v1(k, "POST", `/chat/channels/${channelId}/messages`, { body })).body.message };
  }

  it("reads one message back and edits it with an edited mark", async () => {
    const { channelId, message } = await post("Release 1e45d52: 216 unit tests.");
    const one = await v1(key, "GET", `/chat/messages/${message.id}`);
    expect(one.status).toBe(200);
    expect(one.body.message.body).toContain("216");
    expect(one.body.channel.id).toBe(channelId);
    const fixed = await v1(key, "PATCH", `/chat/messages/${message.id}`, { body: "Release 1e45d52: 214 unit tests." });
    expect(fixed.status).toBe(200);
    expect(fixed.body.message.editedAt).toEqual(expect.any(String));
    const read = await v1(key, "GET", `/chat/channels/${channelId}/messages`);
    expect(read.body.messages.find((m: { id: string }) => m.id === message.id).body).toBe("Release 1e45d52: 214 unit tests.");
  });

  it("only the author edits, an admin key deletes, read only and other workspaces are refused", async () => {
    const agent = (await owner.post("/api/team/agents", { name: "Builder" })).body;
    const { message } = await post("Build is green", agent.secret);
    expect((await v1(key, "PATCH", `/chat/messages/${message.id}`, { body: "edited by someone else" })).status).toBe(403);
    expect((await v1(agent.secret, "PATCH", `/chat/messages/${message.id}`, { body: "Build 42 is green" })).status).toBe(200);
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    expect((await v1(ro, "GET", `/chat/messages/${message.id}`)).status).toBe(200);
    expect((await v1(ro, "DELETE", `/chat/messages/${message.id}`)).status).toBe(403);
    const other = new Client(ctx.app);
    await other.signup("other@else.test", "Other Owner");
    const otherKey = (await other.post("/api/developer/keys", { name: "Other" })).body.secret;
    expect((await v1(otherKey, "GET", `/chat/messages/${message.id}`)).status).toBe(404);
    expect((await v1(otherKey, "PATCH", `/chat/messages/${message.id}`, { body: "x" })).status).toBe(404);
    expect((await v1(key, "DELETE", `/chat/messages/${message.id}`)).status).toBe(200);
    expect((await v1(key, "GET", `/chat/messages/${message.id}`)).body.message.deletedAt ?? (await v1(key, "GET", `/chat/messages/${message.id}`)).body.message.deleted).toBeTruthy();
  });
});

describe("MB-72: sprint filter and strict query parameters on GET /tasks", () => {
  it("sprintId lists one sprint, none the backlog, and an unknown parameter answers 400", async () => {
    const proj = (await v1(key, "POST", "/projects", { name: "MVP build", key: "MVP" })).body.project;
    const sprint = (await v1(key, "POST", `/projects/${proj.id}/sprints`, { name: "Sprint 2" })).body.sprint;
    const inSprint = (await v1(key, "POST", "/tasks", { projectId: proj.id, title: "Push", sprintId: sprint.id })).body.task;
    const backlog = (await v1(key, "POST", "/tasks", { projectId: proj.id, title: "Android" })).body.task;
    const s = await v1(key, "GET", `/tasks?projectId=${proj.id}&sprintId=${sprint.id}`);
    expect(s.status).toBe(200);
    expect(s.body.tasks.map((t: { id: string }) => t.id)).toEqual([inSprint.id]);
    const b = await v1(key, "GET", `/tasks?projectId=${proj.id}&sprintId=none`);
    expect(b.body.tasks.map((t: { id: string }) => t.id)).toEqual([backlog.id]);
    const nested = await v1(key, "GET", `/projects/${proj.id}/tasks?sprintId=${sprint.id}`);
    expect(nested.body.tasks.map((t: { id: string }) => t.id)).toEqual([inSprint.id]);
    const bad = await v1(key, "GET", `/tasks?projectId=${proj.id}&sprint=${sprint.id}`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("unknown_parameter");
    expect(bad.body.error.message).toContain("sprint");
    expect((await v1(key, "GET", `/projects/${proj.id}/tasks?projectId=x`)).status).toBe(400);
    // Custom field filters are still allowed.
    expect((await v1(key, "GET", `/tasks?field.fld_x=gt:1`)).status).not.toBe(400);
  });
});
