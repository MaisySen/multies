/**
 * PRIV1b share-levels-2 (SL1..SL6): review notes on the share-levels batch. A reply share can't steer a thread's
 * answers with Reply-To (SL1), a read share can't cancel a merge (SL2) or clear the owner's returned snoozes (SL3),
 * a long thread's older people still count as in the thread (SL4), Add to Documents decides personal mailboxes from
 * the mailbox row itself (SL5), and inbound mail rules read the mailbox and each maker's level once (SL6).
 */
import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { mailboxes, mailRules, mailSchedules, mailThreadLabels, messages } from "@/server/db/schema";
import { runMailRules } from "@/server/services/mail/rules-r85";

const later = () => new Date(Date.now() + 3 * 3_600_000).toISOString();
const sender = "secret.sender.pers@private.example";

describe("PRIV1b SL1: Reply-To below Send as", () => {
  it("a reply share may only set Reply-To to the mailbox's own address or someone in the thread", async () => {
    const w = await privacyWorld();
    const own = (await w.ctx.db.select({ a: mailboxes.address }).from(mailboxes).where(eq(mailboxes.id, w.boxes.personal)).get())!.a;
    const base = { mailboxId: w.boxes.personal, to: [sender], subject: "Re: hi", text: "answer", inReplyToId: w.msgs.personal };
    for (const [path, body] of [["/api/mail/send", { ...base, replyTo: "boss@evil.example" }], ["/api/mail/drafts", { ...base, replyTo: "boss@evil.example" }],
      ["/api/mail-schedules/send", { message: { ...base, replyTo: "boss@evil.example" }, at: later() }]] as const) {
      const r = await w.dReply.c.post(path, body);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("share_level");
    }
    expect((await w.ctx.db.select().from(messages).where(and(eq(messages.mailboxId, w.boxes.personal), eq(messages.folder, "sent")))).length).toBe(0);
    // The mailbox's own address and a thread participant are fine; Send as and the owner set any Reply-To.
    expect((await w.dReply.c.post("/api/mail/send", { ...base, replyTo: own.toUpperCase() })).status).toBe(201);
    expect((await w.dReply.c.post("/api/mail/send", { ...base, replyTo: sender })).status).toBe(201);
    expect((await w.dSend.c.post("/api/mail/send", { ...base, replyTo: "help@outside.example" })).status).toBe(201);
    expect((await w.pat.c.post("/api/mail/send", { ...base, replyTo: "help@outside.example" })).status).toBe(201);
    expect((await w.member.c.post("/api/mail/send", { ...base, mailboxId: w.boxes.team, inReplyToId: w.msgs.team, replyTo: "help@outside.example" })).status).toBe(201);
  }, 120_000);
});

describe("PRIV1b SL4: a long thread", () => {
  it("someone only in an older message of a long thread is still in the thread; outsiders are not", async () => {
    const w = await privacyWorld();
    const thread = (await w.ctx.db.select({ t: messages.threadId }).from(messages).where(eq(messages.id, w.msgs.personal)).get())!.t;
    const row = (i: number, extra: Partial<typeof messages.$inferInsert> = {}) => ({ id: `msg_long${w.n}_${i}`, orgId: w.orgId, mailboxId: w.boxes.personal, folder: "inbox" as const, threadId: thread,
      fromAddress: `filler${i}@private.example`, to: JSON.stringify([{ name: "", address: "x@acme.io" }]), subject: "Re", date: new Date(Date.now() - 1000 * i), ...extra });
    const rows = Array.from({ length: 260 }, (_, i) => row(i));
    rows.push(row(999, { to: "not json" }));
    // PRIV1b (SP1): valid JSON whose items are not objects (plain strings, one object, numbers) used to fail every send.
    rows.push(row(998, { to: JSON.stringify(["Str.Item@private.example", 7]), cc: JSON.stringify({ name: "Solo", address: "solo@private.example" }), bcc: "[1, null, [2]]" }));
    // Added last, so the thread index finds it after every filler row.
    rows.push(row(1000, { fromAddress: "first@private.example", cc: JSON.stringify([{ name: "Old", address: "Old.CC@private.example" }]), date: new Date(Date.now() - 86_400_000 * 30) }));
    for (const r of rows) await w.ctx.db.insert(messages).values(r);
    const base = { mailboxId: w.boxes.personal, subject: "Re", text: "t", inReplyToId: w.msgs.personal };
    expect((await w.dReply.c.post("/api/mail/send", { ...base, to: ["old.cc@private.example"] })).status).toBe(201);
    expect((await w.dReply.c.post("/api/mail/send", { ...base, to: ["first@private.example", "filler3@private.example"] })).status).toBe(201);
    expect((await w.dReply.c.post("/api/mail/send", { ...base, to: ["str.item@private.example"], cc: ["Solo@private.example"] })).status).toBe(201);
    const odd = await w.dReply.c.post("/api/mail/send", { ...base, to: ["solo@private.example", "boss@evil.example"] });
    expect(odd.status).toBe(403);
    expect(odd.body.error.code).toBe("share_level");
    const out = await w.dReply.c.post("/api/mail/send", { ...base, to: ["old.cc@private.example", "boss@evil.example"] });
    expect(out.status).toBe(403);
    expect(out.body.error.code).toBe("share_level");
  }, 120_000);
});

describe("PRIV1b SL2: cancelling a merge run", () => {
  it("needs Read and reply on the sending mailbox, or to have started the run", async () => {
    const w = await privacyWorld();
    const cfg = w.ctx.deps.config as unknown as { tools: Record<string, unknown> };
    cfg.tools = { enabled: true, engine: { url: "https://engine.test", keyId: "stg-1", key: "k".repeat(40) }, tokenKey: "t".repeat(40), features: ["merge_mail"] };
    const now = Date.now();
    const run = async (id: string, userId: string, mailboxId: string) => {
      await w.ctx.db.run(sql`insert into merge_runs (id, org_id, user_id, mailbox_id, template_id, subject, body, marketing, consent_at, total, status, engine_job, created_at, updated_at)
        values (${id}, ${w.orgId}, ${userId}, ${mailboxId}, 'tpl_x', 'run', 'b', 0, ${now}, 1, 'sending', 'job', ${now}, ${now})`);
      await w.ctx.db.run(sql`insert into merge_recipients (run_id, idx, org_id, email, name, data, status) values (${id}, 0, ${w.orgId}, 'x@private.example', 'X', '{}', 'queued')`);
    };
    const status = async (id: string) => (await w.ctx.db.all<{ status: string }>(sql`select status from merge_runs where id = ${id}`))[0].status;
    await run("mrg_pat1", w.pat.id, w.boxes.personal);
    await run("mrg_rae1", w.dRead.id, w.boxes.personal);
    await run("mrg_team1", w.member.id, w.boxes.team);

    const r = await w.dRead.c.post("/api/tools/merge/mrg_pat1/cancel", {});
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("share_level");
    expect(await status("mrg_pat1")).toBe("sending");
    expect((await w.ctx.db.all<{ status: string }>(sql`select status from merge_recipients where run_id = 'mrg_pat1'`))[0].status).toBe("queued");
    // A reply share stops Pat's run; a run's starter stops her own; an admin stops a team mailbox run.
    expect((await w.dReply.c.post("/api/tools/merge/mrg_pat1/cancel", {})).status).toBe(200);
    expect(await status("mrg_pat1")).toBe("cancelled");
    expect((await w.dRead.c.post("/api/tools/merge/mrg_rae1/cancel", {})).status).toBe(200);
    expect(await status("mrg_rae1")).toBe("cancelled");
    expect((await w.admin.c.post("/api/tools/merge/mrg_team1/cancel", {})).status).toBe(200);
    expect(await status("mrg_team1")).toBe("cancelled");
  }, 120_000);
});

describe("PRIV1b SL3: opening a returned thread", () => {
  it("a read share leaves the owner's returned snoozes and reminders; Read and reply and team mail clear them", async () => {
    const w = await privacyWorld();
    const thread = (await w.ctx.db.select({ t: messages.threadId }).from(messages).where(eq(messages.id, w.msgs.personal)).get())!.t;
    const teamThread = (await w.ctx.db.select({ t: messages.threadId }).from(messages).where(eq(messages.id, w.msgs.team)).get())!.t;
    const returned = (id: string, mailboxId: string, threadId: string, messageId: string, kind: "snooze" | "remind") =>
      ({ id, orgId: w.orgId, mailboxId, userId: w.pat.id, kind, status: "returned" as const, threadId, messageId, dueAt: new Date(Date.now() - 60_000) });
    await w.ctx.db.insert(mailSchedules).values([
      returned(`msch_sn${w.n}aaaaaaaa`, w.boxes.personal, thread, w.msgs.personal, "snooze"),
      returned(`msch_rm${w.n}aaaaaaaa`, w.boxes.personal, thread, w.msgs.personal, "remind"),
      returned(`msch_tm${w.n}aaaaaaaa`, w.boxes.team, teamThread, w.msgs.team, "snooze"),
    ]);
    const left = async (mailboxId: string) => (await w.ctx.db.select().from(mailSchedules).where(and(eq(mailSchedules.mailboxId, mailboxId), eq(mailSchedules.status, "returned")))).length;

    const rRead = await w.dRead.c.post("/api/mail-schedules/opened", { messageId: w.msgs.personal });
    expect(rRead.status).toBe(200);
    expect(rRead.body.cleared).toBe(0);
    expect(await left(w.boxes.personal)).toBe(2);
    expect((await w.nobody.c.post("/api/mail-schedules/opened", { messageId: w.msgs.personal })).status).toBe(404);
    const rReply = await w.dReply.c.post("/api/mail-schedules/opened", { messageId: w.msgs.personal });
    expect(rReply.status).toBe(200);
    expect(rReply.body.cleared).toBe(2);
    expect(await left(w.boxes.personal)).toBe(0);
    const team = await w.admin.c.post("/api/mail-schedules/opened", { messageId: w.msgs.team });
    expect(team.status).toBe(200);
    expect(team.body.cleared).toBe(1);
  }, 120_000);
});

describe("PRIV1b SL5: Add to Documents mailbox list", () => {
  it("a personal mailbox never falls into the team rule, also when the personal rows come back in another order", async () => {
    const w = await privacyWorld();
    w.ctx.deps.config.filesPlus = true;
    w.ctx.deps.config.docInbox = true;
    // PRIV1b (SP3): Sam's 30 personal mailboxes come first by row, then 520 ownerless ones. Read by the personal index
    // (owner first, empty owners sorting first) the ownerless rows filled a separate 500 row list, so Sam's fell out of
    // it and into the team rule, which hands an admin any mailbox at an address no member has.
    const box = (i: number, owner: string | null) => ({ id: `mbx_sl5${w.n}_${String(i).padStart(3, "0")}`, orgId: w.orgId, domainId: w.domainId, localPart: `sam.box${i}.${w.n}`,
      address: `sam.box${i}.${w.n}@acme.io`, displayName: "Sam box", quotaMb: 100, personal: true, ownerUserId: owner });
    const extra = [...Array.from({ length: 30 }, (_, i) => box(i, w.dSend.id)), ...Array.from({ length: 520 }, (_, i) => box(100 + i, null))];
    for (let i = 0; i < extra.length; i += 4) await w.ctx.db.insert(mailboxes).values(extra.slice(i, i + 4));
    const sams = extra.slice(0, 30).map((b) => b.id);
    const ids = async (c: typeof w.pat.c) => { const r = await c.get("/api/doc-inbox/mailboxes"); expect(r.status).toBe(200); return r.body.ids as string[]; };
    const adminIds = await ids(w.admin.c);
    expect(adminIds.filter((id) => id.startsWith("mbx_sl5"))).toEqual([]);
    expect(adminIds).not.toContain(w.boxes.personal);
    expect(adminIds).toContain(w.boxes.team);
    expect((await ids(w.pat.c))).toContain(w.boxes.personal);
    expect((await ids(w.dSend.c)).filter((id) => sams.includes(id)).length).toBeGreaterThan(0);
  }, 120_000);
});

describe("PRIV1b SL6: inbound mail rules", () => {
  it("read the mailbox once a message and each maker's level once, and still keep to the level", async () => {
    const w = await privacyWorld();
    const client = (w.ctx.db as unknown as { $client: { prepare: (s: string) => unknown } }).$client;
    const count = async (mailboxId: string, messageId: string) => {
      const seen: string[] = [];
      const orig = client.prepare.bind(client);
      client.prepare = (s: string) => { seen.push(s); return orig(s); };
      try { await runMailRules(w.ctx.deps, { orgId: w.orgId, mailboxId, messageId }); } finally { client.prepare = orig; }
      return { mailboxReads: seen.filter((s) => /from "mailboxes"/.test(s)).length, delegationReads: seen.filter((s) => /from "mailbox_delegations"/.test(s)).length };
    };
    const rule = (id: string, userId: string, mailboxId: string, tag: string, label: string, position: number) => ({ id, orgId: w.orgId, userId, mailboxId, name: id, position,
      conditions: JSON.stringify([{ field: "subject", value: `SUBJECT-${tag}` }]), actions: JSON.stringify([{ kind: "label", label }]) });
    const many = (who: string, mailboxId: string, tag: string, prefix: string, label: (i: number) => string) => Array.from({ length: 6 }, (_, i) => rule(`mrl_${prefix}${i}${w.n}aaaaaaa`, who, mailboxId, tag, label(i), i));
    for (const r of [...many(w.member.id, w.boxes.team, "TEAM", "tm", (i) => `team-${i}`), ...many(w.dReply.id, w.boxes.personal, "PERS", "rx", (i) => `rex-${i}`),
      ...many(w.dRead.id, w.boxes.personal, "PERS", "ra", (i) => `rae-${i}`)]) await w.ctx.db.insert(mailRules).values(r);
    const team = await count(w.boxes.team, w.msgs.team);
    const pers = await count(w.boxes.personal, w.msgs.personal);
    // Six rules each, but the mailbox read is not repeated per rule (whoCanOpen reads it once too).
    // PRIV1b (SP2): one mailbox read a message on a team mailbox (personalInfo, shared with whoCanOpen); on a personal
    // one that read plus each maker's level check.
    expect(team.mailboxReads).toBe(1);
    expect(team.delegationReads).toBeLessThanOrEqual(1);
    expect(pers.mailboxReads).toBeLessThanOrEqual(3);
    expect(pers.delegationReads).toBeLessThanOrEqual(3);
    const labels = async (prefix: string) => (await w.ctx.db.select().from(mailThreadLabels).where(sql`${mailThreadLabels.label} like ${prefix + "%"}`)).length;
    expect(await labels("team-")).toBe(6);
    expect(await labels("rex-")).toBe(6);
    expect(await labels("rae-")).toBe(0);
  }, 120_000);
});
