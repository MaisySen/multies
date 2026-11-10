/**
 * PRIV1b admin-control, app passwords: P6 (only the owner makes them on a personal mailbox, the owner lists and revokes
 * every one, unsharing destroys a delegate's) and P42 (old ones made before the mailbox became personal are swept).
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { fakeStalwart } from "./fake-stalwart";
import { verifiedDomain } from "./priv1a-world";
import { appPasswords, mailboxes, organizations, users } from "@/server/db/schema";
import { sweepForeignAppPasswords } from "@/server/services/mailserver";
import { runMaintenance } from "@/server/services/maintenance";

let ip = 0;
class IpClient extends Client {
  ip = `10.18.0.${++ip}`;
  override call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return super.call(method, path, body, { "cf-connecting-ip": this.ip, ...headers });
  }
}

async function world() {
  const server = fakeStalwart();
  const ctx = await makeTestApp({ ...server.env, MAIL_CLIENT_HOST: "mail.acme-hosting.net" }, { fetch: server.fetch });
  const owner = new IpClient(ctx.app);
  await owner.signup("olive@acme.io", "Olive Owner");
  const orgId = (await owner.get("/api/account/me")).body.organization.id as string;
  await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId));
  const domainId = await verifiedDomain(ctx, owner, "acme.io");
  const join = async (email: string, name: string, role: "admin" | "member" = "member") => {
    const inv = await owner.post("/api/team/invites", { email, role, mailboxIds: [] });
    const c = new IpClient(ctx.app);
    await c.signup(email, name, "");
    await c.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
    const id = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get())!.id;
    return { c, id };
  };
  const ada = await join("ada@acme.io", "Ada Admin", "admin");
  const pat = await join("pat@acme.io", "Pat");
  const rae = await join("rae@acme.io", "Rae");
  const sam = await join("sam@acme.io", "Sam");
  const personal = "mbx_patpersonal00000";
  await ctx.db.insert(mailboxes).values({ id: personal, orgId, domainId, localPart: "pat.private", address: "pat.private@acme.io", displayName: "Pat", quotaMb: 100, personal: true, ownerUserId: pat.id });
  expect((await pat.c.put(`/api/mailboxes/${personal}/sharing/${rae.id}`, { level: "read" })).status).toBe(200);
  expect((await pat.c.put(`/api/mailboxes/${personal}/sharing/${sam.id}`, { level: "send_as" })).status).toBe(200);
  const acct = (name: string) => [...server.accounts.values()].find((a) => a.name === name)!;
  return { ctx, server, owner, orgId, domainId, ada, pat, rae, sam, personal, acct };
}

describe("PRIV1b (P6) app passwords on a personal mailbox", () => {
  it("only the owner makes one; the owner sees and revokes all; unsharing destroys a delegate's", async () => {
    const w = await world();
    const make = (c: Client, mbx: string) => c.post(`/api/mail-access/mailboxes/${mbx}/app-passwords`, { name: "Laptop" });
    expect((await make(w.rae.c, w.personal)).status).toBe(403);
    expect((await make(w.sam.c, w.personal)).status).toBe(403);
    expect((await make(w.ada.c, w.personal)).status).toBe(404);
    expect((await make(w.owner, w.personal)).status).toBe(404);
    const own = await make(w.pat.c, w.personal);
    expect(own.status).toBe(201);
    const acct = w.acct("pat.private");
    expect(acct.appPasswords.size).toBe(1);
    // One a delegate made before this fix (simulated): Pat sees it and Rae only sees her own.
    const made2 = await make(w.pat.c, w.personal);
    await w.ctx.db.update(appPasswords).set({ createdByUserId: w.rae.id }).where(eq(appPasswords.id, made2.body.appPassword.id));
    const patList = await w.pat.c.get(`/api/mail-access/mailboxes/${w.personal}/app-passwords`);
    expect(patList.body.appPasswords).toHaveLength(2);
    const samList = await w.sam.c.get(`/api/mail-access/mailboxes/${w.personal}/app-passwords`);
    expect(samList.status).toBe(200);
    expect(samList.body.appPasswords).toHaveLength(0);
    const raeList = await w.rae.c.get(`/api/mail-access/mailboxes/${w.personal}/app-passwords`);
    expect(raeList.body.appPasswords.map((p: { id: string }) => p.id)).toEqual([made2.body.appPassword.id]);
    // Sam can't revoke Pat's; Ada and Olive can't reach it.
    expect((await w.sam.c.del(`/api/mail-access/app-passwords/${own.body.appPassword.id}`)).status).toBe(403);
    expect((await w.ada.c.del(`/api/mail-access/app-passwords/${own.body.appPassword.id}`)).status).toBe(404);
    // Pat stops sharing with Rae: Rae's app password goes from the mail server too; Pat's stays.
    expect((await w.pat.c.del(`/api/mailboxes/${w.personal}/sharing/${w.rae.id}`)).status).toBe(200);
    expect(acct.appPasswords.size).toBe(1);
    expect(await w.ctx.db.select().from(appPasswords).where(eq(appPasswords.mailboxId, w.personal)).all()).toHaveLength(1);
    // Pat revokes her own.
    expect((await w.pat.c.del(`/api/mail-access/app-passwords/${own.body.appPassword.id}`)).status).toBe(200);
    expect(acct.appPasswords.size).toBe(0);
  }, 120_000);

  it("a team mailbox keeps the old rules", async () => {
    const w = await world();
    const team = (await w.owner.post("/api/mailboxes", { domainId: w.domainId, localPart: "team", displayName: "Team" })).body.mailbox.id as string;
    const made = await w.ada.c.post(`/api/mail-access/mailboxes/${team}/app-passwords`, { name: "Ada" });
    expect(made.status).toBe(201);
    expect((await w.owner.get(`/api/mail-access/mailboxes/${team}/app-passwords`)).body.appPasswords).toHaveLength(1);
    expect((await w.owner.del(`/api/mail-access/app-passwords/${made.body.appPassword.id}`)).status).toBe(200);
  }, 120_000);
});

describe("PRIV1b (P42) app passwords from before a mailbox became personal", () => {
  it("the new owner sees and revokes them, and the sweep destroys the rest", async () => {
    const w = await world();
    const box = (await w.owner.post("/api/mailboxes", { domainId: w.domainId, localPart: "shared", displayName: "Shared" })).body.mailbox.id as string;
    const a1 = await w.ada.c.post(`/api/mail-access/mailboxes/${box}/app-passwords`, { name: "Ada 1" });
    const a2 = await w.ada.c.post(`/api/mail-access/mailboxes/${box}/app-passwords`, { name: "Ada 2" });
    expect(a1.status).toBe(201);
    expect(a2.status).toBe(201);
    // Migration 0164 made it Pat's personal mailbox.
    await w.ctx.db.update(mailboxes).set({ personal: true, ownerUserId: w.pat.id }).where(eq(mailboxes.id, box));
    const pp = await w.pat.c.post(`/api/mail-access/mailboxes/${box}/app-passwords`, { name: "Pat" });
    expect(pp.status).toBe(201);
    const acct = w.acct("shared");
    expect(acct.appPasswords.size).toBe(3);
    expect((await w.pat.c.get(`/api/mail-access/mailboxes/${box}/app-passwords`)).body.appPasswords).toHaveLength(3);
    expect((await w.pat.c.del(`/api/mail-access/app-passwords/${a1.body.appPassword.id}`)).status).toBe(200);
    expect(acct.appPasswords.size).toBe(2);
    // The sweep takes Ada's other one and leaves Pat's.
    expect(await sweepForeignAppPasswords(w.ctx.deps)).toBe(1);
    expect(acct.appPasswords.size).toBe(1);
    const left = await w.ctx.db.select({ id: appPasswords.id }).from(appPasswords).where(eq(appPasswords.mailboxId, box)).all();
    expect(left.map((r) => r.id)).toEqual([pp.body.appPassword.id]);
    expect(await sweepForeignAppPasswords(w.ctx.deps)).toBe(0);
    // Orphaned: the workspace owner's own app password is kept, others go.
    await w.ctx.db.update(mailboxes).set({ ownerUserId: null }).where(eq(mailboxes.id, box));
    const op = await w.owner.post(`/api/mail-access/mailboxes/${box}/app-passwords`, { name: "Olive" });
    expect(op.status).toBe(201);
    expect(await sweepForeignAppPasswords(w.ctx.deps)).toBe(1); // Pat's, now that the mailbox is no longer hers
    const after = await w.ctx.db.select({ id: appPasswords.id }).from(appPasswords).where(eq(appPasswords.mailboxId, box)).all();
    expect(after.map((r) => r.id)).toEqual([op.body.appPassword.id]);
  }, 120_000);

  it("M1: one whose maker's account is gone (creator NULL) goes too, from unsharing and from the sweep", async () => {
    const w = await world();
    const box = (await w.owner.post("/api/mailboxes", { domainId: w.domainId, localPart: "gone", displayName: "Gone" })).body.mailbox.id as string;
    const a1 = await w.ada.c.post(`/api/mail-access/mailboxes/${box}/app-passwords`, { name: "Ada 1" });
    const a2 = await w.ada.c.post(`/api/mail-access/mailboxes/${box}/app-passwords`, { name: "Ada 2" });
    expect(a2.status).toBe(201);
    await w.ctx.db.update(mailboxes).set({ personal: true, ownerUserId: w.pat.id }).where(eq(mailboxes.id, box));
    const pp = await w.pat.c.post(`/api/mail-access/mailboxes/${box}/app-passwords`, { name: "Pat" });
    expect(pp.status).toBe(201);
    // ON DELETE SET NULL after Ada's account goes.
    await w.ctx.db.update(appPasswords).set({ createdByUserId: null }).where(eq(appPasswords.mailboxId, box));
    await w.ctx.db.update(appPasswords).set({ createdByUserId: w.pat.id }).where(eq(appPasswords.id, pp.body.appPassword.id));
    const acct = w.acct("gone");
    expect(acct.appPasswords.size).toBe(3);
    // Unsharing someone on that mailbox takes the NULL one(s) too.
    expect((await w.pat.c.put(`/api/mailboxes/${box}/sharing/${w.rae.id}`, { level: "read" })).status).toBe(200);
    expect((await w.pat.c.del(`/api/mailboxes/${box}/sharing/${w.rae.id}`)).status).toBe(200);
    const left = await w.ctx.db.select({ id: appPasswords.id }).from(appPasswords).where(eq(appPasswords.mailboxId, box)).all();
    expect(left.map((r) => r.id)).toEqual([pp.body.appPassword.id]);
    expect(acct.appPasswords.size).toBe(1);
    expect(a1.status).toBe(201);
  }, 120_000);

  it("M1, S4: the maintenance pass sweeps a NULL creator one and keeps the owner's", async () => {
    const w = await world();
    const box = (await w.owner.post("/api/mailboxes", { domainId: w.domainId, localPart: "swept", displayName: "Swept" })).body.mailbox.id as string;
    const a1 = await w.ada.c.post(`/api/mail-access/mailboxes/${box}/app-passwords`, { name: "Ada" });
    expect(a1.status).toBe(201);
    await w.ctx.db.update(mailboxes).set({ personal: true, ownerUserId: w.pat.id }).where(eq(mailboxes.id, box));
    const pp = await w.pat.c.post(`/api/mail-access/mailboxes/${box}/app-passwords`, { name: "Pat" });
    await w.ctx.db.update(appPasswords).set({ createdByUserId: null }).where(eq(appPasswords.id, a1.body.appPassword.id));
    const acct = w.acct("swept");
    expect(acct.appPasswords.size).toBe(2);
    await runMaintenance(w.ctx.deps);
    const left = await w.ctx.db.select({ id: appPasswords.id }).from(appPasswords).where(eq(appPasswords.mailboxId, box)).all();
    expect(left.map((r) => r.id)).toEqual([pp.body.appPassword.id]);
    expect(acct.appPasswords.size).toBe(1);
  }, 120_000);
});
