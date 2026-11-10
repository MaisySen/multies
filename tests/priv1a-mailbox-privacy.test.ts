import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { mailboxes, mailConnections, members, organizations } from "@/server/db/schema";
import { MIGRATIONS } from "@/server/db/migrations.generated";
import { usersWhoCanOpen } from "@/server/services/team";
import { syncSubscription } from "@/server/services/billing";
import { onPaymentFailed, sendingPausedForPayment } from "@/server/services/billing/dunning";
import { getPlan } from "@/server/services/plans";
import type { Client } from "./helpers";

// PRIV1a (MB-366): personal mailboxes are private to their owner plus the people the owner shares them with.
// Owners and admins manage people, not their mail. Team and agent mailboxes keep today's rule.

type W = Awaited<ReturnType<typeof privacyWorld>>;
const ROLES = ["owner", "admin", "member", "pat", "dRead", "dReply", "dSend", "nobody", "outsider"] as const;
type R = (typeof ROLES)[number];
const client = (w: W, r: R): Client => (r === "pat" ? w.pat.c : r === "owner" || r === "outsider" ? w[r] : w[r].c);

// Who opens what. pat: owner of the personal mailbox (a plain member otherwise); member: granted the team mailbox.
const EXPECT: Record<"personal" | "team" | "agent", R[]> = {
  personal: ["pat", "dRead", "dReply", "dSend"],
  team: ["owner", "admin", "member"],
  agent: ["owner", "admin"],
};

describe("PRIV1a mailbox privacy: role x resource", () => {
  it("opens, lists and counts only what each person may open", async () => {
    const w = await privacyWorld();
    const got: string[] = [];
    const want: string[] = [];
    for (const r of ROLES) {
      const c = client(w, r);
      // Badge counts (before anything is opened, so all unread; one statement, its own SQL form of the rule): unread inbox mail only from what this person may open.
      if (r !== "outsider") {
        const n = (await c.get("/api/counts")).body?.mail?.inbox;
        expect(`${r} counts ${n}`).toBe(`${r} counts ${(["personal", "team", "agent"] as const).filter((b) => EXPECT[b].includes(r)).length}`);
      }
    }
    for (const r of ROLES) {
      const c = client(w, r);
      const list = await c.get("/api/mail/messages?folder=inbox&limit=50");
      const listed = new Set(((list.body?.messages ?? []) as { id: string }[]).map((m) => m.id));
      for (const box of ["personal", "team", "agent"] as const) {
        const one = await c.get(`/api/mail/messages/${w.msgs[box]}`);
        const may = EXPECT[box].includes(r);
        want.push(`${r} ${box} ${may ? "open" : "closed"} ${may ? "listed" : "unlisted"}`);
        got.push(`${r} ${box} ${one.status === 200 ? "open" : "closed"} ${listed.has(w.msgs[box]) ? "listed" : "unlisted"}`);
        if (!may) expect([403, 404]).toContain(one.status);
      }
      const overview = JSON.stringify((await c.get("/api/mail/overview")).body);
      if (!EXPECT.personal.includes(r)) expect(overview).not.toContain(w.boxes.personal);
    }
    expect(got).toEqual(want);
  }, 120_000);

  it("enforces share levels: read, read and reply, send as", async () => {
    const w = await privacyWorld();
    const draft = (c: Client, reply: boolean) => c.post("/api/mail/drafts", { mailboxId: w.boxes.personal, to: ["a@b.io"], subject: "x", text: "x", ...(reply ? { inReplyToId: w.msgs.personal } : {}) });
    expect((await draft(w.dRead.c, true)).status).toBe(403);
    expect((await draft(w.dRead.c, false)).status).toBe(403);
    // PRIV1b (P10): a reply share drafts answers to the thread's own people only (a@b.io isn't in the thread).
    expect((await draft(w.dReply.c, true)).status).toBe(403);
    expect((await w.dReply.c.post("/api/mail/drafts", { mailboxId: w.boxes.personal, to: [`secret.sender.pers@private.example`], subject: "x", text: "x", inReplyToId: w.msgs.personal })).status).toBeLessThan(300);
    expect((await draft(w.dReply.c, false)).status).toBe(403);
    expect((await draft(w.dSend.c, false)).status).toBeLessThan(300);
    expect((await draft(w.pat.c, false)).status).toBeLessThan(300);
    expect([403, 404]).toContain((await draft(w.admin.c, false)).status);
    expect([403, 404]).toContain((await draft(w.owner, false)).status);
    // A read only share can't change mail; Read and reply can.
    expect((await w.dRead.c.patch(`/api/mail/messages/${w.msgs.personal}`, { isStarred: true })).status).toBe(403);
    expect((await w.dReply.c.patch(`/api/mail/messages/${w.msgs.personal}`, { isStarred: true })).status).toBe(200);
    expect((await w.dRead.c.post("/api/mail/labels", { threadId: `thr_pers${w.n}aaaaaaaaaa`, label: "x" })).status).toBeGreaterThanOrEqual(400);
  }, 120_000);

  it("only the owner shares; admins can't grant, read the sharing page or the attachment", async () => {
    const w = await privacyWorld();
    expect((await w.admin.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.admin.id}`, { level: "read" })).status).toBe(403);
    expect((await w.owner.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.nobody.id}`, { level: "read" })).status).toBe(403);
    expect((await w.owner.patch(`/api/team/members/${w.nobody.id}`, { mailboxIds: [w.boxes.personal] })).status).toBe(403);
    expect((await w.admin.c.get(`/api/mailboxes/${w.boxes.personal}/sharing`)).status).toBe(404);
    expect((await w.admin.c.get(`/api/mail/attachments/${w.attId}`)).status).toBe(404);
    expect((await w.dRead.c.get(`/api/mail/attachments/${w.attId}`)).status).toBe(200);
    // Revoke takes effect at once; a delegate can also leave.
    expect((await w.pat.c.del(`/api/mailboxes/${w.boxes.personal}/sharing/${w.dRead.id}`)).status).toBe(200);
    expect((await w.dRead.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(404);
    expect((await w.dSend.c.del(`/api/mailboxes/${w.boxes.personal}/sharing/${w.dSend.id}`)).status).toBe(200);
    expect((await w.dSend.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(404);
    expect((await usersWhoCanOpen(w.ctx.db, w.orgId, w.boxes.personal)).sort()).toEqual([w.pat.id, w.dReply.id].sort());
    const team = await usersWhoCanOpen(w.ctx.db, w.orgId, w.boxes.team);
    expect(team).toContain(w.admin.id);
    expect(team).toContain(w.member.id);
    expect(team).not.toContain(w.pat.id);
  }, 120_000);

  it("logs who opened the mailbox, and every share and revoke, with no content", async () => {
    const w = await privacyWorld();
    await w.dRead.c.get(`/api/mail/messages/${w.msgs.personal}`);
    await w.dRead.c.get(`/api/mail/messages/${w.msgs.personal}`); // a repeat in the window is one row
    await w.dRead.c.get(`/api/mail/messages?mailboxId=${w.boxes.personal}&folder=inbox`);
    await w.pat.c.get(`/api/mail/messages/${w.msgs.personal}`); // the owner's own opens are not logged
    await w.pat.c.del(`/api/mailboxes/${w.boxes.personal}/sharing/${w.dReply.id}`);
    const v = (await w.pat.c.get(`/api/mailboxes/${w.boxes.personal}/sharing`)).body;
    expect(v.isOwner).toBe(true);
    const actions = (v.log as { action: string; who: string }[]).map((l) => `${l.action} ${l.who}`);
    expect(actions.filter((a) => a === "opened_thread Rae Read")).toHaveLength(1);
    expect(actions).toContain("opened_mailbox Rae Read");
    expect(actions.filter((a) => a.startsWith("share_granted"))).toHaveLength(3);
    expect(actions).toContain("share_revoked Pat Person");
    expect(actions.some((a) => a.includes("Pat Person") && a.startsWith("opened"))).toBe(false);
    expect(JSON.stringify(v.log)).not.toContain("SUBJECT-PERS");
    expect(v.shares.map((s: { level: string }) => s.level).sort()).toEqual(["read", "send_as"]);
    // The admin notice count, and what Pat sees as theirs.
    expect((await w.admin.c.get("/api/mailboxes/privacy/mine")).body.hiddenFromMe).toBe(1);
    expect((await w.pat.c.get("/api/mailboxes/privacy/mine")).body.own.map((m: { id: string }) => m.id)).toEqual([w.boxes.personal]);
    expect((await w.dRead.c.get("/api/mailboxes/privacy/mine")).body.shared.map((m: { id: string }) => m.id)).toEqual([w.boxes.personal]);
  }, 120_000);

  it("backfills owners from connections idempotently and keeps unresolved inboxes with the workspace owner", async () => {
    const w = await privacyWorld();
    const conn = `mbx_conn${w.n}backfill00`;
    const orphan = `mbx_orph${w.n}backfill00`;
    await w.ctx.db.insert(mailboxes).values([
      { id: conn, orgId: w.orgId, domainId: w.domainId, localPart: `c${w.n}`, address: `conn${w.n}@gmail.example`, displayName: "C", quotaMb: 1 },
      { id: orphan, orgId: w.orgId, domainId: w.domainId, localPart: `o${w.n}`, address: `orph${w.n}@gmail.example`, displayName: "O", quotaMb: 1 },
    ]);
    const base = { orgId: w.orgId, provider: "custom", username: "u", imapHost: "imap.sample.example", imapPort: 993, imapSecurity: "tls" as const, smtpHost: "s.example", smtpPort: 465, smtpSecurity: "tls" as const, secretEnc: "sample:none" };
    await w.ctx.db.insert(mailConnections).values([
      { ...base, id: `mcn_a${w.n}backfill00`, mailboxId: conn, email: `conn${w.n}@gmail.example`, createdByUserId: w.nobody.id },
      { ...base, id: `mcn_b${w.n}backfill00`, mailboxId: orphan, email: `orph${w.n}@gmail.example`, createdByUserId: null },
    ]);
    const m = MIGRATIONS.find((x) => x.name.startsWith("0164_"))!;
    const updates = m.statements.filter((s) => s.startsWith("UPDATE `mailboxes`"));
    expect(updates.length).toBeGreaterThanOrEqual(4);
    const raw = (w.ctx.db as unknown as { $client: { exec: (s: string) => void } }).$client;
    for (let i = 0; i < 2; i++) for (const s of updates) raw.exec(s); // twice: idempotent
    const row = (id: string) => w.ctx.db.select({ p: mailboxes.personal, o: mailboxes.ownerUserId }).from(mailboxes).where(eq(mailboxes.id, id)).get();
    expect(await row(conn)).toEqual({ p: true, o: w.nobody.id });
    expect(await row(orphan)).toEqual({ p: true, o: null });
    expect(await row(w.boxes.team)).toEqual({ p: false, o: null });
    // Unresolved: only the workspace owner opens it, not admins.
    const ov = async (c: Client) => JSON.stringify((await c.get("/api/mail/overview")).body);
    expect(await ov(w.owner)).toContain(orphan);
    expect(await ov(w.admin.c)).not.toContain(orphan);
    expect(await ov(w.nobody.c)).toContain(conn);
    expect(await ov(w.owner)).not.toContain(conn);
    // If its owner leaves, a personal inbox falls back to the workspace owner, never to admins.
    await w.ctx.db.delete(members).where(eq(members.userId, w.pat.id));
    expect(await ov(w.owner)).toContain(w.boxes.personal);
    expect(await ov(w.admin.c)).not.toContain(w.boxes.personal);
  }, 120_000);
});

describe("PRIV1a owner comp plan", () => {
  it("billing, webhooks and payment failures never downgrade or cap a comp workspace", async () => {
    const w = await privacyWorld();
    await w.ctx.db.update(organizations).set({ plan: "business", compPlan: true, stripeCustomerId: "cus_comp" }).where(eq(organizations.id, w.orgId));
    const r = await syncSubscription(w.ctx.deps, { id: "sub_x", customer: "cus_comp", status: "canceled", metadata: { orgId: w.orgId }, items: { data: [] } } as never, true);
    expect(r?.plan).toBe("business");
    const org = (await w.ctx.db.select().from(organizations).where(eq(organizations.id, w.orgId)).get())!;
    expect(org.plan).toBe("business");
    expect(org.compPlan).toBe(true);
    expect((await onPaymentFailed(w.ctx.deps, org, { amount_due: 100, currency: "aud" })).started).toBe(false);
    expect(sendingPausedForPayment({ pastDueSince: new Date(0), graceEndsAt: new Date(1), compPlan: true }, new Date())).toBe(false);
    // Even if the plan column were changed underneath, limits stay Business.
    await w.ctx.db.update(organizations).set({ plan: "starter" }).where(eq(organizations.id, w.orgId));
    expect((await getPlan(w.ctx.db, w.orgId)).id).toBe("business");
    expect((await w.owner.post("/api/org/plan", { plan: "starter" })).status).toBe(409);
    // The flag is not editable from the app.
    await w.owner.patch("/api/org", { compPlan: false, name: "Acme" });
    expect((await w.ctx.db.select({ c: organizations.compPlan }).from(organizations).where(eq(organizations.id, w.orgId)).get())!.c).toBe(true);
  }, 60_000);

  it("the migration sets the flag for Fintex Australia only", () => {
    const m = MIGRATIONS.find((x) => x.name.startsWith("0164_"))!;
    const s = m.statements.filter((x) => x.includes("comp_plan` = 1"));
    expect(s).toEqual(["UPDATE `organizations` SET `comp_plan` = 1 WHERE `id` = 'org_14tjeedzlvi8epm3';"]);
  });
});
