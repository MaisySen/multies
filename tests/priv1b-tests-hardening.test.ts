import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { privacyWorld, inboundMail } from "./priv1a-world";
import { deliverInbound } from "@/server/services/mail/delivery";
import { authEmailHooks, mailboxes, tasks, webhookDeliveries } from "@/server/db/schema";
import { getAuthEmailSettings, putAuthEmailSettings } from "@/server/services/mail/auth-email-settings";
import type { Client } from "./helpers";

/**
 * PRIV1b tests hardening (F29): mailboxes made by the product's own flows (a free address claimed in the app, a Gmail
 * connected through createConnection) are personal, and mail delivered into them through deliverInbound reaches only
 * the owner and the people the owner shares with. W1 and W2 are leaks the stronger route walk found. Made up example.* fixtures only.
 */
describe("F29: the real connect, claim and delivery flows", () => {
  it("a claimed address and a connected Gmail are their makers' personal mailboxes; delivered mail stays private", async () => {
    const w = await privacyWorld({ real: true });
    const r = w.real!;
    const owner = async (id: string) => (await w.ctx.db.select({ p: mailboxes.personal, o: mailboxes.ownerUserId }).from(mailboxes).where(eq(mailboxes.id, id)).get());
    expect(await owner(r.connected)).toEqual({ p: true, o: w.pat.id });
    expect(await owner(r.claimed)).toEqual({ p: true, o: w.admin.id });
    expect(r.stored.sort()).toEqual([r.claimed, w.boxes.personal].sort());
    // The connected Gmail shows in Pat's overview and connections, in nobody else's.
    for (const [c, may] of [[w.pat.c, true], [w.owner, false], [w.admin.c, false], [w.nobody.c, false]] as const) {
      expect([may, JSON.stringify((await c.get("/api/mail/overview")).body).includes(r.connected)]).toEqual([may, may]);
      const conns = (await c.get("/api/connections")).body.connections as { id: string; openable?: boolean; imapHost?: string }[];
      expect([may, conns.some((x) => x.id === r.connectionId && x.openable !== false && !!x.imapHost)]).toEqual([may, may]);
    }
    // Each owner lists, opens and downloads their own; nobody else in the workspace does, the workspace owner included.
    const sees = async (c: Client, set: { msgs: { id: string }[]; attIds: string[] }, word: string) => {
      const list = JSON.stringify((await c.get("/api/mail/messages?folder=inbox&limit=100")).body);
      const ids = set.msgs.map((m) => m.id);
      const open = await Promise.all(ids.map(async (id) => (await c.get(`/api/mail/messages/${id}`)).status));
      const att = await Promise.all(set.attIds.map(async (id) => (await c.get(`/api/mail/attachments/${id}`)).status));
      return { listed: ids.filter((id) => list.includes(id)).length, open, att, words: list.includes(word) };
    };
    expect(await sees(w.pat.c, r.pat, r.words.subject)).toEqual({ listed: 1, open: [200], att: [200], words: true });
    expect(await sees(w.admin.c, r.ada, r.adaWords.subject)).toEqual({ listed: 1, open: [200], att: [200], words: true });
    for (const c of [w.owner, w.admin.c, w.member.c, w.nobody.c]) expect(await sees(c, r.pat, r.words.subject)).toEqual({ listed: 0, open: [404], att: [404], words: false });
    for (const c of [w.owner, w.pat.c, w.member.c, w.nobody.c]) expect(await sees(c, r.ada, r.adaWords.subject)).toEqual({ listed: 0, open: [404], att: [404], words: false });
    // Pat's read delegate sees Pat's delivered mail; Pat shares the Gmail and the new delegate sees it in the overview.
    expect((await sees(w.dRead.c, r.pat, r.words.subject)).listed).toBe(1);
    expect((await w.pat.c.put(`/api/mailboxes/${r.connected}/sharing/${w.nobody.id}`, { level: "read" })).status).toBe(200);
    expect(JSON.stringify((await w.nobody.c.get("/api/mail/overview")).body)).toContain(r.connected);
    // The workspace webhook heard nothing of either.
    const hooks = JSON.stringify(await w.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, w.orgId)).all());
    for (const word of [...Object.values(r.words), ...Object.values(r.adaWords)]) expect(hooks).not.toContain(word);
    // Team mail delivered the same way still reaches the workspace hook (the hook works).
    await deliverInbound(w.ctx.deps, inboundMail("team@acme.io", "client@example.com", `TEAMHOOK-${w.n}`, "team"));
    expect(JSON.stringify(await w.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, w.orgId)).all())).toContain(`TEAMHOOK-${w.n}`);
  }, 60_000);
});

describe("W1: sign-up emails never come from someone's personal mailbox", () => {
  it("the sender list and the save leave personal mailboxes out; a team mailbox still works", async () => {
    const w = await privacyWorld();
    const admin = { orgId: w.orgId, userId: w.admin.id, email: "ada@acme.io", role: "admin" } as never;
    const senders = JSON.stringify((await getAuthEmailSettings(w.ctx.deps, admin)).senders);
    expect(senders).toContain("team@acme.io");
    expect(senders).not.toContain(`pat.private${w.n}@acme.io`);
    const put = (from: string) => putAuthEmailSettings(w.ctx.deps, admin, { from, supabaseUrl: "https://walk.example.com" });
    await expect(put(`pat.private${w.n}@acme.io`)).rejects.toMatchObject({ status: 422 });
    expect(await w.ctx.db.select().from(authEmailHooks).where(eq(authEmailHooks.mailboxId, w.boxes.personal)).all()).toHaveLength(0);
    // A team mailbox is still a sender.
    expect(JSON.stringify(await put("team@acme.io"))).toContain("team@acme.io");
    expect(await w.ctx.db.select().from(authEmailHooks).where(eq(authEmailHooks.mailboxId, w.boxes.team)).all()).toHaveLength(1);
  }, 60_000);
});

describe("W2: a task from someone's personal mail takes a reply share", () => {
  it("a read share is refused with share_level; reply share, the owner and team mail still make tasks", async () => {
    const w = await privacyWorld();
    const make = (c: Client, messageId: string) => c.post("/api/tasks/from-email", { messageId });
    const r = await make(w.dRead.c, w.msgs.personal);
    expect([r.status, r.body.error?.code]).toEqual([403, "share_level"]);
    expect(JSON.stringify(await w.ctx.db.select().from(tasks).where(eq(tasks.orgId, w.orgId)).all())).not.toContain(`SUBJECT-PERS-${w.n}`);
    expect((await make(w.admin.c, w.msgs.personal)).status).toBe(404);
    expect((await make(w.dReply.c, w.msgs.personal)).status).toBe(201);
    expect((await make(w.pat.c, w.msgs.personal)).status).toBe(201);
    expect((await make(w.member.c, w.msgs.team)).status).toBe(201);
    expect((await make(w.admin.c, w.msgs.team)).status).toBe(201);
  }, 60_000);
});
