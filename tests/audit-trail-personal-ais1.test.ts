/**
 * AIS1 (audit row 15), after review: an agent's thread read names the thread by its subject, except when the thread is
 * in a personal mailbox (PRIV1a: only its owner opens it, admins and the workspace owner never do). Then the entry keeps
 * the thread id but not the subject, so the subject can't reach other admins through Activity, the agent page or the
 * audit export. A team mailbox thread still carries its subject (tests/audit-trail-ais1.test.ts).
 * Review 2: the agent's next step, a reply, used to put that same subject ("Re: ...") and the outside sender's address
 * on its queued, sent, blocked and approved rows, and a plain member read the address in the agent's audit log. Those
 * rows now keep a recipient count only, and a member's view drops any field that holds an address.
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { auditLogs } from "@/server/db/schema";
import { memberSafeAudit } from "@/server/services/audit";

type W = Awaited<ReturnType<typeof privacyWorld>>;

async function v1(w: W, key: string, method: string, path: string, body?: unknown) {
  const res = await w.ctx.app.request(`/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const meta = (r: typeof auditLogs.$inferSelect) => JSON.parse(r.metadata ?? "{}") as Record<string, unknown>;

describe("AIS1: an agent's read of a personal mailbox thread keeps its subject out of the audit log", () => {
  it("Pat's agent reads her personal thread; Ada (admin) and the owner can't open it and don't read its subject", async () => {
    const w = await privacyWorld();
    // Pat becomes an admin (members can't make agents) and puts her own personal mailbox on an agent (PRIV1b P3/P4).
    expect((await w.owner.patch(`/api/team/members/${w.pat.id}`, { role: "admin" })).status).toBe(200);
    const made = await w.pat.c.post("/api/agents", { name: "Pat helper", localPart: `pathelper${w.n}`, approvalMode: "always", mailboxIds: [w.boxes.personal] });
    expect(made.status).toBe(201);
    const secret = made.body.apiKey.secret as string;
    const agentId = made.body.agent.id as string;
    const subject = `SUBJECT-PERS-${w.n}`;

    // The agent reads Pat's personal thread (allowed: its maker owns the mailbox).
    expect((await v1(w, secret, "GET", `/threads/${w.thread}`)).status).toBe(200);

    // Ada and the workspace owner can't open that mail...
    expect([403, 404]).toContain((await w.admin.c.get(`/api/mail/messages/${w.msgs.personal}`)).status);
    expect([403, 404]).toContain((await w.owner.get(`/api/mail/messages/${w.msgs.personal}`)).status);

    // ...so they must not read its subject anywhere else either.
    const audit = JSON.stringify((await w.admin.c.get("/api/org/audit")).body);
    const agentPage = JSON.stringify((await w.admin.c.get(`/api/agents/${agentId}/audit`)).body);
    const exported = String((await w.owner.get("/api/org/audit/export?format=csv")).body);
    expect({ audit: audit.includes(subject), agentPage: agentPage.includes(subject), exported: exported.includes(subject) })
      .toEqual({ audit: false, agentPage: false, exported: false });

    // The entry still says which thread was read, by which key.
    const [row] = await w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.action, "agent.message_read"), eq(auditLogs.agentId, agentId)));
    expect(row).toBeDefined();
    expect(row.targetType).toBe("thread");
    expect(row.targetId).toBe(w.thread);
    expect(meta(row).subject).toBeUndefined();
    expect((meta(row).caller as { kind?: string } | undefined)?.kind).toBe("agent_key");
  }, 120_000);
});

describe("AIS1 review 2: an agent's reply in a personal thread keeps the subject and the addresses out of the audit log", () => {
  it("Pat's agent reads, replies (queued, then approved), sends at once and is blocked; no row names the subject or an address", async () => {
    const w = await privacyWorld();
    expect((await w.owner.patch(`/api/team/members/${w.pat.id}`, { role: "admin" })).status).toBe(200);
    // AIS1 (PR 22): a new agent only sends to the workspace's own domains unless a person chooses its recipients. Here the person chooses anyone (null), so the send reaches the outside address this test is about.
    const made = await w.pat.c.post("/api/agents", { name: "Pat helper", localPart: `pathelper${w.n}`, approvalMode: "always", mailboxIds: [w.boxes.personal], allowedRecipients: null });
    expect(made.status).toBe(201);
    const secret = made.body.apiKey.secret as string;
    const agentId = made.body.agent.id as string;
    const subject = `SUBJECT-PERS-${w.n}`;
    const sender = "secret.sender.pers@private.example";
    const reply = (text: string) => v1(w, secret, "POST", `/agents/${agentId}/threads/${w.thread}/reply`, { text });
    const rowsOf = (action: string) => w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.action, action), eq(auditLogs.agentId, agentId)));

    // Read, then reply: the reply's subject is "Re: <the private subject>" and it goes to the outside sender.
    expect((await v1(w, secret, "GET", `/threads/${w.thread}`)).status).toBe(200);
    expect([200, 201, 202]).toContain((await reply("Thanks, on it.")).status);
    const [queued] = await rowsOf("agent.send_queued");
    expect(meta(queued)).toMatchObject({ personal: true, recipientCount: 1, reason: "always" });

    // Pat approves it from her own session.
    const approvals = (await w.pat.c.get(`/api/approvals?agentId=${agentId}`)).body.approvals as { id: string }[];
    expect(approvals.length).toBe(1);
    expect((await w.pat.c.post(`/api/approvals/${approvals[0].id}/approve`, {})).status).toBe(200);
    const [approved] = await w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.action, "approval.approved"), eq(auditLogs.targetId, approvals[0].id)));
    expect(meta(approved)).toMatchObject({ personal: true, recipientCount: 1, edited: false });

    // Sent at once (approvalMode never), then refused while paused.
    expect((await w.pat.c.patch(`/api/agents/${agentId}`, { approvalMode: "never" })).status).toBe(200);
    expect([200, 201]).toContain((await reply("Sent now.")).status);
    const [sent] = await rowsOf("agent.message_sent");
    expect(meta(sent)).toMatchObject({ personal: true, recipientCount: 1 });
    expect((await w.pat.c.patch(`/api/agents/${agentId}`, { status: "paused" })).status).toBe(200);
    expect((await reply("Paused.")).status).toBe(403);
    const [blocked] = await rowsOf("agent.send_blocked");
    expect(meta(blocked)).toMatchObject({ code: "agent_paused", personal: true, recipientCount: 1 });

    for (const r of [queued, approved, sent, blocked]) {
      expect(Object.keys(meta(r)).filter((k) => ["to", "cc", "bcc", "from", "subject"].includes(k))).toEqual([]);
      expect(r.metadata).not.toContain(subject);
      expect(r.metadata).not.toContain(sender);
    }

    // Ada, the owner and Max can't open Pat's personal mail, so they read neither its subject nor its sender anywhere.
    expect([403, 404]).toContain((await w.admin.c.get(`/api/mail/messages/${w.msgs.personal}`)).status);
    expect([403, 404]).toContain((await w.owner.get(`/api/mail/messages/${w.msgs.personal}`)).status);
    expect([403, 404]).toContain((await w.member.c.get(`/api/mail/messages/${w.msgs.personal}`)).status);
    const audit = JSON.stringify((await w.admin.c.get("/api/org/audit")).body);
    const exported = String((await w.owner.get("/api/org/audit/export?format=csv")).body);
    const agentPage = JSON.stringify((await w.member.c.get(`/api/agents/${agentId}/audit`)).body);
    expect({
      adminSeesSubject: audit.includes(subject), adminSeesSender: audit.includes(sender),
      exportHasSubject: exported.includes(subject), exportHasSender: exported.includes(sender),
      memberSeesSubject: agentPage.includes(subject), memberSeesSender: agentPage.includes(sender),
    }).toEqual({ adminSeesSubject: false, adminSeesSender: false, exportHasSubject: false, exportHasSender: false, memberSeesSubject: false, memberSeesSender: false });
  }, 120_000);

  it("a team mailbox send still names its subject and recipients for an admin; a member sees neither, and keeps a plan change's from and to", async () => {
    const w = await privacyWorld();
    // AIS1 (PR 22): a new agent only sends to the workspace's own domains unless a person chooses its recipients. Here the person chooses anyone (null), so the send reaches the outside address this test is about.
    const made = await w.owner.post("/api/agents", { name: "Desk", localPart: `desk${w.n}`, approvalMode: "always", allowedRecipients: null });
    expect(made.status).toBe(201);
    const secret = made.body.apiKey.secret as string;
    const agentId = made.body.agent.id as string;
    const send = await v1(w, secret, "POST", `/agents/${agentId}/send`, { to: ["client@outside.example"], cc: ["copy@outside.example"], subject: "Quote for March", text: "Hello" });
    expect([200, 201, 202]).toContain(send.status);
    const [queued] = await w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.action, "agent.send_queued"), eq(auditLogs.agentId, agentId)));
    expect(meta(queued)).toMatchObject({ to: ["client@outside.example"], subject: "Quote for March" });
    expect(meta(queued).personal).toBeUndefined();

    type Entry = { action: string; metadata: Record<string, unknown> | null };
    const adminRow = ((await w.admin.c.get(`/api/agents/${agentId}/audit`)).body.entries as Entry[]).find((e) => e.action === "agent.send_queued");
    expect(adminRow?.metadata).toMatchObject({ to: ["client@outside.example"], subject: "Quote for March" });
    const memberRow = ((await w.member.c.get(`/api/agents/${agentId}/audit`)).body.entries as Entry[]).find((e) => e.action === "agent.send_queued");
    expect(memberRow?.metadata).toMatchObject({ reason: "always" });
    expect(Object.keys(memberRow?.metadata ?? {}).filter((k) => ["to", "subject"].includes(k))).toEqual([]);

    // The member view drops any field that holds an address, whatever its name, and keeps values that are not addresses.
    expect(memberSafeAudit({ ip: "1.2.3.4", actorEmail: "agent:desk@acme.io", metadata: { to: ["a@b.example"], from: "box@acme.io", cc: [], recipients: ["Ada <ada@acme.io>"], code: "plan_limit" } }))
      .toEqual({ ip: null, actorEmail: "agent:desk@acme.io", metadata: { cc: [], code: "plan_limit" } });
    expect(memberSafeAudit({ ip: null, actorEmail: "olive@acme.io", metadata: { from: "free", to: "pro" } }).metadata).toEqual({ from: "free", to: "pro" });
  }, 120_000);
});
