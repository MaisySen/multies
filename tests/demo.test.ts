import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { purgeDemoWorkspaces } from "@/server/services/demo";

describe("demo mode", () => {
  it("is off unless DEMO_MODE is set — production never seeds", async () => {
    const { app, db } = await makeTestApp();
    expect((await new Client(app).post("/api/account/demo")).status).toBe(404);
    expect(await db.query.messages.findMany()).toHaveLength(0);
  });

  it("creates an isolated sandbox with sample mail, and a dashboard", async () => {
    const { app } = await makeTestApp({ DEMO_MODE: "true" });
    const c = new Client(app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    const me = await c.get("/api/account/me");
    expect(me.body.organization).toMatchObject({ isDemo: true, plan: "pro" });
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

  it("purges expired sandboxes", async () => {
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    await new Client(ctx.app).post("/api/account/demo");
    ctx.deps.now = () => new Date(Date.now() + 25 * 3600_000);
    expect(await purgeDemoWorkspaces(ctx.deps)).toBe(1);
    expect(await ctx.db.query.users.findMany()).toHaveLength(0);
    expect(await ctx.db.query.messages.findMany()).toHaveLength(0);
  });
});
