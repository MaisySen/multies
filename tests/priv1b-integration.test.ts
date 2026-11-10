import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { privacyWorld, inboundMail } from "./priv1a-world";
import { domains, mailboxAccessLog, mailRules, messages } from "@/server/db/schema";
import { deliverInbound, isHosted } from "@/server/services/mail/delivery";

/**
 * PRIV1b integration review fixes: M1 (a proved domain keeps receiving after a failed re-check), M2 (the mailbox owner
 * can turn a delegate's rule off and run it), M3 (an orphan is nobody's for Add to Documents; the workspace owner can
 * read, turn off and delete an orphan's rules she is shown), S3 (drafts check the share level once). S4 needed no change:
 * an agent key already acts as its maker, so its reads of her own mailbox were never logged; the test keeps that so.
 */
type W = Awaited<ReturnType<typeof privacyWorld>>;
const ruleRow = (w: W, id: string, actions: unknown[]) => ({ id, orgId: w.orgId, userId: w.admin.id, mailboxId: w.boxes.personal, name: "Ada's", conditions: JSON.stringify([{ field: "subject", value: "SUBJECT" }]), actions: JSON.stringify(actions) });

describe("PRIV1b integration M1: a verified domain whose DNS drifts still receives", () => {
  it("verified then failed still delivers; a never verified domain still bounces", async () => {
    const w = await privacyWorld();
    const before = await deliverInbound(w.ctx.deps, inboundMail("team@acme.io", "client@example.com", "Before drift", "hi"));
    expect(before.code).toBe(250);
    const d = await w.ctx.db.select().from(domains).where(eq(domains.id, w.domainId)).get();
    expect(d!.verifiedAt).toBeTruthy();
    // The daily re-check found an SPF mismatch: status failed, verifiedAt kept.
    await w.ctx.db.update(domains).set({ status: "failed" }).where(eq(domains.id, w.domainId));
    const after = await deliverInbound(w.ctx.deps, inboundMail("team@acme.io", "client@example.com", "After drift", "hi"));
    expect(after.code).toBe(250);
    expect(after.accepted).toBe(true);
    expect(await isHosted(w.ctx.db, "team@acme.io")).toBe(true);
    const got = await w.ctx.db.select({ s: messages.subject }).from(messages).where(eq(messages.mailboxId, w.boxes.team));
    expect(got.map((m) => m.s)).toContain("After drift");

    // Attacker: a squat never proved in DNS (pending, then failed) catches nothing.
    const sq = await w.outsider.post("/api/domains", { name: `squat${w.n}.io` });
    expect(sq.status).toBe(201);
    const box = (await w.outsider.post("/api/mailboxes", { domainId: sq.body.domain.id, localPart: "bob", displayName: "Bob" })).body.mailbox.id as string;
    for (const status of ["pending", "failed"] as const) {
      await w.ctx.db.update(domains).set({ status, verifiedAt: null }).where(eq(domains.id, sq.body.domain.id));
      const r = await deliverInbound(w.ctx.deps, inboundMail(`bob@squat${w.n}.io`, "bank@example.com", `Reset ${status}`, "code 1234"));
      expect(r.code, status).toBe(550);
      expect(r.reason).toMatch(/No mailbox/);
    }
    expect(await w.ctx.db.select().from(messages).where(eq(messages.mailboxId, box))).toEqual([]);
  }, 120_000);
});

describe("PRIV1b integration M2: the owner can turn off and run a rule a delegate made on her mailbox", () => {
  it("Pat toggles and runs Ada's rule but can't rewrite it; Ada still edits it; others get 404", async () => {
    const w = await privacyWorld();
    const id = `mrl_m2${w.n}aaaaaaaaaa`;
    await w.ctx.db.insert(mailRules).values(ruleRow(w, id, [{ kind: "notify" }]));
    expect((await w.pat.c.get(`/api/mail/rules/${id}`)).status).toBe(200);
    const off = await w.pat.c.patch(`/api/mail/rules/${id}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.rule.enabled).toBe(false);
    const on = await w.pat.c.patch(`/api/mail/rules/${id}`, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.rule.enabled).toBe(true);
    const run = await w.pat.c.post(`/api/mail/rules/${id}/run-recent`);
    expect(run.status).toBe(200);
    expect(run.body.matched).toBeGreaterThanOrEqual(1);
    // Rewriting someone else's rule stays with its maker.
    const rename = await w.pat.c.patch(`/api/mail/rules/${id}`, { name: "Pat's now", enabled: false });
    expect(rename.status).toBe(403);
    expect((await w.ctx.db.select().from(mailRules).where(eq(mailRules.id, id)).get())!.name).toBe("Ada's");
    expect((await w.admin.c.patch(`/api/mail/rules/${id}`, { name: "Ada renamed" })).status).toBe(200);
    // Not the owner, not the maker: nothing.
    for (const c of [w.dSend.c, w.nobody.c, w.owner]) {
      expect((await c.patch(`/api/mail/rules/${id}`, { enabled: false })).status).toBe(404);
      expect((await c.post(`/api/mail/rules/${id}/run-recent`)).status).toBe(404);
    }
    expect((await w.ctx.db.select().from(mailRules).where(eq(mailRules.id, id)).get())!.enabled).toBe(true);
  }, 120_000);
});

describe("PRIV1b integration M3: orphan ownership agrees between lists and actions", () => {
  it("after Pat leaves, the workspace owner reads, turns off and deletes the orphan's rule she is shown; Add to Documents lists no orphan", async () => {
    const w = await privacyWorld({ flags: true });
    const id = `mrl_m3${w.n}aaaaaaaaaa`;
    await w.ctx.db.insert(mailRules).values(ruleRow(w, id, [{ kind: "label", label: "orph" }]));
    expect((await w.owner.del(`/api/team/members/${w.pat.id}`)).status).toBe(200);

    const list = await w.owner.get("/api/mail/rules");
    expect(list.status).toBe(200);
    expect((list.body.rules as { id: string }[]).map((r) => r.id)).toContain(id);
    expect((await w.owner.get(`/api/mail/rules/${id}`)).status).toBe(200);
    expect((await w.owner.get(`/api/mail/rules/${id}/runs`)).status).toBe(200);
    // Tidy only: off yes; on, rename or run no.
    expect((await w.owner.patch(`/api/mail/rules/${id}`, { enabled: true })).status).toBe(403);
    expect((await w.owner.patch(`/api/mail/rules/${id}`, { name: "x" })).status).toBe(403);
    expect((await w.owner.post(`/api/mail/rules/${id}/run-recent`)).status).toBe(404);
    const off = await w.owner.patch(`/api/mail/rules/${id}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.rule.enabled).toBe(false);
    // An admin who isn't the maker gets nothing.
    const other = `mrl_m3b${w.n}aaaaaaaaa`;
    await w.ctx.db.insert(mailRules).values({ ...ruleRow(w, other, [{ kind: "notify" }]), userId: w.member.id });
    expect((await w.admin.c.get(`/api/mail/rules/${other}`)).status).toBe(404);
    expect((await w.admin.c.del(`/api/mail/rules/${other}`)).status).toBe(404);
    expect((await w.owner.del(`/api/mail/rules/${id}`)).status).toBe(200);
    expect(await w.ctx.db.select().from(mailRules).where(eq(mailRules.id, id))).toEqual([]);

    // Add to Documents: the orphan isn't listed to the owner, matching from-mail's 403. Team mail still is.
    const boxes = await w.owner.get("/api/doc-inbox/mailboxes");
    expect(boxes.status).toBe(200);
    expect(boxes.body.ids).not.toContain(w.boxes.personal);
    expect(boxes.body.ids).toContain(w.boxes.team);
    expect((await w.owner.post("/api/doc-inbox/from-mail", { attachmentId: w.attId })).status).toBe(403);
  }, 120_000);
});

describe("PRIV1b integration S3: drafts check the share level once", () => {
  it("a read share can't draft, Send as can, team mail keeps its grants", async () => {
    const w = await privacyWorld();
    const draft = (mailboxId: string) => ({ mailboxId, to: ["x@example.org"], subject: "Draft", text: "hi" });
    const r = await w.dRead.c.post("/api/mail/drafts", draft(w.boxes.personal));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("share_level");
    expect((await w.dReply.c.post("/api/mail/drafts", draft(w.boxes.personal))).status).toBe(403);
    expect((await w.nobody.c.post("/api/mail/drafts", draft(w.boxes.personal))).status).toBe(404);
    expect((await w.owner.post("/api/mail/drafts", draft(w.boxes.personal))).status).toBe(404);
    expect((await w.dSend.c.post("/api/mail/drafts", draft(w.boxes.personal))).status).toBe(201);
    expect((await w.pat.c.post("/api/mail/drafts", draft(w.boxes.personal))).status).toBe(201);
    expect((await w.nobody.c.post("/api/mail/drafts", draft(w.boxes.team))).status).toBe(404);
    expect((await w.member.c.post("/api/mail/drafts", draft(w.boxes.team))).status).toBe(201);
    expect((await w.owner.post("/api/mail/drafts", draft(w.boxes.team))).status).toBe(201);
  }, 120_000);
});

describe("PRIV1b integration S4 (guard): an agent key reading its maker's mailbox is not someone else's open", () => {
  it("Pat's own agent reads her thread with no log row; a delegate's read is still logged", async () => {
    const w = await privacyWorld();
    expect((await w.owner.patch(`/api/team/members/${w.pat.id}`, { role: "admin" })).status).toBe(200);
    const ag = await w.pat.c.post("/api/agents", { name: "Pat helper", localPart: `pathelper${w.n}`, approvalMode: "always", mailboxIds: [w.boxes.personal] });
    expect(ag.status).toBe(201);
    const secret = ag.body.apiKey.secret as string;
    const opens = async () => w.ctx.db.select().from(mailboxAccessLog).where(and(eq(mailboxAccessLog.mailboxId, w.boxes.personal), eq(mailboxAccessLog.action, "opened_thread")));
    await w.ctx.db.delete(mailboxAccessLog).where(eq(mailboxAccessLog.mailboxId, w.boxes.personal));
    const res = await w.ctx.app.request(`/api/v1/threads/${w.thread}`, { headers: { authorization: `Bearer ${secret}`, host: "localhost" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`SUBJECT-PERS-${w.n}`);
    expect(await opens()).toEqual([]);
    // A person with a share reading the same thread is still logged, with the person attached.
    expect((await w.dRead.c.get(`/api/agents/threads/${w.thread}`)).status).toBe(200);
    const rows = await opens();
    expect(rows.map((r) => r.actorUserId)).toEqual([w.dRead.id]);
  }, 120_000);
});
