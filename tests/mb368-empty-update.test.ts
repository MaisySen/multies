/**
 * MB-368 (Sentry MYMAIL-API-1Y "No values to set"): an update with no fields reached the database as an empty SET and
 * answered 500. It is a request with nothing to change, so it answers 422 validation_failed with words, the way
 * PATCH /api/mailboxes/:id already does (PRIV1b S1).
 */
import { describe, it, expect } from "vitest";
import { privacyWorld } from "./priv1a-world";
import { isNoValuesToSet } from "@/server/lib/errors";

describe("MB-368: an update with no fields is a 422 with words, not a 500", () => {
  it("PATCH /api/org with {} (and with only unknown fields) answers 422 and changes nothing", async () => {
    const w = await privacyWorld();
    const before = (await w.owner.get("/api/org")).body.organization;
    for (const body of [{}, { nickname: "x" }]) {
      const r = await w.owner.patch("/api/org", body);
      expect(r.status).toBe(422);
      expect(r.body.error).toMatchObject({ code: "validation_failed", message: "Send a field to change." });
    }
    const after = (await w.owner.get("/api/org")).body.organization;
    expect(after.name).toBe(before.name);
    // A real change still works.
    expect((await w.owner.patch("/api/org", { name: "Acme Two" })).status).toBe(200);
    expect((await w.owner.get("/api/org")).body.organization.name).toBe("Acme Two");
  }, 120_000);

  it("PATCH /api/mail/messages/:id with {} answers 422", async () => {
    const w = await privacyWorld({ real: true });
    const list = await w.pat.c.get("/api/mail/messages");
    const id = (list.body.messages ?? list.body.items ?? list.body.data)[0].id as string;
    const r = await w.pat.c.patch(`/api/mail/messages/${id}`, {});
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: "validation_failed", message: "Send a field to change." });
    expect((await w.pat.c.patch(`/api/mail/messages/${id}`, { isStarred: true })).status).toBe(200);
  }, 120_000);

  it("the database's own empty update error is recognised, so any route that still reaches it answers 422", () => {
    expect(isNoValuesToSet(new Error("No values to set"))).toBe(true);
    expect(isNoValuesToSet(new Error("D1_ERROR: something else"))).toBe(false);
    expect(isNoValuesToSet("No values to set")).toBe(false);
  });
});
