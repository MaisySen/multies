/**
 * OPS1 security review (info items): replaying every dead job and changing the phone app's remote config need a
 * recent sign in, like the console's other wide reaching changes.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { signUpAs } from "./console-kit";
import { makeTestApp } from "./helpers";
import { sessions } from "@/server/db/schema";
import { clearAuthCache } from "@/server/auth/guards";
import { consoleRoutes } from "@/server/routes/console";

describe("step up on replay-all and the mobile config", () => {
  it("the routes carry stepUp", () => {
    const guards = new Map<string, boolean>();
    for (const r of consoleRoutes().routes) {
      const h = r.handler as unknown as { permission?: string; stepUp?: boolean };
      if (h.permission) guards.set(`${r.method} ${r.path}`, !!h.stepUp);
    }
    expect(guards.get("POST /api/console/jobs/replay-all")).toBe(true);
    expect(guards.get("PUT /api/console/mobile")).toBe(true);
  });

  it("a stale session is asked to sign in again; a fresh one goes through", async () => {
    const ctx = await makeTestApp();
    const op = await signUpAs(ctx, "ops@ops.test", "ops_admin", "Ops");
    expect((await op.c.post("/api/console/jobs/replay-all", { reason: "Provider is back" })).status).toBe(200);
    expect((await op.c.put("/api/console/mobile", { patch: { message: "Hello" }, reason: "Ship the banner" })).status).toBe(200);
    await ctx.db.update(sessions).set({ createdAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(sessions.userId, op.id));
    clearAuthCache();
    for (const r of [await op.c.post("/api/console/jobs/replay-all", { reason: "Provider is back" }), await op.c.put("/api/console/mobile", { patch: { message: "Hi" }, reason: "Ship the banner" })]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("step_up_required");
    }
  }, 60_000);
});
