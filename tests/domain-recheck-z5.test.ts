/** Review Z5: the scheduled DNS re-check skips released claims (their rows sit under a non-routable name). */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { domains, organizations } from "@/server/db/schema";
import { recheckStaleDomains, releasedDomainName } from "@/server/services/domains";

describe("Z5: recheckStaleDomains leaves released rows alone", () => {
  it("checks a live claim and skips a released one", async () => {
    const ctx = await makeTestApp();
    const s = new Client(ctx.app);
    await s.signup("ann@acme.io", "Ann");
    const orgId = (await s.get("/api/account/me")).body.organization.id as string;
    await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId));
    const live = (await s.post("/api/domains", { name: "live.io" })).body.domain.id as string;
    const gone = (await s.post("/api/domains", { name: "gone.io" })).body.domain.id as string;
    await ctx.db.update(domains).set({ lastCheckedAt: null }).where(eq(domains.orgId, orgId));
    await ctx.db.update(domains).set({ name: releasedDomainName(gone), releasedName: "gone.io", releasedAt: new Date() }).where(eq(domains.id, gone));
    const ids = (await recheckStaleDomains(ctx.deps)).map((r) => r.id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(gone);
    expect((await ctx.db.select().from(domains).where(eq(domains.id, gone)).get())!.lastCheckedAt).toBeNull();
  });
});
