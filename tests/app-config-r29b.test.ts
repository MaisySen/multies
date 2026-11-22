import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { users } from "../src/server/db/schema";
import { APP_CONFIG_DEFAULTS, mergePatch, resolveAppConfig } from "../src/server/routes/app-config-r29b";

/** R29b: the mobile app's remote config (min supported store build, critical and rolled back updates). */
const TOKEN = "k".repeat(40);
const ID1 = "019a1b2c-3d4e-7f00-8a11-223344556677";
const ID2 = "019a1b2c-3d4e-7f00-8a11-aabbccddeeff";

async function put(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, body: unknown, token?: string) {
  const res = await app.request("/api/v1/app-config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/v1/app-config", () => {
  it("answers the safe defaults without a session, cached for a minute, with the mobile DSN", async () => {
    const { app } = await makeTestApp({ SENTRY_DSN_WEB: "https://abc123@o1.ingest.sentry.io/42" });
    const res = await app.request("/api/v1/app-config", { headers: { host: "localhost" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await res.json();
    expect(body.mobile.min_supported).toEqual({ ios: { build: null, version: null }, android: { build: null, version: null } });
    expect(body.mobile.store_url.ios).toBe("https://apps.apple.com/app/id6826562106");
    expect(body.mobile.store_url.android).toBe("https://play.google.com/store/apps/details?id=au.fintex.multies");
    expect(body.mobile.ota).toEqual({ critical_update_ids: [], blocked_update_ids: [], check_interval_minutes: 30, apply_on_resume_after_minutes: 240 });
    expect(body.mobile.telemetry.sentry_dsn).toBe("https://abc123@o1.ingest.sentry.io/42");
    expect(body.updated_at).toBeNull();
  });

  it("prefers SENTRY_DSN_MOBILE over the web DSN", async () => {
    const { app } = await makeTestApp({ SENTRY_DSN_WEB: "https://web1@o1.ingest.sentry.io/1", SENTRY_DSN_MOBILE: "https://mob1@o1.ingest.sentry.io/2" });
    const body = await (await app.request("/api/v1/app-config", { headers: { host: "localhost" } })).json();
    expect(body.mobile.telemetry.sentry_dsn).toBe("https://mob1@o1.ingest.sentry.io/2");
  });
});

describe("PUT /api/v1/app-config", () => {
  it("is refused without the token, with a wrong token, and when no token is configured", async () => {
    const off = await makeTestApp();
    expect((await put(off.app, { message: "x" }, TOKEN)).status).toBe(503);
    // R30: with no token at all a guest gets 401 even before the deployment has one (never a 5xx).
    expect((await put(off.app, { message: "x" })).status).toBe(401);
    const { app } = await makeTestApp({ APP_CONFIG_TOKEN: TOKEN });
    expect((await put(app, { message: "x" })).status).toBe(401);
    expect((await put(app, { message: "x" }, "k".repeat(39) + "j")).status).toBe(401);
    expect((await put(app, { message: "x" }, "short")).status).toBe(401);
  });

  it("sets the minimum store build, adds and removes critical and blocked updates, and phones read it back", async () => {
    const { app } = await makeTestApp({ APP_CONFIG_TOKEN: TOKEN });
    const r1 = await put(app, { min_supported: { ios: { build: 17 }, android: { build: 15, version: "1.9.3" } }, ota: { add_critical_update_ids: [ID1, ID1.toUpperCase()] } }, TOKEN);
    expect(r1.status).toBe(200);
    expect(r1.body.mobile.min_supported).toEqual({ ios: { build: 17, version: null }, android: { build: 15, version: "1.9.3" } });
    expect(r1.body.mobile.ota.critical_update_ids).toEqual([ID1]);
    expect(r1.body.updated_at).toEqual(expect.any(String));

    const r2 = await put(app, { ota: { add_blocked_update_ids: [ID2], remove_critical_update_ids: [ID1], check_interval_minutes: 15 } }, TOKEN);
    expect(r2.body.mobile.ota).toMatchObject({ critical_update_ids: [], blocked_update_ids: [ID2], check_interval_minutes: 15, apply_on_resume_after_minutes: 240 });
    // An earlier field stays when a later patch does not name it.
    expect(r2.body.mobile.min_supported.ios.build).toBe(17);

    const read = await (await app.request("/api/v1/app-config", { headers: { host: "localhost" } })).json();
    expect(read.mobile.ota.blocked_update_ids).toEqual([ID2]);
    expect(read.mobile.min_supported.android.build).toBe(15);

    // Clearing the minimum unblocks every build again.
    const r3 = await put(app, { min_supported: { ios: { build: null } } }, TOKEN);
    expect(r3.body.mobile.min_supported.ios.build).toBeNull();
  });

  it("validates the body strictly", async () => {
    const { app } = await makeTestApp({ APP_CONFIG_TOKEN: TOKEN });
    expect((await put(app, { ota: { add_critical_update_ids: ["not an id!"] } }, TOKEN)).status).toBe(422);
    expect((await put(app, { store_url: { ios: "https://evil.example/app" } }, TOKEN)).status).toBe(422);
    expect((await put(app, { ota: { check_interval_minutes: 1 } }, TOKEN)).status).toBe(422);
    expect((await put(app, { surprise: true }, TOKEN)).status).toBe(422);
    const bad = await app.request("/api/v1/app-config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: "{" });
    expect(bad.status).toBe(400);
  });

  it("does not shadow the rest of the v1 API", async () => {
    const { app } = await makeTestApp();
    expect((await app.request("/api/v1/openapi.json", { headers: { host: "localhost" } })).status).toBe(200);
  });
});

// OPS1 security: the operator's read and change moved from the retired /api/admin/app-config to /api/console/mobile.
describe("/api/console/mobile (the operator's app config)", () => {
  it("lets a platform admin read and change it, and nobody else", async () => {
    const ctx = await makeTestApp({ PLATFORM_ADMIN_EMAILS: "boss@acme.io" });
    const boss = new Client(ctx.app);
    await boss.signup("boss@acme.io", "Boss Person");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "boss@acme.io"));
    const changed = await boss.call("PUT", "/api/console/mobile", { patch: { ota: { add_critical_update_ids: [ID1] }, message: "Please update" }, reason: "Ship the fix" });
    expect(changed.status).toBe(200);
    expect(changed.body.effective.ota.critical_update_ids).toEqual([ID1]);
    expect((await boss.get("/api/console/mobile")).body.effective.message).toBe("Please update");
    // Phones read the same stored row.
    expect((await new Client(ctx.app).get("/api/v1/app-config")).body.mobile.message).toBe("Please update");
    expect((await boss.call("PUT", "/api/admin/app-config", { message: "x" })).status).toBe(404);

    const other = new Client(ctx.app);
    await other.signup("someone@else.io", "Some One");
    expect((await other.get("/api/console/mobile")).status).toBe(403);
    expect((await other.call("PUT", "/api/console/mobile", { patch: { message: "x" }, reason: "Ship the fix" })).status).toBe(403);
    expect((await new Client(ctx.app).get("/api/console/mobile")).status).toBe(401);
  });
});

describe("mergePatch and resolveAppConfig", () => {
  it("replaces a list when given whole and keeps at most 200 blocked ids", () => {
    const ids = Array.from({ length: 205 }, (_, i) => `019a1b2c-0000-7000-8000-${String(i).padStart(12, "0")}`);
    let s = {};
    for (let i = 0; i < ids.length; i += 10) s = mergePatch(s, { ota: { add_blocked_update_ids: ids.slice(i, i + 10) } });
    const r = resolveAppConfig(s, undefined, null);
    expect(r.mobile.ota.blocked_update_ids).toHaveLength(200);
    expect(r.mobile.ota.blocked_update_ids.at(-1)).toBe(ids.at(-1));
    expect(resolveAppConfig(mergePatch(s, { ota: { blocked_update_ids: [] } }), undefined, null).mobile.ota.blocked_update_ids).toEqual([]);
    expect(resolveAppConfig(null, undefined, null).mobile.ota).toEqual(APP_CONFIG_DEFAULTS.ota);
  });
});
