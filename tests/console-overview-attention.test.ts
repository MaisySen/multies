/**
 * OPS1 polish: GET /api/console/overview answers the whole Overview in one request: the attention list (each item
 * with its count and the already filtered page), the totals and the five newest customer workspaces with owners. A
 * quiet deployment has an empty attention list (the page shows "All clear"). Non-operators get 403.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import { signUpAs } from "./console-kit";
import { contentReports, organizations } from "@/server/db/schema";
import { recordAbuse } from "@/server/services/abuse";
import { enqueue, runDueJobs } from "@/server/services/jobs";

describe("console overview", () => {
  it("lists what needs attention with links to the filtered pages, the totals and the newest workspaces", async () => {
    const ctx = await makeTestApp();
    const { c: ops } = await signUpAs(ctx, "ops@acme.test", "admin", "Acme Ops");
    const { c: cus, id: cusId } = await signUpAs(ctx, "owner@else.test", null, "Else Inc");
    const { id: otherId } = await signUpAs(ctx, "other@else.test", null, "Other Co");
    const orgId = (await cus.get("/api/account/me")).body.organization.id as string;

    const quiet = await ops.get("/api/console/overview");
    expect(quiet.status).toBe(200);
    expect(quiet.body.attention).toEqual([]);
    expect(quiet.body).not.toHaveProperty("tenants");
    expect(quiet.body).not.toHaveProperty("integrations");

    await ctx.db.insert(contentReports).values({ id: "rpt_ov", reporterUserId: cusId, orgId, targetType: "user", targetUserId: otherId, reason: "spam" });
    await recordAbuse(ctx.deps, orgId, "message_held", 12, "Spam score 12");
    await enqueue(ctx.deps, "test.unknown" as never, {}, { maxAttempts: 1 });
    await runDueJobs(ctx.deps, 10);
    await ctx.db.update(organizations).set({ pastDueSince: new Date(), suspendedAt: new Date(), suspendedReason: "Review" }).where(eq(organizations.id, orgId));

    const r = await ops.get("/api/console/overview");
    expect(r.status).toBe(200);
    const by = Object.fromEntries((r.body.attention as { id: string; count: number; to: string; tone: string }[]).map((i) => [i.id, i]));
    expect(by.reports).toMatchObject({ count: 1, tone: "bad", to: "/console/moderation" });
    expect(by.abuse).toMatchObject({ count: 1, to: "/console/moderation?tab=abuse" });
    expect(by.dead_jobs).toMatchObject({ count: 1, to: "/console/jobs?status=dead" });
    expect(by.past_due).toMatchObject({ count: 1, tone: "warn", to: "/console/billing" });
    expect(by.suspended).toMatchObject({ count: 1, to: "/console/workspaces?state=suspended" });
    expect(by.migrations).toBeUndefined();
    expect(by.write_budget).toBeUndefined(); // no analytics token in tests: the meter is off
    // Most urgent first.
    expect((r.body.attention as { tone: string }[]).map((i) => i.tone)).toEqual(["bad", "bad", "bad", "warn", "warn"]);

    expect(r.body.totals.users).toBe(3);
    const newest = r.body.newest as { id: string; name: string; ownerEmail: string | null; plan: string; createdAt: string }[];
    expect(newest.length).toBeGreaterThanOrEqual(3);
    expect(newest.length).toBeLessThanOrEqual(5);
    expect(newest.find((w) => w.id === orgId)).toMatchObject({ name: "Else Inc", ownerEmail: "owner@else.test", plan: "starter" });
    expect(newest.map((w) => w.createdAt)).toEqual([...newest.map((w) => w.createdAt)].sort().reverse());

    expect((await cus.get("/api/console/overview")).status).toBe(403);
  }, 120_000);
});
