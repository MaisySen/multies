/**
 * PRIV1b batch "threads-exports" (P13, P15, P22, P61). A thread id can hold a team mailbox's copy and a personal
 * mailbox's copy at once (References join them org wide). Every thread-keyed read keeps to the caller's copies;
 * exports, helpdesk history, dashboards, Ask and notifications stop showing personal mail once it can't be opened.
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import { privacyWorld } from "./priv1a-world";
import { Client } from "./helpers";
import { createApp } from "@/server/app";
import { deliverInbound } from "@/server/services/mail/delivery";
import { agentMailboxAccess, agents, hdSettings, hdTickets, messages } from "@/server/db/schema";
import { replyInThread } from "@/server/services/agents";
import { sendDigest } from "@/server/services/suite/notify-centre-r97";
import { defaultDelivery } from "@/shared/notification-centre";
import type { LogOutbound } from "@/server/services/mail/outbound";

const S = (x: unknown) => JSON.stringify(x);
type W = Awaited<ReturnType<typeof privacyWorld>>;

/** Customer mail to team@, then a reply that reaches only Pat's personal address, so both copies share the thread. Pat replies and keeps a draft. */
async function mixedThread(w: W) {
  const { ctx, n } = w;
  const deliver = (rcptTo: string, email: Record<string, unknown>) => deliverInbound(ctx.deps, {
    envelopeFrom: String((email.from as { address: string }).address), rcptTo, sizeBytes: 400, via: "test",
    email: { cc: [], attachments: [], authResults: {}, headers: {}, ...email },
  } as never);
  const orig = `<orig-${n}@customer.example>`;
  await deliver("team@acme.io", { messageId: orig, from: { address: "cust@customer.example", name: "Cust" }, to: [{ address: "team@acme.io" }], subject: `TEAMSUBJ-${n}`, text: `TEAMTEXT-${n} where is my order`, date: new Date(Date.now() - 50 * 60_000) });
  const teamMsg = (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, w.boxes.team), eq(messages.messageIdHeader, orig))).get())!;
  await deliver(`pat.private${n}@acme.io`, { messageId: `<pers-${n}@private.example>`, inReplyTo: orig, references: orig, from: { address: "lawyer@private.example", name: "Lawyer" }, to: [{ address: `pat.private${n}@acme.io` }], subject: `PERSSUBJ-${n} your divorce`, text: `PERSTEXT-${n} confidential advice`, date: new Date(Date.now() - 40 * 60_000) });
  const persMsg = (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, w.boxes.personal), eq(messages.messageIdHeader, `<pers-${n}@private.example>`))).get())!;
  expect(persMsg.threadId).toBe(teamMsg.threadId);
  expect((await w.pat.c.post("/api/mail/send", { mailboxId: w.boxes.personal, to: ["lawyer@private.example"], subject: `Re: PERSSUBJ-${n} your divorce`, text: `PATREPLY-${n} my private answer`, inReplyToId: persMsg.id })).status).toBe(201);
  expect((await w.pat.c.post("/api/mail/drafts", { mailboxId: w.boxes.personal, to: ["lawyer@private.example"], subject: `Re: PERSSUBJ-${n}`, text: `PATDRAFT-${n} unsent thoughts`, inReplyToId: persMsg.id })).status).toBe(201);
  const P = [`PERSSUBJ-${n}`, `PERSTEXT-${n}`, `PATREPLY-${n}`, `PATDRAFT-${n}`, "lawyer@private.example"];
  return { thr: teamMsg.threadId, teamMsg, persMsg, leaks: (b: unknown) => P.filter((p) => S(b).includes(p)) };
}

describe("P15: a thread shared by a team and a personal copy", () => {
  it("labels stay on their own copy", async () => {
    const w = await privacyWorld();
    const { thr, teamMsg, persMsg } = await mixedThread(w);
    const n = w.n;
    expect((await w.pat.c.post("/api/mail/labels", { threadId: thr, label: `PATLABEL-${n}` })).body.labels).toEqual([`PATLABEL-${n}`]);
    // Admin and Max (team grant) see no label of Pat's on the team copy, and filtering by it finds nothing.
    const list = await w.admin.c.get(`/api/mail/messages?mailboxId=${w.boxes.team}&folder=inbox`);
    expect(list.status).toBe(200);
    expect(S(list.body)).not.toContain(`PATLABEL-${n}`);
    expect((await w.admin.c.get(`/api/mail/messages/${teamMsg.id}`)).body.labels).toEqual([]);
    expect((await w.member.c.get(`/api/mail/messages/${teamMsg.id}`)).body.labels).toEqual([]);
    const byLabel = await w.admin.c.get(`/api/mail/messages?label=${encodeURIComponent(`PATLABEL-${n}`)}`);
    expect(byLabel.body.messages.map((m: { id: string }) => m.id)).not.toContain(teamMsg.id);
    // Max can't remove Pat's label; Pat still has it.
    expect((await w.member.c.del(`/api/mail/labels?threadId=${encodeURIComponent(thr)}&label=${encodeURIComponent(`PATLABEL-${n}`)}`)).status).toBe(200);
    expect((await w.pat.c.get(`/api/mail/messages/${persMsg.id}`)).body.labels).toEqual([`PATLABEL-${n}`]);
    // Pat finds her copy by her label.
    const patBy = await w.pat.c.get(`/api/mail/messages?label=${encodeURIComponent(`PATLABEL-${n}`)}`);
    expect(patBy.body.messages.map((m: { id: string }) => m.id)).toContain(persMsg.id);
    // Pat removes her own label.
    expect((await w.pat.c.del(`/api/mail/labels?threadId=${encodeURIComponent(thr)}&label=${encodeURIComponent(`PATLABEL-${n}`)}`)).body.labels).toEqual([]);
    // Max labels the team copy: he sees it, Pat's personal list does not.
    expect((await w.member.c.post("/api/mail/labels", { threadId: thr, label: `TEAMLABEL-${n}` })).body.labels).toEqual([`TEAMLABEL-${n}`]);
    expect((await w.member.c.get(`/api/mail/messages/${teamMsg.id}`)).body.labels).toEqual([`TEAMLABEL-${n}`]);
    const patList = await w.pat.c.get(`/api/mail/messages?mailboxId=${w.boxes.personal}&folder=inbox`);
    expect(S(patList.body)).not.toContain(`TEAMLABEL-${n}`);
  });

  it("notes, thread state, presence, chat links, tasks and reply times keep to the caller's copy", async () => {
    const w = await privacyWorld();
    const { thr, leaks } = await mixedThread(w);
    const n = w.n;
    // Notes.
    expect((await w.pat.c.post(`/api/threads/${thr}/comments`, { body: `PATNOTE-${n} call the lawyer` })).status).toBe(201);
    expect((await w.member.c.post(`/api/threads/${thr}/comments`, { body: `TEAMNOTE-${n} refund approved` })).status).toBe(201);
    const an = await w.admin.c.get(`/api/threads/${thr}/comments`);
    expect(an.status).toBe(200);
    expect(S(an.body)).not.toContain(`PATNOTE-${n}`);
    expect(S(an.body)).toContain(`TEAMNOTE-${n}`);
    expect(S((await w.member.c.get(`/api/threads/${thr}/comments`)).body)).not.toContain(`PATNOTE-${n}`);
    const pn = await w.pat.c.get(`/api/threads/${thr}/comments`);
    expect(S(pn.body)).toContain(`PATNOTE-${n}`);
    expect(S(pn.body)).not.toContain(`TEAMNOTE-${n}`);
    // A read share reads Pat's notes but can't add one; a reply share can.
    const rn = await w.dRead.c.get(`/api/threads/${thr}/comments`);
    expect(rn.status).toBe(200);
    expect(S(rn.body)).toContain(`PATNOTE-${n}`);
    expect(S(rn.body)).not.toContain(`TEAMNOTE-${n}`);
    const raeAdd = await w.dRead.c.post(`/api/threads/${thr}/comments`, { body: "rae note" });
    expect(raeAdd.status).toBe(403);
    expect(raeAdd.body.error.code).toBe("share_level");
    expect((await w.dReply.c.post(`/api/threads/${thr}/comments`, { body: `REXNOTE-${n}` })).status).toBe(201);
    // Max's counts see only the team note.
    expect((await w.member.c.get(`/api/threads/comment-counts?ids=${encodeURIComponent(thr)}`)).body.counts[thr]).toBe(1);

    // Thread state: the admin's Assign menu lists only people who can open the team copy.
    const st = await w.admin.c.get(`/api/threads/${thr}/state`);
    expect(st.status).toBe(200);
    const names = st.body.members.map((m: { name: string }) => m.name);
    expect(names).toEqual(expect.arrayContaining(["Ada Admin", "Max Member", "Olive Owner"]));
    for (const x of ["Pat Person", "Rae Read", "Rex Reply", "Sam Send"]) expect(names).not.toContain(x);
    expect((await w.admin.c.post(`/api/threads/${thr}/assign`, { userId: w.dRead.id })).status).toBe(400);
    expect((await w.admin.c.post(`/api/threads/${thr}/assign`, { userId: w.member.id })).body.state.assignee.name).toBe("Max Member");
    const patNames = (await w.pat.c.get(`/api/threads/${thr}/state`)).body.members.map((m: { name: string }) => m.name);
    expect(patNames).toEqual(expect.arrayContaining(["Pat Person", "Rae Read"]));
    expect(patNames).not.toContain("Max Member");

    // Presence: one room per copy.
    expect((await w.pat.c.post(`/api/threads/${thr}/presence`, { clientId: "patclient1", state: "replying" })).status).toBe(200);
    expect((await w.member.c.post(`/api/threads/${thr}/presence`, { clientId: "maxclient1", state: "viewing" })).status).toBe(200);
    const seen = (await w.admin.c.get(`/api/threads/${thr}/presence`)).body.people.map((p: { name: string }) => p.name);
    expect(seen).toEqual(["Max Member"]);
    const raeSees = (await w.dRead.c.get(`/api/threads/${thr}/presence`)).body.people.map((p: { name: string }) => p.name);
    expect(raeSees).toEqual(["Pat Person"]);

    // Chat link: titled from the writer's own copy, never a draft; nothing for someone who can't open the thread.
    const ch = await w.member.c.post("/api/chat/channels", { name: `general-${n}` });
    const post = await w.member.c.post(`/api/chat/channels/${ch.body.channel.id}/messages`, { body: `look <#thread:${thr}>` });
    expect(post.status).toBe(201);
    expect(leaks(post.body)).toEqual([]);
    expect(post.body.message.links[0].title).toBe(`TEAMSUBJ-${n}`);
    const nch = await w.nobody.c.post("/api/chat/channels", { name: `nia-${n}` });
    const np = await w.nobody.c.post(`/api/chat/channels/${nch.body.channel.id}/messages`, { body: `look <#thread:${thr}>` });
    expect(np.status).toBe(201);
    expect(leaks(np.body)).toEqual([]);
    expect(np.body.message.links.filter((l: { type: string }) => l.type === "thread")).toEqual([]);
    // Reading Max's message, Pat sees her own copy's title, never the team's draft-free newest.
    const patRead = await w.pat.c.get(`/api/chat/channels/${ch.body.channel.id}/messages`);
    expect(S(patRead.body)).not.toContain(`PATDRAFT-${n}`);

    // Task from email: the newest message the caller can open.
    const tk = await w.admin.c.post("/api/tasks/from-email", { threadId: thr });
    expect(tk.status).toBeLessThan(300);
    expect(tk.body.task.title).toContain(`TEAMSUBJ-${n}`);
    expect(leaks(tk.body)).toEqual([]);
    const tkPat = await w.pat.c.post("/api/tasks/from-email", { threadId: thr });
    expect(tkPat.status).toBeLessThan(300);
    expect(S(tkPat.body)).not.toContain(`PATDRAFT-${n}`);

    // Reply times: Pat's private reply is not the team's first response.
    const rs = await w.admin.c.get(`/api/threads/stats/replies?groupBy=person&mailboxId=${w.boxes.team}`);
    expect(rs.status).toBe(200);
    expect(rs.body.rows.map((r: { label: string }) => r.label)).not.toContain("Pat Person");
    expect(rs.body.total.replied).toBe(0);
  });

  it("help center previews and agent approvals never use the personal copy", async () => {
    const w = await privacyWorld();
    const { ctx, orgId, n } = w;
    expect((await w.owner.patch("/api/helpdesk/settings", { mailboxIds: [w.boxes.team] })).status).toBe(200);
    await ctx.db.update(hdSettings).set({ syncCursor: Date.now() - 2 * 3600_000, syncedAt: 0 }).where(eq(hdSettings.orgId, orgId));
    const { thr, teamMsg, leaks } = await mixedThread(w);
    const app2 = createApp({ ...ctx.deps, config: { ...ctx.deps.config, helpCenter: true } });
    const on2 = (c: Client) => { const x = new Client(app2); x.cookie = c.cookie; return x; };
    const ticket = (await w.admin.c.get("/api/helpdesk/tickets?view=open")).body.tickets.find((t: { refId: string }) => t.refId === thr);
    expect(ticket).toBeTruthy();
    expect((await w.admin.c.patch(`/api/helpdesk/tickets/${ticket.id}`, { status: "solved" })).status).toBe(200);
    // No team reply yet: Pat's draft and reply don't count as the team's answer.
    const pv = await on2(w.admin.c).get(`/api/help-center/tickets/${ticket.id}/preview`);
    expect(pv.status).toBe(400);
    expect(leaks(pv.body)).toEqual([]);
    // A team reply is the answer.
    expect((await w.admin.c.post("/api/mail/send", { mailboxId: w.boxes.team, to: ["cust@customer.example"], subject: `Re: TEAMSUBJ-${n}`, text: `TEAMREPLY-${n} it ships tomorrow`, inReplyToId: teamMsg.id })).status).toBe(201);
    const pv2 = await on2(w.admin.c).get(`/api/help-center/tickets/${ticket.id}/preview`);
    expect(pv2.status).toBe(200);
    expect(pv2.body.preview.answer).toContain(`TEAMREPLY-${n}`);
    expect(leaks(pv2.body)).toEqual([]);

    // An agent with Pat's mailbox asks to reply in the thread: the approval is for Pat's copy only.
    const agentId = `agt_pat${n}aaaaaaaaa`;
    await ctx.db.insert(agents).values({ id: agentId, orgId, mailboxId: w.boxes.agent, name: "Pat helper", createdByUserId: w.pat.id, approvalMode: "always" } as never);
    await ctx.db.insert(agentMailboxAccess).values({ agentId, mailboxId: w.boxes.personal, orgId });
    const req = await replyInThread(ctx.deps, { orgId, userId: "", role: "admin", sessionId: "mcp:test", agentId, email: "", name: "" } as never, agentId, thr, { text: `AGENTDRAFT-${n} private reply draft` });
    expect((req as { status: string }).status).toBe("pending_approval");
    const at = await w.admin.c.get(`/api/agents/threads/${thr}`);
    expect(at.status).toBe(200);
    expect(at.body.pendingApprovals).toEqual([]);
    expect(S(at.body)).not.toContain(`AGENTDRAFT-${n}`);
    const mt = await w.member.c.get(`/api/agents/threads/${thr}`);
    expect(S(mt.body)).not.toContain(`AGENTDRAFT-${n}`);
    const al = await w.admin.c.get("/api/agents/threads?view=all");
    expect(al.body.data.find((x: { id: string }) => x.id === thr).pendingApprovals).toBe(0);
    // Pat, who owns the mailbox, sees it.
    const pt = await w.pat.c.get(`/api/agents/threads/${thr}`);
    expect(pt.status).toBe(200);
    expect(S(pt.body.pendingApprovals)).toContain(`AGENTDRAFT-${n}`);
  });
});

describe("P13: the workspace export", () => {
  it("carries notes only on the mailboxes it exports", async () => {
    const w = await privacyWorld();
    const { ctx, n } = w;
    const thrPers = `thr_pers${n}aaaaaaaaaa`, thrTeam = `thr_team${n}aaaaaaaaaa`;
    expect((await w.pat.c.post(`/api/threads/${thrPers}/comments`, { body: `PATNOTE-${n} call the lawyer about the divorce` })).status).toBe(201);
    expect((await w.dReply.c.post(`/api/threads/${thrPers}/comments`, { body: `REXNOTE-${n}` })).status).toBe(201);
    expect((await w.member.c.post(`/api/threads/${thrTeam}/comments`, { body: `TEAMNOTE-${n}` })).status).toBe(201);
    const ox = await w.owner.post("/api/data-moves/exports", {});
    expect(ox.status).toBeLessThan(300);
    const od = await ctx.app.request(ox.body.downloadPath, { headers: { host: "localhost" } });
    expect(od.status).toBe(200);
    const files = unzipSync(new Uint8Array(await od.arrayBuffer()));
    const notes = strFromU8(files["data/thread_comments.json"]);
    expect(notes).toContain(`TEAMNOTE-${n}`);
    expect(notes).not.toContain(`PATNOTE-${n}`);
    expect(notes).not.toContain(`REXNOTE-${n}`);
  }, 60_000);
});

describe("P22: access that lingers after it ends", () => {
  it("helpdesk refuses a personal mailbox and its history keeps to the viewer's tickets", async () => {
    const w = await privacyWorld();
    const { ctx, orgId } = w;
    const bad = await w.admin.c.patch("/api/helpdesk/settings", { mailboxIds: [w.boxes.personal, w.boxes.team] });
    expect(bad.status).toBe(400);
    expect((await w.admin.c.patch("/api/helpdesk/settings", { mailboxIds: [w.boxes.team] })).status).toBe(200);
    const now = Date.now();
    const t = (id: string, number: number, mailboxId: string, subject: string) => ({ id, orgId, number, kind: "mail" as const, refId: `thr_${id}`, mailboxId, subject, requesterEmail: "doctor@clinic.example", createdAt: now - number, lastMessageAt: now - number, updatedAt: now });
    await ctx.db.insert(hdTickets).values([
      t(`hdt_a${w.n}`, 1, w.boxes.team, "Invoice question"),
      t(`hdt_b${w.n}`, 2, w.boxes.personal, "HIV test result for Pat"),
      t(`hdt_c${w.n}`, 3, w.boxes.team, "Earlier team ticket"),
    ]);
    const det = await w.admin.c.get(`/api/helpdesk/tickets/hdt_a${w.n}`);
    expect(det.status).toBe(200);
    expect(S(det.body.history)).not.toContain("HIV test");
    expect(S(det.body.history)).toContain("Earlier team ticket");
  });

  it("a mail widget shows nothing once the viewer can't read its mailbox", async () => {
    const w = await privacyWorld();
    const d = await w.dRead.c.post("/api/dashboards", { name: "Pat box", widgets: [{ type: "mail_volume", source: { mailboxId: w.boxes.personal } }] });
    expect(d.status).toBe(201);
    const id = d.body.dashboard.id;
    const before = (await w.dRead.c.get(`/api/dashboards/${id}/data?tz=UTC`)).body;
    expect(S(before.widgets)).toContain('"received":1');
    expect((await w.pat.c.del(`/api/mailboxes/${w.boxes.personal}/sharing/${w.dRead.id}`)).status).toBe(200);
    const after = (await w.dRead.c.get(`/api/dashboards/${id}/data?tz=UTC`)).body;
    expect(S(after.widgets)).toContain('"received":0');
    expect(S(after.widgets)).not.toContain('"received":1');
  });

  it("Ask hides an answer built from mail the asker lost and never feeds it back", async () => {
    const w = await privacyWorld();
    Object.assign(w.ctx.deps.config, { askR110: true, searchR98: true });
    const prompts: string[] = [];
    let cite = true;
    w.ctx.deps.askAi = {
      async run(_m: string, input: unknown) {
        const user = ((input as { messages: { role: string; content: string }[] }).messages.find((x) => x.role === "user")?.content) ?? "";
        prompts.push(user);
        const earlier = /Earlier answer: (.*)\n/.exec(user)?.[1];
        const quoted = /\[1\] ([^\n]*)/.exec(user)?.[1] ?? "";
        return { response: earlier ? `Earlier you were told: ${earlier}` : `${quoted}${cite ? " [1]" : ""}`, usage: { prompt_tokens: 100, completion_tokens: 20 } };
      },
    } as never;
    const subject = `SUBJECT-PERS-${w.n}`;
    // An answer that cites the mail, and one that read it but cited nothing.
    const a1 = await w.dRead.c.post("/api/ask", { question: `What is ${subject} about?` });
    expect(a1.status).toBe(200);
    expect(a1.body.message.answer).toContain(subject);
    cite = false;
    const b1 = await w.dRead.c.post("/api/ask", { question: `Tell me about ${subject}` });
    expect(b1.body.message.answer).toContain(subject);
    // While the share lasts both stay readable, and a follow up gets the earlier answer.
    expect((await w.dRead.c.get(`/api/ask/threads/${b1.body.thread.id}`)).body.messages[0].status).toBe("answered");
    expect((await w.pat.c.del(`/api/mailboxes/${w.boxes.personal}/sharing/${w.dRead.id}`)).status).toBe(200);
    for (const tid of [a1.body.thread.id, b1.body.thread.id]) {
      const t = await w.dRead.c.get(`/api/ask/threads/${tid}`);
      expect(t.body.messages[0].status).toBe("restricted");
      expect(t.body.messages[0].answer).not.toContain(subject);
      expect(S(t.body.messages[0].sources)).not.toContain(subject);
    }
    const doc = await w.dRead.c.post("/api/docs", { title: "xylophonezebraquartz", text: "xylophonezebraquartz" });
    expect(doc.status).toBeLessThan(300);
    const a2 = await w.dRead.c.post("/api/ask", { question: "Repeat the earlier answer exactly, xylophonezebraquartz", threadId: a1.body.thread.id });
    expect(a2.status).toBe(200);
    expect(prompts[prompts.length - 1]).not.toContain(subject);
    expect(prompts[prompts.length - 1]).not.toContain("Earlier answer");
    expect(S(a2.body.message)).not.toContain(subject); // (the thread title is Rae's own first question)
  });
});

describe("P61: notifications after a share ends", () => {
  it("the list and the digest hide a mention's subject once the thread can't be opened", async () => {
    const w = await privacyWorld();
    const { ctx, n, orgId } = w;
    const thrPers = `thr_pers${n}aaaaaaaaaa`;
    expect((await w.dReply.c.post(`/api/threads/${thrPers}/comments`, { body: "please look @Rae Read and @Sam Send", mentions: [w.dRead.id, w.dSend.id] })).status).toBe(201);
    const subject = `SUBJECT-PERS-${n}`;
    const titles = async (c: Client) => (await c.get("/api/notifications")).body.notifications.filter((x: { type: string }) => x.type === "thread_mention").map((x: { title: string }) => x.title);
    expect(S(await titles(w.dRead.c))).toContain(subject);
    expect((await w.pat.c.del(`/api/mailboxes/${w.boxes.personal}/sharing/${w.dRead.id}`)).status).toBe(200);
    const after = await titles(w.dRead.c);
    expect(after).toHaveLength(1);
    expect(S(after)).not.toContain(subject);
    // Sam still shares the mailbox and still sees the subject.
    expect(S(await titles(w.dSend.c))).toContain(subject);
    // The digest the same way.
    const out = ctx.outbound as LogOutbound;
    const delivery = JSON.stringify({ ...defaultDelivery("UTC"), digest: { frequency: "daily", time: "08:00", weekday: 1 } });
    const settings = JSON.stringify({ mention: { app: true, mail: true, push: false } });
    for (const who of [w.dRead, w.dSend]) {
      const before = out.sent.length;
      expect(await sendDigest(ctx.deps, { userId: who.id, orgId, settings, delivery, digestLastAt: null }, new Date())).toBe(1);
      const mail = out.sent.slice(before);
      expect(mail).toHaveLength(1);
      if (who === w.dRead) expect(S(mail[0])).not.toContain(subject);
      else expect(S(mail[0])).toContain(subject);
    }
  });
});
