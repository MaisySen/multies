/**
 * Wave 3 review Y1: the 45 day cap on an unverified domain claim also skipped claims "kept" by something on a mailbox
 * (a mail rule, a grant, an agent's access, a sign-up email hook, one imported message), and a squatter can make any
 * of those on an unverified domain. Past 45 days a claim never verified is now released whatever it holds: empty
 * mailboxes and the aliases go, a mailbox holding mail or settings stays (suspended) with its address moved to a
 * non-routable name, the original kept on the domain row, so the name and its addresses can be claimed elsewhere.
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { aliases, auditLogs, domains, mailboxes, mailRules, messages, organizations, users } from "@/server/db/schema";
import { releaseStaleDomainClaims } from "@/server/services/domains";

const DAY = 86_400_000;

async function world() {
  const ctx = await makeTestApp();
  const s = new Client(ctx.app);
  await s.signup("eve@evil.io", "Eve", "Evil");
  const orgId = (await s.get("/api/account/me")).body.organization.id as string;
  const userId = (await ctx.db.select().from(users).where(eq(users.email, "eve@evil.io")).get())!.id;
  await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId));
  const add = async (name: string, ageDays: number) => {
    const r = await s.post("/api/domains", { name });
    expect(r.status).toBe(201);
    await ctx.db.update(domains).set({ createdAt: new Date(ctx.deps.now().getTime() - ageDays * DAY), verifyAttemptedAt: new Date(ctx.deps.now().getTime() - DAY) }).where(eq(domains.id, r.body.domain.id));
    return r.body.domain.id as string;
  };
  const box = async (domainId: string, local: string) => {
    const r = await s.post("/api/mailboxes", { domainId, localPart: local, displayName: local });
    expect(r.status).toBe(201);
    return r.body.mailbox.id as string;
  };
  return { ctx, s, orgId, userId, add, box };
}

describe("Y1: the 45 day cap releases a claim whatever is on it", () => {
  it("a mail rule squat: the name, its addresses and its rule's mailbox are freed; mail is kept, suspended", async () => {
    const w = await world();
    const d = await w.add("squat.io", 46);
    const ruled = await w.box(d, "sales");
    await w.ctx.db.insert(mailRules).values({ id: "mru_y1", orgId: w.orgId, userId: w.userId, mailboxId: ruled, name: "R" } as never);
    const withMail = await w.box(d, "hello");
    await w.ctx.db.insert(messages).values({ id: "msg_y1recv0000000001", orgId: w.orgId, mailboxId: withMail, folder: "inbox", threadId: "thr_y1recv000000001", fromAddress: "a@b.example", fromName: "A",
      to: "[]", subject: "Imported", text: "x", snippet: "x", date: new Date(), isRead: true });
    const empty = await w.box(d, "empty");
    expect((await w.s.post("/api/aliases", { domainId: d, localPart: "fwd", destinations: ["eve@evil.io"] })).status).toBe(201);

    expect(await releaseStaleDomainClaims(w.ctx.deps)).toEqual(["squat.io"]);

    // The name is free: nothing is called squat.io any more, and the row keeps what it was.
    expect(await w.ctx.db.select().from(domains).where(eq(domains.name, "squat.io")).get()).toBeUndefined();
    const row = (await w.ctx.db.select().from(domains).where(eq(domains.id, d)).get())!;
    expect(row.releasedName).toBe("squat.io");
    expect(row.releasedAt).toBeInstanceOf(Date);
    expect(row.name).toMatch(/\.invalid$/);
    // Empty mailboxes and aliases are gone; the ones holding mail or a rule stay, suspended, on a non-routable address.
    expect(await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, empty)).get()).toBeUndefined();
    expect(await w.ctx.db.select().from(aliases).where(eq(aliases.domainId, d)).all()).toEqual([]);
    for (const [id, local] of [[ruled, "sales"], [withMail, "hello"]] as const) {
      const m = (await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get())!;
      expect(m.status).toBe("suspended");
      expect(m.address).toBe(`${local}@${row.name}`);
    }
    expect(await w.ctx.db.select().from(messages).where(eq(messages.mailboxId, withMail)).all()).toHaveLength(1);
    expect(await w.ctx.db.select().from(mailRules).where(eq(mailRules.id, "mru_y1")).get()).toBeTruthy();
    const a = await w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, w.orgId), eq(auditLogs.action, "domain.claim_released"))).all();
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0]!.metadata as unknown as string)).toMatchObject({ name: "squat.io", hardCap: true, keptMailboxes: 2, emptyMailboxes: 1 });

    // The real owner can now add the name and the same addresses.
    const owner = new Client(w.ctx.app);
    await owner.signup("ann@real.io", "Ann", "Real");
    const ownerOrg = (await owner.get("/api/account/me")).body.organization.id as string;
    await w.ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, ownerOrg));
    const mine = await owner.post("/api/domains", { name: "squat.io" });
    expect(mine.status).toBe(201);
    expect((await owner.post("/api/mailboxes", { domainId: mine.body.domain.id, localPart: "sales", displayName: "Sales" })).status).toBe(201);

    // A second pass leaves the released row alone.
    expect(await releaseStaleDomainClaims(w.ctx.deps)).toEqual([]);
  });

  it("a kept claim younger than 45 days still stays", async () => {
    const w = await world();
    const d = await w.add("young.io", 30);
    await w.ctx.db.insert(mailRules).values({ id: "mru_y1b", orgId: w.orgId, userId: w.userId, mailboxId: await w.box(d, "sales"), name: "R" } as never);
    expect(await releaseStaleDomainClaims(w.ctx.deps)).toEqual([]);
    expect((await w.ctx.db.select().from(domains).where(eq(domains.id, d)).get())!.name).toBe("young.io");
  });
});
