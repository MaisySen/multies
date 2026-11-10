/**
 * PRIV1b batch "threads-exports" review fixes. Pat owns a personal mailbox AND has a team grant (common), so a thread
 * with a team copy and a personal copy is in her scope twice. Presence and notes follow the copy she has open, not
 * the oldest one; mention titles name that copy's subject; another copy's assignee is hidden; approval notifications,
 * the One inbox and the helpdesk sync stop showing personal mail once it can't be opened.
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import type { Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { agentMailboxAccess, agents, hdSettings, hdTickets, messages, sendApprovals } from "@/server/db/schema";
import { replyInThread } from "@/server/services/agents";
import { syncTickets } from "@/server/services/helpdesk";

const S = (x: unknown) => JSON.stringify(x);
type W = Awaited<ReturnType<typeof privacyWorld>>;

/** The same mixed thread as tests/priv1b-threads-exports.test.ts: team copy (older) and Pat's personal copy, which Pat answered. */
async function mixedThread(w: W) {
  const { ctx, n } = w;
  const deliver = (rcptTo: string, email: Record<string, unknown>) => deliverInbound(ctx.deps, {
    envelopeFrom: String((email.from as { address: string }).address), rcptTo, sizeBytes: 400, via: "test",
    email: { cc: [], attachments: [], authResults: {}, headers: {}, ...email },
  } as never);
  const orig = `<orig-${n}@customer.example>`;
  await deliver("team@acme.io", { messageId: orig, from: { address: "cust@customer.example", name: "Cust" }, to: [{ address: "team@acme.io" }], subject: `TEAMSUBJ-${n}`, text: `TEAMTEXT-${n}`, date: new Date(Date.now() - 50 * 60_000) });
  const teamMsg = (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, w.boxes.team), eq(messages.messageIdHeader, orig))).get())!;
  await deliver(`pat.private${n}@acme.io`, { messageId: `<pers-${n}@private.example>`, inReplyTo: orig, references: orig, from: { address: "lawyer@private.example", name: "Lawyer" }, to: [{ address: `pat.private${n}@acme.io` }], subject: `PERSSUBJ-${n} your divorce`, text: `PERSTEXT-${n}`, date: new Date(Date.now() - 40 * 60_000) });
  const persMsg = (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, w.boxes.personal), eq(messages.messageIdHeader, `<pers-${n}@private.example>`))).get())!;
  expect(persMsg.threadId).toBe(teamMsg.threadId);
  expect((await w.pat.c.post("/api/mail/send", { mailboxId: w.boxes.personal, to: ["lawyer@private.example"], subject: `Re: PERSSUBJ-${n} your divorce`, text: `PATREPLY-${n}`, inReplyToId: persMsg.id })).status).toBe(201);
  return { thr: teamMsg.threadId, teamMsg, persMsg };
}

const grantPatTeam = async (w: W) => expect((await w.owner.patch(`/api/team/members/${w.pat.id}`, { mailboxIds: [w.boxes.team] })).status).toBe(200);
const names = (b: { people: { name: string }[] }) => b.people.map((p) => p.name);

describe("P15 review: Pat also has a team grant", () => {
  it("presence keys the room by the copy the client has open (M1)", async () => {
    const w = await privacyWorld();
    await grantPatTeam(w);
    const { thr } = await mixedThread(w);
    // Pat replies in her personal copy: the admin's team view does not list her, Rae (her delegate) does.
    expect((await w.pat.c.post(`/api/threads/${thr}/presence`, { clientId: "patclient1", state: "replying", mailboxId: w.boxes.personal })).status).toBe(200);
    expect(names((await w.admin.c.get(`/api/threads/${thr}/presence`)).body)).toEqual([]);
    expect(names((await w.admin.c.get(`/api/threads/${thr}/presence?mailboxId=${w.boxes.team}`)).body)).toEqual([]);
    expect(names((await w.dRead.c.get(`/api/threads/${thr}/presence?mailboxId=${w.boxes.personal}`)).body)).toEqual(["Pat Person"]);
    expect(names((await w.dRead.c.get(`/api/threads/${thr}/presence`)).body)).toEqual(["Pat Person"]);
    // The admin can't name Pat's copy to get in; Max neither.
    expect((await w.admin.c.get(`/api/threads/${thr}/presence?mailboxId=${w.boxes.personal}`)).status).toBe(404);
    expect((await w.member.c.post(`/api/threads/${thr}/presence`, { clientId: "maxclient1", state: "viewing", mailboxId: w.boxes.personal })).status).toBe(404);
    // A mailbox with no message of the thread is refused too.
    expect((await w.pat.c.post(`/api/threads/${thr}/presence`, { clientId: "patclient2", state: "viewing", mailboxId: w.boxes.agent })).status).toBe(404);
    // Pat in the team copy is seen by the team, not by Rae.
    expect((await w.pat.c.post(`/api/threads/${thr}/presence`, { clientId: "patclient3", state: "viewing", mailboxId: w.boxes.team })).status).toBe(200);
    expect(names((await w.admin.c.get(`/api/threads/${thr}/presence`)).body)).toEqual(["Pat Person"]);
    const rae = (await w.dRead.c.get(`/api/threads/${thr}/presence`)).body.people;
    expect(rae.map((p: { name: string; state: string }) => `${p.name}:${p.state}`)).toEqual(["Pat Person:replying"]);
    // Leaving names the copy too.
    expect((await w.pat.c.post(`/api/threads/${thr}/presence/leave`, { clientId: "patclient1", mailboxId: w.boxes.personal })).status).toBe(200);
    expect(names((await w.dRead.c.get(`/api/threads/${thr}/presence`)).body)).toEqual([]);
  });

  it("a note goes on the copy the client names, and its mention names that copy's subject (M2, S3)", async () => {
    const w = await privacyWorld();
    await grantPatTeam(w);
    const { thr } = await mixedThread(w);
    const n = w.n;
    const add = await w.pat.c.post(`/api/threads/${thr}/comments`, { body: `PATNOTE-${n} @Rae Read`, mentions: [w.dRead.id], mailboxId: w.boxes.personal });
    expect(add.status).toBe(201);
    expect(add.body.comment.mailboxId).toBe(w.boxes.personal);
    expect(S((await w.admin.c.get(`/api/threads/${thr}/comments`)).body)).not.toContain(`PATNOTE-${n}`);
    expect(S((await w.member.c.get(`/api/threads/${thr}/comments`)).body)).not.toContain(`PATNOTE-${n}`);
    expect(S((await w.dRead.c.get(`/api/threads/${thr}/comments`)).body)).toContain(`PATNOTE-${n}`);
    const raeNote = (await w.dRead.c.get("/api/notifications")).body.notifications.find((x: { type: string }) => x.type === "thread_mention");
    expect(raeNote.title).toContain(`PERSSUBJ-${n}`);
    // A note on the team copy, mentioning Max, carries the team subject only.
    const team = await w.pat.c.post(`/api/threads/${thr}/comments`, { body: `TEAMNOTE-${n} @Max Member`, mentions: [w.member.id], mailboxId: w.boxes.team });
    expect(team.status).toBe(201);
    expect(S((await w.admin.c.get(`/api/threads/${thr}/comments`)).body)).toContain(`TEAMNOTE-${n}`);
    expect(S((await w.dRead.c.get(`/api/threads/${thr}/comments`)).body)).not.toContain(`TEAMNOTE-${n}`);
    const maxNote = (await w.member.c.get("/api/notifications")).body.notifications.find((x: { type: string }) => x.type === "thread_mention");
    expect(maxNote.title).toContain(`TEAMSUBJ-${n}`);
    expect(maxNote.title).not.toContain("PERSSUBJ");
    // Naming a copy the caller can't open is 404; a read share can't write in it (403); a reply share can.
    expect((await w.member.c.post(`/api/threads/${thr}/comments`, { body: "x", mailboxId: w.boxes.personal })).status).toBe(404);
    const rae = await w.dRead.c.post(`/api/threads/${thr}/comments`, { body: "x", mailboxId: w.boxes.personal });
    expect(rae.status).toBe(403);
    expect(rae.body.error.code).toBe("share_level");
    expect((await w.dReply.c.post(`/api/threads/${thr}/comments`, { body: `REXNOTE-${n}`, mailboxId: w.boxes.personal })).status).toBe(201);
    // No mailboxId still works (the oldest copy the caller can reply in).
    expect((await w.member.c.post(`/api/threads/${thr}/comments`, { body: `MAXNOTE-${n}` })).status).toBe(201);
    expect(S((await w.admin.c.get(`/api/threads/${thr}/comments`)).body)).toContain(`MAXNOTE-${n}`);
  });

  it("a chat link reads as the reader's own copy", async () => {
    const w = await privacyWorld();
    const { thr } = await mixedThread(w);
    const n = w.n;
    const ch = await w.member.c.post("/api/chat/channels", { name: `general-${n}` });
    const post = await w.member.c.post(`/api/chat/channels/${ch.body.channel.id}/messages`, { body: `look <#thread:${thr}> and <#thread:${thr}>` });
    expect(post.status).toBe(201);
    expect(post.body.message.links[0].title).toBe(`TEAMSUBJ-${n}`);
    // With per-reader cards (TD5), Pat's card is her own copy's newest non-draft subject; Max keeps the team's.
    Object.assign(w.ctx.deps.config, { mentionsTd5: true });
    const linkFor = async (c: Client) => {
      const b = (await c.get(`/api/chat/channels/${ch.body.channel.id}/messages`)).body;
      const m = b.messages.find((x: { id: string }) => x.id === post.body.message.id);
      return m.links.filter((l: { type: string }) => l.type === "thread").map((l: { title: string }) => l.title);
    };
    expect(await linkFor(w.pat.c)).toEqual([`Re: PERSSUBJ-${n} your divorce`]);
    expect(await linkFor(w.member.c)).toEqual([`TEAMSUBJ-${n}`]);
  });
});

describe("P15 review: another copy's thread state (S2)", () => {
  it("hides the assignee set from Pat's copy and refuses changes from the team copy", async () => {
    const w = await privacyWorld();
    const { thr } = await mixedThread(w);
    const as = await w.pat.c.post(`/api/threads/${thr}/assign`, { userId: w.dRead.id });
    expect(as.status).toBe(200);
    expect(as.body.state.assignee.name).toBe("Rae Read");
    const st = await w.admin.c.get(`/api/threads/${thr}/state`);
    expect(st.status).toBe(200);
    expect(S(st.body)).not.toContain("Rae Read");
    expect(st.body.state.assignee).toBeNull();
    const list = await w.admin.c.get("/api/agents/threads?view=all");
    expect(S(list.body.data.find((x: { id: string }) => x.id === thr))).not.toContain("Rae Read");
    expect((await w.admin.c.post(`/api/threads/${thr}/assign`, { userId: null })).status).toBe(409);
    expect((await w.member.c.post(`/api/threads/${thr}/status`, { status: "done" })).status).toBe(409);
    // Pat still sees and changes her own.
    expect((await w.pat.c.get(`/api/threads/${thr}/state`)).body.state.assignee.name).toBe("Rae Read");
    expect((await w.pat.c.post(`/api/threads/${thr}/status`, { status: "done" })).status).toBe(200);
  });
});

describe("P61 review: approval notifications and the One inbox", () => {
  it("hide an approval's title once the share ends", async () => {
    const w = await privacyWorld();
    const { ctx, orgId, n } = w;
    const { thr } = await mixedThread(w);
    const agentId = `agt_pat${n}aaaaaaaaa`;
    await ctx.db.insert(agents).values({ id: agentId, orgId, mailboxId: w.boxes.agent, name: "Pat helper", createdByUserId: w.pat.id, approvalMode: "always" } as never);
    await ctx.db.insert(agentMailboxAccess).values({ agentId, mailboxId: w.boxes.personal, orgId });
    const req = await replyInThread(ctx.deps, { orgId, userId: "", role: "admin", sessionId: "mcp:test", agentId, email: "", name: "" } as never, agentId, thr, { text: "draft" });
    expect((req as { status: string }).status).toBe("pending_approval");
    expect(await ctx.db.select().from(sendApprovals).where(eq(sendApprovals.mailboxId, w.boxes.personal)).get()).toBeTruthy();
    const titles = async (c: Client) => (await c.get("/api/notifications")).body.notifications.filter((x: { type: string }) => x.type === "approval.requested").map((x: { title: string }) => x.title);
    const before = await titles(w.dRead.c);
    expect(before).toHaveLength(1);
    expect(S(before)).toContain("Pat helper");
    // One inbox (flag on) shows it too.
    Object.assign(ctx.deps.config, { inboxTd6: true });
    const inbox = async (c: Client) => S([(await c.get("/api/one-inbox?lane=important")).body, (await c.get("/api/one-inbox?lane=noise")).body]);
    expect(await inbox(w.dRead.c)).toContain("Pat helper wants to send");
    expect((await w.pat.c.del(`/api/mailboxes/${w.boxes.personal}/sharing/${w.dRead.id}`)).status).toBe(200);
    const after = await titles(w.dRead.c);
    expect(after).toHaveLength(1);
    expect(S(after)).not.toContain("Pat helper wants to send");
    const ib = await inbox(w.dRead.c);
    expect(ib).not.toContain("Pat helper wants to send");
    expect(ib).toContain("A conversation you can no longer open");
    // Sam still shares the mailbox and still sees it.
    expect(S(await titles(w.dSend.c))).toContain("Pat helper wants to send");
    expect(await inbox(w.dSend.c)).toContain("Pat helper wants to send");
  });
});

describe("P22 review: helpdesk sync (S4)", () => {
  it("never reads a personal mailbox saved in settings before they refused one", async () => {
    const w = await privacyWorld();
    const { ctx, orgId } = w;
    expect((await w.owner.patch("/api/helpdesk/settings", { mailboxIds: [w.boxes.team] })).status).toBe(200);
    const row = (await ctx.db.select().from(hdSettings).where(eq(hdSettings.orgId, orgId)).get())!;
    const settings = { ...JSON.parse(row.settings), mailboxIds: [w.boxes.team, w.boxes.personal] };
    await ctx.db.update(hdSettings).set({ settings: JSON.stringify(settings), syncCursor: Date.now() - 2 * 3600_000, syncedAt: 0 }).where(eq(hdSettings.orgId, orgId));
    await syncTickets(ctx.deps, orgId, undefined, true);
    const tickets = await ctx.db.select().from(hdTickets).where(eq(hdTickets.orgId, orgId));
    expect(tickets.map((t) => t.mailboxId)).toContain(w.boxes.team);
    expect(tickets.map((t) => t.mailboxId)).not.toContain(w.boxes.personal);
  });
});
