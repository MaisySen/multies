import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { auditLogs, mailboxAccess, mailboxAccessLog, mailboxDelegations, mailboxes, members } from "@/server/db/schema";
import { MIGRATIONS } from "@/server/db/migrations.generated";
import { pruneMailboxOpens } from "@/server/services/maintenance";

// PRIV1b batch "migration-log": P18 (0164 UPDATE 4 cost), P24 (stale grants on personal mailboxes), P32 (access log index and retention).

type W = Awaited<ReturnType<typeof privacyWorld>>;
type Raw = { exec: (s: string) => void; prepare: (s: string) => { all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown } };
const raw = (w: W) => (w.ctx.db as unknown as { $client: Raw }).$client;
const m0164 = () => MIGRATIONS.find((x) => x.name.startsWith("0164_"))!.statements;
const m0165 = () => MIGRATIONS.find((x) => x.name.startsWith("0165_"))!.statements;
const TMP = "audit_logs_priv1a_claim_tmp_idx";
// PRIV1b (ML3): the backfill steps exactly as the old 0164 file had them (origin/main), pinned here so the comparison is real.
const OLD_STEPS = [
  "UPDATE `mailboxes` SET `personal` = 1 WHERE `kind` = 'person' AND `personal` = 0 AND `id` IN (SELECT `mailbox_id` FROM `mail_connections`);",
  "UPDATE `mailboxes` SET `personal` = 1 WHERE `kind` = 'person' AND `personal` = 0 AND `id` IN (SELECT `target_id` FROM `audit_logs` WHERE `action` = 'free_address.claimed' AND `target_type` = 'mailbox');",
  "UPDATE `mailboxes` SET `owner_user_id` = (SELECT c.`created_by_user_id` FROM `mail_connections` c JOIN `members` m ON m.`user_id` = c.`created_by_user_id` AND m.`organization_id` = c.`org_id` WHERE c.`mailbox_id` = `mailboxes`.`id` ORDER BY c.`created_at` LIMIT 1) WHERE `personal` = 1 AND `owner_user_id` IS NULL;",
  "UPDATE `mailboxes` SET `owner_user_id` = (SELECT a.`actor_user_id` FROM `audit_logs` a JOIN `members` m ON m.`user_id` = a.`actor_user_id` AND m.`organization_id` = a.`org_id` WHERE a.`action` = 'free_address.claimed' AND a.`target_type` = 'mailbox' AND a.`target_id` = `mailboxes`.`id` ORDER BY a.`created_at` LIMIT 1) WHERE `personal` = 1 AND `owner_user_id` IS NULL;",
  "UPDATE `mailboxes` SET `owner_user_id` = (SELECT x.`user_id` FROM `mailbox_access` x JOIN `members` m ON m.`user_id` = x.`user_id` AND m.`organization_id` = x.`org_id` WHERE x.`mailbox_id` = `mailboxes`.`id`) WHERE `personal` = 1 AND `owner_user_id` IS NULL AND (SELECT count(*) FROM `mailbox_access` x WHERE x.`mailbox_id` = `mailboxes`.`id`) = 1;",
];

describe("PRIV1b P18: 0164 UPDATE 4 looks claims up by index", () => {
  it("the backfill uses a temporary index, drops it, and gives the same owners as the old SQL", async () => {
    const w = await privacyWorld();
    const s = m0164();
    const ci = s.findIndex((x) => x.includes(`CREATE INDEX IF NOT EXISTS \`${TMP}\``));
    const di = s.findIndex((x) => x.startsWith(`DROP INDEX IF EXISTS \`${TMP}\``));
    const u4 = s.findIndex((x) => x.includes("free_address.claimed") && x.includes("SET `owner_user_id`"));
    expect(ci).toBeGreaterThan(-1);
    expect(ci).toBeLessThan(u4);
    expect(di).toBeGreaterThan(u4);
    // The backfill steps as the old file had them (pinned), and as the new one has them.
    const first = s.findIndex((x) => x.startsWith("UPDATE `mailboxes`"));
    const steps = s.slice(Math.min(first, ci)).filter((x) => !x.includes("comp_plan"));
    const oldSteps = OLD_STEPS;
    expect(steps.length).toBe(oldSteps.length + 2);

    // Fixture: several claimed free addresses, claims by people who left, repeated claims, and noise rows.
    const n = w.n;
    const box = (k: string) => `mbx_p18${k}${n}aaaaaaa`;
    const keys = ["one", "late", "two", "gone", "type", "agnt", "plain"];
    await w.ctx.db.insert(mailboxes).values(keys.map((k) => ({ id: box(k), orgId: w.orgId, domainId: w.domainId, localPart: `p18${k}${n}`, address: `p18${k}${n}@acme.io`, displayName: k, quotaMb: 1, ...(k === "agnt" ? { kind: "agent" as const } : {}) })));
    const claim = (k: string, actor: string, at: number, targetType = "mailbox") => ({ id: `aud_p18${k}${actor.slice(-6)}${at}`, orgId: w.orgId, actorUserId: actor, action: "free_address.claimed", targetType, targetId: box(k), createdAt: new Date(at) });
    await w.ctx.db.insert(auditLogs).values([
      claim("one", w.nobody.id, 1000),
      claim("late", "usr_left000000000", 1000), claim("late", w.admin.id, 2000),
      claim("two", w.dRead.id, 3000), claim("two", w.member.id, 2500),
      claim("gone", "usr_left000000000", 1000),
      claim("type", w.nobody.id, 1000, "other"),
      claim("agnt", w.nobody.id, 1000),
    ]);
    const r = raw(w);
    r.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 300) INSERT INTO audit_logs (id, org_id, actor_user_id, action, target_type, target_id, created_at) SELECT 'aud_p18noise' || ? || i, ?, ?, 'mailbox.created', 'mailbox', ?, i FROM k")
      .run(String(n), w.orgId, w.admin.id, box("one"));
    const snap = () => r.prepare("SELECT id, personal, owner_user_id FROM mailboxes WHERE org_id = ? ORDER BY id").all(w.orgId) as { id: string; personal: number; owner_user_id: string | null }[];
    const before = snap();
    const restore = () => { for (const b of before) r.prepare("UPDATE mailboxes SET personal = ?, owner_user_id = ? WHERE id = ?").run(b.personal, b.owner_user_id, b.id); };
    const run = (list: string[]) => { restore(); for (const x of list) r.exec(x); return snap(); };
    const oldOut = run(oldSteps);
    const newOut = run(steps);
    expect(newOut).toEqual(oldOut);
    const got = Object.fromEntries(newOut.filter((x) => x.id.startsWith("mbx_p18")).map((x) => [x.id, [x.personal, x.owner_user_id]]));
    expect(got).toEqual({
      [box("one")]: [1, w.nobody.id], [box("late")]: [1, w.admin.id], [box("two")]: [1, w.member.id], [box("gone")]: [1, null],
      [box("type")]: [0, null], [box("agnt")]: [0, null], [box("plain")]: [0, null],
    });
    // The index is gone again, and running the steps twice is harmless.
    expect(r.prepare("SELECT name FROM sqlite_master WHERE name = ?").all(TMP)).toEqual([]);
    for (const x of steps) r.exec(x);
    expect(snap()).toEqual(newOut);
  }, 120_000);

  it("with the index the per mailbox lookup no longer scans audit_logs", async () => {
    const w = await privacyWorld();
    const s = m0164();
    const u4 = s.find((x) => x.includes("free_address.claimed") && x.includes("SET `owner_user_id`"))!;
    const r = raw(w);
    const plan = () => (r.prepare(`EXPLAIN QUERY PLAN ${u4}`).all() as { detail: string }[]).map((p) => p.detail).join("\n");
    expect(plan()).toMatch(/SCAN a\b/);
    r.exec(s.find((x) => x.includes(`CREATE INDEX IF NOT EXISTS \`${TMP}\``))!);
    expect(plan()).not.toMatch(/SCAN a\b/);
    expect(plan()).toContain(TMP);
  }, 60_000);
});

describe("PRIV1b P24: grants on personal mailboxes", () => {
  it("Team no longer lists a stale grant on a personal mailbox, so saving access works again", async () => {
    const w = await privacyWorld();
    // A grant left from before 0164 made the mailbox personal.
    await w.ctx.db.insert(mailboxAccess).values({ orgId: w.orgId, userId: w.member.id, mailboxId: w.boxes.personal });
    const list = await w.owner.get("/api/team");
    expect(list.status).toBe(200);
    const max = (list.body.members as { userId: string; mailboxIds: string[] | null }[]).find((m) => m.userId === w.member.id)!;
    expect(max.mailboxIds).toEqual([w.boxes.team]);
    // The editor sends back what it was given.
    expect((await w.owner.patch(`/api/team/members/${w.member.id}`, { mailboxIds: max.mailboxIds })).status).toBe(200);
    // A personal mailbox still can't be granted, and the team grant still opens.
    expect((await w.owner.patch(`/api/team/members/${w.member.id}`, { mailboxIds: [w.boxes.team, w.boxes.personal] })).status).toBe(403);
    expect((await w.member.c.get(`/api/mail/messages/${w.msgs.team}`)).status).toBe(200);
    expect([403, 404]).toContain((await w.member.c.get(`/api/mail/messages/${w.msgs.personal}`)).status);
  }, 120_000);

  it("0165 removes grants on personal mailboxes and shares whose person or owner left", async () => {
    const w = await privacyWorld();
    await w.ctx.db.insert(mailboxAccess).values({ orgId: w.orgId, userId: w.member.id, mailboxId: w.boxes.personal });
    const deletes = m0165().filter((x) => /^(--[^\n]*\n)*DELETE/.test(x));
    expect(deletes.length).toBe(2);
    const r = raw(w);
    const runDeletes = () => { for (const x of deletes) r.exec(x); };
    const grants = async () => (await w.ctx.db.select({ m: mailboxAccess.mailboxId }).from(mailboxAccess).where(eq(mailboxAccess.userId, w.member.id))).map((x) => x.m);
    const shares = async () => (await w.ctx.db.select({ u: mailboxDelegations.userId }).from(mailboxDelegations).where(eq(mailboxDelegations.mailboxId, w.boxes.personal))).map((x) => x.u).sort();
    runDeletes();
    expect(await grants()).toEqual([w.boxes.team]);
    expect(await shares()).toEqual([w.dRead.id, w.dReply.id, w.dSend.id].sort());
    // Rae left without the leave flow ending her share.
    await w.ctx.db.delete(members).where(and(eq(members.organizationId, w.orgId), eq(members.userId, w.dRead.id)));
    runDeletes();
    expect(await shares()).toEqual([w.dReply.id, w.dSend.id].sort());
    // Pat, the owner, left the same way: every share on the mailbox ends.
    await w.ctx.db.delete(members).where(and(eq(members.organizationId, w.orgId), eq(members.userId, w.pat.id)));
    runDeletes();
    expect(await shares()).toEqual([]);
    expect(await grants()).toEqual([w.boxes.team]);
  }, 120_000);
});

describe("PRIV1b P32: mailbox access log index and retention", () => {
  it("has an (org_id, created_at) index the prune uses", async () => {
    const w = await privacyWorld();
    const r = raw(w);
    expect(r.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'mailbox_access_log_org_idx'").all()).toHaveLength(1);
    const plan = (r.prepare("EXPLAIN QUERY PLAN SELECT id FROM mailbox_access_log WHERE org_id IN (SELECT id FROM organizations) AND created_at < 1 AND action IN ('opened_mailbox','opened_thread') LIMIT 5").all() as { detail: string }[]).map((p) => p.detail).join("\n");
    expect(plan).toContain("mailbox_access_log_org_idx");
  }, 60_000);

  it("prunes opens older than 400 days, a bounded number a pass, and keeps share changes and recent opens", async () => {
    const w = await privacyWorld();
    const now = w.ctx.deps.now().getTime();
    const day = 86_400_000;
    const row = (id: string, action: string, ageDays: number) => ({ id: `mal_p32${id}${w.n}`, orgId: w.orgId, mailboxId: w.boxes.personal, actorUserId: w.dRead.id, actorEmail: null, action, targetId: null, device: "web", createdAt: new Date(now - ageDays * day) });
    await w.ctx.db.delete(mailboxAccessLog).where(eq(mailboxAccessLog.orgId, w.orgId));
    await w.ctx.db.insert(mailboxAccessLog).values([
      row("old1", "opened_mailbox", 401), row("old2", "opened_thread", 500), row("old3", "opened_thread", 900),
      row("share", "share_granted", 900), row("recent", "opened_thread", 399),
    ]);
    const ids = async () => (await w.ctx.db.select({ id: mailboxAccessLog.id }).from(mailboxAccessLog).where(eq(mailboxAccessLog.orgId, w.orgId))).map((x) => x.id.replace(`mal_p32`, "").replace(`${w.n}`, "")).sort();
    expect(await pruneMailboxOpens(w.ctx.deps, 2)).toBe(2);
    expect((await ids()).filter((x) => x.startsWith("old"))).toHaveLength(1);
    expect(await pruneMailboxOpens(w.ctx.deps)).toBe(1);
    expect(await ids()).toEqual(["recent", "share"]);
    expect(await pruneMailboxOpens(w.ctx.deps)).toBe(0);
  }, 60_000);
});
