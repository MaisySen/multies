/**
 * OPS1 security review (item 4): a webhook delivery's lastError never carries the endpoint's secret path or query, even
 * on a runtime whose fetch error text includes the URL. Scrubbed where it is recorded, and on the way out of the
 * console's delivery list (rows stored before the fix).
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { signUpAs } from "./console-kit";
import { makeTestApp } from "./helpers";
import { members, webhookDeliveries } from "@/server/db/schema";
import { createEndpoint, scrubEndpointUrl, scrubUrls, sendTestEvent } from "@/server/services/developer/webhooks";

const SECRET = "T0001/B0002/HookSecret7c6b5a4d3e";
const URL_ = `https://hooks.slack.com/services/${SECRET}?token=QuerySecret9f8e`;

describe("webhook errors without the secret URL", () => {
  it("the scrubbers keep the origin only", () => {
    expect(scrubUrls(`Could not connect: request to ${URL_} failed`)).toBe("Could not connect: request to https://hooks.slack.com failed");
    expect(scrubUrls("plain https://example.com is fine")).toBe("plain https://example.com is fine");
    const s = scrubEndpointUrl(`fetch failed for /services/${SECRET}?token=QuerySecret9f8e and ?token=QuerySecret9f8e`, URL_);
    expect(s).not.toContain("HookSecret7c6b5a4d3e");
    expect(s).not.toContain("QuerySecret9f8e");
  });

  it("a delivery whose fetch error names the URL stores and shows no secret", async () => {
    const fetchWithUrl = (async (url: string) => { throw new TypeError(`fetch failed: connect ECONNREFUSED for ${url}`); }) as unknown as typeof fetch;
    const ctx = await makeTestApp({}, { fetch: fetchWithUrl });
    const ro = await signUpAs(ctx, "ro@ops.test", "ops_readonly", "Ro");
    const cus = await signUpAs(ctx, "c@example.com", null, "Cust");
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, cus.id)).get())!.organizationId;
    const ep = await createEndpoint(ctx.deps, orgId, { url: URL_, events: ["*"] });
    await sendTestEvent(ctx.deps, orgId, ep.endpoint.id);
    const row = (await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, ep.endpoint.id)).get())!;
    expect(row.lastError).toMatch(/^Could not connect/);
    expect(row.lastError).not.toContain("HookSecret7c6b5a4d3e");
    expect(row.lastError).not.toContain("QuerySecret9f8e");

    // A row stored before the fix: the console still shows the origin only.
    await ctx.db.update(webhookDeliveries).set({ status: "failed", lastError: `Could not connect: fetch failed for ${URL_}` }).where(eq(webhookDeliveries.id, row.id));
    const list = await ro.c.get("/api/console/developer/webhook-deliveries?status=failed,pending");
    const item = list.body.items.find((d: { id: string }) => d.id === row.id);
    expect(item.lastError).toBe("Could not connect: fetch failed for https://hooks.slack.com");
    expect(JSON.stringify(list.body)).not.toContain("HookSecret7c6b5a4d3e");
  }, 60_000);
});
