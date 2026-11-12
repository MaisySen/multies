import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

/**
 * AIS1 review (PR 24): a public form answer waits in Triage until a person accepts it, and it can still be found in
 * task search (GET /api/tasks?q= and GET /api/v1/tasks?q=) the moment it arrives, shown with its Triage state. Plain
 * lists, boards and counts still leave it out, and nobody outside the workspace finds it.
 */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

async function api(key: string, path: string) {
  const res = await ctx.app.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${key}`, host: "localhost" } });
  return { status: res.status, body: await res.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A project with Triage on, a public form for it, and one answer set sent to it; returns the new item id. */
async function formAnswer(subject: string) {
  const project = (await c.post("/api/projects", { name: "Support" })).body.project;
  expect(project.triage).toBe(true);
  const form = (await c.post("/api/forms", { name: "Website enquiry", projectId: project.id, triage: true })).body.form;
  const pub = new Client(ctx.app);
  const r = await pub.post(`/api/public/forms/${form.slug}`, { answers: { name: "Grace Lee", email: "grace@harbourcoffee.com.au", subject, details: "We move in November." }, elapsedMs: 8000 });
  expect(r.status).toBe(200);
  return { id: r.body.created.id as string, projectId: project.id as string };
}

const ids = (list: { id: string }[]) => list.map((t) => t.id);

describe("AIS1 review: Triage items are findable in task search", () => {
  it("a form answer waits in Triage and is found by a search, with its Triage state, but not by a plain list", async () => {
    const { id, projectId } = await formAnswer("Quote for 6 mailboxes");
    const found = (await c.get(`/api/tasks?q=${encodeURIComponent("Quote for 6 mailboxes")}`)).body.tasks;
    expect(ids(found)).toEqual([id]);
    expect(found[0].triage).toMatchObject({ state: "pending", source: "form", from: "grace@harbourcoffee.com.au" });
    // Plain words in the task query language, inside one project, and in page mode find it too.
    expect(ids((await c.get(`/api/tasks?q=mailboxes&projectId=${projectId}`)).body.tasks)).toEqual([id]);
    expect(ids((await c.get("/api/tasks?q=mailboxes&paged=1")).body.tasks)).toEqual([id]);
    // Without a search it stays out of lists, boards and counts, as before.
    expect((await c.get("/api/tasks")).body.tasks).toHaveLength(0);
    expect((await c.get(`/api/tasks?projectId=${projectId}`)).body.tasks).toHaveLength(0);
    expect((await c.get("/api/projects")).body.projects.find((p: { id: string }) => p.id === projectId).counts).toEqual({ todo: 0, doing: 0, done: 0 });
    // A search that doesn't match still finds nothing.
    expect((await c.get("/api/tasks?q=invoice")).body.tasks).toHaveLength(0);
  });

  it("the public API search finds it too, and after a person accepts it the search shows a normal task", async () => {
    const { id } = await formAnswer("Quote for 6 mailboxes");
    const key = (await c.post("/api/developer/keys", { name: "Bot" })).body.secret as string;
    const viaKey = await api(key, `/tasks?q=${encodeURIComponent("Quote for 6 mailboxes")}`);
    expect(viaKey.status).toBe(200);
    expect(ids(viaKey.body.tasks)).toEqual([id]);
    expect(viaKey.body.tasks[0].triage).toMatchObject({ state: "pending", source: "form" });
    expect((await api(key, "/tasks")).body.tasks).toHaveLength(0);

    expect((await c.post(`/api/triage/${id}/accept`, {})).status).toBe(200);
    const after = (await c.get("/api/tasks?q=mailboxes")).body.tasks;
    expect(ids(after)).toEqual([id]);
    expect(after[0].triage).toBeNull();
    expect(ids((await c.get("/api/tasks")).body.tasks)).toEqual([id]);
  });

  it("nobody in another workspace finds it", async () => {
    await formAnswer("Quote for 6 mailboxes");
    const other = new Client(ctx.app);
    await other.signup("someone@globex.io");
    expect((await other.get("/api/tasks?q=mailboxes")).body.tasks).toHaveLength(0);
    expect((await other.get(`/api/tasks?q=${encodeURIComponent("Quote for 6 mailboxes")}`)).body.tasks).toHaveLength(0);
  });
});
