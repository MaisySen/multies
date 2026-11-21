/**
 * OPS1 feature flags: the /api/* middleware in app.ts loads the operator overrides once per isolate per 60 seconds, so
 * featureOn answers them in the request path, and it never fails a request (a failed read leaves the env defaults).
 */
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import { featureFlagOverrides } from "@/server/db/schema";
import type { DB } from "@/server/db";
import { featureOn, invalidateFlagOverrides } from "@/server/services/console/flags";

afterEach(() => invalidateFlagOverrides());

function countSelects(db: DB) {
  const client = (db as unknown as { $client: { prepare: (s: string) => unknown } }).$client;
  const prepare = client.prepare.bind(client);
  let n = 0;
  client.prepare = (s: string) => { if (/^\s*select/i.test(s) && /feature_flag_overrides/.test(s)) n++; return prepare(s); };
  return () => n;
}

describe("flag overrides middleware", () => {
  it("loads the overrides on an API request, once per 60 seconds", async () => {
    const { app, deps, db } = await makeTestApp({ CRM_TIMELINE: "on" });
    await db.insert(featureFlagOverrides).values({ key: "crmTimeline", scopeId: "", value: "off", locked: false, updatedAt: new Date() });
    const selects = countSelects(db);
    expect(featureOn(deps, "crmTimeline")).toBe(true); // nothing loaded yet: the env default
    expect((await app.request("/api/health")).status).toBeLessThan(500);
    expect(featureOn(deps, "crmTimeline")).toBe(false);
    for (let i = 0; i < 5; i++) await app.request("/api/config");
    expect(selects()).toBe(1);
  }, 60_000);

  it("never fails a request when the overrides cannot be read, and keeps the env defaults", async () => {
    const { app, deps, db } = await makeTestApp({ CRM_TIMELINE: "on" });
    await db.run(sql`drop table feature_flag_overrides`);
    const res = await app.request("/api/config");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { crmTimeline: boolean }).crmTimeline).toBe(true);
    expect(featureOn(deps, "crmTimeline")).toBe(true);
    expect((await app.request("/api/config")).status).toBe(200);
  }, 60_000);
});
