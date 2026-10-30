/**
 * R74 (MB-271): our own smoke and QA checks never use up the visitors' daily demos. A request with the checks' token
 * in x-multies-check opens a demo marked "check-" that the daily cap does not count; without it (or with a wrong
 * token) the cap holds as before.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { organizations } from "@/server/db/schema";
import { CHECK_DEMO_SLUG_PREFIX, isInternalCheck } from "@/server/services/demo";

const TOKEN = "qa".repeat(16);

describe("demo cap and our own checks (R74, MB-271)", () => {
  it("checks open demos past the cap, marked, and visitors still get theirs", async () => {
    const { app, db } = await makeTestApp({ DEMO_MODE: "true", DEMO_DAILY_LIMIT: "1", DEMO_PER_IP_DAILY: "0", QA_CHECK_TOKEN: TOKEN });
    for (let i = 0; i < 3; i++) {
      const r = await new Client(app).call("POST", "/api/account/demo", {}, { "x-multies-check": TOKEN });
      expect(r.status).toBe(201);
    }
    const marked = (await db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.isDemo, true)).all()).map((o) => o.slug ?? "");
    expect(marked.length).toBe(3);
    expect(marked.every((s) => s.startsWith(CHECK_DEMO_SLUG_PREFIX))).toBe(true);
    // The visitor's demo still opens (the checks did not count), and the cap of 1 then holds for the next visitor.
    expect((await new Client(app).post("/api/account/demo")).status).toBe(201);
    const capped = await new Client(app).post("/api/account/demo");
    expect(capped.status).toBe(503);
    expect(capped.body.error.code).toBe("demo_paused");
  });

  it("a wrong or missing token is a visitor", async () => {
    const { app } = await makeTestApp({ DEMO_MODE: "true", DEMO_DAILY_LIMIT: "1", DEMO_PER_IP_DAILY: "0", QA_CHECK_TOKEN: TOKEN });
    expect((await new Client(app).call("POST", "/api/account/demo", {}, { "x-multies-check": "nope" })).status).toBe(201);
    expect((await new Client(app).call("POST", "/api/account/demo", {}, { "x-multies-check": TOKEN.slice(1) + "x" })).status).toBe(503);
  });

  it("no token configured: nothing is exempt; a short token is ignored", () => {
    expect(isInternalCheck(null, TOKEN)).toBe(false);
    expect(isInternalCheck(TOKEN, undefined)).toBe(false);
    expect(isInternalCheck(TOKEN, ` ${TOKEN} `)).toBe(true);
  });
});
