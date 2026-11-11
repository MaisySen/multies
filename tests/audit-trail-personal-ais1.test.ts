/**
 * AIS1 (audit row 15), after review: an agent's thread read names the thread by its subject, except when the thread is
 * in a personal mailbox (PRIV1a: only its owner opens it, admins and the workspace owner never do). Then the entry keeps
 * the thread id but not the subject, so the subject can't reach other admins through Activity, the agent page or the
 * audit export. A team mailbox thread still carries its subject (tests/audit-trail-ais1.test.ts).
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { auditLogs } from "@/server/db/schema";

type W = Awaited<ReturnType<typeof privacyWorld>>;

async function v1(w: W, key: string, method: string, path: string) {
  const res = await w.ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost" } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

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
    const meta = JSON.parse(row.metadata ?? "{}") as Record<string, unknown>;
    expect(meta.subject).toBeUndefined();
    expect((meta.caller as { kind?: string } | undefined)?.kind).toBe("agent_key");
  }, 120_000);
});
