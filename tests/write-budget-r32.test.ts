import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { meter } from "./d1-meter";
import { loadConfig } from "@/server/config";
import { alertSubject, checkWriteBudget, healthView, levelFor, noteD1LimitHit, resetWriteBudgetCache, writeBudget, WRITE_BUDGET_SHED_PCT, WRITE_BUDGET_WARN_PCT } from "@/server/services/write-budget";
import { COALESCE_MS, COALESCED_AT_WARN, decideDeferrable, deferrableWrite, DEFERRABLE_KINDS, resetWritePriority } from "@/server/services/write-priority";

const PROD = "e467919b-f7d8-4961-86b9-9cd861708efc";
const STAGING = "72494627-4880-4fb9-9586-e2175f16e8d3";
const env = (extra: Record<string, string> = {}) => ({ CF_ANALYTICS_TOKEN: "cf_test", CF_ACCOUNT_ID: "acct", ...extra });
/** A fake Cloudflare GraphQL answer: rows written today split over production and staging. */
function analytics(rows: number, calls = { n: 0 }) {
  return (async () => {
    calls.n += 1;
    const prod = Math.floor(rows / 2);
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [
      { sum: { rowsWritten: prod }, dimensions: { databaseId: PROD, date: "2026-10-26" } },
      { sum: { rowsWritten: rows - prod }, dimensions: { databaseId: STAGING, date: "2026-10-26" } },
    ] }] } }, errors: null }));
  }) as unknown as typeof fetch;
}

describe("R32 D1 write budget: meter and alerts", () => {
  beforeEach(() => { resetWriteBudgetCache(); resetWritePriority(); });

  it("warns at 60% and sheds at 85% by default", () => {
    expect(WRITE_BUDGET_WARN_PCT).toBe(60);
    expect(WRITE_BUDGET_SHED_PCT).toBe(85);
    const cfg = loadConfig({ APP_SECRET: "t".repeat(40) }).writeBudget;
    expect(cfg.warnAt).toBe(0.6);
    expect(cfg.shedAt).toBe(0.85);
    expect(levelFor(84_999, cfg)).toBe("warn");
    expect(levelFor(85_000, cfg)).toBe("shed");
    expect(cfg.alertTo).toBe("security@multies.si");
    expect(loadConfig({ APP_SECRET: "t".repeat(40), OPS_ALERT_EMAIL: "off" }).writeBudget.alertTo).toBeUndefined();
    expect(loadConfig({ APP_SECRET: "t".repeat(40), OPS_ALERT_EMAIL: "ops@fintex.test" }).writeBudget.alertTo).toBe("ops@fintex.test");
  });

  it("subject reads like the brief", () => {
    expect(alertSubject("Multies", { rowsWritten: 60_123, budget: 100_000, level: "warn" }, { warnAt: 0.6, shedAt: 0.85 })).toBe("Multies D1 writes at 60% today (60,123 of 100,000)");
    expect(alertSubject("Multies", { rowsWritten: 85_500, budget: 100_000, level: "shed" }, { warnAt: 0.6, shedAt: 0.85 })).toBe("Multies D1 writes at 85% today (85,500 of 100,000)");
  });

  it("mails the ops address once per level per UTC day, deduped by one app_settings row", async () => {
    const { deps, outbound } = await makeTestApp(env({ OPS_ALERT_EMAIL: "ops@fintex.test" }), { fetch: analytics(62_000) });
    await checkWriteBudget(deps);
    resetWriteBudgetCache(); // a second isolate: memory is empty, the row still dedupes
    await checkWriteBudget(deps);
    const alerts = outbound.sent.filter((m) => m.subject.includes("D1 writes"));
    expect(alerts.map((m) => m.subject)).toEqual(["Multies D1 writes at 60% today (62,000 of 100,000)"]);
    expect(alerts[0].to).toEqual(["ops@fintex.test"]);
    expect(alerts[0].text).toContain("production");
  });

  it("a jump straight to 85% sends the 60% and the 85% mail, and nothing more that day", async () => {
    const { deps, outbound } = await makeTestApp(env({ OPS_ALERT_EMAIL: "ops@fintex.test" }), { fetch: analytics(86_000) });
    await checkWriteBudget(deps);
    await checkWriteBudget(deps);
    expect(outbound.sent.filter((m) => m.subject.includes("D1 writes")).map((m) => m.subject)).toEqual([
      "Multies D1 writes at 60% today (86,000 of 100,000)",
      "Multies D1 writes at 85% today (86,000 of 100,000)",
    ]);
  });

  it("sends nothing under 60% and with no token", async () => {
    const a = await makeTestApp(env(), { fetch: analytics(10_000) });
    await checkWriteBudget(a.deps);
    expect(a.outbound.sent.filter((m) => m.subject.includes("D1 writes"))).toHaveLength(0);
    resetWriteBudgetCache();
    const b = await makeTestApp();
    await checkWriteBudget(b.deps);
    expect(b.outbound.sent.filter((m) => m.subject.includes("D1 writes"))).toHaveLength(0);
  });

  it("/api/health shows today, percent, reset time and production vs staging, never database ids", async () => {
    const { app } = await makeTestApp(env(), { fetch: analytics(62_000) });
    const body = await (await app.request("/api/health", { headers: { host: "localhost" } })).json() as { writes: Record<string, unknown> };
    expect(body.writes).toMatchObject({ today: 62_000, budget: 100_000, level: "warn", pct: 62, warnAt: 60, shedAt: 85, byEnvironment: { production: 31_000, staging: 31_000 } });
    expect(String(body.writes.resetAt)).toMatch(/T00:00:00\.000Z$/);
    expect(JSON.stringify(body)).not.toContain(PROD);
    const v = healthView({ level: "ok", rowsWritten: 1, budget: 100_000, byDatabase: { other: 1 }, at: "2026-10-26T23:59:00.000Z" }, { warnAt: 0.6, shedAt: 0.85 }, new Date("2026-10-26T23:59:00Z"));
    expect(v.resetAt).toBe("2026-10-27T00:00:00.000Z");
    expect(v.byEnvironment).toEqual({ other: 1 });
  });

  it("a real D1 limit error sheds deferrable writes for the rest of the UTC day, even with no token", async () => {
    const { deps } = await makeTestApp();
    expect((await writeBudget(deps)).level).toBe("off");
    noteD1LimitHit(deps.now());
    expect((await writeBudget(deps)).level).toBe("shed");
    noteD1LimitHit(new Date(deps.now().getTime() - 86_400_000));
    expect((await writeBudget(deps)).level).toBe("off");
  });
});

describe("R32 write priority: deferrable writes", () => {
  beforeEach(() => { resetWriteBudgetCache(); resetWritePriority(); });

  it("names every deferrable kind, and decides written, coalesced or skipped by level", () => {
    expect(DEFERRABLE_KINDS).toEqual(["item_visit", "chat_read", "mail_read_on_open", "notification_read", "last_used", "last_seen"]);
    for (const k of DEFERRABLE_KINDS) {
      expect(decideDeferrable("ok", k, "a", 0)).toBe("written");
      expect(decideDeferrable("off", k, "a", 0)).toBe("written");
      expect(decideDeferrable("shed", k, "a", 0)).toBe("skipped");
      expect(decideDeferrable("warn", k, "x", 0)).toBe("written");
      expect(decideDeferrable("warn", k, "x", COALESCE_MS - 1)).toBe(COALESCED_AT_WARN.has(k) ? "coalesced" : "written");
      expect(decideDeferrable("warn", k, "x", COALESCE_MS)).toBe("written");
      expect(decideDeferrable("warn", k, "y", 1)).toBe("written");
    }
  });

  it("runs the write normally, bookkeeping once per item per 15 minutes at warn, read state every time at warn, nothing at shed", async () => {
    const ok = await makeTestApp();
    let n = 0;
    expect(await deferrableWrite(ok.deps, "item_visit", "u:1", async () => { n++; })).toBe("written");
    expect(await deferrableWrite(ok.deps, "item_visit", "u:1", async () => { n++; })).toBe("written");
    expect(n).toBe(2);
    resetWriteBudgetCache();
    const warn = await makeTestApp(env(), { fetch: analytics(61_000) });
    expect(await deferrableWrite(warn.deps, "item_visit", "u:c", async () => { n++; })).toBe("written");
    expect(await deferrableWrite(warn.deps, "item_visit", "u:c", async () => { n++; })).toBe("coalesced");
    expect(n).toBe(3);
    // Read state a person sees is not coalesced at warn: a second read of a channel still writes.
    expect(await deferrableWrite(warn.deps, "chat_read", "u:c", async () => { n++; })).toBe("written");
    expect(await deferrableWrite(warn.deps, "chat_read", "u:c", async () => { n++; })).toBe("written");
    expect(n).toBe(5);
    resetWriteBudgetCache();
    const shed = await makeTestApp(env(), { fetch: analytics(90_000) });
    expect(await deferrableWrite(shed.deps, "last_used", "key:1", async () => { n++; })).toBe("skipped");
    expect(await deferrableWrite(shed.deps, "chat_read", "u:c", async () => { n++; })).toBe("skipped");
    expect(n).toBe(5);
  });

  it("at shed a chat read marker, a visit and a notification read mark write 0 rows; a task create, a chat message and a doc still write", async () => {
    const ctx = await makeTestApp(env(), { fetch: analytics(90_000) });
    const u = new Client(ctx.app);
    await u.signup("owner@acme.test", "Olive Owner");
    const me = (await u.get("/api/account/me")).body;
    const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
    expect((await writeBudget(ctx.deps)).level).toBe("shed");
    const { createTask } = await import("@/server/services/suite/tasks");
    const { postMessage, markRead } = await import("@/server/services/suite/chat");
    const { recordVisit } = await import("@/server/services/suite/catchup");
    const { markNotificationsRead } = await import("@/server/services/suite/notify");
    const { createDoc } = await import("@/server/services/suite/docs");
    const g = ((await u.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const take = meter(ctx.db);
    const task = await createTask(ctx.deps, actor, { title: "Still saved" });
    expect(take()).toBeGreaterThan(0);
    await postMessage(ctx.deps, actor, g.id, { body: "still sent" });
    expect(take()).toBeGreaterThan(0);
    await createDoc(ctx.deps, actor, { title: "Still written", text: "x" });
    expect(take()).toBeGreaterThan(0);
    expect(await markRead(ctx.deps, actor, g.id)).toEqual({ ok: true });
    expect(take()).toBe(0);
    expect((await recordVisit(ctx.deps, actor, "task", task.id)).ok).toBe(true);
    expect(take()).toBe(0);
    expect((await markNotificationsRead(ctx.deps, actor.orgId, actor.userId)).ok).toBe(true);
    expect(take()).toBe(0);
    // "Mark as caught up" is the person's own action: essential, written even at shed.
    expect((await recordVisit(ctx.deps, actor, "task", task.id, { force: true })).written).toBe(true);
    expect(take()).toBeGreaterThan(0);
    // The API still answers success to the client.
    expect((await u.post(`/api/chat/channels/${g.id}/read`, {})).status).toBe(200);
  });
});

describe("R32 write amplification (migration 0072)", () => {
  it("the seven partial indexes still serve their lookups (EXPLAIN QUERY PLAN)", async () => {
    const ctx = await makeTestApp();
    const c = (ctx.db as unknown as { $client: { prepare: (q: string) => { all: (...a: unknown[]) => { detail: string }[] } } }).$client;
    const plan = (q: string, ...a: unknown[]) => c.prepare(`explain query plan ${q}`).all(...a).map((r) => r.detail).join(" | ");
    expect(plan("select id from tasks where parent_id = ?", "t")).toContain("tasks_parent_idx");
    expect(plan("select id from tasks where parent_id in (?, ?)", "a", "b")).toContain("tasks_parent_idx");
    expect(plan("select id from tasks where org_id = ? and thread_id = ?", "o", "t")).toContain("tasks_org_thread_idx");
    expect(plan("select id from chat_messages where parent_id = ?", "m")).toContain("chat_messages_parent_idx");
    expect(plan("select id from deliveries where provider_message_id = ?", "p")).toContain("deliveries_provider_msg_idx");
    expect(plan("select id from messages where mailbox_id = ? and provider_message_id_header = ?", "b", "h")).toContain("messages_mailbox_provider_msgid_idx");
    expect(plan("select id from contacts where company_id = ?", "c")).toContain("contacts_company_idx");
    // Due dates: every query compares due_at (<, >=, between) or says is not null, which implies the partial WHERE.
    expect(plan("select id from tasks where org_id = ? and due_at < ?", "o", 1)).toContain("tasks_org_due_idx");
    expect(plan("select id from tasks where org_id = ? and due_at >= ? and due_at <= ?", "o", 1, 2)).toContain("tasks_org_due_idx");
    expect(plan("select id from tasks where org_id = ? and due_at is not null and due_at < ? order by due_at", "o", 1)).toContain("tasks_org_due_idx");
    const partial = (c.prepare("select name from sqlite_master where type='index' and sql like '% WHERE %' and name in ('tasks_parent_idx','tasks_org_thread_idx','chat_messages_parent_idx','deliveries_provider_msg_idx','messages_mailbox_provider_msgid_idx','contacts_company_idx','tasks_org_due_idx')").all() as unknown as { name: string }[]);
    expect(partial).toHaveLength(7);
  });

  // Write budget per action, measured with the D1 meter (row plus every full index; partial ones by entry).
  // Before R32 (main 53b8cdb) and after migration 0072. Fails if any of them grows: docs/runbooks/d1-daily-limits.md.
  // Rows written per action, measured with tests/d1-meter.ts on base 53b8cdb (before 0072) and on this branch (after):
  //   task create 17 -> 14 (no due date), task status 7 -> 5, task title 13 -> 11, chat send 12 -> 11, doc create 9 -> 9,
  //   doc save 9 -> 9, mail receive 20 -> 17, mail send (http) 33 -> 32, sign in (http) 10 -> 10, cron pass 3 -> 3.
  // A change that raises any of these fails here; lower the number when a change makes an action cheaper.
  const BUDGET = { taskCreate: 14, taskUpdateStatus: 5, taskUpdateTitle: 11, chatSend: 11, docSave: 9, mailReceive: 17, signIn: 12, cronPass: 3 };
  it("locks the per action write cost", async () => {
    const ctx = await makeTestApp();
    const u = new Client(ctx.app);
    const email = await u.signup("owner@acme.test", "Olive Owner");
    const me = (await u.get("/api/account/me")).body;
    const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
    const projectId = (await u.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
    const { createTask, updateTask } = await import("@/server/services/suite/tasks");
    const { createDoc, updateDoc } = await import("@/server/services/suite/docs");
    const { postMessage } = await import("@/server/services/suite/chat");
    const { deliverInbound } = await import("@/server/services/mail/delivery");
    const { runMaintenance } = await import("@/server/services/maintenance");
    const g = ((await u.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    await createTask(ctx.deps, actor, { title: "Warm", projectId });
    await postMessage(ctx.deps, actor, g.id, { body: "warm" });
    const d = await createDoc(ctx.deps, actor, { title: "Doc", text: "a" });
    const v = new Client(ctx.app);
    await v.signup("ann@help.test", "Ann", "Help");
    const dom = (await v.post("/api/domains", { name: "help.test" })).body.domain.id as string;
    await v.post("/api/mailboxes", { domainId: dom, localPart: "help", displayName: "Help" });
    const mail = () => deliverInbound(ctx.deps, { envelopeFrom: "pat@gmail.com", rcptTo: "help@help.test", sizeBytes: 300, via: "test",
      email: { messageId: `<${Math.random()}@gmail.com>`, from: { address: "pat@gmail.com" }, to: [{ address: "help@help.test" }], cc: [], subject: "Help", text: "Hi", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} } });
    await mail();
    const take = meter(ctx.db);
    const t = await createTask(ctx.deps, actor, { title: "Ship it", projectId });
    expect(take(), "task create").toBeLessThanOrEqual(BUDGET.taskCreate);
    await updateTask(ctx.deps, actor, t.id, { status: "in_progress" } as never);
    expect(take(), "task status").toBeLessThanOrEqual(BUDGET.taskUpdateStatus);
    await updateTask(ctx.deps, actor, t.id, { title: "Ship it now" } as never);
    expect(take(), "task title").toBeLessThanOrEqual(BUDGET.taskUpdateTitle);
    await postMessage(ctx.deps, actor, g.id, { body: "hello" });
    expect(take(), "chat send").toBeLessThanOrEqual(BUDGET.chatSend);
    await updateDoc(ctx.deps, actor, d.id, { text: "hello world" });
    expect(take(), "doc save").toBeLessThanOrEqual(BUDGET.docSave);
    await mail();
    expect(take(), "mail receive").toBeLessThanOrEqual(BUDGET.mailReceive);
    await new Client(ctx.app).login(email);
    expect(take(), "sign in").toBeLessThanOrEqual(BUDGET.signIn);
    await runMaintenance(ctx.deps); take();
    await runMaintenance(ctx.deps);
    expect(take(), "cron pass").toBeLessThanOrEqual(BUDGET.cronPass);
  });
});
