import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

describe("workspace region", () => {
  it("defaults new workspaces to UTC (no fixed zone) and lets admins change it", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup();
    const me = await c.get("/api/account/me");
    expect(me.body.organization).toMatchObject({ timezone: "UTC", country: "US" });
    expect((await c.patch("/api/org", { timezone: "Pacific/Auckland", country: "NZ" })).status).toBe(200);
    expect((await c.get("/api/org")).body.organization).toMatchObject({ timezone: "Pacific/Auckland", country: "NZ" });
    expect((await c.patch("/api/org", { timezone: "Mars/Olympus" })).status).toBe(422);
    expect((await c.patch("/api/org", { country: "XX" })).status).toBe(422);
  });
});
