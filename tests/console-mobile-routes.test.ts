/**
 * OPS1: /api/console/mobile, the phone app's remote config in the console: read with field metadata (no telemetry
 * block), save with a reason (ops_admin and owner only), audited with the stored overrides before and after, and the
 * public GET /api/v1/app-config answering the saved values.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { signUpAs } from "./console-kit";
import { platformAuditLogs } from "@/server/db/schema";
import { MOBILE_CONFIG_FIELDS } from "@/server/services/console/mobile-config";

const DSN_SENTINEL = "https://mobile-dsn-sentinel-7c41e2a9f0b34d18@o1.ingest.sentry.io/2";

async function setup() {
  const ctx = await makeTestApp({ SENTRY_DSN_MOBILE: DSN_SENTINEL });
  const { c: admin, id: adminId } = await signUpAs(ctx, "opsadmin@ops.test", "ops_admin");
  const { c: support } = await signUpAs(ctx, "support@ops.test", "ops_support");
  const { c: readonly } = await signUpAs(ctx, "readonly@ops.test", "ops_readonly");
  const { c: customer } = await signUpAs(ctx, "customer@else.test", null);
  return { ctx, admin, adminId, support, readonly, customer };
}

const auditRows = (ctx: Awaited<ReturnType<typeof makeTestApp>>) =>
  ctx.db.select().from(platformAuditLogs).where(and(eq(platformAuditLogs.action, "app_config.updated"), eq(platformAuditLogs.targetType, "app_config"))).all();

describe("/api/console/mobile", () => {
  it("every operator reads the config with its fields; the telemetry block is left out; others are refused", async () => {
    const { ctx, readonly, customer } = await setup();
    const r = await readonly.get("/api/console/mobile");
    expect(r.status).toBe(200);
    expect(r.body.stored).toEqual({});
    expect(r.body.updatedAt).toBeNull();
    expect(r.body.updatedByEmail).toBeNull();
    expect(r.body.fields.map((f: { path: string }) => f.path)).toEqual(MOBILE_CONFIG_FIELDS.map((f) => f.path));
    expect(r.body.effective.ota.check_interval_minutes).toBe(30);
    expect(r.body.effective).not.toHaveProperty("telemetry");
    expect(JSON.stringify(r.body)).not.toContain("mobile-dsn-sentinel-7c41e2a9f0b34d18");
    expect((await customer.get("/api/console/mobile")).status).toBe(403);
    expect((await new Client(ctx.app).get("/api/console/mobile")).status).toBe(401);
  }, 60_000);

  it("saving needs a reason and a change; bad values are 422 and write nothing", async () => {
    const { ctx, admin } = await setup();
    expect((await admin.put("/api/console/mobile", { patch: { message: "Hi" } })).status).toBe(422);
    expect((await admin.put("/api/console/mobile", { patch: { message: "Hi" }, reason: "x" })).status).toBe(422);
    expect((await admin.put("/api/console/mobile", { patch: {}, reason: "Nothing here" })).status).toBe(422);
    const bad = await admin.put("/api/console/mobile", { patch: { ota: { check_interval_minutes: 1 } }, reason: "Too often" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("validation_failed");
    expect((await admin.put("/api/console/mobile", { patch: { min_supported: { ios: { version: "one" } } }, reason: "Bad version" })).status).toBe(422);
    expect((await admin.put("/api/console/mobile", { patch: { unknown: true }, reason: "Unknown key" })).status).toBe(422);
    expect((await admin.put("/api/console/mobile", { patch: { message: "x" }, reason: "Extra", other: 1 })).status).toBe(422);
    expect((await admin.get("/api/console/mobile")).body.stored).toEqual({});
    expect(await auditRows(ctx)).toHaveLength(0);
  }, 60_000);

  it("ops_admin saves with a reason: audited before and after, and the public config follows", async () => {
    const { ctx, admin, adminId } = await setup();
    const r = await admin.put("/api/console/mobile", {
      patch: { min_supported: { ios: { build: 42, version: "1.4.0" } }, ota: { check_interval_minutes: 60 }, message: "Please update." },
      reason: "Raise the minimum after the login fix",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.effective.min_supported.ios).toEqual({ build: 42, version: "1.4.0" });
    expect(r.body.effective.min_supported.android).toEqual({ build: null, version: null });
    expect(r.body.effective).not.toHaveProperty("telemetry");
    expect(r.body.updatedBy).toBe(`console:${adminId}`);
    expect(r.body.updatedByEmail).toBe("opsadmin@ops.test");

    const g = await admin.get("/api/console/mobile");
    expect(g.body.stored).toMatchObject({ min_supported: { ios: { build: 42, version: "1.4.0" } }, message: "Please update." });
    expect(g.body.updatedByEmail).toBe("opsadmin@ops.test");
    const pub = await new Client(ctx.app).get("/api/v1/app-config");
    expect(pub.body.mobile.min_supported.ios.build).toBe(42);
    expect(pub.body.mobile.ota.check_interval_minutes).toBe(60);

    const rows = await auditRows(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: adminId, actorRole: "ops_admin", targetId: "mobile_app_config", reason: "Raise the minimum after the login fix" });
    expect(JSON.parse(rows[0]!.before!)).toEqual({});
    expect(JSON.parse(rows[0]!.after!)).toMatchObject({ message: "Please update.", ota: { check_interval_minutes: 60 } });
    expect(JSON.parse(rows[0]!.metadata!).keys.sort()).toEqual(["message", "min_supported", "ota"]);

    // A second save records the first state as before.
    await admin.put("/api/console/mobile", { patch: { message: null }, reason: "Clear the message" });
    const rows2 = await auditRows(ctx);
    expect(rows2).toHaveLength(2);
    const second = rows2.find((x) => x.reason === "Clear the message")!;
    expect(JSON.parse(second.before!).message).toBe("Please update.");
    expect(JSON.parse(second.after!).message).toBeNull();
  }, 60_000);

  it("support, read only and customers cannot save; anonymous callers get 401", async () => {
    const { ctx, support, readonly, customer } = await setup();
    const body = { patch: { message: "Nope" }, reason: "Trying it out" };
    for (const c of [support, readonly, customer]) expect((await c.put("/api/console/mobile", body)).status).toBe(403);
    expect((await support.put("/api/console/mobile", body)).body.error.code).toBe("forbidden");
    expect((await new Client(ctx.app).put("/api/console/mobile", body)).status).toBe(401);
    expect(await auditRows(ctx)).toHaveLength(0);
  }, 60_000);
});
