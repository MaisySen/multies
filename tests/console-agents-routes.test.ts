/**
 * OPS1: /api/console/agents routes. Lists page through nextCursor, filter, refuse a bad sort, and never return run
 * content, trigger instructions, approval messages or AI keys. Changes need a reason and agents.manage, write a
 * platform audit row (action, target, workspace, reason) and leave the workspace's own audit entry naming the operator.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { agentRuns, agents, agentTriggers, aiKeys, aiUsageDaily, auditLogs, domains, mailboxes, organizations, platformAuditLogs, sendApprovals } from "@/server/db/schema";
import { LONG_RUNNING_MS } from "@/server/services/console/agents";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const PLANTED = "PLANTED-AGENTS-ROUTES-SENTINEL-7f3c91d2b8e64a05";
const BASE = "/api/console/agents";

async function orgOf(ctx: Ctx, name: string) {
  return (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, name)).get())!.id;
}

/** A customer workspace with one agent member and one task assigned to it. */
async function workspace(ctx: Ctx, email: string, name: string) {
  const { c } = await signUpAs(ctx, email, null, name);
  const orgId = await orgOf(ctx, name);
  const projectId = (await c.post("/api/projects", { name: "Build", key: "MB" })).body.project.id as string;
  const agentUserId = (await c.post("/api/team/agents", { name: `${name} Bot` })).body.member.userId as string;
  const taskId = (await c.post("/api/tasks", { title: "Triage", projectId, assignee: `member:${agentUserId}` })).body.task.id as string;
  return { c, orgId, projectId, agentUserId, taskId };
}

/** Every page of a list through nextCursor; returns the items in order. */
async function walk(c: Client, path: string) {
  const out: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await c.get(`${path}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    out.push(...r.body.items);
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return out;
}

describe("agents console lists", () => {
  let ctx: Ctx;
  let readonly: Client;
  let alpha: Awaited<ReturnType<typeof workspace>>;
  let beta: Awaited<ReturnType<typeof workspace>>;
  const now = Date.now();

  beforeAll(async () => {
    ctx = await makeTestApp();
    readonly = (await signUpAs(ctx, "rory@ops.test", "ops_readonly")).c;
    alpha = await workspace(ctx, "owner@alpha.test", "Alpha");
    beta = await workspace(ctx, "owner@beta.test", "Beta");

    const run = (id: string, w: typeof alpha, status: "queued" | "running" | "succeeded" | "failed", createdAgo: number, extra: Partial<typeof agentRuns.$inferInsert> = {}) => ({
      id, orgId: w.orgId, taskId: w.taskId, agentUserId: w.agentUserId, status, createdAt: new Date(now - createdAgo), updatedAt: new Date(now - createdAgo),
      result: `${PLANTED} result`, steps: JSON.stringify([{ at: "x", kind: "note", text: PLANTED }]), input: JSON.stringify({ instructions: PLANTED }), ...extra,
    });
    const rows: (typeof agentRuns.$inferInsert)[] = [];
    for (let i = 0; i < 5; i++) rows.push(run(`run_a_failed_${i}`, alpha, "failed", (i + 1) * HOUR));
    rows.push(run("run_b_failed", beta, "failed", 2 * HOUR));
    rows.push(run("run_a_ok", alpha, "succeeded", 3 * HOUR));
    rows.push(run("run_a_long", alpha, "running", 4 * HOUR, { startedAt: new Date(now - LONG_RUNNING_MS - 5 * MIN) }));
    rows.push(run("run_a_old", alpha, "failed", 20 * DAY));
    for (const r of rows) await ctx.db.insert(agentRuns).values(r);

    const sched = await alpha.c.post("/api/agent-triggers", { agentUserId: alpha.agentUserId, kind: "schedule", name: "Hourly sweep", taskId: alpha.taskId, everyHours: 1, instructions: PLANTED });
    expect(sched.status).toBe(201);
    const hook = await beta.c.post("/api/agent-triggers", { agentUserId: beta.agentUserId, kind: "webhook", name: "Alert hook", projectId: beta.projectId, titleTemplate: "Alert", instructions: PLANTED });
    expect(hook.status).toBe(201);
    await ctx.db.update(agentTriggers).set({ enabled: false }).where(eq(agentTriggers.id, hook.body.trigger.id));

    await ctx.db.insert(domains).values({ id: "dom_alpha_r", orgId: alpha.orgId, name: "alpha.test", verificationToken: "v", dkimSelector: "s", dkimPublicKey: "p", dkimPrivateKeyEnc: "e" });
    await ctx.db.insert(mailboxes).values({ id: "mbx_agent_r", orgId: alpha.orgId, domainId: "dom_alpha_r", localPart: "bot", address: "bot@alpha.test", displayName: "Bot", quotaMb: 100, kind: "agent" });
    await ctx.db.insert(agents).values({ id: "agt_alpha_r", orgId: alpha.orgId, mailboxId: "mbx_agent_r", name: "Alpha Mailer" });
    const payload = JSON.stringify({ to: ["recipient@example.com"], subject: PLANTED, text: PLANTED });
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert(sendApprovals).values({ id: `apr_r_${i}`, orgId: alpha.orgId, agentId: "agt_alpha_r", mailboxId: "mbx_agent_r", payload, status: "pending", createdAt: new Date(now - (i + 1) * HOUR), expiresAt: new Date(now + (i - 1) * HOUR) });
    }

    const day = (ago: number) => new Date(now - ago * DAY).toISOString().slice(0, 10);
    await ctx.db.insert(aiUsageDaily).values([
      { day: day(0), orgId: alpha.orgId, units: 300, calls: 3 },
      { day: day(1), orgId: beta.orgId, units: 100, calls: 30 },
      { day: day(20), orgId: beta.orgId, units: 5000, calls: 1 },
      { day: day(0), orgId: "*", units: 400, calls: 33 },
    ]);
    await ctx.db.insert(aiKeys).values([
      { orgId: alpha.orgId, provider: "openai", model: "gpt-x", keyEnc: `enc-${PLANTED}`, keyHint: "hint-7f3c", problem: "key_refused", problemAt: new Date(now - HOUR), updatedAt: new Date(now - DAY) },
      { orgId: beta.orgId, provider: "anthropic", model: "claude-x", keyEnc: `enc-${PLANTED}`, keyHint: "hint-7f3c", problem: "no_credit", problemAt: new Date(now - 2 * HOUR), updatedAt: new Date(now - DAY) },
    ]);
  }, 120_000);

  it("runs: defaults to failed and long-running in 7 days, pages through nextCursor, never shows run content", async () => {
    const first = await readonly.get(`${BASE}/runs?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(typeof first.body.nextCursor).toBe("string");
    const all = await walk(readonly, `${BASE}/runs?limit=2`);
    const ids = all.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(["run_a_failed_0", "run_a_failed_1", "run_a_failed_2", "run_a_failed_3", "run_a_failed_4", "run_a_long", "run_b_failed"]);
    expect(all.find((r) => r.id === "run_a_long")).toMatchObject({ workspaceName: "Alpha", agentName: "Alpha Bot", longRunning: true, status: "running" });
    expect(JSON.stringify(all)).not.toContain(PLANTED);
    expect(all.some((r) => "steps" in r || "result" in r || "input" in r)).toBe(false);
  }, 60_000);

  it("runs: filters by status, window, workspace and search", async () => {
    const ids = async (q: string) => ((await readonly.get(`${BASE}/runs?${q}`)).body.items as { id: string }[]).map((r) => r.id).sort();
    expect(await ids("status=succeeded")).toEqual(["run_a_ok"]);
    expect(await ids("status=long_running")).toEqual(["run_a_long"]);
    expect(await ids("status=any")).toHaveLength(8);
    expect(await ids("status=failed&days=30")).toContain("run_a_old");
    expect(await ids(`orgId=${beta.orgId}`)).toEqual(["run_b_failed"]);
    expect(await ids("q=beta")).toEqual(["run_b_failed"]);
    expect((await readonly.get(`${BASE}/runs?status=bogus`)).status).toBe(422);
    expect((await readonly.get(`${BASE}/runs?days=500`)).status).toBe(422);
  }, 60_000);

  it("refuses a sort outside the whitelist and a broken cursor", async () => {
    for (const path of ["runs?sort=result:desc", "triggers?sort=instructions:asc", "approvals?sort=payload:asc", "ai-usage?sort=orgId:desc", "ai-key-problems?sort=keyEnc:desc", "runs?sort=createdAt:sideways"]) {
      const r = await readonly.get(`${BASE}/${path}`);
      expect(r.status, path).toBe(422);
      expect(r.body.error.code, path).toBe("invalid_sort");
    }
    const bad = await readonly.get(`${BASE}/runs?cursor=not-a-cursor`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("bad_cursor");
  }, 60_000);

  it("triggers: enabled and kind filters, fire count sort, no instructions", async () => {
    const all = await readonly.get(`${BASE}/triggers`);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);
    expect(JSON.stringify(all.body)).not.toContain(PLANTED);
    const paused = await readonly.get(`${BASE}/triggers?enabled=false`);
    expect(paused.body.items.map((t: { name: string }) => t.name)).toEqual(["Alert hook"]);
    expect(paused.body.items[0]).toMatchObject({ workspaceName: "Beta", kind: "webhook", enabled: false });
    const on = await readonly.get(`${BASE}/triggers?enabled=true&kind=schedule`);
    expect(on.body.items.map((t: { name: string }) => t.name)).toEqual(["Hourly sweep"]);
    expect(on.body.items[0].nextRunAt).toBeTruthy();
    expect((await readonly.get(`${BASE}/triggers?q=sweep`)).body.items).toHaveLength(1);
    expect((await readonly.get(`${BASE}/triggers?sort=fireCount:desc`)).status).toBe(200);
    const pages = await walk(readonly, `${BASE}/triggers?limit=1`);
    expect(pages).toHaveLength(2);
    expect((await readonly.get(`${BASE}/triggers?kind=email`)).status).toBe(422);
  }, 60_000);

  it("approvals: oldest first with age and overdue, pages, never the message", async () => {
    const r = await readonly.get(`${BASE}/approvals`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((a: { id: string }) => a.id)).toEqual(["apr_r_2", "apr_r_1", "apr_r_0"]);
    expect(r.body.items[2]).toMatchObject({ workspaceName: "Alpha", agentName: "Alpha Mailer", overdue: true });
    expect(r.body.items[0].overdue).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain(PLANTED);
    expect(JSON.stringify(r.body)).not.toContain("recipient@example.com");
    expect((await walk(readonly, `${BASE}/approvals?limit=1`)).map((a) => a.id)).toEqual(["apr_r_2", "apr_r_1", "apr_r_0"]);
    expect((await readonly.get(`${BASE}/approvals?orgId=${beta.orgId}`)).body.items).toEqual([]);
  }, 60_000);

  it("ai usage: top workspaces for 7 or 30 days with the account total", async () => {
    const week = await readonly.get(`${BASE}/ai-usage`);
    expect(week.status).toBe(200);
    expect(week.body.items.map((w: { workspaceName: string }) => w.workspaceName)).toEqual(["Alpha", "Beta"]);
    expect(week.body.account).toEqual({ units: 400, calls: 33 });
    expect(week.body.window.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const byCalls = await readonly.get(`${BASE}/ai-usage?sort=calls:desc`);
    expect(byCalls.body.items[0].workspaceName).toBe("Beta");
    const month = await readonly.get(`${BASE}/ai-usage?days=30`);
    expect(month.body.items[0]).toMatchObject({ workspaceName: "Beta", units: 5100 });
    expect((await walk(readonly, `${BASE}/ai-usage?limit=1`)).map((w) => w.workspaceName)).toEqual(["Alpha", "Beta"]);
    expect((await readonly.get(`${BASE}/ai-usage?days=14`)).status).toBe(422);
  }, 60_000);

  it("ai key problems: newest first, filter by problem, never the key or its hint", async () => {
    const r = await readonly.get(`${BASE}/ai-key-problems`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((k: { workspaceName: string; problem: string }) => [k.workspaceName, k.problem])).toEqual([["Alpha", "key_refused"], ["Beta", "no_credit"]]);
    expect(JSON.stringify(r.body)).not.toContain(PLANTED);
    expect(JSON.stringify(r.body)).not.toContain("hint-7f3c");
    expect((await readonly.get(`${BASE}/ai-key-problems?problem=no_credit`)).body.items.map((k: { orgId: string }) => k.orgId)).toEqual([beta.orgId]);
    expect((await walk(readonly, `${BASE}/ai-key-problems?limit=1`))).toHaveLength(2);
    expect((await readonly.get(`${BASE}/ai-key-problems?problem=bad`)).status).toBe(422);
  }, 60_000);

  it("lists are for operators only", async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get(`${BASE}/runs`)).status).toBe(401);
    expect((await alpha.c.get(`${BASE}/runs`)).status).toBe(403);
    expect((await alpha.c.get(`${BASE}/ai-usage`)).status).toBe(403);
  }, 60_000);
});

describe("agents console changes", () => {
  let ctx: Ctx;
  let admin: Client;
  let support: Client;
  let w: Awaited<ReturnType<typeof workspace>>;

  beforeAll(async () => {
    ctx = await makeTestApp();
    admin = (await signUpAs(ctx, "ada@ops.test", "ops_admin")).c;
    support = (await signUpAs(ctx, "sam@ops.test", "ops_support")).c;
    w = await workspace(ctx, "owner@gamma.test", "Gamma");
  }, 120_000);

  it("cancel a run: reason required, support refused, ops_admin cancels and both audit logs record it", async () => {
    const run = (await w.c.post(`/api/tasks/${w.taskId}/runs`, { agentUserId: w.agentUserId })).body.run as { id: string; status: string };
    expect(run.status).toBe("queued");
    const path = `${BASE}/runs/${run.id}/cancel`;

    const noReason = await admin.post(path, {});
    expect(noReason.status).toBe(422);
    expect((await admin.post(path, { reason: "x" })).status).toBe(422);
    expect((await support.post(path, { reason: "Stuck for hours" })).status).toBe(403);
    expect((await w.c.post(path, { reason: "Stuck for hours" })).status).toBe(403);
    expect((await new Client(ctx.app).post(path, { reason: "Stuck for hours" })).status).toBe(401);
    expect((await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get())?.status).toBe("queued");
    expect(await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "agent_run.cancelled"))).toHaveLength(0);

    const ok = await admin.post(path, { reason: "Stuck for hours" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, id: run.id, status: "cancelled", previousStatus: "queued" });
    expect((await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get())?.status).toBe("cancelled");

    const rows = await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "agent_run.cancelled"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorEmail: "ada@ops.test", actorRole: "ops_admin", targetType: "agent_run", targetId: run.id, orgId: w.orgId, reason: "Stuck for hours" });
    expect(JSON.parse(rows[0].before!)).toEqual({ status: "queued" });
    expect(JSON.parse(rows[0].after!)).toEqual({ status: "cancelled" });
    const ws = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, w.orgId), eq(auditLogs.action, "agent_run.cancelled")));
    expect(ws).toHaveLength(1);
    expect(ws[0].actorEmail).toBe("ada@ops.test");

    // A finished run cannot be cancelled; an unknown or malformed id is 404.
    await ctx.db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, run.id));
    expect((await admin.post(path, { reason: "Again please" })).status).toBe(409);
    expect((await admin.post(`${BASE}/runs/run_nope/cancel`, { reason: "Stuck for hours" })).status).toBe(404);
    expect((await admin.post(`${BASE}/runs/${encodeURIComponent("bad id!")}/cancel`, { reason: "Stuck for hours" })).status).toBe(404);
  }, 60_000);

  it("pause and resume a trigger: reason required, support refused, audited with before and after", async () => {
    const made = await w.c.post("/api/agent-triggers", { agentUserId: w.agentUserId, kind: "schedule", name: "Nightly", taskId: w.taskId, everyHours: 24, instructions: PLANTED });
    expect(made.status).toBe(201);
    const id = made.body.trigger.id as string;

    expect((await admin.post(`${BASE}/triggers/${id}/pause`, {})).status).toBe(422);
    expect((await support.post(`${BASE}/triggers/${id}/pause`, { reason: "Runaway schedule" })).status).toBe(403);
    expect((await w.c.post(`${BASE}/triggers/${id}/pause`, { reason: "Runaway schedule" })).status).toBe(403);

    const paused = await admin.post(`${BASE}/triggers/${id}/pause`, { reason: "Runaway schedule" });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body).toMatchObject({ ok: true, enabled: false, changed: true, nextRunAt: null });
    expect((await ctx.db.select().from(agentTriggers).where(eq(agentTriggers.id, id)).get())?.enabled).toBe(false);
    const p = await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "agent_trigger.paused"));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ actorEmail: "ada@ops.test", targetType: "agent_trigger", targetId: id, orgId: w.orgId, reason: "Runaway schedule" });
    expect(JSON.parse(p[0].before!)).toEqual({ enabled: true });
    expect(JSON.stringify(p[0])).not.toContain(PLANTED);

    const resumed = await admin.post(`${BASE}/triggers/${id}/resume`, { reason: "Owner fixed it" });
    expect(resumed.status).toBe(200);
    expect(resumed.body.enabled).toBe(true);
    expect(resumed.body.nextRunAt).toBeTruthy();
    const r = await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "agent_trigger.resumed"));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ targetId: id, orgId: w.orgId, reason: "Owner fixed it" });
    const ws = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, w.orgId), eq(auditLogs.action, "agent_trigger.updated")));
    expect(ws.map((x) => x.actorEmail)).toEqual(["ada@ops.test", "ada@ops.test"]);

    expect((await admin.post(`${BASE}/triggers/trg_nope/resume`, { reason: "Owner fixed it" })).status).toBe(404);
  }, 60_000);
});
