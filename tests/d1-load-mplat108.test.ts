import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { messages, users } from "@/server/db/schema";
import { CATEGORIES_DEFAULT_FROM, importantBaseCond } from "@/server/services/mail/splits";
import { runCronSteps, type CronStep } from "@/server/services/cron-steps";
import { FIRST_SENDER_KEY, fillFirstSender, firstSenderReady, forgetFirstSenderReady, refreshFirstSenderReady } from "@/server/services/mail/first-sender";

/**
 * MPLAT-108 and MPLAT-96 (D1 load, 12 Nov 2026). The badge counts poll (78% of all D1 rows read on mymail-au) and the
 * Important list worked out "first message from this sender" with a window over every received message of the
 * workspace on every call. The answer now lives on the row (messages.first_of_sender, kept by triggers), so:
 *   1. the flag must equal the old window after every kind of write (insert in any order, moves, repairs, deletes);
 *   2. counts and the Important list must be identical to the old rule;
 *   3. no statement may read the workspace's mail to answer it again.
 * And the cron passes run one after another, with staging off production's minutes.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let orgId: string;
let mailboxId: string;
let mailbox2: string;
type Db = { prepare: (q: string) => { run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown } };
const db = () => (ctx.db as unknown as { $client: Db }).$client;

/** The R59 window, verbatim: the earliest message per mailbox and lower(from_address), outside Sent and Drafts. */
const WINDOW = `select f.id from (select p.id, row_number() over (partition by p.mailbox_id, lower(p.from_address) order by p.date, p.id) as rn
  from messages p where p.org_id = ? and p.folder <> 'sent' and p.folder <> 'drafts') f where f.rn = 1`;
const windowIds = () => (db().prepare(`${WINDOW} order by 1`).all(orgId) as { id: string }[]).map((r) => r.id);
const flagged = () => (db().prepare("select id from messages where org_id = ? and first_of_sender = 1 order by 1").all(orgId) as { id: string }[]).map((r) => r.id);
const agree = () => expect(flagged()).toEqual(windowIds());

let n = 0;
function put(o: { id?: string; from: string; date: number; folder?: string; mailbox?: string; read?: boolean; auth?: string | null; bulk?: number; thread?: string }) {
  const id = o.id ?? `msg_t${++n}`;
  db().prepare(`insert into messages (id, org_id, mailbox_id, folder, thread_id, from_address, to_json, subject, is_read, auth_results, is_bulk, date, created_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, orgId, o.mailbox ?? mailboxId, o.folder ?? "inbox", o.thread ?? `thr_${id}`, o.from, '[{"address":"hello@acme.io"}]', id,
    o.read ? 1 : 0, o.auth === undefined ? '{"spf":"pass","dkim":"pass","dmarc":"pass"}' : o.auth, o.bulk ?? 0, o.date, o.date);
  return id;
}
const T = Date.UTC(2026, 9, 1);
const min = (k: number) => T + k * 60_000;

async function setupMailbox(local: string) {
  const domains = (await owner.get("/api/domains")).body.domains as { id: string; name: string }[];
  let domainId = domains.find((d) => d.name === "acme.io")?.id;
  if (!domainId) {
    domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id as string;
    const { body } = await owner.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await owner.post(`/api/domains/${domainId}/verify`);
  }
  return (await owner.post("/api/mailboxes", { domainId, localPart: local, displayName: local })).body.mailbox.id as string;
}

beforeEach(async () => {
  ctx = await makeTestApp();
  expect(await refreshFirstSenderReady(ctx.db)).toBe(true); // a new database has no mail: 0171 marks the fill done
  ctx.deps.now = () => new Date(Date.UTC(2026, 10, 12));
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  // Important and Other tabs (an account made before R85's Primary, Updates and Promotions default).
  await ctx.db.update(users).set({ createdAt: new Date(CATEGORIES_DEFAULT_FROM - 86_400_000) }).where(eq(users.email, "owner@acme.io"));
  await owner.post("/api/org/plan", { plan: "pro" });
  mailboxId = await setupMailbox("hello");
  mailbox2 = await setupMailbox("sales");
  orgId = (db().prepare("select org_id from mailboxes where id = ?").get(mailboxId) as { org_id: string }).org_id;
});

describe("first_of_sender equals the old window after every kind of write (MPLAT-108)", () => {
  it("inserts in any order, mixed case senders, Sent and Drafts left out, two mailboxes", () => {
    put({ id: "m_b", from: "ana@studio.io", date: min(20) });
    agree();
    put({ id: "m_a", from: "Ana@Studio.io", date: min(10) }); // earlier, arrives later (an import going newest first)
    agree();
    put({ id: "m_c", from: "ana@studio.io", date: min(10) }); // same instant: the lower id wins
    agree();
    put({ id: "m_s", from: "ana@studio.io", date: min(1), folder: "sent" });
    put({ id: "m_d", from: "ana@studio.io", date: min(2), folder: "drafts" });
    agree();
    put({ id: "m_x", from: "ana@studio.io", date: min(5), mailbox: mailbox2 });
    put({ id: "m_t", from: "ana@studio.io", date: min(3), folder: "trash" });
    agree();
    expect(flagged()).toEqual(["m_t", "m_x"]);
  });

  it("moves, repairs, date changes and deletes", () => {
    for (let i = 0; i < 6; i++) put({ id: `m${i}`, from: i % 2 ? "bo@corp.io" : "cy@corp.io", date: min(10 + i) });
    agree();
    const step = (q: string, ...a: unknown[]) => { db().prepare(q).run(...a); agree(); };
    step("update messages set folder = 'archive' where id = 'm0'"); // still counted: same first
    step("update messages set folder = 'sent' where id = 'm0'"); // leaves the set: m2 becomes first
    step("update messages set folder = 'inbox' where id = 'm0'"); // back
    step("update messages set folder = 'drafts' where id in ('m0', 'm2')");
    step("update messages set from_address = 'Bo@Corp.io' where id = 'm4'"); // a header repair moves it to Bo
    step("update messages set from_address = 'dee@new.io' where id = 'm1'"); // Bo's first leaves
    step("update messages set date = ? where id = 'm5'", min(1)); // Bo's latest becomes his earliest
    step("update messages set mailbox_id = ? where id = 'm3'", mailbox2);
    step("update messages set is_read = 1, is_starred = 1"); // unrelated columns: nothing moves
    step("delete from messages where id = 'm5'");
    step("delete from messages where from_address = 'Bo@Corp.io'");
    step("delete from messages");
    expect(flagged()).toEqual([]);
  });

  it("random writes keep the flag exact", () => {
    let s = 7; const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const senders = ["a@x.io", "A@x.io", "b@x.io", "c@y.io", "noreply@z.io"];
    const folders = ["inbox", "archive", "trash", "spam", "sent", "drafts"];
    for (let i = 0; i < 300; i++) {
      const ids = (db().prepare("select id from messages").all() as { id: string }[]).map((x) => x.id);
      const pick = () => ids[Math.floor(r() * ids.length)];
      const k = r();
      if (k < 0.45 || ids.length < 5) put({ from: senders[Math.floor(r() * senders.length)], date: min(Math.floor(r() * 50)), folder: folders[Math.floor(r() * folders.length)], mailbox: r() < 0.3 ? mailbox2 : mailboxId });
      else if (k < 0.6) db().prepare("update messages set folder = ? where id = ?").run(folders[Math.floor(r() * folders.length)], pick());
      else if (k < 0.7) db().prepare("update messages set date = ? where id = ?").run(min(Math.floor(r() * 50)), pick());
      else if (k < 0.8) db().prepare("update messages set from_address = ? where id = ?").run(senders[Math.floor(r() * senders.length)], pick());
      else if (k < 0.85) db().prepare("update messages set mailbox_id = ? where id = ?").run(r() < 0.5 ? mailbox2 : mailboxId, pick());
      else db().prepare("delete from messages where id = ?").run(pick());
      expect(flagged(), `after write ${i}`).toEqual(windowIds());
    }
  });

  it("the migration fills nothing itself: no statement in it reads the whole messages table with a window", () => {
    const sqlText = readFileSync("drizzle/0171_first_sender_d1load.sql", "utf8").split("--> statement-breakpoint").map((x) => x.replace(/^--.*$/gm, "").trim());
    expect(sqlText.filter((x) => /row_number|^UPDATE/i.test(x))).toEqual([]);
    expect(sqlText.some((x) => x.startsWith("INSERT INTO `app_settings`") && x.includes("NOT EXISTS (SELECT 1 FROM `messages`)"))).toBe(true);
  });

  it("an existing database is filled a mailbox at a time; counts stay right before, during and after", async () => {
    for (let i = 0; i < 40; i++) put({ from: `p${i % 7}@d.io`, date: min(100 - i), folder: i % 9 === 0 ? "sent" : "inbox", mailbox: i % 2 ? mailbox2 : mailboxId });
    const important = async () => ((await owner.get("/api/counts")).body.mail as { important: number }).important;
    const expected = await important();
    expect(expected).toBeGreaterThan(0);
    // As a database with mail looks right after 0171: no flags, no mark.
    db().prepare("update messages set first_of_sender = 0").run();
    db().prepare("delete from app_settings where key = ?").run(FIRST_SENDER_KEY);
    forgetFirstSenderReady();
    expect(await important()).toBe(expected); // the old window answers until the fill is done
    expect(firstSenderReady()).toBe(false);
    const first = await fillFirstSender(ctx.deps, { mailboxesPerPass: 1 });
    expect(first).toEqual({ filled: 1, done: false });
    expect(firstSenderReady()).toBe(false);
    // A new first message between passes: the triggers keep its group, the fill keeps the rest.
    put({ from: "p1@d.io", date: min(0), mailbox: mailbox2 });
    let passes = 1;
    while (!(await fillFirstSender(ctx.deps, { mailboxesPerPass: 1 })).done) expect(++passes).toBeLessThan(20);
    expect(firstSenderReady()).toBe(true);
    agree();
    const stmt = ctx.deps.db.select({ n: sql<number>`count(*)` }).from(messages).where(importantBaseCond(orgId)).toSQL();
    expect(stmt.sql).not.toMatch(/row_number/);
    const flagCount = await important();
    // The same count through the old window.
    db().prepare("delete from app_settings where key = ?").run(FIRST_SENDER_KEY);
    forgetFirstSenderReady();
    expect(await important()).toBe(flagCount);
    expect((await fillFirstSender(ctx.deps)).done).toBe(true); // nothing left to fill: done again in one pass
    expect(firstSenderReady()).toBe(true);
  });
});

describe("counts and the Important list are identical to the old rule (MPLAT-108)", () => {
  /** The old Important rule: the same SQL with the stored flag swapped back for the R59 window. */
  function oldImportant(): { sql: string; params: unknown[] } {
    const q = ctx.deps.db.select({ id: messages.id }).from(messages).where(sql`${messages.orgId} = ${orgId} and ${messages.folder} = 'inbox' and ${messages.isRead} = 0 and (${importantBaseCond(orgId)}) is true`).toSQL();
    expect(q.sql).toContain(`"messages"."first_of_sender" = 1`);
    return { sql: q.sql.replace(`"messages"."first_of_sender" = 1`, `"messages"."id" in (${WINDOW.replace("?", "'" + orgId.replace(/'/g, "''") + "'")})`), params: q.params };
  }
  const oldIds = () => { const q = oldImportant(); return (db().prepare(q.sql + " order by 1").all(...q.params) as { id: string }[]).map((r) => r.id); };

  it("a prod shaped mailbox: same Important count, Other count and Important list", async () => {
    let s = 11; const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    // Some contacts saved by hand, some threads this mailbox wrote in, some senders it wrote to.
    db().prepare("insert into contacts (id, org_id, email, source, created_at, updated_at) values ('ct1', ?, 'P3@d3.io', 'manual', 0, 0), ('ct2', ?, 'p4@d4.io', 'mail', 0, 0)").run(orgId, orgId);
    put({ from: "hello@acme.io", date: min(1), folder: "sent", thread: "thr_w1", read: true });
    db().prepare("update messages set to_json = '[{\"address\":\"P5@D5.io\"}]' where folder = 'sent'").run();
    for (let i = 0; i < 600; i++) {
      const who = Math.floor(Math.pow(r(), 2) * 60);
      put({
        from: who < 8 ? `noreply${who}@svc.io` : `p${who}@d${who}.io`, date: min(Math.floor(r() * 5000)), read: r() < 0.2,
        auth: r() < 0.7 ? '{"spf":"pass","dkim":"pass","dmarc":"pass"}' : r() < 0.5 ? '{"spf":"pass","dkim":"fail"}' : null,
        bulk: r() < 0.15 ? 1 : 0, thread: r() < 0.03 ? "thr_w1" : undefined, mailbox: r() < 0.25 ? mailbox2 : mailboxId,
        folder: r() < 0.08 ? "archive" : "inbox",
      });
    }
    const expected = oldIds();
    expect(expected.length).toBeGreaterThan(20);
    const c = (await owner.get("/api/counts")).body.mail as { inbox: number; important: number; other: number };
    expect(c.important).toBe(expected.length);
    expect(c.other).toBe(c.inbox - expected.length);
    const list = async (mb: string) => {
      const out: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const res = (await owner.get(`/api/mail/messages?mailboxId=${mb}&folder=inbox&split=important&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).body as { messages: { id: string; isRead: boolean }[]; nextCursor?: string | null };
        out.push(...res.messages.filter((m) => !m.isRead).map((m) => m.id));
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      return out;
    };
    const listed = [...await list(mailboxId), ...await list(mailbox2)].sort();
    expect(listed).toEqual(expected);
  });
});

describe("no badge poll reads the workspace's mail again (MPLAT-108)", () => {
  const plan = (q: string, ...a: unknown[]) => (db().prepare(`explain query plan ${q}`).all(...a) as { detail: string }[]).map((p) => p.detail);

  it("the Important rule has no window and no subquery over messages", () => {
    const stmt = ctx.deps.db.select({ n: sql<number>`count(*)` }).from(messages)
      .where(sql`${messages.orgId} = ${"o"} and ${messages.folder} = 'inbox' and ${messages.isRead} = 0 and ${importantBaseCond("o")}`).toSQL();
    expect(stmt.sql).not.toMatch(/row_number|over \(/i);
    const rows = plan(stmt.sql, ...stmt.params);
    // Only the Sent sets (wrote to, Sent threads) still read messages, through the (org, folder) index: Sent rows only.
    const msgReads = rows.filter((d) => /^(SCAN|SEARCH) (p|s|t|messages)\b/.test(d));
    expect(msgReads.filter((d) => /^SCAN/.test(d))).toEqual([]);
    expect(rows.filter((d) => /^SEARCH (s|t) /.test(d)).every((d) => /messages_org_folder_date_idx \(org_id=\? AND folder=\?\)/.test(d))).toBe(true);
    expect(rows.some((d) => /^SEARCH p /.test(d))).toBe(false);
    // Saved contacts: only the kept ones, not every automatic "mail" contact.
    expect(rows.join(" ")).toMatch(/SEARCH ct USING (COVERING )?INDEX contacts_org_kept_email_idx/);
  });

  it("each trigger lookup is one index seek, never a mailbox scan", () => {
    const first = plan("SELECT p.id FROM messages p WHERE p.mailbox_id = ? AND lower(p.from_address) = lower(?) AND p.folder <> 'sent' AND p.folder <> 'drafts' ORDER BY p.date, p.id LIMIT 1", "m", "a@b.io");
    expect(first.join(" ")).toMatch(/SEARCH p USING (COVERING )?INDEX messages_sender_first_idx/);
    expect(first.join(" ")).not.toMatch(/TEMP B-TREE/);
    const flag = plan("SELECT id FROM messages WHERE mailbox_id = ? AND lower(from_address) = lower(?) AND first_of_sender = 1", "m", "a@b.io");
    expect(flag.join(" ")).toMatch(/messages_first_of_sender_idx/);
  });

  it("an inbound message that is not its sender's first writes nothing beyond its own row", () => {
    put({ id: "w1", from: "ana@studio.io", date: min(1) });
    const before = db().prepare("select total_changes() as n").get() as { n: number };
    put({ id: "w2", from: "ana@studio.io", date: min(2) });
    const after = db().prepare("select total_changes() as n").get() as { n: number };
    expect(after.n - before.n).toBe(1);
    put({ id: "w0", from: "ana@studio.io", date: min(0) }); // the new first: its row, plus the old first cleared and the new one set
    const last = db().prepare("select total_changes() as n").get() as { n: number };
    expect(last.n - after.n).toBe(3);
    agree();
  });
});

describe("cron passes run one after another (MPLAT-96)", () => {
  it("never two at once, in order, a failing pass does not stop the rest", async () => {
    let active = 0, peak = 0;
    const order: string[] = [];
    const errors: string[] = [];
    const deps = { ...ctx.deps, reportError: (_e: unknown, c: { where: string }) => { errors.push(c.where); } } as typeof ctx.deps;
    const step = (name: string, fail = false): CronStep => ({
      name,
      run: async () => {
        active++; peak = Math.max(peak, active); order.push(name);
        await new Promise((res) => setTimeout(res, 5));
        active--;
        if (fail) throw new Error("boom");
      },
    });
    const out = await runCronSteps(deps, [step("maintenance"), step("tools.sign_pass", true), step("tools.merge_pass"), step("notify.digest_pass")]);
    expect(peak).toBe(1);
    expect(order).toEqual(["maintenance", "tools.sign_pass", "tools.merge_pass", "notify.digest_pass"]);
    expect(out.ran).toEqual(order);
    expect(errors).toEqual(["cron.tools.sign_pass"]);
  });

  it("a pass not started within the budget is skipped, so two ticks never overlap", async () => {
    let now = 0;
    const steps: CronStep[] = ["a", "b", "c"].map((name) => ({ name, run: async () => { now += 6 * 60_000; } }));
    const out = await runCronSteps(ctx.deps, steps, { clock: () => now });
    expect(out).toEqual({ ran: ["a", "b"], skipped: ["c"] });
  });

  it("the scheduled handler hands the passes over as one sequence", () => {
    const src = readFileSync("src/entry/worker.ts", "utf8");
    const scheduled = src.slice(src.indexOf("async scheduled(_event"), src.indexOf("\n  },\n};", src.indexOf("async scheduled(_event")));
    expect(scheduled.match(/ctx\.waitUntil\(/g)).toHaveLength(1);
    expect(scheduled).toContain("runScheduledSteps(deps)");
    expect(src).toMatch(/\{ name: "maintenance", run: \(\) => runMaintenanceIfMigrated\(deps, \{ rotate: true \}\) \}/);
  });

  it("staging ticks 7 minutes after production, in the same quarter hour", () => {
    const toml = readFileSync("wrangler.toml", "utf8");
    const crons = [...toml.matchAll(/^crons = \[([^\]]*)\]/gm)].map((m) => m[1]);
    expect(crons).toEqual([`"*/15 * * * *"`, `"7-59/15 * * * *"`]);
    const staging = [7, 22, 37, 52];
    expect(staging.map((m) => Math.floor(m / 15))).toEqual([0, 1, 2, 3]); // the rotated hourly housekeeping slot
  });
});
