import { describe, expect, it } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { forgetOrgCache, getOrgCached, getPlanCached, peekOrgCached } from "@/server/services/plans";
import { organizations } from "@/server/db/schema";
import { eq } from "drizzle-orm";

describe("R40 deploy 3: demo workspaces send no invites (MB-220)", () => {
  it("an invite from a demo workspace is refused with a plain message and no mail goes out", async () => {
    const { app, outbound } = await makeTestApp({ DEMO_MODE: "true" });
    const c = new Client(app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    const before = (outbound as unknown as { sent: unknown[] }).sent?.length ?? 0;
    const r = await c.post("/api/team/invites", { email: "someone@example.com", role: "member", mailboxIds: [] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("demo_invites_off");
    expect(r.body.error.message).toBe("Invites are off in the demo. Sign up to invite your team.");
    expect((outbound as unknown as { sent: unknown[] }).sent?.length ?? 0).toBe(before);
  });

  it("system mail tied to a demo workspace never leaves Multies", async () => {
    const { app, deps, outbound } = await makeTestApp({ DEMO_MODE: "true" });
    const c = new Client(app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    const orgId = (await c.get("/api/account/me")).body.organization.id as string;
    const { sendSystemEmail } = await import("@/server/services/system-mail");
    const before = (outbound as unknown as { sent: unknown[] }).sent.length;
    const r = await sendSystemEmail(deps, { to: "victim@example.com", subject: "Hi", text: "Hello", orgId } as never);
    expect(r).toMatchObject({ delivered: false, via: "none" });
    expect((outbound as unknown as { sent: unknown[] }).sent.length).toBe(before);
  });

  it("caps new demos per IP address per day, shared through the database", async () => {
    const { app } = await makeTestApp({ DEMO_MODE: "true", DEMO_PER_IP_DAILY: "2", TRUST_PROXY: "true" });
    const open = (ip: string) => new Client(app).call("POST", "/api/account/demo", {}, { "cf-connecting-ip": ip });
    expect((await open("203.0.113.7")).status).toBe(201);
    expect((await open("203.0.113.7")).status).toBe(201);
    const third = await open("203.0.113.7");
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("demo_limit");
    // Another address is not affected.
    expect((await open("203.0.113.8")).status).toBe(201);
  });
});

describe("R40 deploy 3: short per isolate copy of the workspace row and plan", () => {
  it("serves reads from the copy, drops it on any write through the API, and never caches a missing workspace", async () => {
    const { app, db, deps } = await makeTestApp();
    const c = new Client(app);
    await c.signup();
    const me = await c.get("/api/account/me");
    const orgId = me.body.organization.id as string;
    forgetOrgCache();
    const first = await c.get("/api/org");
    expect(first.status).toBe(200);
    expect(peekOrgCached(orgId)?.id).toBe(orgId);
    // A change made outside the API (another isolate) shows once the copy is dropped or expires.
    await db.update(organizations).set({ name: "Renamed elsewhere" }).where(eq(organizations.id, orgId));
    expect((await c.get("/api/org")).body.organization.name).not.toBe("Renamed elsewhere");
    // A write through the API drops this workspace's copy at once.
    expect((await c.patch("/api/org", { name: "Renamed here" })).status).toBe(200);
    expect((await c.get("/api/org")).body.organization.name).toBe("Renamed here");
    expect((await getPlanCached(deps.db, orgId)).limits).toBeTruthy();
    await expect(getOrgCached(deps.db, "org_missing")).rejects.toMatchObject({ status: 404 });
    expect(peekOrgCached("org_missing")).toBeUndefined();
  });
});
