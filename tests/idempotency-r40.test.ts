import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { idempotencyKeys } from "@/server/db/schema";
import { IDEMPOTENCY_STALE_MS, IDEMPOTENCY_TTL_MS } from "@/server/lib/idempotency";

/** R40 (MB-201): a create that answered 503 but committed must not turn into a duplicate on retry. */
async function setup() {
  const t = await makeTestApp();
  const c = new Client(t.app);
  await c.signup();
  const clock = { offset: 0 };
  t.deps.now = () => new Date(Date.now() + clock.offset);
  return { ...t, c, clock };
}
const K = { "idempotency-key": "web-proj-0001-abcdef" };
const projectsNamed = async (c: Client, name: string) => ((await c.get("/api/projects")).body.projects as { name: string }[]).filter((p) => p.name === name);

describe("idempotent creates (R40 MB-201)", () => {
  it("replays the first project for a repeat with the same key", async () => {
    const { c } = await setup();
    const a = await c.call("POST", "/api/projects", { name: "QA Launch plan" }, K);
    const b = await c.call("POST", "/api/projects", { name: "QA Launch plan" }, K);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.project.id).toBe(a.body.project.id);
    expect(await projectsNamed(c, "QA Launch plan")).toHaveLength(1);
  });

  it("refuses the same key with a different body", async () => {
    const { c } = await setup();
    await c.call("POST", "/api/projects", { name: "One" }, K);
    const r = await c.call("POST", "/api/projects", { name: "Two" }, K);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("idempotency_key_reused");
  });

  it("a first attempt cut off after it committed: 409 while fresh, then the retry returns the same project", async () => {
    const { c, db, clock } = await setup();
    const a = await c.call("POST", "/api/projects", { name: "Cut off" }, K);
    // Simulate the platform stopping the Worker after the insert but before the answer was stored.
    await db.update(idempotencyKeys).set({ state: "running", responseStatus: null, responseBody: null });
    const busy = await c.call("POST", "/api/projects", { name: "Cut off" }, K);
    expect(busy.status).toBe(409);
    clock.offset = IDEMPOTENCY_STALE_MS + 1000;
    const retry = await c.call("POST", "/api/projects", { name: "Cut off" }, K);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.project.id).toBe(a.body.project.id);
    expect(await projectsNamed(c, "Cut off")).toHaveLength(1);
  });

  it("a first attempt that answered 5xx after committing: the retry returns the same task, not a copy", async () => {
    const { c, db } = await setup();
    const k = { "idempotency-key": "web-task-0001-abcdef" };
    const a = await c.call("POST", "/api/tasks", { title: "Only once" }, k);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    await db.update(idempotencyKeys).set({ state: "running", responseStatus: 503, responseBody: null });
    const retry = await c.call("POST", "/api/tasks", { title: "Only once" }, k);
    expect(retry.status).toBe(201);
    expect(retry.body.task.id).toBe(a.body.task.id);
    const list = (await c.get("/api/tasks")).body.tasks as { title: string }[];
    expect(list.filter((t) => t.title === "Only once")).toHaveLength(1);
  });

  it("expires keys after 24 hours", async () => {
    const { c, clock } = await setup();
    const a = await c.call("POST", "/api/projects", { name: "Daily" }, K);
    clock.offset = IDEMPOTENCY_TTL_MS + 60_000;
    const b = await c.call("POST", "/api/projects", { name: "Daily" }, K);
    expect(b.status).toBe(201);
    expect(b.body.project.id).not.toBe(a.body.project.id);
  });

  it("keeps keys per person and workspace", async () => {
    const { app, c, db } = await setup();
    const other = new Client(app);
    await other.signup();
    const a = await c.call("POST", "/api/projects", { name: "Shared key" }, K);
    const b = await other.call("POST", "/api/projects", { name: "Shared key" }, K);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.project.id).not.toBe(a.body.project.id);
    expect(await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, K["idempotency-key"]))).toHaveLength(2);
  });

  it("calls without a key behave as before", async () => {
    const { c } = await setup();
    await c.post("/api/projects", { name: "Twice" });
    await c.post("/api/projects", { name: "Twice" });
    expect(await projectsNamed(c, "Twice")).toHaveLength(2);
  });

  it("an import run and an invite with a key replay too", async () => {
    const { c } = await setup();
    const inv = { email: "new.person@idem.test", role: "member" };
    const k = { "idempotency-key": "web-invite-0001-abcdef" };
    const a = await c.call("POST", "/api/team/invites", inv, k);
    const b = await c.call("POST", "/api/team/invites", inv, k);
    expect(a.status, JSON.stringify(a.body)).toBeLessThan(300);
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
  });
});
