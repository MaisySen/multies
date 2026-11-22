/**
 * OPS1 security review M1 (and its audit of every console list): a value a list hides or masks never leaves through
 * a sort, a nextCursor or a `q` match. The webhook case is the review's exact experiment.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { assertCursorFromItems, signUpAs } from "./console-kit";
import { makeTestApp } from "./helpers";
import { deliveries, members, platformAuditLogs, webhookDeliveries, webhookEndpoints } from "@/server/db/schema";
import { listWebhookDeliveries, listWebhookEndpoints } from "@/server/services/console/developer";

const SECRET = "SuperSecretToken9f8e7d6c5b4a";
const secretUrl = `https://hooks.slack.com/services/T0001/B0002/${SECRET}`;
const decode = (c: string) => Buffer.from(c.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();

describe("M1: secret webhook URLs never leave the service", () => {
  it("the review's experiment: no URL sort, no URL in the cursor, no q oracle; the service masks too", async () => {
    const ctx = await makeTestApp();
    const ro = await signUpAs(ctx, "ro@ops.test", "ops_readonly", "RO");
    const cust = await signUpAs(ctx, "c@example.com", null, "Cust");
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, cust.id)).get())!.organizationId;
    for (const [id, url] of [["whe_a", secretUrl], ["whe_b", "https://zzz.example/b"], ["whe_c", `https://user:${SECRET}@creds.example/x`]]) {
      await ctx.db.insert(webhookEndpoints).values({ id: id!, orgId, url: url!, events: "[\"*\"]", secretEnc: "x", format: "slack", description: id === "whe_b" ? "Billing hook" : null });
    }
    await ctx.db.insert(webhookDeliveries).values({ id: "whd_1", orgId, endpointId: "whe_a", eventType: "message.received", payload: "{\"data\":{\"id\":\"m1\"}}", status: "failed", attempts: 6 });

    expect((await ro.c.get("/api/console/developer/webhooks?sort=url:asc&limit=1")).status).toBe(400);
    const r = await ro.c.get("/api/console/developer/webhooks?limit=1");
    expect(r.status).toBe(200);
    expect(r.body.nextCursor).toBeTruthy();
    expect(decode(r.body.nextCursor)).not.toContain(SECRET);
    assertCursorFromItems(r.body);
    let cursor = r.body.nextCursor as string | null;
    const all = [...r.body.items];
    while (cursor) {
      const n = await ro.c.get(`/api/console/developer/webhooks?limit=1&cursor=${cursor}`);
      assertCursorFromItems(n.body);
      if (n.body.nextCursor) expect(decode(n.body.nextCursor)).not.toContain(SECRET);
      all.push(...n.body.items);
      cursor = n.body.nextCursor;
    }
    expect(all.map((e) => e.url).sort()).toEqual(["https://creds.example", "https://hooks.slack.com", "https://zzz.example"]);
    expect(JSON.stringify(all)).not.toContain(SECRET);
    for (const probe of ["SuperSecretT", "services/T0001", "hooks.slack.com/services", "user:"]) {
      expect((await ro.c.get(`/api/console/developer/webhooks?q=${encodeURIComponent(probe)}`)).body.items, probe).toEqual([]);
    }
    expect((await ro.c.get("/api/console/developer/webhooks?q=Billing")).body.items.map((e: { id: string }) => e.id)).toEqual(["whe_b"]);
    const d = await ro.c.get("/api/console/developer/webhook-deliveries");
    expect(d.body.items[0].endpointUrl).toBe("https://hooks.slack.com");
    expect(JSON.stringify(d.body)).not.toContain(SECRET);

    // The service itself, for any later caller.
    const page = { limit: 50, cursor: null, sort: { field: "createdAt", dir: "desc" as const } };
    expect(JSON.stringify(await listWebhookEndpoints(ctx.deps, {}, page))).not.toContain(SECRET);
    expect(JSON.stringify(await listWebhookDeliveries(ctx.deps, { orgId }, page))).not.toContain(SECRET);
    await expect(listWebhookEndpoints(ctx.deps, {}, { ...page, sort: { field: "url", dir: "asc" } })).rejects.toMatchObject({ status: 400 });
  }, 60_000);
});

describe("the audit of every console list's search", () => {
  it("platform audit q never matches a masked invite target id", async () => {
    const ctx = await makeTestApp();
    const owner = await signUpAs(ctx, "owner@ops.test", "admin", "Ops");
    const inviteId = "inv_SECRETINVITE1234567890";
    await ctx.db.insert(platformAuditLogs).values({ id: "pal_inv", actorUserId: owner.id, actorEmail: "owner@ops.test", actorRole: "admin", action: "invite.revoked", targetType: "invitation", targetId: inviteId });
    await ctx.db.insert(platformAuditLogs).values({ id: "pal_ws", actorUserId: owner.id, actorEmail: "owner@ops.test", actorRole: "admin", action: "workspace.suspended", targetType: "workspace", targetId: "org_visible_target" });
    const all = await owner.c.get("/api/console/audit");
    expect(JSON.stringify(all.body)).not.toContain(inviteId);
    expect((await owner.c.get("/api/console/audit?q=SECRETINVITE")).body.items).toEqual([]);
    expect((await owner.c.get("/api/console/audit?q=org_visible_target")).body.items.map((r: { id: string }) => r.id)).toEqual(["pal_ws"]);
  }, 60_000);

  it("mail deliveries hide the addresses, and q on them is ignored (no oracle)", async () => {
    const ctx = await makeTestApp();
    const ro = await signUpAs(ctx, "ro@ops.test", "ops_readonly", "RO");
    const cust = await signUpAs(ctx, "c@example.com", null, "Cust");
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, cust.id)).get())!.organizationId;
    await ctx.db.insert(deliveries).values({ id: "dlv_hidden", orgId, direction: "outbound", fromAddress: "a@cust.example", toAddress: "secret.person@else.example", subject: "Hi", status: "bounced", provider: "test" });
    const base = await ro.c.get("/api/console/mail/deliveries");
    expect(JSON.stringify(base.body)).not.toContain("secret.person");
    const probe = await ro.c.get("/api/console/mail/deliveries?q=nobody-matches-this");
    expect(probe.body.items.map((d: { id: string }) => d.id)).toEqual(base.body.items.map((d: { id: string }) => d.id));
  }, 60_000);
});
