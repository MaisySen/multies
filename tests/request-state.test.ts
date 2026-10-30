import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { defineRequestState, hasRequestState } from "@better-auth/core/context";
import { withAuthRequestState } from "@/server/lib/request-state";
import { makeTestApp, Client } from "./helpers";

// Regression for the 500 failed_to_get_session that about 1 in 5 API requests hit under
// concurrent load on Workers (seen on prod e4d5721 with wrangler tail: "No request state
// found" from Better Auth's getSession).
describe("Better Auth request state", () => {
  it("is open for the whole request and separate per request", async () => {
    const flag = defineRequestState(() => "unset");
    const seen = await Promise.all(Array.from({ length: 25 }, (_, i) => withAuthRequestState(async () => {
      expect(await hasRequestState()).toBe(true);
      await flag.set(`req-${i}`);
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return flag.get();
    })));
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `req-${i}`));
  });

  it("is opened by both the Worker and the Node entry", () => {
    for (const file of ["src/entry/worker.ts", "src/entry/node.ts"]) {
      expect(readFileSync(file, "utf8")).toMatch(/withAuthRequestState\(/);
    }
  });

  it("serves many concurrent signed-in requests without a session error", async () => {
    const { app } = await makeTestApp({ DEMO_MODE: "true" });
    const c = new Client(app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    const statuses = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      withAuthRequestState(async () => (await c.get(i % 2 ? "/api/tasks" : "/api/contacts")).status)));
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("recognises the lost request state failure, and nothing else", async () => {
    const { isLostRequestState } = await import("@/server/lib/request-state");
    expect(isLostRequestState({ statusCode: 500, body: { code: "FAILED_TO_GET_SESSION" } })).toBe(true);
    expect(isLostRequestState({ cause: new Error("No request state found. Please make sure...") })).toBe(true);
    expect(isLostRequestState({ statusCode: 401, body: { code: "FAILED_TO_GET_SESSION" } })).toBe(false);
    expect(isLostRequestState(new Error("database is locked"))).toBe(false);
    expect(isLostRequestState(null)).toBe(false);
  });
});
