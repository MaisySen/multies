import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { users } from "@/server/db/schema";
import { enqueue, runDueJobs } from "@/server/services/jobs";
import { recordAbuse } from "@/server/services/abuse";

describe("operator console", () => {
  it("is for platform admins only, and lists every workspace", async () => {
    const ctx = await makeTestApp();
    const a = new Client(ctx.app);
    await a.signup("ops@acme.io");
    await new Client(ctx.app).signup("customer@else.io", "Cus Tomer", "Else Inc");
    expect((await a.get("/api/admin/overview")).status).toBe(403);
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    const r = await a.get("/api/admin/overview");
    expect(r.status).toBe(200);
    expect(r.body.totals).toMatchObject({ users: 2, workspaces: 2 });
    expect(r.body.tenants.map((t: { name: string }) => t.name).sort()).toEqual(["Acme", "Else Inc"]);
    expect((await a.get("/api/account/me")).body.user.platformAdmin).toBe(true);
  });

  it("promotes listed user ids, and listed emails only once verified", async () => {
    const ctx = await makeTestApp({ PLATFORM_ADMIN_EMAILS: "boss@acme.io" });
    const a = new Client(ctx.app);
    await a.signup("boss@acme.io");
    expect((await a.get("/api/account/me")).body.user.platformAdmin).toBe(false);
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "boss@acme.io"));
    expect((await a.get("/api/account/me")).body.user.platformAdmin).toBe(true);

    const ctx2 = await makeTestApp();
    const b = new Client(ctx2.app);
    await b.signup("someone@acme.io");
    const id = (await b.get("/api/account/me")).body.user.id;
    ctx2.deps.config.platformAdmins.push(id.toLowerCase());
    expect((await b.get("/api/account/me")).body.user.platformAdmin).toBe(true);
  });

  it("sends a Sentry test event when error tracking is configured", async () => {
    const ctx = await makeTestApp({ SENTRY_DSN_API: "https://key@o1.ingest.sentry.io/1" });
    const reported: unknown[] = [];
    ctx.deps.reportError = (err) => { reported.push(err); return "evt_123"; };
    const a = new Client(ctx.app);
    await a.signup("ops@acme.io");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    expect((await a.post("/api/admin/sentry-test")).body).toEqual({ configured: true, eventId: "evt_123" });
    expect(String(reported[0])).toContain("MyMail API test event");
  });

  it("suspends, caps and restores a workspace, with every action audited", async () => {
    const ctx = await makeTestApp();
    const ops = new Client(ctx.app);
    await ops.signup("ops@acme.io");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    const cus = new Client(ctx.app);
    await cus.signup("customer@else.io", "Cus Tomer", "Else Inc");
    const orgId = (await cus.get("/api/account/me")).body.organization.id;
    await recordAbuse(ctx.deps, orgId, "message_held", 12, "Spam score 12");

    const abuse = await ops.get("/api/admin/abuse");
    expect(abuse.body.events[0]).toMatchObject({ workspace: "Else Inc", kind: "message_held", score: 12 });
    expect((await cus.get("/api/admin/abuse")).status).toBe(403);

    expect((await ops.post(`/api/admin/workspaces/${orgId}/suspend`, { reason: "" })).status).toBe(422);
    expect((await ops.post(`/api/admin/workspaces/${orgId}/suspend`, { reason: "Phishing reports" })).status).toBe(200);
    expect((await ops.put(`/api/admin/workspaces/${orgId}/send-cap`, { cap: 10 })).body.sendCapDaily).toBe(10);
    const tenant = (await ops.get("/api/admin/overview")).body.tenants.find((t: { id: string }) => t.id === orgId);
    expect(tenant).toMatchObject({ suspendedReason: "Phishing reports", sendCapDaily: 10 });

    expect((await ops.post(`/api/admin/workspaces/${orgId}/unsuspend`)).status).toBe(200);
    expect((await ops.get("/api/admin/abuse")).body.events).toHaveLength(0);
    const audit = (await cus.get("/api/org/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["workspace.suspended", "workspace.send_cap_changed", "workspace.unsuspended"]));
  });

  it("shows dead jobs and replays them", async () => {
    const ctx = await makeTestApp();
    const ops = new Client(ctx.app);
    await ops.signup("ops@acme.io");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    await enqueue(ctx.deps, "test.unknown" as never, {}, { maxAttempts: 1 });
    await runDueJobs(ctx.deps, 10);
    const jobs = await ops.get("/api/admin/jobs");
    expect(jobs.body.dead).toHaveLength(1);
    expect((await ops.post("/api/admin/jobs/replay", { ids: [jobs.body.dead[0].id] })).body.replayed).toBe(1);
    expect((await ops.get("/api/admin/jobs")).body.dead).toHaveLength(0);
  });
});
