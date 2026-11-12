/**
 * PRIV1b share-levels batch (P43, P16, P21, overview level): mail rules run at the level their actions need and the
 * owner sees every rule on her mailbox; mail merge runs keep to the people who can open the sending mailbox; Add to
 * Documents from a personal mailbox is its owner's alone; /api/mail/overview says the viewer's level per mailbox.
 */
import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { mailRules, mailThreadLabels, tasks } from "@/server/db/schema";
import { runMailRules } from "@/server/services/mail/rules-r85";

describe("PRIV1b P43: mail rules on a personal mailbox", () => {
  it("an old rule runs only at the level its actions need, never makes a task, and the owner sees and deletes it", async () => {
    const w = await privacyWorld();
    const proj = (await w.admin.c.post("/api/projects", { name: "Ops" })).body.project.id as string;
    // Before 0164 Ada made two rules on the mailbox while it was a team mailbox.
    await w.ctx.db.insert(mailRules).values([
      { id: `mrl_task${w.n}aaaaaaaa`, orgId: w.orgId, userId: w.admin.id, mailboxId: w.boxes.personal, name: "To ops", conditions: JSON.stringify([{ field: "subject", value: "SUBJECT" }]), actions: JSON.stringify([{ kind: "create_task", projectId: proj }]) },
      { id: `mrl_labl${w.n}aaaaaaaa`, orgId: w.orgId, userId: w.admin.id, mailboxId: w.boxes.personal, name: "Tag it", conditions: JSON.stringify([{ field: "subject", value: "SUBJECT" }]), actions: JSON.stringify([{ kind: "label", label: "ada-tag" }]), position: 1 },
    ]);
    // Pat gives Ada a read share: neither rule may copy or change her mail.
    expect((await w.pat.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.admin.id}`, { level: "read" })).status).toBe(200);
    await runMailRules(w.ctx.deps, { orgId: w.orgId, mailboxId: w.boxes.personal, messageId: w.msgs.personal });
    expect(await w.ctx.db.select().from(tasks).where(eq(tasks.projectId, proj))).toHaveLength(0);
    expect(await w.ctx.db.select().from(mailThreadLabels).where(eq(mailThreadLabels.label, "ada-tag"))).toHaveLength(0);
    // At Read and reply the label rule runs; the task rule still never copies a personal mailbox into a project.
    expect((await w.pat.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.admin.id}`, { level: "reply" })).status).toBe(200);
    await runMailRules(w.ctx.deps, { orgId: w.orgId, mailboxId: w.boxes.personal, messageId: w.msgs.personal });
    expect(await w.ctx.db.select().from(tasks).where(eq(tasks.projectId, proj))).toHaveLength(0);
    expect(await w.ctx.db.select().from(mailThreadLabels).where(eq(mailThreadLabels.label, "ada-tag"))).toHaveLength(1);

    // Pat sees both rules with their maker, and deletes one; Ada still sees only her own, Nia none.
    const list = await w.pat.c.get("/api/mail/rules");
    expect(list.status).toBe(200);
    const theirs = (list.body.rules as { id: string; createdBy?: { name: string } }[]).filter((r) => r.createdBy);
    expect(theirs.map((r) => r.id).sort()).toEqual([`mrl_labl${w.n}aaaaaaaa`, `mrl_task${w.n}aaaaaaaa`]);
    expect(theirs[0].createdBy!.name).toBe("Ada Admin");
    expect((await w.pat.c.get(`/api/mail/rules/mrl_task${w.n}aaaaaaaa`)).status).toBe(200);
    expect((await w.pat.c.patch(`/api/mail/rules/mrl_task${w.n}aaaaaaaa`, { name: "mine now" })).status).toBe(403); // PRIV1b (integration M2): she may toggle it, not rewrite it
    expect((await w.pat.c.del(`/api/mail/rules/mrl_task${w.n}aaaaaaaa`)).status).toBe(200);
    expect((await w.admin.c.get("/api/mail/rules")).body.rules.map((r: { id: string }) => r.id)).toEqual([`mrl_labl${w.n}aaaaaaaa`]);
    expect((await w.nobody.c.get("/api/mail/rules")).body.rules).toEqual([]);
    expect((await w.dSend.c.del(`/api/mail/rules/mrl_labl${w.n}aaaaaaaa`)).status).toBe(404);
  }, 120_000);

  it("a new rule's actions need their level: a read share may notify, not label or forward", async () => {
    const w = await privacyWorld();
    const rule = (actions: unknown[]) => ({ name: "r", mailboxId: w.boxes.personal, match: "all", conditions: [{ field: "subject", value: "SUBJECT" }], actions });
    const label = await w.dRead.c.post("/api/mail/rules", rule([{ kind: "label", label: "rae" }]));
    expect(label.status).toBe(403);
    expect(label.body.error.code).toBe("share_level");
    const fwd = await w.dReply.c.post("/api/mail/rules", rule([{ kind: "forward", to: "me@outside.example" }]));
    expect(fwd.status).toBe(403);
    expect(fwd.body.error.code).toBe("share_level");
    expect((await w.dRead.c.post("/api/mail/rules", rule([{ kind: "notify" }]))).status).toBe(201);
    // An old label rule of a read share's holder writes nothing on "Run on recent mail".
    await w.ctx.db.insert(mailRules).values({ id: `mrl_rae${w.n}aaaaaaaaa`, orgId: w.orgId, userId: w.dRead.id, mailboxId: w.boxes.personal, name: "old", conditions: JSON.stringify([{ field: "subject", value: "SUBJECT" }]), actions: JSON.stringify([{ kind: "label", label: "rae-old" }]) });
    expect((await w.dRead.c.post(`/api/mail/rules/mrl_rae${w.n}aaaaaaaaa/run-recent`)).status).toBe(200);
    expect(await w.ctx.db.select().from(mailThreadLabels).where(eq(mailThreadLabels.label, "rae-old"))).toHaveLength(0);
    // Read and reply labels; Send as forwards; the owner does both.
    const ok = await w.dReply.c.post("/api/mail/rules", rule([{ kind: "label", label: "rex" }]));
    expect(ok.status).toBe(201);
    expect((await w.dReply.c.post(`/api/mail/rules/${ok.body.rule.id}/run-recent`)).body.ran).toBe(1);
    expect(await w.ctx.db.select().from(mailThreadLabels).where(and(eq(mailThreadLabels.label, "rex"), eq(mailThreadLabels.mailboxId, w.boxes.personal)))).toHaveLength(1);
    expect((await w.dSend.c.post("/api/mail/rules", rule([{ kind: "forward", to: "me@outside.example" }]))).status).toBe(201);
    expect((await w.pat.c.post("/api/mail/rules", rule([{ kind: "label", label: "pat" }, { kind: "forward", to: "pat@outside.example" }]))).status).toBe(201);
    // Team mailbox rules are unchanged.
    expect((await w.member.c.post("/api/mail/rules", { ...rule([{ kind: "label", label: "max" }]), mailboxId: w.boxes.team })).status).toBe(201);
  }, 120_000);
});

describe("PRIV1b P16: mail merge runs", () => {
  it("are listed, read and cancelled only by people who can open the sending mailbox; starting one needs Send as", async () => {
    const w = await privacyWorld();
    const cfg = w.ctx.deps.config as unknown as { tools: Record<string, unknown> };
    cfg.tools = { enabled: true, engine: { url: "https://engine.test", keyId: "stg-1", key: "k".repeat(40) }, tokenKey: "t".repeat(40), features: ["merge_mail"] };
    const now = Date.now();
    const subject = `MERGE-SECRET-${w.n}`;
    await w.ctx.db.run(sql`insert into merge_runs (id, org_id, user_id, mailbox_id, template_id, subject, body, marketing, consent_at, total, status, engine_job, created_at, updated_at)
      values ('mrg_done1', ${w.orgId}, ${w.pat.id}, ${w.boxes.personal}, 'tpl_x', ${subject}, 'b', 0, ${now}, 2, 'done', 'job1', ${now}, ${now})`);
    await w.ctx.db.run(sql`insert into merge_recipients (run_id, idx, org_id, email, name, data, status, error) values
      ('mrg_done1', 0, ${w.orgId}, 'lawyer@private.example', 'Lawyer', '{}', 'failed', 'bounced'), ('mrg_done1', 1, ${w.orgId}, 'doctor@private.example', 'Doctor', '{}', 'sent', null)`);
    await w.ctx.db.run(sql`insert into merge_runs (id, org_id, user_id, mailbox_id, template_id, subject, body, marketing, consent_at, total, status, engine_job, created_at, updated_at)
      values ('mrg_live1', ${w.orgId}, ${w.pat.id}, ${w.boxes.personal}, 'tpl_x', 'live run', 'b', 0, ${now}, 1, 'sending', 'job2', ${now}, ${now})`);
    await w.ctx.db.run(sql`insert into merge_recipients (run_id, idx, org_id, email, name, data, status) values ('mrg_live1', 0, ${w.orgId}, 'x@private.example', 'X', '{}', 'queued')`);
    await w.ctx.db.run(sql`insert into merge_runs (id, org_id, user_id, mailbox_id, template_id, subject, body, marketing, consent_at, total, status, engine_job, created_at, updated_at)
      values ('mrg_team1', ${w.orgId}, ${w.member.id}, ${w.boxes.team}, 'tpl_x', 'TEAM-MERGE', 'b', 0, ${now}, 1, 'done', 'job3', ${now}, ${now})`);

    for (const c of [w.nobody.c, w.admin.c]) {
      const list = await c.get("/api/tools/merge");
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body.runs)).not.toContain(subject);
      const one = await c.get("/api/tools/merge/mrg_done1");
      expect(one.status).toBe(404);
      expect(JSON.stringify(one.body)).not.toContain("lawyer@private.example");
    }
    expect((await w.nobody.c.post("/api/tools/merge/mrg_live1/cancel", {})).status).toBe(404);
    expect((await w.ctx.db.all<{ status: string }>(sql`select status from merge_recipients where run_id = 'mrg_live1'`))[0].status).toBe("queued");
    // An admin still sees team mailbox runs; Pat and her delegates see hers.
    expect(JSON.stringify((await w.admin.c.get("/api/tools/merge")).body.runs)).toContain("TEAM-MERGE");
    expect(JSON.stringify((await w.pat.c.get("/api/tools/merge")).body.runs)).toContain(subject);
    expect((await w.dRead.c.get("/api/tools/merge/mrg_done1")).status).toBe(200);
    const cancel = await w.pat.c.post("/api/tools/merge/mrg_live1/cancel", {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("cancelled");

    // Starting a merge from Pat's mailbox needs Send as.
    const start = { templateId: "tpl_x", mailboxId: w.boxes.personal, subject: "Hi", body: "b", people: [{ email: "a@outside.example", name: "A", data: {} }], consent: true, marketing: false };
    const r = await w.dReply.c.post("/api/tools/merge", start);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("share_level");
  }, 120_000);
});

describe("PRIV1b P21: Add to Documents from a personal mailbox", () => {
  it("is the owner's: Pat adds, a share or an admin with a read share can't; team mailboxes unchanged", async () => {
    const w = await privacyWorld();
    w.ctx.deps.config.filesPlus = true;
    w.ctx.deps.config.docInbox = true;
    const patList = await w.pat.c.get("/api/doc-inbox/mailboxes");
    expect(patList.status).toBe(200);
    expect(patList.body.ids).toContain(w.boxes.personal);
    expect((await w.pat.c.post("/api/doc-inbox/from-mail", { attachmentId: w.attId })).status).toBe(200);
    expect((await w.pat.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.admin.id}`, { level: "read" })).status).toBe(200);
    for (const c of [w.admin.c, w.dRead.c, w.dSend.c]) {
      expect((await c.post("/api/doc-inbox/from-mail", { attachmentId: w.attId })).status).toBe(403);
      expect((await c.get("/api/doc-inbox/mailboxes")).body.ids).not.toContain(w.boxes.personal);
    }
    // Team mailbox: the admin keeps it (no member's address matches it).
    expect((await w.admin.c.get("/api/doc-inbox/mailboxes")).body.ids).toContain(w.boxes.team);
  }, 120_000);
});

describe("PRIV1b: the overview says the viewer's level per mailbox", () => {
  it("own, share levels and team", async () => {
    const w = await privacyWorld();
    const level = async (c: typeof w.pat.c, id: string) => ((await c.get("/api/mail/overview")).body.mailboxes as { id: string; level: string }[]).find((m) => m.id === id)?.level;
    expect(await level(w.pat.c, w.boxes.personal)).toBe("own");
    expect(await level(w.dRead.c, w.boxes.personal)).toBe("read");
    expect(await level(w.dReply.c, w.boxes.personal)).toBe("reply");
    expect(await level(w.dSend.c, w.boxes.personal)).toBe("send_as");
    expect(await level(w.admin.c, w.boxes.personal)).toBeUndefined();
    expect(await level(w.admin.c, w.boxes.team)).toBe("team");
    expect(await level(w.member.c, w.boxes.team)).toBe("team");
  }, 120_000);
});
