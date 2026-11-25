/**
 * Review Z6: the Y1 hard release was not atomic. Mail server accounts went before the conditional rename (a rename that
 * then failed left a live claim with its accounts gone), the rename and the mailbox moves were separate writes (a crash
 * between them left mailboxes at the original address for ever), and verifyDomain could write a released row back.
 * Now the rename and the mailbox moves are one batch, accounts go only after it, verifyDomain skips released rows, and
 * each pass repairs a released row whose mailboxes still carry the original name.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { domains, mailboxes, mailRules, organizations, users } from "@/server/db/schema";
import { releasedDomainName, releaseStaleDomainClaims, verifyDomain } from "@/server/services/domains";

const calls: { mailboxId: string; domainName: string | undefined }[] = [];
vi.mock("@/server/services/mailserver", async (orig) => ({
  ...(await orig<typeof import("@/server/services/mailserver")>()),
  deprovisionMailbox: vi.fn(async (deps: { db: import("@/server/db").DB }, _orgId: string, mailboxId: string) => {
    const { domains: d, mailboxes: m } = await import("@/server/db/schema");
    const { eq: e } = await import("drizzle-orm");
    const row = await deps.db.select({ name: d.name }).from(m).innerJoin(d, e(d.id, m.domainId)).where(e(m.id, mailboxId)).get();
    calls.push({ mailboxId, domainName: row?.name });
    return true;
  }),
}));

const DAY = 86_400_000;
beforeEach(() => { calls.length = 0; });

async function world() {
  const ctx = await makeTestApp();
  const s = new Client(ctx.app);
  await s.signup("eve@evil.io", "Eve", "Evil");
  const orgId = (await s.get("/api/account/me")).body.organization.id as string;
  const userId = (await ctx.db.select().from(users).where(eq(users.email, "eve@evil.io")).get())!.id;
  await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId));
  const claim = async (name: string) => {
    const r = await s.post("/api/domains", { name });
    const id = r.body.domain.id as string;
    await ctx.db.update(domains).set({ createdAt: new Date(ctx.deps.now().getTime() - 50 * DAY), verifyAttemptedAt: new Date(ctx.deps.now().getTime() - DAY), lastCheckedAt: null }).where(eq(domains.id, id));
    const kept = (await s.post("/api/mailboxes", { domainId: id, localPart: "sales", displayName: "Sales" })).body.mailbox.id as string;
    await ctx.db.insert(mailRules).values({ id: `mru_${id}`, orgId, userId, mailboxId: kept, name: "R" } as never);
    const empty = (await s.post("/api/mailboxes", { domainId: id, localPart: "empty", displayName: "Empty" })).body.mailbox.id as string;
    return { id, kept, empty };
  };
  return { ctx, orgId, claim };
}

describe("Z6: the hard release is one step, and repaired if cut short", () => {
  it("mail server accounts go only after the rename, and not at all when the rename fails", async () => {
    const w = await world();
    const a = await w.claim("first.io");
    const like = (await w.ctx.db.select().from(domains).where(eq(domains.id, a.id)).get())!;
    await w.ctx.db.insert(domains).values({ ...like, id: "dom_blocker", name: releasedDomainName(a.id), verificationToken: "z6", createdAt: new Date() });
    w.ctx.deps.reportError = () => undefined;
    expect(await releaseStaleDomainClaims(w.ctx.deps)).toEqual([]);
    expect(calls).toEqual([]);
    expect((await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, a.kept)).get())!).toMatchObject({ address: "sales@first.io", status: "active" });

    await w.ctx.db.delete(domains).where(eq(domains.id, "dom_blocker"));
    expect(await releaseStaleDomainClaims(w.ctx.deps)).toEqual(["first.io"]);
    expect(calls.map((c) => c.mailboxId).sort()).toEqual([a.kept, a.empty].sort());
    for (const c of calls) expect(c.domainName).toBe(releasedDomainName(a.id));
    expect((await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, a.kept)).get())!).toMatchObject({ address: `sales@${releasedDomainName(a.id)}`, status: "suspended" });
    expect(await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, a.empty)).get()).toBeUndefined();
  });

  it("verifyDomain does not write a released row back", async () => {
    const w = await world();
    const a = await w.claim("stale.io");
    const before = (await w.ctx.db.select().from(domains).where(eq(domains.id, a.id)).get())!;
    expect(await releaseStaleDomainClaims(w.ctx.deps)).toEqual(["stale.io"]);
    await verifyDomain(w.ctx.deps, before);
    const after = (await w.ctx.db.select().from(domains).where(eq(domains.id, a.id)).get())!;
    expect(after.name).toBe(releasedDomainName(a.id));
    expect(after.lastCheckedAt).toBeNull();
  });

  it("a released row whose mailbox still has the original address is moved on the next pass", async () => {
    const w = await world();
    const a = await w.claim("cut.io");
    // As if the process stopped right after the rename: the row is released, the mailbox is not moved yet.
    await w.ctx.db.update(domains).set({ name: releasedDomainName(a.id), releasedName: "cut.io", releasedAt: new Date() }).where(eq(domains.id, a.id));
    await releaseStaleDomainClaims(w.ctx.deps);
    expect((await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, a.kept)).get())!).toMatchObject({ address: `sales@${releasedDomainName(a.id)}`, status: "suspended" });
    expect((await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, a.empty)).get())!).toMatchObject({ address: `empty@${releasedDomainName(a.id)}`, status: "suspended" });
  });
});
