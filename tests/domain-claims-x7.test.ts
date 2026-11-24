/**
 * Wave 2 review X7: a squatter could hold an unverified domain claim for ever by pressing Verify once a week (each
 * press restarted the 7 day quiet period), or with a draft in a mailbox on it (drafts counted as mail). Now a claim
 * never verified is released 45 days after it was added whatever the checks, only received or imported mail keeps it
 * (not drafts or the workspace's own writes), and a claim is kept, not deleted, while a mailbox on it holds a grant,
 * a share, a mail rule, a sign-up email hook or an AI agent's access.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { agentMailboxAccess, authEmailHooks, domains, mailboxAccess, mailRules, messages, organizations, users } from "@/server/db/schema";
import { DOMAIN_CLAIM_HARD_DAYS, releaseStaleDomainClaims } from "@/server/services/domains";

const DAY = 86_400_000;

async function world() {
  const ctx = await makeTestApp();
  const s = new Client(ctx.app);
  await s.signup("eve@evil.io", "Eve", "Evil");
  const orgId = (await s.get("/api/account/me")).body.organization.id as string;
  const userId = (await ctx.db.select().from(users).where(eq(users.email, "eve@evil.io")).get())!.id;
  await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId));
  const add = async (name: string, ageDays: number, checkedDaysAgo: number | null) => {
    const id = (await s.post("/api/domains", { name })).body.domain.id as string;
    await ctx.db.update(domains).set({ createdAt: new Date(ctx.deps.now().getTime() - ageDays * DAY), verifyAttemptedAt: checkedDaysAgo === null ? null : new Date(ctx.deps.now().getTime() - checkedDaysAgo * DAY) }).where(eq(domains.id, id));
    return id;
  };
  const box = async (domainId: string, local: string) => (await s.post("/api/mailboxes", { domainId, localPart: local, displayName: local })).body.mailbox.id as string;
  const names = async () => (await ctx.db.select({ name: domains.name }).from(domains).where(eq(domains.orgId, orgId)).all()).map((r) => r.name).sort();
  return { ctx, s, orgId, userId, add, box, names };
}

describe("X7: unverified domain claims", () => {
  it("are released 45 days after they were added, however often someone pressed Verify", async () => {
    expect(DOMAIN_CLAIM_HARD_DAYS).toBe(45);
    const w = await world();
    await w.add("old-checked.io", 46, 1);
    await w.add("young-checked.io", 44, 1);
    await releaseStaleDomainClaims(w.ctx.deps);
    expect(await w.names()).toEqual(["young-checked.io"]);
  });

  it("a draft, or a message the workspace wrote, doesn't keep a claim; received or imported mail does", async () => {
    const w = await world();
    const drafted = await w.add("drafted.io", 15, null);
    const dBox = await w.box(drafted, "d");
    await w.ctx.db.insert(messages).values({ id: "msg_x7draft000000001", orgId: w.orgId, mailboxId: dBox, folder: "drafts", threadId: "thr_x7draft00000001", fromAddress: "d@drafted.io", fromName: "D",
      to: "[]", subject: "Draft", text: "x", snippet: "x", date: new Date(), isRead: true, sentByUserId: w.userId });
    const wrote = await w.add("wrote.io", 15, null);
    const wBox = await w.box(wrote, "w");
    await w.ctx.db.insert(messages).values({ id: "msg_x7wrote000000001", orgId: w.orgId, mailboxId: wBox, folder: "trash", threadId: "thr_x7wrote00000001", fromAddress: "w@wrote.io", fromName: "W",
      to: "[]", subject: "Deleted draft", text: "x", snippet: "x", date: new Date(), isRead: true, sentByUserId: w.userId });
    const got = await w.add("received.io", 15, null);
    const gBox = await w.box(got, "g");
    await w.ctx.db.insert(messages).values({ id: "msg_x7recv0000000001", orgId: w.orgId, mailboxId: gBox, folder: "archive", threadId: "thr_x7recv000000001", fromAddress: "a@b.example", fromName: "A",
      to: "[]", subject: "Imported", text: "x", snippet: "x", date: new Date(), isRead: true });
    await releaseStaleDomainClaims(w.ctx.deps);
    expect(await w.names()).toEqual(["received.io"]);
  });

  it("a mailbox with a grant, a rule, a sign-up email hook or an agent's access keeps the claim (and the mailbox)", async () => {
    const w = await world();
    const granted = await w.add("granted.io", 15, null);
    await w.ctx.db.insert(mailboxAccess).values({ orgId: w.orgId, userId: w.userId, mailboxId: await w.box(granted, "g") });
    const ruled = await w.add("ruled.io", 15, null);
    await w.ctx.db.insert(mailRules).values({ id: "mru_x7", orgId: w.orgId, userId: w.userId, mailboxId: await w.box(ruled, "r"), name: "R" } as never);
    const hooked = await w.add("hooked.io", 15, null);
    await w.ctx.db.insert(authEmailHooks).values({ id: "aeh_x7", orgId: w.orgId, mailboxId: await w.box(hooked, "h"), secretEnc: "x", supabaseUrl: "https://x.supabase.co", appName: "App" } as never);
    const agented = await w.add("agented.io", 15, null);
    const agentBox = await w.box(agented, "a");
    const ag = await w.s.post("/api/agents", { name: "Helper", localPart: "helperx7" });
    expect(ag.status).toBe(201);
    await w.ctx.db.insert(agentMailboxAccess).values({ agentId: ag.body.agent.id, mailboxId: agentBox, orgId: w.orgId });
    await w.add("plain.io", 15, null);
    await releaseStaleDomainClaims(w.ctx.deps);
    expect(await w.names()).toEqual(expect.arrayContaining(["agented.io", "granted.io", "hooked.io", "ruled.io"]));
    expect(await w.names()).not.toContain("plain.io");
  });

  it("the 409 for a taken name gives the 45 day limit", async () => {
    const w = await world();
    await w.s.post("/api/domains", { name: "acme.io" });
    const b = new Client(w.ctx.app);
    await b.signup("ann@acme.io", "Ann", "Acme");
    const r = await b.post("/api/domains", { name: "acme.io" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain("45 days");
  });
});
