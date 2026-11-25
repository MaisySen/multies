/**
 * Review Z7: releasing a domain claim ignored legal holds. A mailbox under a hold (or holding mail a held person sent)
 * now counts as kept: it never goes with a soft release, and a hard release keeps it, suspended, off the name.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { domains, mailboxes, mailLegalHolds, messages, organizations, users } from "@/server/db/schema";
import { releasedDomainName, releaseStaleDomainClaims } from "@/server/services/domains";

const DAY = 86_400_000;

async function world() {
  const ctx = await makeTestApp();
  const s = new Client(ctx.app);
  await s.signup("ann@acme.io", "Ann", "Acme");
  const orgId = (await s.get("/api/account/me")).body.organization.id as string;
  const userId = (await ctx.db.select().from(users).where(eq(users.email, "ann@acme.io")).get())!.id;
  await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId));
  const claim = async (name: string, ageDays: number) => {
    const id = (await s.post("/api/domains", { name })).body.domain.id as string;
    await ctx.db.update(domains).set({ createdAt: new Date(ctx.deps.now().getTime() - ageDays * DAY), verifyAttemptedAt: new Date(ctx.deps.now().getTime() - 10 * DAY) }).where(eq(domains.id, id));
    return id;
  };
  const box = async (domainId: string, local: string) => (await s.post("/api/mailboxes", { domainId, localPart: local, displayName: local })).body.mailbox.id as string;
  const hold = (kind: "mailbox" | "person", targetId: string) => ctx.db.insert(mailLegalHolds).values({ id: `hold_${targetId}`, orgId, kind, targetId, name: "Case" });
  return { ctx, orgId, userId, claim, box, hold };
}

describe("Z7: legal holds keep mailboxes through a claim release", () => {
  it("a held empty mailbox keeps a claim from the 14 day release", async () => {
    const w = await world();
    const d = await w.claim("held.io", 20);
    await w.hold("mailbox", await w.box(d, "legal"));
    expect(await releaseStaleDomainClaims(w.ctx.deps)).toEqual([]);
    expect((await w.ctx.db.select().from(domains).where(eq(domains.id, d)).get())!.name).toBe("held.io");
  });

  it("past 45 days a held mailbox, and one with mail a held person sent, stay suspended off the name", async () => {
    const w = await world();
    const d = await w.claim("old.io", 50);
    const held = await w.box(d, "legal");
    await w.hold("mailbox", held);
    const sentBox = await w.box(d, "outbox");
    await w.ctx.db.insert(messages).values({ id: "msg_z7sent00000000001", orgId: w.orgId, mailboxId: sentBox, folder: "sent", threadId: "thr_z7sent0000000001", fromAddress: "outbox@old.io", fromName: "Ann",
      to: "[]", subject: "Sent", text: "x", snippet: "x", date: new Date(), isRead: true, sentByUserId: w.userId } as never);
    await w.hold("person", w.userId);
    const empty = await w.box(d, "empty");
    expect(await releaseStaleDomainClaims(w.ctx.deps)).toEqual(["old.io"]);
    for (const [id, local] of [[held, "legal"], [sentBox, "outbox"]] as const) {
      expect((await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get())!).toMatchObject({ status: "suspended", address: `${local}@${releasedDomainName(d)}` });
    }
    expect(await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, empty)).get()).toBeUndefined();
  });
});
