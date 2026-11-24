/**
 * Round 2 (PRIV1b domain claims): a domain name is unique across the service, so a workspace that adds a domain it never
 * verifies holds the name from its real owner. The maintenance pass now releases a claim that was never verified, is
 * older than 14 days and has nothing on it (no mailbox, no alias), so the owner can add it.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, domains, organizations } from "@/server/db/schema";
import { runMaintenance } from "@/server/services/maintenance";
import { DOMAIN_CLAIM_DAYS, releaseStaleDomainClaims } from "@/server/services/domains";
import { verifiedDomain } from "./priv1a-world";

const DAY = 86_400_000;

describe("Round 2: unverified domain claims are released", () => {
  it("after 14 days a claim never verified, with nothing on it, goes; the real owner can then add the name", async () => {
    expect(DOMAIN_CLAIM_DAYS).toBe(14);
    const ctx = await makeTestApp();
    const squatter = new Client(ctx.app);
    await squatter.signup("eve@evil.io", "Eve", "Evil");
    const sOrg = (await squatter.get("/api/account/me")).body.organization.id as string;
    await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, sOrg)); // room for five domains
    expect((await squatter.post("/api/domains", { name: "acme.io" })).status).toBe(201);
    const owner = new Client(ctx.app);
    await owner.signup("ann@acme.io", "Ann", "Acme");
    expect((await owner.post("/api/domains", { name: "acme.io" })).status).toBe(409);

    // Kept: a younger claim, a claim with a mailbox, one with an alias, and one that was verified once.
    const young = (await squatter.post("/api/domains", { name: "young.io" })).body.domain.id as string;
    const withBox = (await squatter.post("/api/domains", { name: "boxed.io" })).body.domain.id as string;
    expect((await squatter.post("/api/mailboxes", { domainId: withBox, localPart: "x", displayName: "X" })).status).toBe(201);
    const withAlias = (await squatter.post("/api/domains", { name: "aliased.io" })).body.domain.id as string;
    expect((await squatter.post("/api/aliases", { domainId: withAlias, localPart: "a", destinations: ["eve@evil.io"] })).status).toBe(201);
    const onceVerified = await verifiedDomain(ctx, squatter, "verified.io");
    await ctx.db.update(domains).set({ status: "failed" }).where(eq(domains.id, onceVerified));

    const old = new Date(ctx.deps.now().getTime() - 15 * DAY);
    await ctx.db.update(domains).set({ createdAt: old }).where(eq(domains.orgId, sOrg));
    await ctx.db.update(domains).set({ createdAt: new Date(ctx.deps.now().getTime() - 13 * DAY) }).where(eq(domains.id, young));

    await runMaintenance(ctx.deps);
    const left = (await ctx.db.select({ name: domains.name }).from(domains).where(eq(domains.orgId, sOrg)).all()).map((r) => r.name).sort();
    expect(left).toEqual(["aliased.io", "boxed.io", "verified.io", "young.io"]);
    const logged = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "domain.claim_released")).all();
    expect(logged).toHaveLength(1);
    expect(logged[0].orgId).toBe(sOrg);
    expect((await owner.post("/api/domains", { name: "acme.io" })).status).toBe(201);
    // Nothing more to release.
    expect(await releaseStaleDomainClaims(ctx.deps)).toEqual([]);
  });
});
