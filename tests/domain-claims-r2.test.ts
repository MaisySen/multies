/**
 * Round 2 (PRIV1b domain claims): a domain name is unique across the service, so a workspace that adds a domain it never
 * verifies holds the name from its real owner. The maintenance pass now releases a claim that was never verified, is
 * older than 14 days and has nothing on it (no mailbox, no alias), so the owner can add it.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, domains, messages, organizations } from "@/server/db/schema";
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

    // Kept: a younger claim, a claim with a mailbox that has mail, and one that was verified once.
    // Wave 1 review V7 (changed on purpose): an empty mailbox or an alias no longer keeps a claim, so boxed.io and
    // aliased.io now go; a mailbox with mail in it still keeps one (mailed.io).
    const young = (await squatter.post("/api/domains", { name: "young.io" })).body.domain.id as string;
    const withBox = (await squatter.post("/api/domains", { name: "boxed.io" })).body.domain.id as string;
    expect((await squatter.post("/api/mailboxes", { domainId: withBox, localPart: "x", displayName: "X" })).status).toBe(201);
    const withAlias = (await squatter.post("/api/domains", { name: "aliased.io" })).body.domain.id as string;
    expect((await squatter.post("/api/aliases", { domainId: withAlias, localPart: "a", destinations: ["eve@evil.io"] })).status).toBe(201);
    const withMail = (await squatter.post("/api/domains", { name: "mailed.io" })).body.domain.id as string;
    const mailBox = (await squatter.post("/api/mailboxes", { domainId: withMail, localPart: "y", displayName: "Y" })).body.mailbox.id as string;
    await ctx.db.insert(messages).values({ id: "msg_claimmail00000001", orgId: sOrg, mailboxId: mailBox, folder: "inbox", threadId: "thr_claimmail0000001", fromAddress: "a@b.example", fromName: "A",
      to: JSON.stringify([{ name: "", address: "y@mailed.io" }]), subject: "Hello", text: "x", snippet: "x", date: new Date(), isRead: false });
    const onceVerified = await verifiedDomain(ctx, squatter, "verified.io");
    await ctx.db.update(domains).set({ status: "failed" }).where(eq(domains.id, onceVerified));

    // Added 15 days ago, and (V7) last checked by a person 8 days ago.
    const old = new Date(ctx.deps.now().getTime() - 15 * DAY);
    await ctx.db.update(domains).set({ createdAt: old, verifyAttemptedAt: new Date(ctx.deps.now().getTime() - 8 * DAY) }).where(eq(domains.orgId, sOrg));
    await ctx.db.update(domains).set({ createdAt: new Date(ctx.deps.now().getTime() - 13 * DAY) }).where(eq(domains.id, young));

    await runMaintenance(ctx.deps);
    const left = (await ctx.db.select({ name: domains.name }).from(domains).where(eq(domains.orgId, sOrg)).all()).map((r) => r.name).sort();
    expect(left).toEqual(["mailed.io", "verified.io", "young.io"]);
    const logged = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "domain.claim_released")).all();
    expect(logged).toHaveLength(3);
    expect(logged[0].orgId).toBe(sOrg);
    expect((await owner.post("/api/domains", { name: "acme.io" })).status).toBe(201);
    // Nothing more to release.
    expect(await releaseStaleDomainClaims(ctx.deps)).toEqual([]);
  });
});

describe("Wave 1 review V7: a claim someone is checking is kept", () => {
  it("a claim a person checked in the last 7 days stays; the scheduled re-check doesn't count as a check", async () => {
    const ctx = await makeTestApp();
    const squatter = new Client(ctx.app);
    await squatter.signup("eve@evil.io", "Eve", "Evil");
    const id = (await squatter.post("/api/domains", { name: "acme.io" })).body.domain.id as string;
    await ctx.db.update(domains).set({ createdAt: new Date(ctx.deps.now().getTime() - 20 * DAY), verifyAttemptedAt: new Date(ctx.deps.now().getTime() - 20 * DAY) }).where(eq(domains.id, id));
    // A person presses Verify: kept.
    expect((await squatter.post(`/api/domains/${id}/verify`)).status).toBe(200);
    await runMaintenance(ctx.deps);
    expect(await ctx.db.select().from(domains).where(eq(domains.id, id)).get()).toBeTruthy();
    // Eight days later, with only the scheduled re-checks since: released.
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + 8 * DAY);
    try { await runMaintenance(ctx.deps); } finally { ctx.deps.now = real; }
    expect(await ctx.db.select().from(domains).where(eq(domains.id, id)).get()).toBeUndefined();
  });

  it("the 409 for a taken name says when it is released", async () => {
    const ctx = await makeTestApp();
    const a = new Client(ctx.app);
    await a.signup("eve@evil.io", "Eve", "Evil");
    await a.post("/api/domains", { name: "acme.io" });
    const b = new Client(ctx.app);
    await b.signup("ann@acme.io", "Ann", "Acme");
    const r = await b.post("/api/domains", { name: "acme.io" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain("holds no mail");
    expect(r.body.error.message).toContain("7 days");
  });
});
