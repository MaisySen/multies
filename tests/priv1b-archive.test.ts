import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { Client } from "./helpers";
import { agents, attachments, dataMoves, mailConnections, mailRetentionPolicies, mailboxes, messages } from "@/server/db/schema";
import { heldScope, runRetentionPass } from "@/server/services/mail/archive-r111";
import { toBase64, splitMbox } from "../src/web/lib/mbox-r40";

/**
 * PRIV1b archive batch (P44, P58): legal holds keep every mailbox a held person can open and survive agent delete and
 * import Undo; retention cuts on both the Date header and the receive time, skips personal mailboxes, can't starve,
 * deletes stored blobs, and a hold doesn't stop an owner disconnecting. Made up example.com fixtures only.
 */
const DAY = 86_400_000;
async function world() {
  const w = await privacyWorld();
  (w.ctx.deps.config as { mailArchive: boolean }).mailArchive = true;
  let now = new Date();
  w.ctx.deps.now = () => now;
  const old = new Date(now.getTime() - 4000 * DAY);
  await w.ctx.db.update(messages).set({ date: old, createdAt: old }).where(eq(messages.orgId, w.orgId));
  const preview = async () => (await w.owner.post("/api/mail-archive/policy/preview", { keepYears: 1 })).body.preview;
  const turnOn = async () => {
    const pre = await preview();
    const put = await w.owner.put("/api/mail-archive/policy", { enabled: true, keepYears: 1, confirmEligible: pre.eligible });
    expect(put.status).toBe(200);
    now = new Date(now.getTime() + 8 * DAY);
    return pre;
  };
  const later = (days: number) => { now = new Date(now.getTime() + days * DAY); };
  const exists = async (id: string) => !!(await w.ctx.db.select({ id: messages.id }).from(messages).where(eq(messages.id, id)).get());
  const hold = async (kind: "mailbox" | "person", targetId: string) => {
    const r = await w.owner.post("/api/mail-archive/holds", { kind, targetId, name: "Matter" });
    expect(r.status).toBe(200);
    return r.body.hold.id as string;
  };
  const release = async (id: string) => expect((await w.owner.post(`/api/mail-archive/holds/${id}/release`)).status).toBe(200);
  let seq = 0;
  const seed = async (mailboxId: string, date: Date, createdAt: Date, extra: Partial<typeof messages.$inferInsert> = {}) => {
    const id = `msg_arch${w.n}_${++seq}aaaaaaaa`;
    await w.ctx.db.insert(messages).values({ id, orgId: w.orgId, mailboxId, folder: "inbox", threadId: `thr_${id}`, fromAddress: "a@example.com", subject: "fixture", snippet: "", sizeBytes: 10, date, createdAt, ...extra });
    return id;
  };
  return { ...w, preview, turnOn, later, exists, hold, release, seed, old, now: () => now };
}

describe("PRIV1b (P44) legal hold reach", () => {
  it("a hold on a delegate keeps the personal mailbox shared with them; a hold on an admin keeps team mail", async () => {
    const w = await world();
    const h = await w.hold("person", w.dSend.id);
    expect((await heldScope(w.ctx.deps, w.orgId)).mailboxIds).toContain(w.boxes.personal);
    // Pat (the owner) can't delete forever mail that is held through the delegate.
    await w.ctx.db.update(messages).set({ folder: "trash" }).where(eq(messages.id, w.msgs.personal));
    const blocked = await w.pat.c.del(`/api/mail/messages/${w.msgs.personal}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("legal_hold");
    expect(await w.exists(w.msgs.personal)).toBe(true);
    await w.release(h);
    expect((await w.pat.c.del(`/api/mail/messages/${w.msgs.personal}`)).status).toBe(200);

    const ha = await w.hold("person", w.admin.id);
    const scope = (await heldScope(w.ctx.deps, w.orgId)).mailboxIds;
    expect(scope).toEqual(expect.arrayContaining([w.boxes.team, w.boxes.agent]));
    expect(scope).not.toContain(w.boxes.personal); // the admin can't open Pat's mailbox
    await w.turnOn();
    await runRetentionPass(w.ctx.deps);
    expect(await w.exists(w.msgs.team)).toBe(true);
    expect(await w.exists(w.msgs.agent)).toBe(true);
    // Lifted: the next pass deletes the old team mail.
    await w.release(ha);
    w.later(2);
    await runRetentionPass(w.ctx.deps);
    expect(await w.exists(w.msgs.team)).toBe(false);
  });

  it("a hold on a member covers only what they can open", async () => {
    const w = await world();
    await w.hold("person", w.nobody.id);
    const s = await heldScope(w.ctx.deps, w.orgId);
    expect(s.mailboxIds).not.toContain(w.boxes.team);
    expect(s.mailboxIds).not.toContain(w.boxes.personal);
    await w.hold("person", w.member.id);
    expect((await heldScope(w.ctx.deps, w.orgId)).mailboxIds).toContain(w.boxes.team);
  });

  it("deleting an agent whose inbox is held is refused; after the hold is lifted it works", async () => {
    const w = await world();
    const made = await w.owner.post("/api/agents", { name: "Held bot", localPart: "heldbot" });
    expect(made.status).toBe(201);
    const agentId = made.body.agent.id as string;
    const mb = (await w.ctx.db.select({ id: agents.mailboxId }).from(agents).where(eq(agents.id, agentId)).get())!.id;
    const msg = await w.seed(mb, new Date(), new Date());
    const h = await w.hold("mailbox", mb);
    const del = await w.admin.c.del(`/api/agents/${agentId}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("legal_hold");
    expect(await w.exists(msg)).toBe(true);
    expect(await w.ctx.db.select().from(agents).where(eq(agents.id, agentId)).get()).toBeTruthy();
    await w.release(h);
    expect((await w.admin.c.del(`/api/agents/${agentId}`)).status).toBe(200);
    expect(await w.exists(msg)).toBe(false);
  });

  it("Undo of an mbox import is refused while the mail is held, and works after", async () => {
    const w = await world();
    const raw = (id: string) => `From a@x Mon Sep  1 09:00:00 2026\r\nMessage-ID: <${id}@old.example>\r\nFrom: Old <friend@old.example>\r\nTo: me@acme.io\r\nSubject: Archive ${id}\r\nDate: Tue, 1 Sep 2026 09:00:00 +1000\r\nContent-Type: text/plain\r\n\r\nHello.\r\n`;
    const mbox = splitMbox(new TextEncoder().encode(["u1", "u2"].map(raw).join("\r\n"))).map(toBase64);
    const run = await w.owner.call("POST", "/api/data-moves/mbox/batch", { mailboxId: w.boxes.team, total: 2, fileName: "old.mbox", last: true, messages: mbox }, { "idempotency-key": `mbox_p44_run_${w.n}0001` });
    expect(run.status).toBe(200);
    const imported = () => w.ctx.db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, w.boxes.team));
    const before = (await imported()).length;
    const h = await w.hold("mailbox", w.boxes.team);
    const undo = await w.owner.post(`/api/data-moves/${run.body.move.id}/undo`, {});
    expect(undo.status).toBe(409);
    expect(undo.body.error.code).toBe("legal_hold");
    expect((await imported()).length).toBe(before);
    expect((await w.ctx.db.select({ s: dataMoves.status }).from(dataMoves).where(eq(dataMoves.id, run.body.move.id)).get())!.s).toBe("done");
    await w.release(h);
    const ok = await w.owner.post(`/api/data-moves/${run.body.move.id}/undo`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.removed).toBe(2);
    expect((await imported()).length).toBe(before - 2);
  });
});

describe("PRIV1b (P58) retention details", () => {
  it("cuts only when both the Date header and the receive time are past the cutoff", async () => {
    const w = await world();
    const backdated = await w.seed(w.boxes.team, w.old, w.now()); // sender wrote an old Date, received just now
    const both = await w.seed(w.boxes.team, w.old, w.old);
    await w.turnOn();
    await runRetentionPass(w.ctx.deps);
    expect(await w.exists(backdated)).toBe(true);
    expect(await w.exists(both)).toBe(false);
    expect(await w.exists(w.msgs.team)).toBe(false);
  });

  it("skips personal mailboxes, and the preview never counts them (no per mailbox oracle)", async () => {
    const w = await world();
    const a = await w.preview();
    const h = await w.hold("mailbox", w.boxes.personal);
    const b = await w.preview();
    expect(b).toMatchObject({ eligible: a.eligible, heldBack: a.heldBack, connectedSkipped: a.connectedSkipped });
    expect(b.heldBack).toBe(0);
    await w.release(h);
    expect(a.eligible).toBe(2); // team and agent mail, not Pat's
    await w.turnOn();
    expect(await runRetentionPass(w.ctx.deps)).toMatchObject({ deleted: 2 });
    expect(await w.exists(w.msgs.personal)).toBe(true);
    expect(await w.exists(w.msgs.team)).toBe(false);
  });

  it("a workspace that never finishes its pass can't starve the others", async () => {
    const w = await world();
    const other = new (class extends Client {
      override call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) { return super.call(method, path, body, { "cf-connecting-ip": "10.77.0.1", ...headers }); }
    })(w.ctx.app);
    await other.signup(`stuck${w.n}@other.io`, "Stuck Owner", "Stuck");
    const stuckOrg = (await other.get("/api/account/me")).body.organization.id as string;
    // A policy that can never run (99 years has no cutoff), created first so it comes first in table order.
    await w.ctx.db.insert(mailRetentionPolicies).values({ orgId: stuckOrg, enabled: true, keepYears: 99, startsAt: new Date(0) });
    await w.turnOn();
    await w.ctx.db.update(mailRetentionPolicies).set({ lastRunAt: new Date(w.now().getTime() - 2 * DAY) }).where(eq(mailRetentionPolicies.orgId, w.orgId));
    const first = await runRetentionPass(w.ctx.deps, { maxOrgs: 1 }); // the never run one goes first
    expect(first).toMatchObject({ orgs: 1, deleted: 0 });
    const second = await runRetentionPass(w.ctx.deps, { maxOrgs: 1 });
    expect(second).toMatchObject({ orgs: 1, deleted: 2 });
    expect(await w.exists(w.msgs.team)).toBe(false);
  });

  it("deletes the stored attachment blobs of the messages it removes", async () => {
    const w = await world();
    const gone: string[] = [];
    w.ctx.deps.bodyStore = { name: "fake", put: async () => undefined, get: async () => null, delete: async (k: string) => { gone.push(k); } };
    await w.ctx.db.insert(attachments).values({ id: `att_blob${w.n}aaaaaaaa`, messageId: w.msgs.team, filename: "big.pdf", contentType: "application/pdf", sizeBytes: 9_000_000, contentB64: null, storageKey: `attachments/${w.orgId}/att_blob${w.n}` } as never);
    await w.ctx.db.insert(attachments).values({ id: `att_keep${w.n}aaaaaaaa`, messageId: w.msgs.personal, filename: "keep.pdf", contentType: "application/pdf", sizeBytes: 9_000_000, contentB64: null, storageKey: `attachments/${w.orgId}/att_keep${w.n}` } as never);
    await w.turnOn();
    await runRetentionPass(w.ctx.deps);
    expect(gone).toEqual([`attachments/${w.orgId}/att_blob${w.n}`]);
  });

  it("a hold on a connected personal mailbox doesn't stop its owner disconnecting; the held mail stays", async () => {
    const w = await world();
    const conn = `conn_p58_${w.n}aaaaaa`;
    await w.ctx.db.insert(mailConnections).values({ id: conn, orgId: w.orgId, mailboxId: w.boxes.personal, provider: "imap", email: "pat@example.com", username: "pat", imapHost: "imap.example.com", imapPort: 993, imapSecurity: "tls", smtpHost: "smtp.example.com", smtpPort: 465, smtpSecurity: "tls", secretEnc: "x" });
    await w.hold("mailbox", w.boxes.personal);
    const r = await w.pat.c.del(`/api/connections/${conn}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, keptForLegalHold: true });
    expect(await w.ctx.db.select().from(mailConnections).where(eq(mailConnections.id, conn)).get()).toBeUndefined();
    expect(await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, w.boxes.personal)).get()).toBeTruthy();
    expect(await w.exists(w.msgs.personal)).toBe(true);
  });

  it("without a hold, disconnecting still removes the mailbox copy", async () => {
    const w = await world();
    const conn = `conn_p58b_${w.n}aaaaa`;
    await w.ctx.db.insert(mailConnections).values({ id: conn, orgId: w.orgId, mailboxId: w.boxes.personal, provider: "imap", email: "pat@example.com", username: "pat", imapHost: "imap.example.com", imapPort: 993, imapSecurity: "tls", smtpHost: "smtp.example.com", smtpPort: 465, smtpSecurity: "tls", secretEnc: "x" });
    const r = await w.pat.c.del(`/api/connections/${conn}`);
    expect(r.status).toBe(200);
    expect(r.body.keptForLegalHold).toBeUndefined();
    expect(await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, w.boxes.personal)).get()).toBeUndefined();
  });
});
