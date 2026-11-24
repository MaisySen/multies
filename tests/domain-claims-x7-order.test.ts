/**
 * Wave 2 review X7: the claim release deprovisioned the mailboxes' mail server accounts first and re-checked the claim
 * only in the delete after, so mail that arrived in between kept the claim but its accounts were already gone. It now
 * re-checks the claim right before deprovisioning, and leaves a claim that gained mail untouched.
 */
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { domains, messages, organizations } from "@/server/db/schema";
import { releaseStaleDomainClaims } from "@/server/services/domains";

const calls: string[] = [];
let onFirst: (() => Promise<void>) | null = null;
vi.mock("@/server/services/mailserver", async (orig) => ({
  ...(await orig<typeof import("@/server/services/mailserver")>()),
  deprovisionMailbox: vi.fn(async (_deps: unknown, _orgId: string, mailboxId: string) => {
    calls.push(mailboxId);
    if (onFirst) { const f = onFirst; onFirst = null; await f(); }
  }),
}));

const DAY = 86_400_000;

describe("X7: re-check before deprovisioning", () => {
  it("a claim that gains mail while an earlier one is released keeps its mailboxes' accounts", async () => {
    const ctx = await makeTestApp();
    const s = new Client(ctx.app);
    await s.signup("eve@evil.io", "Eve", "Evil");
    const orgId = (await s.get("/api/account/me")).body.organization.id as string;
    await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId));
    const first = (await s.post("/api/domains", { name: "first.io" })).body.domain.id as string;
    const second = (await s.post("/api/domains", { name: "second.io" })).body.domain.id as string;
    const firstBox = (await s.post("/api/mailboxes", { domainId: first, localPart: "a", displayName: "A" })).body.mailbox.id as string;
    const secondBox = (await s.post("/api/mailboxes", { domainId: second, localPart: "b", displayName: "B" })).body.mailbox.id as string;
    await ctx.db.update(domains).set({ createdAt: new Date(ctx.deps.now().getTime() - 16 * DAY), verifyAttemptedAt: null }).where(eq(domains.id, first));
    await ctx.db.update(domains).set({ createdAt: new Date(ctx.deps.now().getTime() - 15 * DAY), verifyAttemptedAt: null }).where(eq(domains.id, second));
    // While the first claim's account is being removed, mail arrives in the second's mailbox.
    onFirst = async () => {
      await ctx.db.insert(messages).values({ id: "msg_x7order00000001", orgId, mailboxId: secondBox, folder: "inbox", threadId: "thr_x7order0000001", fromAddress: "a@b.example", fromName: "A",
        to: "[]", subject: "Arrived", text: "x", snippet: "x", date: new Date(), isRead: false });
    };
    expect(await releaseStaleDomainClaims(ctx.deps)).toEqual(["first.io"]);
    expect(calls).toEqual([firstBox]);
    expect(await ctx.db.select().from(domains).where(eq(domains.id, second)).get()).toBeTruthy();
  });
});
