/**
 * PRIV1b rule-lifecycle: P9 (shares and orphans follow membership; leaving ends shares, pauses the connection and
 * destroys app passwords), P17 (the access log logs only openers, and the Team inbox reader and attachments log),
 * P26 (a free address claimed with an API key is a team mailbox), P28 (orphans are in the workspace owner's export),
 * P29 (one read for the log, no second picture load), P30 (whoCanOpen keeps the owner past 90 shares).
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import { privacyWorld } from "./priv1a-world";
import { appPasswords, dataMoves, mailboxAccessLog, mailboxDelegations, mailboxes, mailConnections, members, users } from "@/server/db/schema";
import { canOpen, whoCanOpen } from "@/server/services/mail-access-priv1a";
import * as access from "@/server/services/mail-access-priv1a";

type W = Awaited<ReturnType<typeof privacyWorld>>;
type C = W["owner"];

const draft = (c: C, mailboxId: string) => c.post("/api/mail/drafts", { mailboxId, to: ["a@b.io"], subject: "x", text: "x" });

async function connect(w: W) {
  await w.ctx.db.insert(mailConnections).values({
    id: `mcn_pat${w.n}aaaaaaaa`, orgId: w.orgId, mailboxId: w.boxes.personal, provider: "gmail", email: `pat.private${w.n}@acme.io`, username: `pat.private${w.n}@acme.io`,
    imapHost: "imap.gmail.com", imapPort: 993, imapSecurity: "tls", smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecurity: "tls",
    authKind: "oauth", secretEnc: "enc:pat-refresh-token", status: "active", createdByUserId: w.pat.id,
  } as never);
  const pw = (id: string, by: string) => ({ id, orgId: w.orgId, mailboxId: w.boxes.personal, createdByUserId: by, name: "Laptop", serverCredentialId: `cred_${id}`, hint: "abcd" });
  await w.ctx.db.insert(appPasswords).values([pw(`apw_pat${w.n}`, w.pat.id), pw(`apw_sam${w.n}`, w.dSend.id)]);
}
const shares = (w: W) => w.ctx.db.select().from(mailboxDelegations).where(eq(mailboxDelegations.mailboxId, w.boxes.personal));
const revoked = async (w: W) => (await w.ctx.db.select().from(mailboxAccessLog).where(and(eq(mailboxAccessLog.mailboxId, w.boxes.personal), eq(mailboxAccessLog.action, "share_revoked")))).map((r) => r.targetId).sort();
const status = async (w: W) => (await w.ctx.db.select({ s: mailConnections.status }).from(mailConnections).where(eq(mailConnections.mailboxId, w.boxes.personal)).get())?.s;
const pws = async (w: W) => (await w.ctx.db.select().from(appPasswords).where(eq(appPasswords.mailboxId, w.boxes.personal))).map((p) => p.id);

describe("PRIV1b (P9) personal mailboxes follow membership", () => {
  it("removing the owner: the workspace owner reads only, shares end, the connection pauses, app passwords go", async () => {
    const w = await privacyWorld();
    await connect(w);
    // Before: Pat drafts from it, the workspace owner can't see it.
    expect((await draft(w.pat.c, w.boxes.personal)).status).toBe(201);
    expect((await w.owner.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(404);
    expect((await w.owner.del(`/api/team/members/${w.pat.id}`)).status).toBe(200);
    // The workspace owner reads it (nobody is locked out of mail) but can't write or send from Pat's address.
    const open = await w.owner.get(`/api/mail/messages/${w.msgs.personal}`);
    expect(open.status).toBe(200);
    expect(open.body.message.subject).toBe(`SUBJECT-PERS-${w.n}`);
    const d = await draft(w.owner, w.boxes.personal);
    expect(d.status).toBe(403);
    expect(JSON.stringify(d.body)).not.toContain(`SUBJECT-PERS`);
    expect((await w.owner.post("/api/mail/send", { mailboxId: w.boxes.personal, to: ["a@b.io"], subject: "y", text: "y" })).status).toBe(403);
    expect(await canOpen(w.ctx.db, { userId: (await w.owner.get("/api/account/me")).body.user.id, orgId: w.orgId, role: "owner" }, w.boxes.personal, "send")).toBe(false);
    // Admins still see nothing; the delegates lost their shares.
    expect((await w.admin.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(404);
    expect((await draft(w.dSend.c, w.boxes.personal)).status).toBe(404);
    expect((await w.dRead.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(404);
    expect(await shares(w)).toHaveLength(0);
    expect(await revoked(w)).toEqual([w.dRead.id, w.dReply.id, w.dSend.id].sort());
    expect(await status(w)).toBe("paused");
    expect(await pws(w)).toEqual([]);
    // Team mail is untouched.
    expect((await w.admin.c.get(`/api/mail/messages/${w.msgs.team}`)).status).toBe(200);
    expect((await w.member.c.get(`/api/mail/messages/${w.msgs.team}`)).status).toBe(200);
  }, 180_000);

  it("a removed delegate's share ends and doesn't come back on a re-invite; others keep theirs", async () => {
    const w = await privacyWorld();
    expect((await w.dRead.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(200);
    expect((await w.owner.del(`/api/team/members/${w.dRead.id}`)).status).toBe(200);
    expect((await shares(w)).map((s) => s.userId).sort()).toEqual([w.dReply.id, w.dSend.id].sort());
    expect(await revoked(w)).toEqual([w.dRead.id]);
    const inv = await w.owner.post("/api/team/invites", { email: `rae${w.n}@acme.io`, role: "member" });
    expect(inv.status).toBe(201);
    expect((await w.dRead.c.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    const me = await w.dRead.c.get("/api/account/me");
    if (me.body?.organization?.id !== w.orgId) await w.dRead.c.post("/api/account/workspace", { organizationId: w.orgId });
    expect((await w.dRead.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(404);
    // Pat and the remaining delegates are unaffected.
    expect((await w.pat.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(200);
    expect((await w.dReply.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(200);
    expect((await draft(w.dSend.c, w.boxes.personal)).status).toBe(201);
  }, 180_000);

  it("a delegate who leaves on their own loses the share", async () => {
    const w = await privacyWorld();
    expect((await w.dSend.c.del(`/api/team/members/${w.dSend.id}`)).status).toBe(200);
    expect((await shares(w)).map((s) => s.userId)).not.toContain(w.dSend.id);
    expect(await revoked(w)).toEqual([w.dSend.id]);
  }, 180_000);

  it("account deletion ends the shares and pauses the connection; the workspace owner reads only", async () => {
    const w = await privacyWorld();
    await connect(w);
    const del = await w.pat.c.call("DELETE", "/api/account", { confirm: "DELETE", password: "a-strong-password" });
    expect(del.status).toBe(200);
    expect(await w.ctx.db.select().from(users).where(eq(users.id, w.pat.id)).get()).toBeFalsy();
    expect(await shares(w)).toHaveLength(0);
    expect(await revoked(w)).toEqual([w.dRead.id, w.dReply.id, w.dSend.id].sort());
    expect(await status(w)).toBe("paused");
    // Sam's app password (made under a share) went at once; Pat's goes with the maintenance sweep.
    expect(await pws(w)).not.toContain(`apw_sam${w.n}`);
    expect((await w.owner.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(200);
    expect((await draft(w.owner, w.boxes.personal)).status).toBe(403);
    expect((await draft(w.dSend.c, w.boxes.personal)).status).toBe(404);
    expect((await w.dRead.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(404);
  }, 180_000);

  it("the rule: shares count only while the owner is a member, even if rows were left behind", async () => {
    const w = await privacyWorld();
    await w.ctx.db.delete(members).where(eq(members.userId, w.pat.id)); // no cleanup ran
    expect((await w.dRead.c.get(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(404);
    expect((await draft(w.dSend.c, w.boxes.personal)).status).toBe(404);
    expect(JSON.stringify((await w.dSend.c.get("/api/mail/overview")).body)).not.toContain(w.boxes.personal);
    expect((await w.dSend.c.get("/api/counts")).status).toBe(200);
    expect(JSON.stringify((await w.owner.get("/api/mail/overview")).body)).toContain(w.boxes.personal);
    expect((await draft(w.owner, w.boxes.personal)).status).toBe(403);
    expect(await whoCanOpen(w.ctx.db, w.orgId, w.boxes.personal)).not.toContain(w.dSend.id);
  }, 180_000);
});

describe("PRIV1b (P17) the access log", () => {
  const rows = async (w: W, userId: string) => (await w.ctx.db.select().from(mailboxAccessLog)
    .where(and(eq(mailboxAccessLog.mailboxId, w.boxes.personal), eq(mailboxAccessLog.actorUserId, userId)))).map((r) => r.action).filter((a) => a.startsWith("opened"));

  it("listing a mailbox one can't open logs nothing", async () => {
    const w = await privacyWorld();
    const r = await w.nobody.c.get(`/api/mail/messages?mailboxId=${w.boxes.personal}&folder=inbox`);
    expect(JSON.stringify(r.body)).not.toContain("SUBJECT-PERS");
    await w.admin.c.get(`/api/mail/messages?mailboxId=${w.boxes.personal}&folder=inbox`);
    expect(await rows(w, w.nobody.id)).toEqual([]);
    expect(await rows(w, w.admin.id)).toEqual([]);
    // A delegate who can open it is logged.
    const ok = await w.dRead.c.get(`/api/mail/messages?mailboxId=${w.boxes.personal}&folder=inbox`);
    expect(JSON.stringify(ok.body)).toContain("SUBJECT-PERS");
    expect(await rows(w, w.dRead.id)).toEqual(["opened_mailbox"]);
  }, 120_000);

  it("the Team inbox reader and attachment downloads log; the owner is never logged", async () => {
    const w = await privacyWorld();
    const thr = `thr_pers${w.n}aaaaaaaaaa`;
    const t = await w.dRead.c.get(`/api/agents/threads/${thr}`);
    expect(t.status).toBe(200);
    expect(await rows(w, w.dRead.id)).toEqual(["opened_thread"]);
    // Within 15 minutes a second read adds nothing.
    await w.dRead.c.get(`/api/agents/threads/${thr}`);
    expect(await rows(w, w.dRead.id)).toEqual(["opened_thread"]);
    const a = await w.dReply.c.get(`/api/mail/attachments/${w.attId}`);
    expect(a.status).toBe(200);
    expect(await rows(w, w.dReply.id)).toEqual(["opened_thread"]);
    // Refused reads log nothing.
    expect((await w.admin.c.get(`/api/agents/threads/${thr}`)).status).toBe(404);
    expect((await w.admin.c.get(`/api/mail/attachments/${w.attId}`)).status).toBe(404);
    expect(await rows(w, w.admin.id)).toEqual([]);
    expect((await w.pat.c.get(`/api/agents/threads/${thr}`)).status).toBe(200);
    expect(await rows(w, w.pat.id)).toEqual([]);
    // Team mail is never logged.
    expect((await w.member.c.get(`/api/agents/threads/thr_team${w.n}aaaaaaaaaa`)).status).toBe(200);
    expect((await w.ctx.db.select().from(mailboxAccessLog).where(eq(mailboxAccessLog.mailboxId, w.boxes.team))).length).toBe(0);
  }, 120_000);
});

describe("PRIV1b (P29, P30) rule cost and whoCanOpen", () => {
  it("opening a message reads the shares once, not again for the log; the dead helpers are gone", async () => {
    const w = await privacyWorld();
    const client = (w.ctx.db as unknown as { $client: { prepare: (s: string) => unknown } }).$client;
    const prepare = client.prepare.bind(client);
    let seen: string[] = [];
    client.prepare = (s: string) => { seen.push(s); return prepare(s); };
    try {
      for (const [c, msg] of [[w.admin.c, w.msgs.team], [w.dRead.c, w.msgs.personal]] as const) {
        await c.get(`/api/mail/messages/${msg}`);
        seen = [];
        expect((await c.get(`/api/mail/messages/${msg}`)).status).toBe(200);
        expect(seen.filter((s) => /from "mailbox_delegations"/.test(s))).toHaveLength(1);
      }
    } finally { client.prepare = prepare; }
    expect("forgetPicture" in access).toBe(false);
    expect("ownerOfPersonal" in access).toBe(false);
  }, 120_000);

  it("a mailbox shared with more than 90 people keeps its owner and every delegate", async () => {
    const w = await privacyWorld();
    const db = w.ctx.db;
    const ids: string[] = [];
    for (let i = 0; i < 92; i++) ids.push(`usr_bulk${w.n}x${i}`);
    for (const [i, id] of ids.entries()) {
      await db.insert(users).values({ id, email: `bulk${w.n}x${i}@acme.io`, name: `Bulk ${i}` } as never);
      await db.insert(members).values({ id: `mem_${id}`, organizationId: w.orgId, userId: id, role: "member" } as never);
      await db.insert(mailboxDelegations).values({ orgId: w.orgId, mailboxId: w.boxes.personal, userId: id, level: "read" } as never);
    }
    const who = await whoCanOpen(db, w.orgId, w.boxes.personal);
    expect(who).toContain(w.pat.id);
    expect(who).toContain(ids[91]);
    expect(who).toContain(w.dSend.id);
    expect(who).toHaveLength(92 + 3 + 1);
    expect(who).not.toContain(w.admin.id);
  }, 180_000);
});

describe("PRIV1b (P26) a free address claimed with an API key", () => {
  it("is a team mailbox the workspace keeps; a claim in the app stays personal", async () => {
    const w = await privacyWorld();
    (w.ctx.deps.config as unknown as { freeMail: { domain: string } }).freeMail.domain = "mail.multies.test";
    const key = (await w.admin.c.post("/api/developer/keys", { name: "support-bot" })).body.secret as string;
    const v1 = (method: string, path: string, body?: unknown) => w.ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "cf-connecting-ip": "10.77.0.1" }, body: body ? JSON.stringify(body) : undefined });
    const claim = await v1("POST", "/free-address", { localPart: `acmedesk${w.n}x` });
    expect(claim.status).toBe(201);
    const id = ((await claim.json()) as { id: string }).id;
    const row = (await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get())!;
    expect(row.personal).toBe(false);
    expect(row.ownerUserId).toBeNull();
    expect((await draft(w.owner, id)).status).toBe(201);
    expect((await w.owner.del(`/api/team/members/${w.admin.id}`)).status).toBe(200);
    expect((await draft(w.owner, id)).status).toBe(201);
    // The workspace owner claims one in the app: theirs alone, closed to the admin.
    await w.ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, `olive${w.n}@acme.io`));
    const own = await w.owner.post("/api/free-address", { localPart: `olive.own${w.n}` });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const nid = (own.body.mailbox?.id ?? own.body.id) as string;
    const nrow = (await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, nid)).get())!;
    expect(nrow.personal).toBe(true);
    expect(nrow.ownerUserId).toBe((await w.owner.get("/api/account/me")).body.user.id);
    expect((await w.dRead.c.get(`/api/mail/messages?mailboxId=${nid}`)).body.messages ?? []).toEqual([]);
  }, 180_000);
});

describe("PRIV1b (P28) workspace export and orphaned mailboxes", () => {
  const exported = async (w: W, c: C) => {
    await w.ctx.db.delete(dataMoves).where(eq(dataMoves.orgId, w.orgId)); // one export per 10 minutes
    const x = await c.post("/api/data-moves/exports", {});
    expect(x.status, JSON.stringify(x.body)).toBeLessThan(300);
    const d = await w.ctx.app.request(x.body.downloadPath, { headers: { host: "localhost" } });
    const f = unzipSync(new Uint8Array(await d.arrayBuffer()));
    return Object.keys(f).filter((k) => k.startsWith("mail/")).map((k) => strFromU8(f[k]!)).join("\n");
  };

  it("the workspace owner's export has orphans; an admin's has neither orphans nor mailboxes shared with them", async () => {
    const w = await privacyWorld();
    expect((await w.pat.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.admin.id}`, { level: "read" })).status).toBe(200);
    // While Pat is a member: neither export has her mail; the admin's share doesn't put it in.
    expect(await exported(w, w.owner)).not.toContain(`SUBJECT-PERS-${w.n}`);
    const adminAll = await exported(w, w.admin.c);
    expect(adminAll).not.toContain(`SUBJECT-PERS-${w.n}`);
    expect(adminAll).toContain(`SUBJECT-TEAM-${w.n}`);
    await w.ctx.db.update(mailboxes).set({ ownerUserId: null }).where(eq(mailboxes.id, w.boxes.personal));
    const ownerAll = await exported(w, w.owner);
    expect(ownerAll).toContain(`SUBJECT-PERS-${w.n}`);
    expect(ownerAll).toContain(`SUBJECT-TEAM-${w.n}`);
    expect(await exported(w, w.admin.c)).not.toContain(`SUBJECT-PERS-${w.n}`);
  }, 180_000);
});
