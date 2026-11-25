/**
 * Review Z2: a released claim's name was `dom-<id>.released.invalid`, predictable and accepted by the domain check, so
 * a squatter could add it first. The rename then hit the unique name index, threw, and stopped every later pass (the
 * row sorts first). Now: the released name has a character no added domain can have, .invalid and .localhost names
 * can't be added, and one row that fails is reported while the pass goes on.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { domains, mailboxes, mailRules, organizations, users } from "@/server/db/schema";
import { domainNameSchema } from "@/shared/schemas";
import { releasedDomainName, releaseStaleDomainClaims } from "@/server/services/domains";

const DAY = 86_400_000;

describe("Z2: released names can't be squatted, and one bad row doesn't stop the pass", () => {
  it("the domain check refuses .invalid and .localhost names and any released name", () => {
    for (const bad of ["dom-abc.released.invalid", "squat.invalid", "mail.localhost", releasedDomainName("dom_0abc"), releasedDomainName("DOM_0ABC")]) {
      expect(domainNameSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(domainNameSchema.safeParse("acme.io").success).toBe(true);
    expect(releasedDomainName("dom_1")).not.toBe(releasedDomainName("dom_2"));
  });

  it("a release that fails is reported and the next claim is still released", async () => {
    const ctx = await makeTestApp();
    const errors: unknown[] = [];
    ctx.deps.reportError = (err) => { errors.push(err); return undefined; };
    const s = new Client(ctx.app);
    await s.signup("eve@evil.io", "Eve", "Evil");
    const orgId = (await s.get("/api/account/me")).body.organization.id as string;
    const userId = (await ctx.db.select().from(users).where(eq(users.email, "eve@evil.io")).get())!.id;
    await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId));
    const add = async (name: string, ageDays: number) => {
      const r = await s.post("/api/domains", { name });
      expect(r.status).toBe(201);
      await ctx.db.update(domains).set({ createdAt: new Date(ctx.deps.now().getTime() - ageDays * DAY), verifyAttemptedAt: new Date(ctx.deps.now().getTime() - DAY) }).where(eq(domains.id, r.body.domain.id));
      const box = await s.post("/api/mailboxes", { domainId: r.body.domain.id, localPart: "sales", displayName: "Sales" });
      await ctx.db.insert(mailRules).values({ id: `mru_${name.replace(/\W/g, "")}`, orgId, userId, mailboxId: box.body.mailbox.id, name: "R" } as never);
      return r.body.domain.id as string;
    };
    const first = await add("first.io", 50);
    const second = await add("second.io", 49);
    // Something already holds the first claim's released name (only a direct write can make one now).
    const like = (await ctx.db.select().from(domains).where(eq(domains.id, first)).get())!;
    await ctx.db.insert(domains).values({ ...like, id: "dom_blocker", name: releasedDomainName(first), verificationToken: "z2-blocker", createdAt: new Date() });

    expect(await releaseStaleDomainClaims(ctx.deps)).toEqual(["second.io"]);
    expect(errors).toHaveLength(1);
    expect((await ctx.db.select().from(domains).where(eq(domains.id, first)).get())!.name).toBe("first.io");
    const row = (await ctx.db.select().from(domains).where(eq(domains.id, second)).get())!;
    expect(row.name).toBe(releasedDomainName(second));
    expect((await ctx.db.select().from(mailboxes).where(eq(mailboxes.domainId, second)).get())!.address).toBe(`sales@${row.name}`);
  });
});
