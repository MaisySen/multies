import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { users } from "@/server/db/schema";

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
});
