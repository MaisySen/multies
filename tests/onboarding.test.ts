import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

describe("onboarding checklist", () => {
  it("tracks setup steps and can be hidden", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup();
    let d = (await c.get("/api/dashboard")).body;
    expect(d.onboarding).toEqual({ dismissed: false, steps: { domainAdded: false, domainVerified: false, mailboxCreated: false, inboundConnected: false, firstSend: false, teamInvited: false } });
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    await c.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" });
    await c.post("/api/team/invites", { email: "max@acme.io", role: "member" });
    d = (await c.get("/api/dashboard")).body;
    expect(d.onboarding.steps).toMatchObject({ domainAdded: true, mailboxCreated: true, teamInvited: true, domainVerified: false });
    expect((await c.post("/api/dashboard/onboarding/dismiss", {})).status).toBe(200);
    expect((await c.get("/api/dashboard")).body.onboarding.dismissed).toBe(true);
  });
});
