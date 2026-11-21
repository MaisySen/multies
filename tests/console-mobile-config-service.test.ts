/**
 * OPS1: the console's Mobile app config service (services/console/mobile-config.ts) over the R29b remote config:
 * read with field metadata, update with before and after, the existing validation, and the same stored row the
 * public GET /api/v1/app-config reads.
 */
import { describe, it, expect, vi } from "vitest";
import { makeTestApp } from "./helpers";
import { HttpError } from "../src/server/lib/errors";
import { APP_CONFIG_DEFAULTS, appConfigPatch } from "../src/server/routes/app-config-r29b";
import { getMobileConfig, MOBILE_CONFIG_FIELDS, updateMobileConfig } from "../src/server/services/console/mobile-config";

const actor = { userId: "usr_op1", email: "op@example.com" };
const ID1 = "019a1b2c-3d4e-7f00-8a11-223344556677";
const T0 = new Date("2026-11-21T10:00:00.000Z");

async function setup() {
  const t = await makeTestApp({ SENTRY_DSN_MOBILE: "https://mob1@o1.ingest.sentry.io/2" });
  return { ...t, deps: { ...t.deps, now: () => T0 } };
}

describe("getMobileConfig", () => {
  it("answers defaults, no stored overrides and the form fields, without writing", async () => {
    const { deps } = await setup();
    const writes = [vi.spyOn(deps.db, "insert"), vi.spyOn(deps.db, "update"), vi.spyOn(deps.db, "delete")];
    const v = await getMobileConfig(deps);
    expect(v.stored).toEqual({});
    expect(v.updatedAt).toBeNull();
    expect(v.updatedBy).toBeNull();
    expect(v.effective.ota).toEqual(APP_CONFIG_DEFAULTS.ota);
    expect(v.effective.store_url).toEqual(APP_CONFIG_DEFAULTS.store_url);
    expect(v.effective.telemetry.sentry_dsn).toBe("https://mob1@o1.ingest.sentry.io/2");
    expect(v.fields).toBe(MOBILE_CONFIG_FIELDS);
    for (const w of writes) expect(w).not.toHaveBeenCalled();
  });

  it("every field path is a key the existing patch schema accepts", () => {
    for (const f of MOBILE_CONFIG_FIELDS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.help.length).toBeGreaterThan(0);
      const sample = f.type === "update_ids" ? [ID1] : f.type === "integer" ? (f.min ?? 0) + 1 : f.type === "version" ? "1.2.3"
        : f.type === "url" ? (f.path.endsWith("ios") ? "https://apps.apple.com/app/id1" : "https://play.google.com/store/apps/details?id=x") : "Hello";
      const body = f.path.split(".").reduceRight<unknown>((acc, k) => ({ [k]: acc }), sample);
      expect(appConfigPatch.safeParse(body).success, f.path).toBe(true);
    }
  });
});

describe("updateMobileConfig", () => {
  it("applies a patch, returns before and after, and the public endpoint serves it", async () => {
    const { deps, app } = await setup();
    const first = await updateMobileConfig(deps, { min_supported: { ios: { build: 42 } }, ota: { add_critical_update_ids: [ID1] }, message: "Please update" }, actor);
    expect(first.before.stored).toEqual({});
    expect(first.before.effective.min_supported.ios.build).toBeNull();
    expect(first.after.effective.min_supported.ios).toEqual({ build: 42, version: null });
    expect(first.after.effective.ota.critical_update_ids).toEqual([ID1]);
    expect(first.after.effective.message).toBe("Please update");
    expect(first.after.updatedAt).toBe(T0.toISOString());
    expect(first.after.updatedBy).toBe("console:usr_op1");

    const second = await updateMobileConfig(deps, { ota: { remove_critical_update_ids: [ID1], check_interval_minutes: 60 } }, actor);
    expect(second.before).toEqual(first.after);
    expect(second.after.effective.ota.critical_update_ids).toEqual([]);
    expect(second.after.effective.ota.check_interval_minutes).toBe(60);
    expect(second.after.effective.min_supported.ios.build).toBe(42);

    const read = await getMobileConfig(deps);
    expect(read.effective).toEqual(second.after.effective);
    expect(read.updatedBy).toBe("console:usr_op1");

    const pub = await (await app.request("/api/v1/app-config", { headers: { host: "localhost" } })).json();
    expect(pub.mobile).toEqual(second.after.effective);
    expect(pub.updated_at).toBe(T0.toISOString());
  });

  it("uses the existing validation: bad input is a 422 and nothing is written", async () => {
    const { deps } = await setup();
    for (const bad of [
      { ota: { check_interval_minutes: 1 } },
      { store_url: { ios: "https://evil.example.com/" } },
      { min_supported: { ios: { build: -1 } } },
      { ota: { add_critical_update_ids: ["not-an-id"] } },
      { message: "x".repeat(201) },
      { unknown: true },
      "not an object",
    ]) {
      const err = await updateMobileConfig(deps, bad, actor).then(() => null, (e: unknown) => e);
      expect(err, JSON.stringify(bad)).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(422);
      expect((err as HttpError).code).toBe("validation_failed");
      expect(appConfigPatch.safeParse(bad).success).toBe(false);
    }
    expect((await getMobileConfig(deps)).updatedAt).toBeNull();
  });
});
