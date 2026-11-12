import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { auditLogs, mailboxAccess, mailboxes, mailConnections, members, messages, organizations } from "@/server/db/schema";
import { scopeCond, scopeFor } from "@/server/services/mail-access-priv1a";
import type { LogOutbound } from "@/server/services/mail/outbound";
import { MIGRATIONS } from "@/server/db/migrations.generated";
import { usersWhoCanOpen } from "@/server/services/team";
import { syncSubscription } from "@/server/services/billing";
import { enforceGracePeriods, onPaymentFailed, sendingPausedForPayment } from "@/server/services/billing/dunning";
import { signStripePayload, stripeClient } from "@/server/services/billing/stripe";
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
    // PRIV1b (F58): a refused level says so (share_level), not just any 403.
    const level = async (p: Promise<{ status: number; body: { error?: { code?: string } } }>) => { const r = await p; return `${r.status} ${r.body?.error?.code}`; };
    expect(await level(draft(w.dRead.c, true))).toBe("403 share_level");
    expect(await level(draft(w.dRead.c, false))).toBe("403 share_level");
    // PRIV1b (P10): a reply share drafts answers to the thread's own people only (a@b.io isn't in the thread).
    expect(await level(draft(w.dReply.c, true))).toBe("403 share_level");
    expect((await w.dReply.c.post("/api/mail/drafts", { mailboxId: w.boxes.personal, to: [`secret.sender.pers@private.example`], subject: "x", text: "x", inReplyToId: w.msgs.personal })).status).toBeLessThan(300);
    expect(await level(draft(w.dReply.c, false))).toBe("403 share_level");
    expect((await draft(w.dSend.c, false)).status).toBeLessThan(300);
    expect((await draft(w.pat.c, false)).status).toBeLessThan(300);
    expect([403, 404]).toContain((await draft(w.admin.c, false)).status);
    expect([403, 404]).toContain((await draft(w.owner, false)).status);
    // A read only share can't change mail; Read and reply can.
    expect(await level(w.dRead.c.patch(`/api/mail/messages/${w.msgs.personal}`, { isStarred: true }))).toBe("403 share_level");
    expect((await w.dReply.c.patch(`/api/mail/messages/${w.msgs.personal}`, { isStarred: true })).status).toBe(200);
    // PRIV1b (F58): labels look the thread up in the reply scope, so a read share gets the thread's 404 (not any error).
    expect(await level(w.dRead.c.post("/api/mail/labels", { threadId: `thr_pers${w.n}aaaaaaaaaa`, label: "x" }))).toBe("404 not_found");
    expect((await w.dReply.c.post("/api/mail/labels", { threadId: `thr_pers${w.n}aaaaaaaaaa`, label: "x" })).status).toBe(200);
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

// PRIV1b tests hardening (F58, F59, F28, N9): the cases the first suite left out.
describe("PRIV1b share levels on delete, bulk and real send (F58)", () => {
  it("a read share deletes, trashes and sends nothing; reply answers the thread only; send as and the owner send", async () => {
    const w = await privacyWorld();
    const code = (r: { status: number; body: { error?: { code?: string } } }) => `${r.status} ${r.body?.error?.code}`;
    const folder = async () => (await w.ctx.db.select({ f: messages.folder }).from(messages).where(eq(messages.id, w.msgs.personal)).get())?.f;
    expect(code(await w.dRead.c.del(`/api/mail/messages/${w.msgs.personal}`))).toBe("403 share_level");
    for (const action of ["trash", "delete", "archive", "spam"]) {
      const r = await w.dRead.c.post("/api/mail/messages/bulk", { ids: [w.msgs.personal], action });
      expect([action, r.status, r.body.updated ?? r.body.error?.code]).toEqual([action, 200, 0]);
    }
    expect(await folder()).toBe("inbox");
    const outbox = (w.ctx.deps.outbound as LogOutbound).sent;
    const send = (c: Client, to: string, reply: boolean) => c.post("/api/mail/send", { mailboxId: w.boxes.personal, to: [to], subject: "Re: x", text: "x", ...(reply ? { inReplyToId: w.msgs.personal } : {}) });
    expect(code(await send(w.dRead.c, "secret.sender.pers@private.example", true))).toBe("403 share_level");
    expect(code(await send(w.dReply.c, "new.person@example.com", false))).toBe("403 share_level");
    expect(code(await send(w.dReply.c, "new.person@example.com", true))).toBe("403 share_level");
    expect([403, 404]).toContain((await send(w.admin.c, "new.person@example.com", false)).status);
    expect(outbox.filter((m) => m.from.address === `pat.private${w.n}@acme.io`)).toHaveLength(0);
    // Allowed: reply share answers the thread's own sender; send as and the owner write to anyone.
    expect((await send(w.dReply.c, "secret.sender.pers@private.example", true)).status).toBeLessThan(300);
    expect((await send(w.dSend.c, "new.person@example.com", false)).status).toBeLessThan(300);
    expect((await send(w.pat.c, "new.person@example.com", false)).status).toBeLessThan(300);
    expect(outbox.filter((m) => m.from.address === `pat.private${w.n}@acme.io`)).toHaveLength(3);
    // A reply share and the owner can trash it.
    expect((await w.dReply.c.post("/api/mail/messages/bulk", { ids: [w.msgs.personal], action: "trash" })).body.updated).toBe(1);
    expect(await folder()).toBe("trash");
    expect((await w.pat.c.del(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(200);
  }, 120_000);

  it("an admin with a read share can't put the mailbox on an agent (N9)", async () => {
    const w = await privacyWorld();
    await w.pat.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.admin.id}`, { level: "read" });
    expect((await w.admin.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(200);
    expect((await w.admin.c.post("/api/agents", { name: "Ada bot", localPart: `adabot${w.n}`, mailboxIds: [w.boxes.personal] })).status).toBe(403);
    expect((await w.admin.c.post("/api/agents", { name: "Ada team", localPart: `adateam${w.n}`, mailboxIds: [w.boxes.team] })).status).toBe(201);
  }, 60_000);
});

describe("PRIV1b orphan and owner left (F59)", () => {
  /** Each person's badge count agrees with their list, and the SQL form of the rule with the TS one. */
  async function agree(w: Awaited<ReturnType<typeof privacyWorld>>) {
    const who = { owner: w.owner, admin: w.admin.c, member: w.member.c, pat: w.pat.c, dRead: w.dRead.c, dSend: w.dSend.c, nobody: w.nobody.c };
    const ids = { owner: (await w.owner.get("/api/account/me")).body.user.id as string, admin: w.admin.id, member: w.member.id, pat: w.pat.id, dRead: w.dRead.id, dSend: w.dSend.id, nobody: w.nobody.id };
    const roles = { owner: "owner", admin: "admin" } as Record<string, "owner" | "admin">;
    const opens: string[] = [];
    for (const [k, c] of Object.entries(who)) {
      const listed = ((await c.get("/api/mail/messages?folder=inbox&limit=50")).body?.messages ?? []) as { id: string; isRead?: boolean }[];
      const n = (await c.get("/api/counts")).body?.mail?.inbox ?? 0;
      expect(`${k} counts ${n}`).toBe(`${k} counts ${listed.filter((m) => !m.isRead).length}`);
      if (listed.some((m) => m.id === w.msgs.personal)) opens.push(k);
      const me = { userId: ids[k as keyof typeof ids], orgId: w.orgId, role: roles[k] ?? "member" };
      const ts = await scopeFor(w.ctx.db, me);
      const all = (await w.ctx.db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.orgId, w.orgId)).all()).map((r) => r.id);
      const sql = (await w.ctx.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.orgId, w.orgId), scopeCond(me, mailboxes.id))).all()).map((r) => r.id);
      expect([k, [...(ts ?? all)].sort()]).toEqual([k, sql.sort()]);
    }
    return opens;
  }

  it("counts, lists and both forms of the rule agree: base, orphan, owner left; stale grants and shares open nothing", async () => {
    const w = await privacyWorld();
    // An admin who is also a delegate, and a member with a grant left over from before 0164.
    await w.pat.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.admin.id}`, { level: "read" });
    await w.ctx.db.insert(mailboxAccess).values({ orgId: w.orgId, userId: w.member.id, mailboxId: w.boxes.personal });
    expect((await agree(w)).sort()).toEqual(["admin", "dRead", "dSend", "pat"]);
    // Orphan (no owner): only the workspace owner, and only to read; shares and grants count for nothing.
    await w.ctx.db.update(mailboxes).set({ ownerUserId: null }).where(eq(mailboxes.id, w.boxes.personal));
    expect(await agree(w)).toEqual(["owner"]);
    expect((await w.member.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(404);
    expect((await w.owner.post("/api/mail/drafts", { mailboxId: w.boxes.personal, to: ["a@example.com"], subject: "x", text: "x" })).status).toBe(403);
    // Owner left the workspace: the same, and the delegates lose it.
    await w.ctx.db.update(mailboxes).set({ ownerUserId: w.pat.id }).where(eq(mailboxes.id, w.boxes.personal));
    await w.ctx.db.delete(members).where(eq(members.userId, w.pat.id));
    expect(await agree(w)).toEqual(["owner"]);
    for (const c of [w.dRead.c, w.dSend.c, w.admin.c]) expect((await c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(404);
  }, 120_000);

  it("a delegate removed from the workspace and invited back gets nothing back (F28)", async () => {
    const w = await privacyWorld();
    expect((await w.admin.c.del(`/api/team/members/${w.dRead.id}`)).status).toBe(200);
    const shares = async () => ((await w.pat.c.get(`/api/mailboxes/${w.boxes.personal}/sharing`)).body.shares as { userId?: string; id?: string }[]).map((x) => x.userId ?? x.id);
    expect(await shares()).not.toContain(w.dRead.id);
    const inv = await w.owner.post("/api/team/invites", { email: `rae${w.n}@acme.io`, role: "member" });
    expect(inv.status).toBe(201);
    expect((await w.dRead.c.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    expect((await w.dRead.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(404);
    expect(JSON.stringify((await w.dRead.c.get("/api/mail/messages?folder=inbox")).body)).not.toContain(w.msgs.personal);
    expect(await shares()).not.toContain(w.dRead.id);
    // Pat shares again on purpose: it works.
    expect((await w.pat.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.dRead.id}`, { level: "read" })).status).toBe(200);
    expect((await w.dRead.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(200);
  }, 120_000);
});

describe("PRIV1b migration 0164: every backfill statement has a fixture (F31)", () => {
  it("connected, claimed, single grant and admin connected inboxes each get the owner the statements say", async () => {
    const w = await privacyWorld();
    const box = (tag: string) => ({ id: `mbx_${tag}${w.n}mig000000`, orgId: w.orgId, domainId: w.domainId, localPart: `${tag}${w.n}`, address: `${tag}${w.n}@acme.io`, displayName: tag, quotaMb: 1 });
    const ids = { conn: box("conn").id, claim: box("claim").id, grant1: box("grantone").id, grant2: box("granttwo").id, adminConn: box("support").id, stranger: box("stranger").id };
    await w.ctx.db.insert(mailboxes).values(["conn", "claim", "grantone", "granttwo", "support", "stranger"].map(box));
    const base = { orgId: w.orgId, provider: "custom", username: "u", imapHost: "imap.sample.example", imapPort: 993, imapSecurity: "tls" as const, smtpHost: "s.example", smtpPort: 465, smtpSecurity: "tls" as const, secretEnc: "sample:none" };
    await w.ctx.db.insert(mailConnections).values([
      // UPDATE 1 and 3: connected, owner = the connector while a member.
      { ...base, id: `mcn_c${w.n}mig0000000`, mailboxId: ids.conn, email: `conn${w.n}@acme.io`, createdByUserId: w.nobody.id },
      // UPDATE 1, then 5: connector unknown, one grant, so the grantee owns it.
      { ...base, id: `mcn_g${w.n}mig0000000`, mailboxId: ids.grant1, email: `grantone${w.n}@acme.io`, createdByUserId: null },
      // UPDATE 1, 5 skipped: two grants, nobody owns it (the workspace owner opens it, to read).
      { ...base, id: `mcn_h${w.n}mig0000000`, mailboxId: ids.grant2, email: `granttwo${w.n}@acme.io`, createdByUserId: null },
      // The team's shared support@ Gmail an admin connected and granted to Max: becomes the admin's (design choice 2, P25).
      { ...base, id: `mcn_s${w.n}mig0000000`, mailboxId: ids.adminConn, email: `support${w.n}@acme.io`, createdByUserId: w.admin.id },
    ]);
    await w.ctx.db.insert(mailboxAccess).values([
      { orgId: w.orgId, userId: w.member.id, mailboxId: ids.grant1 },
      { orgId: w.orgId, userId: w.member.id, mailboxId: ids.grant2 }, { orgId: w.orgId, userId: w.dRead.id, mailboxId: ids.grant2 },
      { orgId: w.orgId, userId: w.member.id, mailboxId: ids.adminConn },
    ]);
    // UPDATE 2 and 4: a claimed free address, owner = the claimer; one claimed by someone who is no member stays unowned.
    await w.ctx.db.insert(auditLogs).values([
      { id: `aud_c${w.n}mig000000`, orgId: w.orgId, actorUserId: w.dSend.id, action: "free_address.claimed", targetType: "mailbox", targetId: ids.claim },
      { id: `aud_s${w.n}mig000000`, orgId: w.orgId, actorUserId: "usr_gone000000000", action: "free_address.claimed", targetType: "mailbox", targetId: ids.stranger },
    ]);
    const m = MIGRATIONS.find((x) => x.name.startsWith("0164_"))!;
    const updates = m.statements.filter((x) => x.startsWith("UPDATE `mailboxes`"));
    expect(updates).toHaveLength(5);
    const raw = (w.ctx.db as unknown as { $client: { exec: (s: string) => void } }).$client;
    const row = async (id: string) => { const r = await w.ctx.db.select({ p: mailboxes.personal, o: mailboxes.ownerUserId }).from(mailboxes).where(eq(mailboxes.id, id)).get(); return [r!.p, r!.o]; };
    const want = { conn: [true, w.nobody.id], claim: [true, w.dSend.id], grant1: [true, w.member.id], grant2: [true, null], adminConn: [true, w.admin.id], stranger: [true, null] };
    // Each statement matters: leaving any one out changes at least one row.
    for (let skip = 0; skip < updates.length; skip++) {
      await w.ctx.db.update(mailboxes).set({ personal: false, ownerUserId: null }).where(eq(mailboxes.orgId, w.orgId));
      await w.ctx.db.update(mailboxes).set({ personal: true, ownerUserId: w.pat.id }).where(eq(mailboxes.id, w.boxes.personal));
      updates.forEach((s, i) => i !== skip && raw.exec(s));
      const got = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await row(id)])));
      expect([skip, got]).not.toEqual([skip, want]);
    }
    for (let i = 0; i < 2; i++) for (const s of updates) raw.exec(s); // all of them, twice: idempotent
    expect(Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await row(id)])))).toEqual(want);
    expect(await row(w.boxes.team)).toEqual([false, null]);
    // Who opens what afterwards. The admin connected support@ is the admin's now and Max's old grant opens nothing:
    // pinned here so the open decision (design choice 2) changes this line on purpose, not by accident.
    const ov = async (c: Client) => JSON.stringify((await c.get("/api/mail/overview")).body);
    expect(await ov(w.member.c)).toContain(ids.grant1);
    expect(await ov(w.member.c)).not.toContain(ids.adminConn);
    expect(await ov(w.admin.c)).toContain(ids.adminConn);
    expect(await ov(w.dSend.c)).toContain(ids.claim);
    expect(await ov(w.owner)).toContain(ids.grant2);
    expect(await ov(w.owner)).not.toContain(ids.claim);
  }, 120_000);
});

describe("PRIV1b comp plan through the real Stripe webhook and grace job (F60, W3)", () => {
  it("signed subscription, checkout and invoice events never downgrade or pause a comp workspace; a paying one still is", async () => {
    const STRIPE = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_BUSINESS: "price_biz" };
    const sub = (customer: string, status: string, price: string, orgId: string) => ({ id: `sub_${customer}`, object: "subscription", customer, status, cancel_at_period_end: false, items: { data: [{ price: { id: price }, current_period_end: 1762600000 }] }, metadata: { orgId } });
    let orgIds: Record<string, string> = {};
    const fakeStripe = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
      if (path.startsWith("/v1/subscriptions/sub_")) { const cus = path.slice("/v1/subscriptions/sub_".length); return json(sub(cus, "active", "price_pro", orgIds[cus]!)); }
      return json({ object: "list", data: [], has_more: false });
    }) as typeof fetch;
    const w = await privacyWorld({ env: STRIPE, fetch: fakeStripe });
    // A second, paying workspace (the outsider's) shows the same events do change a normal workspace.
    const paidOrg = (await w.outsider.get("/api/account/me")).body.organization.id as string;
    orgIds = { cus_comp: w.orgId, cus_paid: paidOrg };
    const past = new Date(Date.now() - 30 * 86_400_000);
    await w.ctx.db.update(organizations).set({ plan: "business", compPlan: true, stripeCustomerId: "cus_comp", pastDueSince: past, graceEndsAt: new Date(Date.now() - 86_400_000) }).where(eq(organizations.id, w.orgId));
    await w.ctx.db.update(organizations).set({ plan: "business", stripeCustomerId: "cus_paid" }).where(eq(organizations.id, paidOrg));
    let seq = 0;
    const post = async (type: string, object: unknown) => {
      const raw = JSON.stringify({ id: `evt_comp${w.n}_${++seq}`, object: "event", type, data: { object } });
      const res = await w.ctx.app.request("/api/webhooks/stripe", { method: "POST", body: raw, headers: { "stripe-signature": await signStripePayload(stripeClient("sk_test_fake", fetch), raw, "whsec_test", new Date()), "content-type": "application/json" } });
      return res.status;
    };
    const org = async (id: string) => (await w.ctx.db.select().from(organizations).where(eq(organizations.id, id)).get())!;
    for (const cus of ["cus_comp", "cus_paid"]) {
      expect(await post("customer.subscription.updated", sub(cus, "active", "price_pro", orgIds[cus]!))).toBe(200);
      expect(await post("checkout.session.completed", { id: "cs_x", object: "checkout.session", subscription: `sub_${cus}`, metadata: { orgId: orgIds[cus] } })).toBe(200);
      expect(await post("customer.subscription.deleted", sub(cus, "canceled", "price_pro", orgIds[cus]!))).toBe(200);
      expect(await post("invoice.payment_failed", { id: "in_x", object: "invoice", customer: cus, amount_due: 100, currency: "aud" })).toBe(200);
    }
    const comp = await org(w.orgId);
    expect([comp.plan, comp.compPlan]).toEqual(["business", true]);
    expect((await getPlan(w.ctx.db, w.orgId)).id).toBe("business");
    expect((await org(paidOrg)).plan).not.toBe("business"); // the same events downgrade a paying workspace
    expect((await org(paidOrg)).pastDueSince).not.toBeNull();
    // W3: the grace job never tells a comp workspace that sending is paused (its old pastDueSince predates the flag).
    const before = (w.ctx.deps.outbound as LogOutbound).sent.length;
    await enforceGracePeriods(w.ctx.deps);
    const notices = (w.ctx.deps.outbound as LogOutbound).sent.slice(before).filter((m) => m.subject.startsWith("Sending is paused"));
    expect(notices.map((m) => m.subject)).not.toContain(`Sending is paused for ${comp.name}`);
    expect(await w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, w.orgId), eq(auditLogs.action, "billing.grace_ended"))).all()).toHaveLength(0);
    // A paying workspace past its grace end still gets it.
    await w.ctx.db.update(organizations).set({ graceEndsAt: new Date(Date.now() - 1000) }).where(eq(organizations.id, paidOrg));
    expect((await enforceGracePeriods(w.ctx.deps)).notified).toBe(1);
  }, 60_000);
});
