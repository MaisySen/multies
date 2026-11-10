import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { automations, changes, tasks, webhookDeliveries } from "@/server/db/schema";
import { deliverInbound } from "@/server/services/mail/delivery";
import { createEndpoint, emitEvent } from "@/server/services/developer/webhooks";

/**
 * PRIV1b, batch fanout: P1 (workspace webhooks and integrations got a personal mailbox's mail) and P2 (workspace
 * automations and the tasks step ran on personal mail). Each case checks the personal mailbox leaks nothing and the
 * team mailbox behaves as before.
 */
const SECRET = "PERSONAL-BODY-SECRET-123456";
const mail = (to: string, from: string, subject: string, text: string, id = `<${Math.random().toString(36).slice(2)}@x.example.com>`, inReplyTo?: string) => ({
  envelopeFrom: from, rcptTo: to, sizeBytes: 300, via: "test",
  email: { messageId: id, inReplyTo, references: inReplyTo, from: { address: from, name: "Dr Who" }, to: [{ address: to }], cc: [], subject, text, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
}) as never;

type World = Awaited<ReturnType<typeof privacyWorld>>;
const hooks = async (w: World, type: string) => (await w.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, w.orgId))).filter((d) => d.eventType === type);

describe("P1: webhooks and integrations get no personal mail", () => {
  it("message.received: no delivery row for a personal mailbox, the team mailbox still emits", async () => {
    const w = await privacyWorld();
    await createEndpoint(w.ctx.deps, w.orgId, { url: "https://example.com/hook", events: ["message.received", "message.sent", "approval.requested"] });
    const r = await deliverInbound(w.ctx.deps, mail(`pat.private${w.n}@acme.io`, "doctor@clinic.example.com", "Test results", `${SECRET} your code is 948213`));
    expect(r.storedIn).toEqual([w.boxes.personal]);
    expect(await hooks(w, "message.received")).toHaveLength(0);
    expect(JSON.stringify(await w.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, w.orgId)))).not.toContain(SECRET);

    await deliverInbound(w.ctx.deps, mail("team@acme.io", "client@example.com", "Invoice question", "team stuff"));
    const team = await hooks(w, "message.received");
    expect(team).toHaveLength(1);
    expect(team[0]!.payload).toContain("team stuff");
    expect(team[0]!.payload).toContain(w.boxes.team);
  });

  it("message.sent: a send from a personal mailbox emits nothing, a team send still does", async () => {
    const w = await privacyWorld();
    await createEndpoint(w.ctx.deps, w.orgId, { url: "https://example.com/hook", events: ["*"] });
    const p = await w.pat.c.post("/api/mail/send", { mailboxId: w.boxes.personal, to: ["friend@example.com"], subject: "Private plans", text: "hi" });
    expect(p.status).toBe(201);
    expect(await hooks(w, "message.sent")).toHaveLength(0);
    const t = await w.member.c.post("/api/mail/send", { mailboxId: w.boxes.team, to: ["client@example.com"], subject: "Team update", text: "hi" });
    expect(t.status).toBe(201);
    const sent = await hooks(w, "message.sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toContain("Team update");
  });

  it("approval.requested: an approval from a personal address emits nothing, from a team address it still does; other events pass", async () => {
    const w = await privacyWorld();
    await createEndpoint(w.ctx.deps, w.orgId, { url: "https://example.com/hook", events: ["*"] });
    await emitEvent(w.ctx.deps, w.orgId, "approval.requested", { approvalId: "apr_1", from: `pat.private${w.n}@acme.io`, to: ["x@example.com"], subject: "Private" });
    expect(await hooks(w, "approval.requested")).toHaveLength(0);
    await emitEvent(w.ctx.deps, w.orgId, "approval.requested", { approvalId: "apr_2", from: "team@acme.io", to: ["x@example.com"], subject: "Team" });
    expect(await hooks(w, "approval.requested")).toHaveLength(1);
    // Events that carry no mail are not touched even when they name the mailbox.
    await emitEvent(w.ctx.deps, w.orgId, "task.created", { id: "tsk_1", mailboxId: w.boxes.personal });
    expect(await hooks(w, "task.created")).toHaveLength(1);
  });

  it("message.bounced and message.complained: a personal sender gives no row, a team sender still does", async () => {
    const w = await privacyWorld();
    await createEndpoint(w.ctx.deps, w.orgId, { url: "https://example.com/hook", events: ["*"] });
    for (const type of ["message.bounced", "message.complained"] as const) {
      await emitEvent(w.ctx.deps, w.orgId, type, { id: "msg_p", to: "doctor@clinic.example.com", from: `pat.private${w.n}@acme.io`, subject: "Private biopsy", detail: null, bounceType: null });
      expect(await hooks(w, type)).toHaveLength(0);
      await emitEvent(w.ctx.deps, w.orgId, type, { id: "msg_t", to: "client@example.com", from: "team@acme.io", subject: "Team invoice", detail: null, bounceType: null });
      const rows = await hooks(w, type);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toContain("Team invoice");
    }
    expect(JSON.stringify(await w.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, w.orgId)))).not.toContain("Private biopsy");
  });
});

describe("P2: workspace automations and the tasks step leave personal mail alone", () => {
  it("create_task and notify rules do not run on a personal mailbox, and still run on the team mailbox", async () => {
    const w = await privacyWorld();
    const proj = await w.admin.c.post("/api/projects", { name: "Inbox work" });
    const projectId = (proj.body.project?.id ?? proj.body.id) as string;
    expect((await w.admin.c.post("/api/automations", { name: "Mail to task", trigger: "email_received", conditions: { from: "example" }, action: "create_task", actionConfig: { projectId } })).status).toBe(201);
    expect((await w.admin.c.post("/api/automations", { name: "Tell admins", trigger: "email_received", conditions: { subjectContains: "salary" }, action: "notify", actionConfig: { to: "admins" } })).status).toBe(201);

    await deliverInbound(w.ctx.deps, mail(`pat.private${w.n}@acme.io`, "doctor@clinic.example.com", "Your salary garnishment", SECRET));
    const rows = await w.ctx.db.select().from(tasks).where(and(eq(tasks.orgId, w.orgId), eq(tasks.projectId, projectId)));
    expect(rows.filter((t) => (t.notes ?? "").includes(SECRET) || /salary/i.test(t.title))).toHaveLength(0);
    expect(JSON.stringify((await w.admin.c.get("/api/notifications")).body)).not.toContain("salary garnishment");

    await deliverInbound(w.ctx.deps, mail("team@acme.io", "client@example.com", "Team salary review", "team body"));
    const after = await w.ctx.db.select().from(tasks).where(and(eq(tasks.orgId, w.orgId), eq(tasks.projectId, projectId)));
    expect(after.some((t) => /Team salary review/.test(t.title) && (t.notes ?? "").includes("team body"))).toBe(true);
    expect(JSON.stringify((await w.admin.c.get("/api/notifications")).body)).toContain("Team salary review");
  });

  it("post_to_channel rule posts team mail only", async () => {
    const w = await privacyWorld();
    const ch = (await w.admin.c.post("/api/chat/channels", { name: "mailfeed" })).body.channel;
    expect((await w.admin.c.post("/api/automations", { name: "Mail feed", trigger: "email_received", conditions: { from: "clinic" }, action: "post_to_channel", actionConfig: { channelId: ch.id, message: "{email.from}: {email.subject}" } })).status).toBe(201);
    await deliverInbound(w.ctx.deps, mail(`pat.private${w.n}@acme.io`, "doctor@clinic.example.com", "HIV test result for Pat", "private"));
    await deliverInbound(w.ctx.deps, mail("team@acme.io", "desk@clinic.example.com", "Clinic invoice", "team"));
    const body = JSON.stringify((await w.nobody.c.get(`/api/chat/channels/${ch.id}/messages`)).body);
    expect(body).not.toContain("HIV test result");
    expect(body).toContain("Clinic invoice");
  });

  it("a rule cannot name a personal mailbox; a team mailbox is fine", async () => {
    const w = await privacyWorld();
    const bad = await w.admin.c.post("/api/automations", { name: "Watch Pat", trigger: "email_received", conditions: { mailboxId: w.boxes.personal }, action: "notify", actionConfig: { to: "admins" } });
    expect(bad.status).toBe(422);
    const ok = await w.admin.c.post("/api/automations", { name: "Watch team", trigger: "email_received", conditions: { mailboxId: w.boxes.team }, action: "notify", actionConfig: { to: "admins" } });
    expect(ok.status).toBe(201);
    const up = await w.admin.c.patch(`/api/automations/${ok.body.automation?.id ?? ok.body.id}`, { conditions: { mailboxId: w.boxes.personal } });
    expect(up.status).toBe(422);
  });

  it("a rule stored before the guard that names a personal mailbox can still be disabled and renamed", async () => {
    const w = await privacyWorld();
    const ok = await w.admin.c.post("/api/automations", { name: "Old rule", trigger: "email_received", conditions: { mailboxId: w.boxes.team }, action: "notify", actionConfig: { to: "admins" } });
    expect(ok.status).toBe(201);
    const id = (ok.body.automation?.id ?? ok.body.id) as string;
    await w.ctx.db.update(automations).set({ conditions: JSON.stringify({ mailboxId: w.boxes.personal }) }).where(eq(automations.id, id));
    const off = await w.admin.c.patch(`/api/automations/${id}`, { enabled: false });
    expect(off.status).toBe(200);
    expect((off.body.automation ?? off.body).enabled).toBe(false);
    expect((await w.admin.c.patch(`/api/automations/${id}`, { name: "Old rule, off" })).status).toBe(200);
    // Saving the personal condition again is still refused.
    expect((await w.admin.c.patch(`/api/automations/${id}`, { conditions: { mailboxId: w.boxes.personal } })).status).toBe(422);
  });

  it("createTaskFromThread refuses a personal source for a system actor, people keep it", async () => {
    const w = await privacyWorld();
    const { createTaskFromThread } = await import("@/server/services/suite/tasks");
    const sys = { orgId: w.orgId, userId: "", email: "", name: "Rule", system: true } as never;
    await expect(createTaskFromThread(w.ctx.deps, sys, { messageId: w.msgs.personal })).rejects.toMatchObject({ status: 404 });
    const team = await createTaskFromThread(w.ctx.deps, sys, { messageId: w.msgs.team });
    expect(team.id).toBeTruthy();
    const own = await w.pat.c.post("/api/tasks/from-email", { messageId: w.msgs.personal, title: "My own follow up" });
    expect(own.status).toBe(201);
  });

  it("tasks step: a personal reply names no sender or subject and notifies only people who can open the mailbox", async () => {
    const w = await privacyWorld();
    const patAddr = `pat.private${w.n}@acme.io`;
    await deliverInbound(w.ctx.deps, mail(patAddr, "landlord@rent.example", "Lease renewal", "renew?", "<orig1@rent.example>"));
    const pm = (await w.pat.c.get(`/api/mail/messages?mailboxId=${w.boxes.personal}&folder=inbox`)).body.messages.find((m: { subject: string }) => m.subject === "Lease renewal");
    const projectId = ((await w.owner.post("/api/projects", { name: "Office" })).body.project?.id) as string;
    const t = await w.pat.c.post("/api/tasks/from-email", { messageId: pm.id, projectId, title: "Sort the office lease", assignee: `member:${w.member.id}` });
    expect(t.status).toBe(201);
    await deliverInbound(w.ctx.deps, mail(patAddr, "eviction-lawyer@law.example", "Re: Lease renewal - notice of eviction", "pay", "<r2@law.example>", "<orig1@rent.example>"));
    const acts = await w.ctx.db.select().from(changes).where(and(eq(changes.orgId, w.orgId), eq(changes.entityId, t.body.task.id)));
    const reply = acts.find((a) => a.verb === "email_received");
    expect(reply).toBeTruthy();
    expect(JSON.stringify(acts)).not.toContain("eviction");
    expect(JSON.stringify((await w.member.c.get(`/api/tasks/${t.body.task.id}`)).body)).not.toContain("eviction");
    expect(JSON.stringify((await w.member.c.get("/api/notifications")).body)).not.toContain("New reply on Sort the office lease");
    // A delegate who can open the mailbox, assigned to a task on the same thread, still hears of the reply.
    const t2 = await w.pat.c.post("/api/tasks/from-email", { messageId: pm.id, projectId, title: "Read the lease", assignee: `member:${w.dRead.id}` });
    expect(t2.status).toBe(201);
    await deliverInbound(w.ctx.deps, mail(patAddr, "landlord@rent.example", "Re: Lease renewal - follow up", "again", "<r3@rent.example>", "<orig1@rent.example>"));
    expect(JSON.stringify((await w.dRead.c.get("/api/notifications")).body)).toContain("New reply on Read the lease");
    expect(JSON.stringify((await w.member.c.get("/api/notifications")).body)).not.toContain("New reply on Read the lease");

    // Team mailbox: the activity keeps sender and subject and the assignee hears of it.
    await deliverInbound(w.ctx.deps, mail("team@acme.io", "client@example.com", "Order 7", "first", "<t1@example.com>"));
    const tm = (await w.member.c.get(`/api/mail/messages?mailboxId=${w.boxes.team}&folder=inbox`)).body.messages.find((m: { subject: string }) => m.subject === "Order 7");
    const tt = await w.member.c.post("/api/tasks/from-email", { messageId: tm.id, projectId, title: "Ship order 7", assignee: `member:${w.member.id}` });
    expect(tt.status).toBe(201);
    await deliverInbound(w.ctx.deps, mail("team@acme.io", "client@example.com", "Re: Order 7 shipping date", "when?", "<t2@example.com>", "<t1@example.com>"));
    const tacts = await w.ctx.db.select().from(changes).where(and(eq(changes.orgId, w.orgId), eq(changes.entityId, tt.body.task.id)));
    expect(JSON.stringify(tacts.filter((a) => a.verb === "email_received"))).toContain("Re: Order 7 shipping date");
    expect(JSON.stringify((await w.member.c.get("/api/notifications")).body)).toContain("New reply on Ship order 7");
  });
});
