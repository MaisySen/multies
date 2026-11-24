/**
 * PRIV1b P37 (round 2, owner decision): a mailbox at a human member's sign in address receives that person's account
 * mail (password resets, sign in links), so it is that person's personal mailbox: only they open it, whoever created it.
 * Migration 0174 does the same for existing team mailboxes, leaving out the mailboxes the platform relies on.
 */
import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { agentMailboxAccess, auditLogs, authEmailHooks, domains, mailboxAccess, mailboxes } from "@/server/db/schema";
import { Client } from "./helpers";
import { MIGRATIONS } from "@/server/db/migrations.generated";

type W = Awaited<ReturnType<typeof privacyWorld>>;
const box = async (w: W, id: string) => (await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get())!;

describe("PRIV1b P37: a mailbox at a member's sign in address is theirs", () => {
  it("made by an admin (app or API) or by the person, it is the person's personal mailbox; team addresses stay team", async () => {
    const w = await privacyWorld();
    const pat = await w.admin.c.post("/api/mailboxes", { domainId: w.domainId, localPart: `pat${w.n}`, displayName: "Pat" });
    expect(pat.status).toBe(201);
    expect(await box(w, pat.body.mailbox.id)).toMatchObject({ personal: true, ownerUserId: w.pat.id });
    // The admin who made it can't open it; Pat can.
    const adminList = (await w.admin.c.get("/api/mailboxes")).body.mailboxes as { id: string; openable?: boolean }[];
    expect(adminList.find((m) => m.id === pat.body.mailbox.id)?.openable).toBe(false);
    const patList = (await w.pat.c.get("/api/mailboxes")).body.mailboxes as { id: string; openable?: boolean }[];
    expect(patList.find((m) => m.id === pat.body.mailbox.id)?.openable).toBe(true);
    // Her own, made by herself (the owner).
    const olive = await w.owner.post("/api/mailboxes", { domainId: w.domainId, localPart: `olive${w.n}`, displayName: "Olive" });
    const oliveId = (await w.owner.get("/api/account/me")).body.user.id as string;
    expect(await box(w, olive.body.mailbox.id)).toMatchObject({ personal: true, ownerUserId: oliveId });
    // Through the API with a key.
    const key = (await w.admin.c.post("/api/developer/keys", { name: "k" })).body.secret as string;
    const viaKey = await w.ctx.app.request("/api/v1/mailboxes", { method: "POST", headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ domainId: w.domainId, localPart: `max${w.n}`, displayName: "Max" }) });
    expect(viaKey.status).toBe(201);
    const maxId = ((await viaKey.json()) as { id: string }).id;
    expect(await box(w, maxId)).toMatchObject({ personal: true, ownerUserId: w.member.id });
    // A team address is a team mailbox.
    const ops = await w.admin.c.post("/api/mailboxes", { domainId: w.domainId, localPart: `ops${w.n}`, displayName: "Ops" });
    expect(await box(w, ops.body.mailbox.id)).toMatchObject({ personal: false, ownerUserId: null });
  }, 120_000);

  it("migration 0174 converts existing team mailboxes at a member's address, except the ones the platform relies on", async () => {
    const w = await privacyWorld();
    const mk = async (local: string, extra: Partial<typeof mailboxes.$inferInsert> = {}) => {
      const id = `mbx_p37${local.replace(/[^a-z0-9]/g, "")}`;
      await w.ctx.db.insert(mailboxes).values({ id, orgId: w.orgId, domainId: w.domainId, localPart: local, address: `${local}@acme.io`, displayName: local, quotaMb: 100, ...extra });
      return id;
    };
    const pat = await mk(`pat${w.n}`); // an admin made it before the rule
    const ada = await mk(`ada${w.n}`); // sends sign-up emails: stays a team mailbox
    await w.ctx.db.insert(authEmailHooks).values({ id: "ahk_p37", orgId: w.orgId, mailboxId: ada, kind: "supabase", secretEnc: "x", supabaseUrl: "https://abcd1234.supabase.co", appName: "Acme" });
    const max = await mk(`max${w.n}`); // a catch-all: stays
    await w.ctx.db.update(domains).set({ catchAllMailboxId: max }).where(eq(domains.id, w.domainId));
    const ops = await mk(`ops${w.n}`); // nobody signs in with it
    // Rae signs in with an address that is an agent's inbox here, and Rex with support@: both stay.
    await w.ctx.db.run(sql`update users set email = ${`bot${w.n}@acme.io`} where id = ${w.dRead.id}`);
    await w.ctx.db.run(sql`update users set email = 'support@acme.io' where id = ${w.dReply.id}`);
    const support = await mk("support");
    // Wave 1 review V12: Sam's address is a team mailbox granted to Max (team use), and Nia's is worked by an agent: both stay.
    const sam = await mk(`sam${w.n}`);
    await w.ctx.db.insert(mailboxAccess).values({ orgId: w.orgId, userId: w.member.id, mailboxId: sam });
    const nia = await mk(`nia${w.n}`);
    const ag = await w.admin.c.post("/api/agents", { name: "Helper", localPart: `helper${w.n}`, mailboxIds: [w.boxes.team] });
    await w.ctx.db.insert(agentMailboxAccess).values({ agentId: ag.body.agent.id, mailboxId: nia, orgId: w.orgId });
    // A grant to the member herself doesn't count as team use.
    await w.ctx.db.insert(mailboxAccess).values({ orgId: w.orgId, userId: w.pat.id, mailboxId: pat });

    const m = MIGRATIONS.find((x) => x.name.startsWith("0174_"))!;
    expect(m).toBeTruthy();
    for (const st of m.statements) await w.ctx.db.run(sql.raw(st));

    expect(await box(w, pat)).toMatchObject({ personal: true, ownerUserId: w.pat.id });
    for (const id of [ada, max, ops, support, sam, nia, w.boxes.agent, w.boxes.team]) expect(await box(w, id), id).toMatchObject({ personal: false });
    // Admins see the ones left at a member's sign in address.
    const notice = (await w.owner.get("/api/mailboxes/privacy/mine")).body.loginAddressTeam as { address: string }[];
    expect(notice.map((x) => x.address).sort()).toEqual(expect.arrayContaining([`sam${w.n}@acme.io`, `nia${w.n}@acme.io`, "support@acme.io"]));
    expect((await w.member.c.get("/api/mailboxes/privacy/mine")).body.loginAddressTeam).toEqual([]);
    // Already personal mailboxes keep their owner.
    expect(await box(w, w.boxes.personal)).toMatchObject({ personal: true, ownerUserId: w.pat.id });
  }, 120_000);

  it("Wave 2 review X3: joining or changing address converts nothing; the workspace owner converts a listed mailbox", async () => {
    const w = await privacyWorld();
    const mk = async (local: string) => {
      const id = `mbx_v12${local.replace(/[^a-z0-9]/g, "")}`;
      await w.ctx.db.insert(mailboxes).values({ id, orgId: w.orgId, domainId: w.domainId, localPart: local, address: `${local}@acme.io`, displayName: local, quotaMb: 100 });
      return id;
    };
    const zoe = await mk(`zoe${w.n}`);
    const yan = await mk(`yan${w.n}`);
    await w.ctx.db.insert(mailboxAccess).values({ orgId: w.orgId, userId: w.member.id, mailboxId: yan });
    const join = async (email: string) => {
      const inv = await w.owner.post("/api/team/invites", { email, role: "member" });
      const c = new Client(w.ctx.app);
      await c.call("POST", "/api/auth/sign-up/email", { name: "New", email, password: "a-strong-password" }, { "cf-connecting-ip": `10.77.${w.n % 250}.${email.length}` });
      c.email = email;
      const acc = await c.call("POST", `/api/invites/${inv.body.link.split("/invite/")[1]}/accept`, {}, { "cf-connecting-ip": `10.78.${w.n % 250}.${email.length}` });
      // The first request after sign up may already have joined through the pending invite (410 invite_used then).
      expect([200, 410]).toContain(acc.status);
      expect((await c.get("/api/account/me")).status).toBe(200);
      return c;
    };
    // An admin inviting an unshared team mailbox's address no longer hands it to whoever accepts.
    const zoeClient = await join(`zoe${w.n}@acme.io`);
    await join(`yan${w.n}@acme.io`);
    expect(await box(w, zoe)).toMatchObject({ personal: false, ownerUserId: null });
    expect(await box(w, yan)).toMatchObject({ personal: false });
    const notice = (await w.owner.get("/api/mailboxes/privacy/mine")).body.loginAddressTeam as { id: string; address: string }[];
    expect(notice.map((x) => x.address)).toEqual(expect.arrayContaining([`zoe${w.n}@acme.io`, `yan${w.n}@acme.io`]));
    expect(Object.keys(notice[0]).sort()).toEqual(["address", "id", "member"]);
    // Only the workspace owner converts: an admin, the member herself and a member are refused.
    expect((await w.admin.c.post(`/api/mailboxes/${zoe}/make-personal`, {})).status).toBe(403);
    expect((await zoeClient.post(`/api/mailboxes/${zoe}/make-personal`, {})).status).toBe(403);
    expect((await w.member.c.post(`/api/mailboxes/${zoe}/make-personal`, {})).status).toBe(403);
    expect(await box(w, zoe)).toMatchObject({ personal: false });
    // A mailbox not in the list (a plain team address) is not found.
    expect((await w.owner.post(`/api/mailboxes/${w.boxes.team}/make-personal`, {})).status).toBe(404);
    const made = await w.owner.post(`/api/mailboxes/${zoe}/make-personal`, {});
    expect(made.status).toBe(200);
    expect(await box(w, zoe)).toMatchObject({ personal: true });
    expect((await box(w, zoe)).ownerUserId).toBeTruthy();
    const log = await w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.targetId, zoe), eq(auditLogs.action, "mailbox.made_personal_by_owner"))).all();
    expect(log).toHaveLength(1);
    expect((await w.owner.post(`/api/mailboxes/${zoe}/make-personal`, {})).status).toBe(404);
    // A shared one: the owner's confirmation ends the other grants (the audit says how many).
    const y = await w.owner.post(`/api/mailboxes/${yan}/make-personal`, {});
    expect(y.status).toBe(200);
    expect(y.body.mailbox.grantsEnded).toBe(1);
    expect(await w.ctx.db.select().from(mailboxAccess).where(eq(mailboxAccess.mailboxId, yan)).all()).toEqual([]);
    // A changed sign in address converts nothing either; the mailbox is listed for the owner.
    const rae = await mk(`rae.new${w.n}`);
    await w.ctx.db.run(sql`update users set email = ${`rae.new${w.n}@acme.io`} where id = ${w.dRead.id}`);
    expect(await box(w, rae)).toMatchObject({ personal: false });
    expect(((await w.owner.get("/api/mailboxes/privacy/mine")).body.loginAddressTeam as { id: string }[]).map((x) => x.id)).toContain(rae);
    // A catch-all or the sign-up emails mailbox stays a team mailbox, with the reason.
    await w.ctx.db.update(domains).set({ catchAllMailboxId: rae }).where(eq(domains.id, w.domainId));
    const ca = await w.owner.post(`/api/mailboxes/${rae}/make-personal`, {});
    expect(ca.status).toBe(409);
    expect(await box(w, rae)).toMatchObject({ personal: false });
  }, 120_000);
});
