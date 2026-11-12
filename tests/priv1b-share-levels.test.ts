/**
 * PRIV1b share-levels batch (P10, P11): what a reply share and a read share may do in someone's personal mailbox.
 * A reply share answers the thread's own people only; a read share changes nothing (snooze, remind, status, assign,
 * draft take-over, approvals); Send later checks the Send level before it writes and leaves others' drafts alone;
 * scheduled sends in a personal mailbox show to its owner, not by workspace role.
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { agents, messages, sendApprovals } from "@/server/db/schema";

const later = () => new Date(Date.now() + 3 * 3_600_000).toISOString();

describe("PRIV1b P10: a reply share answers the thread, nothing more", () => {
  it("refuses new mail and outside recipients below Send as, on Send, drafts and Send later", async () => {
    const w = await privacyWorld();
    const sender = `secret.sender.pers@private.example`;
    const base = { mailboxId: w.boxes.personal, to: ["boss@evil.example"], subject: "Wire money", text: "please wire" };

    // A made up inReplyToId no longer turns a reply share into Send as.
    for (const inReplyToId of ["nope", w.msgs.team]) {
      const r = await w.dReply.c.post("/api/mail/send", { ...base, inReplyToId });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("share_level");
    }
    // A real message of the thread, but a recipient who isn't in it.
    const outside = await w.dReply.c.post("/api/mail/send", { ...base, inReplyToId: w.msgs.personal });
    expect(outside.status).toBe(403);
    expect(outside.body.error.code).toBe("share_level");
    const sneak = await w.dReply.c.post("/api/mail/send", { ...base, to: [sender], bcc: ["boss@evil.example"], inReplyToId: w.msgs.personal });
    expect(sneak.status).toBe(403);
    // Drafts and Send later check the same.
    const draft = await w.dReply.c.post("/api/mail/drafts", { ...base, inReplyToId: "nope" });
    expect(draft.status).toBe(403);
    expect(draft.body.error.code).toBe("share_level");
    const sched = await w.dReply.c.post("/api/mail-schedules/send", { message: { ...base, inReplyToId: "nope" }, at: later() });
    expect(sched.status).toBe(403);
    expect(sched.body.error.code).toBe("share_level");
    // A read share still can't reply at all; no share is a 404.
    expect((await w.dRead.c.post("/api/mail/send", { ...base, to: [sender], inReplyToId: w.msgs.personal })).status).toBe(403);
    expect((await w.nobody.c.post("/api/mail/send", { ...base, to: [sender], inReplyToId: w.msgs.personal })).status).toBe(404);
    // Nothing went out from Pat's mailbox.
    expect((await w.ctx.db.select().from(messages).where(and(eq(messages.mailboxId, w.boxes.personal), eq(messages.folder, "sent")))).length).toBe(0);

    // The legitimate cases: a reply to the thread's sender, a reply draft and a scheduled reply; Send as and the owner write to anyone.
    const reply = await w.dReply.c.post("/api/mail/send", { ...base, to: [sender], subject: "Re: hi", inReplyToId: w.msgs.personal });
    expect(reply.status).toBe(201);
    expect((await w.dReply.c.post("/api/mail/drafts", { ...base, to: [sender], inReplyToId: w.msgs.personal })).status).toBe(201);
    expect((await w.dReply.c.post("/api/mail-schedules/send", { message: { ...base, to: [sender], inReplyToId: w.msgs.personal }, at: later() })).status).toBe(201);
    expect((await w.dSend.c.post("/api/mail/send", { ...base, inReplyToId: "nope" })).status).toBe(201);
    expect((await w.pat.c.post("/api/mail/send", base)).status).toBe(201);
    // Team mailboxes are unchanged: Max (granted) sends new mail.
    expect((await w.member.c.post("/api/mail/send", { ...base, mailboxId: w.boxes.team })).status).toBe(201);
  }, 120_000);
});

describe("PRIV1b P11: a read share changes nothing", () => {
  it("snooze, remind, thread status, assign and draft take-over need Read and reply", async () => {
    const w = await privacyWorld();
    const thread = (await w.ctx.db.select({ t: messages.threadId }).from(messages).where(eq(messages.id, w.msgs.personal)).get())!.t;
    const teamThread = (await w.ctx.db.select({ t: messages.threadId }).from(messages).where(eq(messages.id, w.msgs.team)).get())!.t;
    const refused = (r: { status: number; body: { error?: { code: string } } }) => { expect(r.status).toBe(403); expect(r.body.error?.code).toBe("share_level"); };

    refused(await w.dRead.c.post("/api/mail-schedules/snooze", { messageId: w.msgs.personal, preset: "tomorrow" }));
    refused(await w.dRead.c.post("/api/mail-schedules/remind", { messageId: w.msgs.personal, days: 3 }));
    refused(await w.dRead.c.post(`/api/threads/${thread}/status`, { status: "done" }));
    refused(await w.dRead.c.post(`/api/threads/${thread}/assign`, { userId: w.dRead.id }));
    expect((await w.nobody.c.post("/api/mail-schedules/snooze", { messageId: w.msgs.personal, preset: "tomorrow" })).status).toBe(404);

    // Pat's draft reply: a read share can't take it over, a reply share can.
    const draft = await w.pat.c.post("/api/mail/drafts", { mailboxId: w.boxes.personal, to: ["secret.sender.pers@private.example"], subject: "Re", text: "mine", inReplyToId: w.msgs.personal });
    expect(draft.status).toBe(201);
    refused(await w.dRead.c.post(`/api/threads/drafts/${draft.body.id}/take-over`));
    expect((await w.ctx.db.select({ by: messages.sentByUserId }).from(messages).where(eq(messages.id, draft.body.id)).get())!.by).toBe(w.pat.id);

    // The same actions at Read and reply, and by the owner, still work; an admin keeps them on team mail.
    expect((await w.dReply.c.post("/api/mail-schedules/snooze", { messageId: w.msgs.personal, preset: "tomorrow" })).status).toBe(201);
    expect((await w.dReply.c.post("/api/mail-schedules/remind", { messageId: w.msgs.personal, days: 3 })).status).toBe(201);
    expect((await w.dReply.c.post(`/api/threads/${thread}/status`, { status: "done" })).status).toBe(200);
    expect((await w.pat.c.post(`/api/threads/${thread}/assign`, { userId: w.pat.id })).status).toBe(200);
    expect((await w.dReply.c.post(`/api/threads/drafts/${draft.body.id}/take-over`)).status).toBe(200);
    expect((await w.admin.c.post(`/api/threads/${teamThread}/status`, { status: "done" })).status).toBe(200);
    expect((await w.admin.c.post("/api/mail-schedules/snooze", { messageId: w.msgs.team, preset: "tomorrow" })).status).toBe(201);
  }, 120_000);

  it("agent approvals: reject needs Read and reply, approve needs Send as", async () => {
    const w = await privacyWorld();
    await w.ctx.db.insert(agents).values({ id: `agt_sl${w.n}aaaaaaaa`, orgId: w.orgId, mailboxId: w.boxes.agent, name: "Bot", createdByUserId: w.pat.id });
    const approval = async (id: string) => {
      await w.ctx.db.insert(sendApprovals).values({ id, orgId: w.orgId, agentId: `agt_sl${w.n}aaaaaaaa`, mailboxId: w.boxes.personal, payload: JSON.stringify({ to: ["x@private.example"], subject: "s", text: "t" }), expiresAt: new Date(Date.now() + 86_400_000) });
      return id;
    };
    const a1 = await approval(`apr_a${w.n}aaaaaaaa`);
    const a2 = await approval(`apr_b${w.n}aaaaaaaa`);
    const rRead = await w.dRead.c.post(`/api/approvals/${a1}/reject`, {});
    expect(rRead.status).toBe(403);
    expect(rRead.body.error.code).toBe("share_level");
    const aReply = await w.dReply.c.post(`/api/approvals/${a2}/approve`, {});
    expect(aReply.status).toBe(403);
    expect(aReply.body.error.code).toBe("share_level");
    expect((await w.ctx.db.select({ s: sendApprovals.status }).from(sendApprovals).where(eq(sendApprovals.id, a1)).get())!.s).toBe("pending");
    expect((await w.nobody.c.post(`/api/approvals/${a1}/reject`, {})).status).toBe(404);
    const ok = await w.dReply.c.post(`/api/approvals/${a1}/reject`, { note: "no" });
    expect(ok.status).toBe(200);
    expect(ok.body.approval.status).toBe("rejected");
  }, 120_000);

  it("Send later: Send level first, never deletes someone else's draft; scheduled sends show to the mailbox owner", async () => {
    const w = await privacyWorld();
    expect((await w.pat.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.admin.id}`, { level: "read" })).status).toBe(200);
    const patDraft = await w.pat.c.post("/api/mail/drafts", { mailboxId: w.boxes.personal, to: ["a@outside.example"], subject: "PAT-DRAFT", text: "mine" });
    expect(patDraft.status).toBe(201);
    const draftThere = async () => !!(await w.ctx.db.select({ id: messages.id }).from(messages).where(eq(messages.id, patDraft.body.id)).get());
    const msg = (subject: string, extra: Record<string, unknown> = {}) => ({ message: { mailboxId: w.boxes.personal, to: ["boss@outside.example"], subject, text: `${subject} body`, ...extra }, preset: "tomorrow" });

    // A read share: 403 before anything is deleted.
    const rRead = await w.dRead.c.post("/api/mail-schedules/send", msg("RAE", { draftId: patDraft.body.id }));
    expect(rRead.status).toBe(403);
    expect(rRead.body.error.code).toBe("share_level");
    expect(await draftThere()).toBe(true);
    // Send as schedules its own message, but Pat's draft stays hers.
    const sam = await w.dSend.c.post("/api/mail-schedules/send", msg("SAM-AS-PAT", { draftId: patDraft.body.id }));
    expect(sam.status).toBe(201);
    expect(await draftThere()).toBe(true);
    const pat = await w.pat.c.post("/api/mail-schedules/send", msg("PAT-OWN"));
    expect(pat.status).toBe(201);

    const subjects = async (c: typeof w.pat.c) => {
      const r = await c.get("/api/mail-schedules?view=scheduled");
      expect(r.status).toBe(200);
      return (r.body.items as { send: { subject: string } | null }[]).map((i) => i.send?.subject);
    };
    // Pat (a member) sees every scheduled send in her own mailbox; Sam sees his own; Ada (admin, read share) none of them.
    expect((await subjects(w.pat.c)).sort()).toEqual(["PAT-OWN", "SAM-AS-PAT"]);
    expect(await subjects(w.dSend.c)).toEqual(["SAM-AS-PAT"]);
    expect(await subjects(w.admin.c)).toEqual([]);
    expect(JSON.stringify((await w.admin.c.get("/api/mail-schedules?view=scheduled")).body)).not.toContain("PAT-OWN body");
    expect((await w.admin.c.del(`/api/mail-schedules/${pat.body.id}`)).status).toBe(404);
    expect((await w.dSend.c.del(`/api/mail-schedules/${pat.body.id}`)).status).toBe(404);
    // The owner cancels a delegate's scheduled send.
    expect((await w.pat.c.del(`/api/mail-schedules/${sam.body.id}`)).status).toBe(200);
    expect(await subjects(w.pat.c)).toEqual(["PAT-OWN"]);

    // Team mailbox: unchanged, an admin sees a member's scheduled send there.
    const max = await w.member.c.post("/api/mail-schedules/send", { message: { mailboxId: w.boxes.team, to: ["c@outside.example"], subject: "MAX-TEAM", text: "t" }, preset: "tomorrow" });
    expect(max.status).toBe(201);
    expect(await subjects(w.admin.c)).toEqual(["MAX-TEAM"]);
  }, 120_000);
});
