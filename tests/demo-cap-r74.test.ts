/**
 * R74 (MB-271): our own smoke and QA checks never use up the visitors' daily demos. A request with a valid check header
 * in x-multies-check opens a demo marked "check-" that the visitors' cap does not count; without it (or with a wrong
 * one) the cap holds as before.
 * R76 (security review M1, M2): the header is signed with a time (v1.<seconds>.<HMAC>), good for five minutes, so the
 * raw token never travels; and checks keep a burst limit and their own daily allowance instead of unlimited demos.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { organizations } from "@/server/db/schema";
import { CHECK_DEMO_DAILY_CAP, CHECK_DEMO_SLUG_PREFIX, isInternalCheck, signInternalCheck } from "@/server/services/demo";

const TOKEN = "qa".repeat(16);
const hdr = async () => ({ "x-multies-check": await signInternalCheck(TOKEN, Date.now()) });

describe("demo cap and our own checks (R74, MB-271; R76 M1, M2)", () => {
  it("checks open demos past the visitors' cap, marked, and visitors still get theirs", async () => {
    const { app, db } = await makeTestApp({ DEMO_MODE: "true", DEMO_DAILY_LIMIT: "1", DEMO_PER_IP_DAILY: "0", QA_CHECK_TOKEN: TOKEN });
    for (let i = 0; i < 3; i++) {
      const r = await new Client(app).call("POST", "/api/account/demo", {}, await hdr());
      expect(r.status).toBe(201);
    }
    const marked = (await db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.isDemo, true)).all()).map((o) => o.slug ?? "");
    expect(marked.length).toBe(3);
    expect(marked.every((s) => s.startsWith(CHECK_DEMO_SLUG_PREFIX))).toBe(true);
    expect((await new Client(app).post("/api/account/demo")).status).toBe(201);
    const capped = await new Client(app).post("/api/account/demo");
    expect(capped.status).toBe(503);
    expect(capped.body.error.code).toBe("demo_paused");
  });

  it("the raw token, a wrong or an old signature is a visitor", async () => {
    const { app } = await makeTestApp({ DEMO_MODE: "true", DEMO_DAILY_LIMIT: "2", DEMO_PER_IP_DAILY: "0", QA_CHECK_TOKEN: TOKEN });
    expect((await new Client(app).call("POST", "/api/account/demo", {}, { "x-multies-check": TOKEN })).status).toBe(201);
    const old = await signInternalCheck(TOKEN, Date.now() - 10 * 60_000);
    expect((await new Client(app).call("POST", "/api/account/demo", {}, { "x-multies-check": old })).status).toBe(201);
    // Both counted as visitors: the cap of 2 is used up.
    expect((await new Client(app).call("POST", "/api/account/demo", {}, await hdr())).status).toBe(201);
    expect((await new Client(app).post("/api/account/demo")).status).toBe(503);
  });

  it("checks have their own daily allowance, not unlimited demos", async () => {
    const { app, db } = await makeTestApp({ DEMO_MODE: "true", DEMO_DAILY_LIMIT: "5", DEMO_PER_IP_DAILY: "0", QA_CHECK_TOKEN: TOKEN });
    const now = new Date();
    for (let i = 0; i < CHECK_DEMO_DAILY_CAP; i++) await db.insert(organizations).values({ id: `org_chk${i}`, name: "Check", slug: `${CHECK_DEMO_SLUG_PREFIX}org_chk${i}`, isDemo: true, plan: "starter", createdAt: now });
    const r = await new Client(app).call("POST", "/api/account/demo", {}, await hdr());
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("check_demo_limit");
    // Visitors are unaffected by the checks' allowance.
    expect((await new Client(app).post("/api/account/demo")).status).toBe(201);
  });

  it("verifies the signature, the time window and the token", async () => {
    const now = Date.now();
    const good = await signInternalCheck(TOKEN, now);
    expect(good).toMatch(/^v1\.\d+\.[0-9a-f]{64}$/);
    expect(await isInternalCheck(TOKEN, good, now)).toBe(true);
    expect(await isInternalCheck(TOKEN, ` ${good} `, now + 299_000)).toBe(true);
    expect(await isInternalCheck(TOKEN, good, now + 301_000)).toBe(false);
    expect(await isInternalCheck(TOKEN, good, now - 301_000)).toBe(false);
    expect(await isInternalCheck("other".repeat(6), good, now)).toBe(false);
    expect(await isInternalCheck(null, good, now)).toBe(false);
    expect(await isInternalCheck(TOKEN, undefined, now)).toBe(false);
    expect(await isInternalCheck(TOKEN, TOKEN, now)).toBe(false);
    const ts = good.split(".")[1];
    expect(await isInternalCheck(TOKEN, good.replace(`.${ts}.`, `.${Number(ts) + 1}.`), now)).toBe(false);
  });
});
