import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { purgeDemoWorkspaces } from "@/server/services/demo";
import { runDueJobs } from "@/server/services/jobs";

describe("demo mode", () => {
  it("is off unless DEMO_MODE is set, so production never seeds", async () => {
    const { app, db } = await makeTestApp();
    expect((await new Client(app).post("/api/account/demo")).status).toBe(404);
    expect(await db.query.messages.findMany()).toHaveLength(0);
  });

  it("creates an isolated sandbox with sample mail, and a dashboard", async () => {
    const { app } = await makeTestApp({ DEMO_MODE: "true" });
    const c = new Client(app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    const me = await c.get("/api/account/me");
    expect(me.body.organization).toMatchObject({ isDemo: true, plan: "starter" });
    // Two sample agents, one reply sent with approval and two waiting.
    expect((await c.get("/api/agents")).body.agents.map((a: { name: string }) => a.name).sort()).toEqual(["Invoice chaser", "Support triage"]);
    expect((await c.get("/api/approvals?status=pending")).body.approvals).toHaveLength(2);
    expect((await c.get("/api/agents/threads")).body.data.some((t: { lastSentBy: { type: string } }) => t.lastSentBy.type === "agent")).toBe(true);
    const inbox = await c.get("/api/mail/messages?folder=inbox");
    expect(inbox.body.messages.length).toBeGreaterThanOrEqual(6);
    const dash = await c.get("/api/dashboard");
    expect(dash.body.usage).toMatchObject({ domains: 1, mailboxes: 4, aliases: 2 });
    expect(dash.body.series).toHaveLength(14);
    expect(dash.body.series.reduce((n: number, d: { inbound: number }) => n + d.inbound, 0)).toBeGreaterThan(0);
    // A second visitor gets their own sandbox.
    const other = new Client(app);
    await other.post("/api/account/demo");
    expect((await other.get("/api/domains")).body.domains[0].name).not.toBe((await c.get("/api/domains")).body.domains[0].name);
  });

  it("stays small enough for a Worker request and never sends outside MyMail", async () => {
    // Production timed out at more than 100 s: about 640 D1 queries, an RSA key per demo
    // and real provider calls for the sample's outside recipients ran past the CPU limit.
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    const client = (ctx.db as unknown as { $client: { prepare: (q: string) => unknown } }).$client;
    const prepare = client.prepare.bind(client);
    const first = new Client(ctx.app);
    expect((await first.post("/api/account/demo")).status).toBe(201);
    let queries = 0;
    client.prepare = (q: string) => { queries++; return prepare(q); };
    const c = new Client(ctx.app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    expect(queries).toBeLessThan(450);
    expect(ctx.outbound.sent).toHaveLength(0);
    const sent = (await c.get("/api/mail/messages?folder=sent")).body.messages;
    expect(sent.length).toBeGreaterThan(0);
    // Sandbox domains share one stored DKIM key instead of generating one each time.
    const keys = (await ctx.db.query.domains.findMany()).map((d) => d.dkimPublicKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^MII/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("seeds sample tasks, docs, contacts and deals in a background job", async () => {
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    const c = new Client(ctx.app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    await runDueJobs(ctx.deps);
    const projects = (await c.get("/api/projects")).body.projects;
    expect(projects.map((p: { key: string }) => p.key).sort()).toEqual(["BHM", "TSK"]);
    const tasks = (await c.get("/api/tasks")).body.tasks as { title: string; source: unknown; due: string | null }[];
    expect(tasks.length).toBeGreaterThanOrEqual(10);
    expect(tasks.filter((t) => t.source).length).toBe(3);
    expect((await c.get("/api/contacts?q=maria")).body.contacts[0]).toMatchObject({ email: "maria@blueharbor.co", company: { name: "Blueharbor" } });
    expect((await c.get("/api/deals")).body.deals).toHaveLength(4);
    expect((await c.get("/api/docs")).body.docs).toHaveLength(2);
    expect((await c.get("/api/automations")).body.automations).toHaveLength(3);
    // A retry of the job does not seed twice, and finishes a seed that stopped part way.
    await ctx.db.delete((await import("@/server/db/schema")).automations);
    const { enqueue } = await import("@/server/services/jobs");
    const me = (await c.get("/api/account/me")).body;
    await enqueue(ctx.deps, "demo.seed_suite", { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: "Alex Rivera" });
    await runDueJobs(ctx.deps);
    expect((await c.get("/api/projects")).body.projects).toHaveLength(2);
    expect((await c.get("/api/tasks")).body.tasks).toHaveLength(tasks.length);
    expect((await c.get("/api/deals")).body.deals).toHaveLength(4);
    expect((await c.get("/api/automations")).body.automations).toHaveLength(3);
  });

  it("purges expired sandboxes", async () => {
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    await new Client(ctx.app).post("/api/account/demo");
    ctx.deps.now = () => new Date(Date.now() + 25 * 3600_000);
    expect(await purgeDemoWorkspaces(ctx.deps)).toBe(1);
    expect(await ctx.db.query.users.findMany()).toHaveLength(0);
    expect(await ctx.db.query.messages.findMany()).toHaveLength(0);
  });
});
