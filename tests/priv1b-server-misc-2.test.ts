/**
 * PRIV1b round 2, batch "server-misc-2": invite grants skip personal mailboxes (ML1), the access log prune keeps a
 * mark (ML2), comp workspaces get their granted plan in campaigns and referrals (CB1), a ban, a report suspension and
 * an account deletion close live sockets and end apps (CB2), a refused calendar port says so (CB3), a picked due day
 * shows on that day west of UTC (DUE1), the agent event stream stops at once when its key is revoked (SSE1), the
 * bounce notice is not stamped pass for an unverified claim (AR1), approval webhooks carry the mailbox (AP1), and the
 * One inbox hides the title of a thread notification the viewer can no longer open (NOTIF1).
 */
import { describe, it, expect } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { privacyWorld } from "./priv1a-world";
import { appSettings, domains, invitations, mailboxAccess, mailboxes, mailboxAccessLog, messages, notifications, oauthClients, oauthGrants, organizations, sessions, users, webhookDeliveries } from "@/server/db/schema";
import { OPENS_PRUNED_KEY, pruneMailboxOpens } from "@/server/services/maintenance";
import { mergeCap } from "@/server/services/campaigns/r109";
import { monthlyTotal } from "@/server/services/billing/referrals";
import { checkUrl } from "@/server/services/suite/caldav";
import { CLOSE_REVOKED, MemoryChatHub, type HubConn } from "@/server/realtime/hub";
import { deliverInbound } from "@/server/services/mail/delivery";
import { onDeliverDead } from "@/server/services/mail/deliver-job";
import { createEndpoint } from "@/server/services/developer/webhooks";

const S = (x: unknown) => JSON.stringify(x);
const DAY = 86_400_000;

async function pair() {
  const ctx = await makeTestApp();
  const owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  const inv = await owner.post("/api/team/invites", { email: "maya@acme.io", role: "member", mailboxIds: [] });
  const maya = new Client(ctx.app);
  await maya.signup("maya@acme.io", "Maya Lopez", "");
  expect((await maya.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const me = (await owner.get("/api/account/me")).body;
  const mayaId = (await maya.get("/api/account/me")).body.user.id as string;
  return { ctx, owner, maya, orgId: me.organization.id as string, ownerId: me.user.id as string, mayaId };
}
function conn(userId: string) {
  const closed: number[] = [];
  const c: HubConn = { userId, openedAt: Date.now(), send: () => undefined, close: (code) => { closed.push(code); } };
  return { c, closed };
}
async function grantFor(ctx: Awaited<ReturnType<typeof makeTestApp>>, orgId: string, userId: string, tag: string) {
  await ctx.db.insert(oauthClients).values({ id: `oac_${tag}`, name: "App", redirectUris: "[]" }).onConflictDoNothing();
  await ctx.db.insert(oauthGrants).values({ id: `oag_${tag}`, clientId: `oac_${tag}`, orgId, userId, scope: "full", redirectUri: "https://example.com/cb", refreshHash: "h" });
  return async () => !!(await ctx.db.select().from(oauthGrants).where(and(eq(oauthGrants.id, `oag_${tag}`), isNull(oauthGrants.revokedAt))).get());
}

describe("ML1: accepting an invite never grants a personal mailbox", () => {
  it("the team mailbox is granted, the personal one stored on the invite is skipped", async () => {
    const w = await privacyWorld();
    const inv = await w.owner.post("/api/team/invites", { email: `kim${w.n}@acme.io`, role: "member", mailboxIds: [w.boxes.team] });
    expect(inv.status).toBe(201);
    // An invite stored before the rule (or a crafted one) names Pat's personal mailbox as well.
    await w.ctx.db.update(invitations).set({ mailboxIds: S([w.boxes.team, w.boxes.personal]) }).where(eq(invitations.email, `kim${w.n}@acme.io`));
    const kim = new Client(w.ctx.app);
    await kim.signup(`kim${w.n}@acme.io`, "Kim New", "");
    expect((await kim.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    const kimId = (await w.ctx.db.select({ id: users.id }).from(users).where(eq(users.email, `kim${w.n}@acme.io`)).get())!.id;
    const granted = (await w.ctx.db.select({ m: mailboxAccess.mailboxId }).from(mailboxAccess).where(eq(mailboxAccess.userId, kimId))).map((r) => r.m);
    expect(granted).toEqual([w.boxes.team]);
    const list = await kim.get("/api/mail/messages?folder=inbox&limit=50");
    expect(list.status).toBe(200);
    expect(S(list.body)).toContain(`SUBJECT-TEAM-${w.n}`);
    expect(S(list.body)).not.toContain(`SUBJECT-PERS-${w.n}`);
  }, 60_000);
});

describe("ML2: the access log prune starts where the last pass stopped", () => {
  it("keeps a mark, a cut pass stops at its newest row, and old share rows behind the mark are not read again", async () => {
    const w = await privacyWorld();
    const now = w.ctx.deps.now().getTime();
    const row = (id: string, action: string, ageDays: number) => ({ id: `mal_ml2${id}${w.n}`, orgId: w.orgId, mailboxId: w.boxes.personal, actorUserId: w.dRead.id, actorEmail: null, action, targetId: null, device: "web", createdAt: new Date(now - ageDays * DAY) });
    await w.ctx.db.delete(mailboxAccessLog).where(eq(mailboxAccessLog.orgId, w.orgId));
    await w.ctx.db.insert(mailboxAccessLog).values([row("a", "opened_thread", 900), row("b", "opened_mailbox", 700), row("c", "opened_thread", 500), row("s", "share_granted", 950), row("r", "opened_thread", 10)]);
    const mark = async () => Number((await w.ctx.db.select().from(appSettings).where(eq(appSettings.key, OPENS_PRUNED_KEY)).get())?.value ?? 0);
    expect(await pruneMailboxOpens(w.ctx.deps, 2)).toBe(2);
    expect(await mark()).toBe(now - 700 * DAY); // the newest row the cut pass removed
    expect(await pruneMailboxOpens(w.ctx.deps)).toBe(1);
    const cutoff = await mark();
    expect(cutoff).toBeGreaterThan(now - 401 * DAY);
    const left = (await w.ctx.db.select({ id: mailboxAccessLog.id }).from(mailboxAccessLog).where(eq(mailboxAccessLog.orgId, w.orgId))).map((r) => r.id).sort();
    expect(left).toEqual([`mal_ml2r${w.n}`, `mal_ml2s${w.n}`]);
    // A row behind the mark is not looked at again (only opens logged now ever land in the log).
    await w.ctx.db.insert(mailboxAccessLog).values(row("z", "opened_thread", 600));
    expect(await pruneMailboxOpens(w.ctx.deps)).toBe(0);
  }, 60_000);
});

describe("CB1: a comp workspace gets the plan it was granted", () => {
  it("merge cap follows effectivePlanId; the referral total follows what is paid", async () => {
    const { ctx, orgId } = await pair();
    await ctx.db.update(organizations).set({ plan: "starter", compPlan: false }).where(eq(organizations.id, orgId));
    expect(await mergeCap(ctx.deps, orgId)).toBe(50);
    const org = async () => (await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).get())!;
    expect(await monthlyTotal(ctx.deps, await org())).toBe(0);
    await ctx.db.update(organizations).set({ compPlan: true }).where(eq(organizations.id, orgId));
    expect(await mergeCap(ctx.deps, orgId)).toBe(2000);
    // PRIV1b (SP4): the referral total is what the workspace pays; a comp workspace pays nothing for its granted plan.
    expect(await monthlyTotal(ctx.deps, await org())).toBe(0);
  }, 60_000);
});

describe("CB2: a ban, a report suspension and an account deletion close live sockets", () => {
  it("a platform ban closes the person's sockets and ends their apps; others keep theirs", async () => {
    const { ctx, owner, orgId, mayaId, ownerId } = await pair();
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.id, ownerId));
    const hub = new MemoryChatHub();
    ctx.deps.chatLive = hub;
    const m = conn(mayaId), o = conn(ownerId);
    hub.join(orgId, m.c); hub.join(orgId, o.c);
    const live = await grantFor(ctx, orgId, mayaId, "ban");
    expect((await owner.post("/api/auth/admin/ban-user", { userId: mayaId })).status).toBe(200);
    expect(m.closed).toEqual([CLOSE_REVOKED]);
    expect(o.closed).toEqual([]);
    expect(await live()).toBe(false);
  }, 60_000);

  it("suspending after a content report closes sockets and ends OAuth grants", async () => {
    const { ctx, owner, maya, orgId, mayaId, ownerId } = await pair();
    const hub = new MemoryChatHub();
    ctx.deps.chatLive = hub;
    const m = conn(mayaId), o = conn(ownerId);
    hub.join(orgId, m.c); hub.join(orgId, o.c);
    const live = await grantFor(ctx, orgId, mayaId, "rep");
    const ownerLive = await grantFor(ctx, orgId, ownerId, "rep2");
    const rep = await owner.post("/api/reports", { targetType: "user", userId: mayaId, reason: "harassment" });
    expect(rep.status).toBeLessThan(300);
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.id, ownerId));
    const act = await owner.post(`/api/admin/reports/${rep.body.id}/action`, { action: "suspend_user" });
    expect(act.status).toBe(200);
    expect(act.body.report).toMatchObject({ action: "user_suspended" });
    expect(m.closed).toEqual([CLOSE_REVOKED]);
    expect(o.closed).toEqual([]);
    expect(await live()).toBe(false);
    expect(await ownerLive()).toBe(true);
    expect((await maya.get("/api/account/me")).status).toBe(401);
  }, 60_000);

  it("deleting an account closes its sockets", async () => {
    const { ctx, maya, orgId, mayaId, ownerId } = await pair();
    const hub = new MemoryChatHub();
    ctx.deps.chatLive = hub;
    const m = conn(mayaId), o = conn(ownerId);
    hub.join(orgId, m.c); hub.join(orgId, o.c);
    const del = await maya.call("DELETE", "/api/account", { confirm: "DELETE", password: "a-strong-password" });
    expect(del.status).toBe(200);
    expect(m.closed).toEqual([CLOSE_REVOKED]);
    expect(o.closed).toEqual([]);
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, mayaId)).get()).toBeFalsy();
  }, 60_000);
});

describe("CB3: a calendar address on another port", () => {
  it("says the port is not allowed, not private network; private hosts still say private", () => {
    expect(() => checkUrl("https://calendar.example.com:6379/x.ics", false)).toThrow(/port is not allowed/);
    expect(() => checkUrl("https://calendar.example.com:6379/x.ics", false)).not.toThrow(/private network/);
    expect(() => checkUrl("https://10.0.0.5/x.ics", false)).toThrow(/private network/);
    expect(checkUrl("https://calendar.example.com:443/x.ics", false).hostname).toBe("calendar.example.com");
  });
});

describe("DUE1: a picked due day shows on that day west of UTC", () => {
  it("America/New_York sees a day picked as 2026-11-20 on the 20th; a due time stays an instant", async () => {
    const { ctx, owner, ownerId } = await pair();
    await ctx.db.update(users).set({ timezone: "America/New_York" }).where(eq(users.id, ownerId));
    expect((await owner.post("/api/tasks", { title: "Picked day", due: "2026-11-20", assignee: `member:${ownerId}` })).status).toBe(201);
    expect((await owner.post("/api/tasks", { title: "Late UTC", due: "2026-11-25T03:00:00Z", assignee: `member:${ownerId}` })).status).toBe(201);
    const ev = await owner.get("/api/calendar/events?from=2026-11-01&to=2026-12-01");
    expect(ev.status).toBe(200);
    expect(ev.body.timezone).toBe("America/New_York");
    const due = (t: string) => (ev.body.events as { title: string; start: string; end: string }[]).find((e) => e.title.startsWith(`Due: ${t}`))!;
    expect(due("Picked day")).toMatchObject({ start: "2026-11-20", end: "2026-11-21" });
    expect(due("Late UTC").start).toBe("2026-11-24"); // 22:00 on the 24th in New York
    // What is stored does not change.
    const t = await owner.get("/api/tasks?limit=50");
    expect(S(t.body)).toContain("2026-11-20T00:00:00.000Z");
  }, 60_000);
});

describe("SSE1: the agent event stream stops when its key is revoked", () => {
  async function setup() {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const { body } = await c.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await c.post(`/api/domains/${domainId}/verify`);
    const made = await c.post("/api/developer/keys", { name: "W" });
    const key = made.body.secret as string;
    const keyId = (made.body.apiKey?.id ?? made.body.key?.id ?? made.body.id) as string;
    const res0 = await ctx.app.request("/api/v1/agents", { method: "POST", headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ name: "S" }) });
    const { agent } = (await res0.json()) as { agent: { id: string; address: string } };
    const res = await ctx.app.request(`/api/v1/agents/${agent.id}/events/stream?timeout=6`, { headers: { authorization: `Bearer ${key}`, host: "localhost" } });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    const deliver = (subject: string) => deliverInbound(ctx.deps, { envelopeFrom: "g@example.com", rcptTo: agent.address, sizeBytes: 300, via: "test",
      email: { messageId: `<${subject}${Date.now()}@example.com>`, from: { address: "g@example.com", name: "G" }, to: [{ address: agent.address }], cc: [], subject, text: "Your code is 482913", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} } } as never);
    const readUntil = async (needle: string) => {
      let got = "";
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) { const r = await reader.read(); if (r.done) break; got += new TextDecoder().decode(r.value); if (got.includes(needle)) break; }
      return got;
    };
    return { ctx, c, keyId, deliver, readUntil, reader };
  }

  it("a live key gets the mail; after revoke nothing more is sent and the stream ends", async () => {
    const s = await setup();
    await s.deliver("BEFORE-REVOKE");
    expect(await s.readUntil("BEFORE-REVOKE")).toContain("BEFORE-REVOKE");
    expect((await s.c.del(`/api/developer/keys/${s.keyId}`)).status).toBeLessThan(300);
    await s.deliver("AFTER-REVOKE");
    const got = await s.readUntil("AFTER-REVOKE");
    expect(got).not.toContain("AFTER-REVOKE");
    expect(got).not.toContain("482913");
    await s.reader.cancel().catch(() => undefined);
  }, 30_000);
});

describe("AR1: the bounce notice is stamped pass only for a domain that is not an unverified claim", () => {
  it("pass from the deployment's own domain; none when a workspace holds that name unverified", async () => {
    const { ctx, owner, orgId } = await pair();
    const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id as string;
    await ctx.db.update(domains).set({ status: "verified" }).where(eq(domains.id, domainId));
    const dom = (await ctx.db.select().from(domains).where(eq(domains.id, domainId)).get())!;
    const box = (await owner.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" })).body.mailbox.id as string;
    const sent = { id: "msg_ar1sent0000000000", orgId, mailboxId: box, folder: "sent", threadId: "thr_ar1", fromAddress: "team@acme.io", fromName: "Team", to: S([{ name: "", address: "x@example.org" }]), subject: "AR1 subject", text: "t", snippet: "t", date: new Date(), isRead: true };
    await ctx.db.insert(messages).values(sent as never);
    const ndr = async () => (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, box), eq(messages.folder, "inbox"))).all()).filter((m) => m.subject.startsWith("Undeliverable"));
    await onDeliverDead(ctx.deps, { orgId, messageId: sent.id, to: ["x@example.org"], cc: [], bcc: [] }, null, "550 no such user");
    const first = await ndr();
    expect(first).toHaveLength(1);
    expect(JSON.parse(first[0]!.authResults!)).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "pass" });
    // A workspace holds the system address's domain without proving it.
    const sysDomain = ctx.deps.config.systemFrom.address.split("@")[1]!.toLowerCase();
    await ctx.db.insert(domains).values({ ...dom, id: "dom_ar1claim", name: sysDomain, status: "pending" });
    await ctx.db.delete(messages).where(eq(messages.id, first[0]!.id));
    await onDeliverDead(ctx.deps, { orgId, messageId: sent.id, to: ["x@example.org"], cc: [], bcc: [] }, null, "550 no such user");
    const second = await ndr();
    expect(second).toHaveLength(1);
    expect(JSON.parse(second[0]!.authResults!)).toMatchObject({ spf: "none", dkim: "none", dmarc: "none" });
  }, 60_000);
});

describe("AP1: approval.requested carries the mailbox id", () => {
  it("the workspace webhook payload names the agent's mailbox", async () => {
    const { ctx, owner, orgId } = await pair();
    const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id as string;
    await ctx.db.update(domains).set({ status: "verified" }).where(eq(domains.id, domainId));
    await createEndpoint(ctx.deps, orgId, { url: "https://example.com/hook", events: ["approval.requested"] });
    const made = await owner.post("/api/agents", { name: "Approver", localPart: "approver", allowedRecipients: null }); // AIS1: x@example.org is outside the default list
    expect(made.status).toBe(201);
    const agent = made.body.agent as { id: string; mailboxId?: string };
    expect((await owner.patch(`/api/agents/${agent.id}`, { approvalMode: "always" })).status).toBeLessThan(300);
    const key = made.body.apiKey.secret as string;
    const send = await ctx.app.request(`/api/v1/agents/${agent.id}/send`, { method: "POST", headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ to: ["x@example.org"], subject: "AP1 hello", text: "hi" }) });
    expect(send.status).toBeLessThan(300);
    const rows = await ctx.db.select().from(webhookDeliveries);
    const ev = rows.map((r) => JSON.parse(r.payload as string)).find((p) => p.type === "approval.requested");
    expect(ev, S(rows)).toBeTruthy();
    const mb = (await ctx.db.select().from(mailboxes).where(eq(mailboxes.address, "approver@acme.io")).get())!;
    expect(ev.data.mailboxId).toBe(mb.id);
  }, 60_000);
});

describe("NOTIF1: the One inbox hides a thread notification's title once the thread can't be opened", () => {
  it("Rae loses the title when Pat's share ends; Sam keeps it; a team thread stays for the admin", async () => {
    const w = await privacyWorld({ flags: true });
    const { ctx, orgId, n } = w;
    const note = (id: string, userId: string, entityId: string, title: string) => ({ id: `ntf_n1${id}${n}aaaaaaaa`, orgId, userId, type: "thread_mention", entityType: "thread", entityId, title, actorName: "Pat" });
    await ctx.db.insert(notifications).values([
      note("rae", w.dRead.id, w.thread, `PERSNOTE-${n}`), note("sam", w.dSend.id, w.thread, `PERSNOTE-${n}`),
      note("ada", w.admin.id, `thr_team${n}aaaaaaaaaa`, `TEAMNOTE-${n}`),
    ] as never);
    const inbox = async (c: Client) => S([(await c.get("/api/one-inbox?lane=important")).body, (await c.get("/api/one-inbox?lane=noise")).body]);
    expect(await inbox(w.dRead.c)).toContain(`PERSNOTE-${n}`);
    expect((await w.pat.c.del(`/api/mailboxes/${w.boxes.personal}/sharing/${w.dRead.id}`)).status).toBe(200);
    const after = await inbox(w.dRead.c);
    expect(after).not.toContain(`PERSNOTE-${n}`);
    expect(after).toContain("A conversation you can no longer open");
    expect(await inbox(w.dSend.c)).toContain(`PERSNOTE-${n}`);
    expect(await inbox(w.admin.c)).toContain(`TEAMNOTE-${n}`);
  }, 60_000);
});
