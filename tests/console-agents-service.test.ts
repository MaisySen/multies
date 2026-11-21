import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { agentRuns, agents, aiKeys, aiUsageDaily, auditLogs, domains, mailboxes, organizations, sendApprovals, users } from "@/server/db/schema";
import { HttpError } from "@/server/lib/errors";
import {
  aiUsageTopWorkspaces, cancelAgentRun, listAgentRuns, listAgentTriggers, listAiKeyProblems, listPendingSendApprovals, setAgentTriggerPaused,
  AGENT_RUN_SORT_FIELDS, LONG_RUNNING_MS, type ConsoleOperator,
} from "@/server/services/console/agents";
import type { ConsoleCursor, ConsolePage, ConsolePageResult } from "@/server/services/console/jobs";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const PLANTED = "PLANTED-SECRET-zq9";

const page = <F extends string>(field: F, dir: "asc" | "desc" = "desc", limit = 50, cursor: ConsoleCursor | null = null): ConsolePage<F> => ({ limit, cursor, sort: { field, dir } });

/** Walks every page and returns the ids in order. */
async function walk<T>(fetch: (cursor: ConsoleCursor | null) => Promise<ConsolePageResult<T>>, id: (t: T) => string) {
  const out: string[] = [];
  let cursor: ConsoleCursor | null = null;
  for (let i = 0; i < 100; i++) {
    const r = await fetch(cursor);
    out.push(...r.items.map(id));
    if (!r.next) break;
    cursor = r.next;
  }
  return out;
}

async function orgOf(ctx: Ctx, name: string) {
  return (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, name)).get())!.id;
}

async function setupWorkspace(ctx: Ctx, email: string, orgName: string) {
  const c = new Client(ctx.app);
  await c.signup(email, "Owner", orgName);
  const orgId = await orgOf(ctx, orgName);
  const projectId = (await c.post("/api/projects", { name: "Build", key: "MB" })).body.project.id as string;
  const made = (await c.post("/api/team/agents", { name: `${orgName} Bot` })).body;
  const agentUserId = made.member.userId as string;
  const taskId = (await c.post("/api/tasks", { title: "Triage", projectId, assignee: `member:${agentUserId}` })).body.task.id as string;
  return { c, orgId, projectId, agentUserId, taskId };
}

async function operator(ctx: Ctx): Promise<ConsoleOperator> {
  const c = new Client(ctx.app);
  await c.signup("ops@multies.test", "Opal Operator", "Ops");
  const u = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, "ops@multies.test")).get())!;
  return { userId: u.id, email: "ops@multies.test", name: "Opal Operator" };
}

async function expectHttp(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    if (code) expect((e as HttpError).code).toBe(code);
    return;
  }
  throw new Error(`expected HTTP ${status}`);
}

describe("listAgentRuns", () => {
  let ctx: Ctx;
  let a: Awaited<ReturnType<typeof setupWorkspace>>;
  let b: Awaited<ReturnType<typeof setupWorkspace>>;
  const now = Date.now();
  beforeAll(async () => {
    ctx = await makeTestApp();
    a = await setupWorkspace(ctx, "owner@alpha.test", "Alpha");
    b = await setupWorkspace(ctx, "owner@beta.test", "Beta");
    const row = (id: string, w: typeof a, status: "queued" | "running" | "succeeded" | "failed" | "cancelled", createdAgo: number, extra: Partial<typeof agentRuns.$inferInsert> = {}) => ({
      id, orgId: w.orgId, taskId: w.taskId, agentUserId: w.agentUserId, status, createdAt: new Date(now - createdAgo), updatedAt: new Date(now - createdAgo),
      result: `${PLANTED} result`, steps: JSON.stringify([{ at: "x", kind: "note", text: PLANTED }]), input: JSON.stringify({ instructions: PLANTED }), ...extra,
    });
    // Failed runs in both workspaces, 12 in Alpha with some sharing a created_at (tie-break on id).
    const rows: (typeof agentRuns.$inferInsert)[] = [];
    for (let i = 0; i < 12; i++) rows.push(row(`run_a_failed_${String(i).padStart(2, "0")}`, a, "failed", (i % 4) * HOUR + HOUR, { startedAt: new Date(now - 2 * DAY), finishedAt: new Date(now - DAY) }));
    rows.push(row("run_b_failed_00", b, "failed", 2 * HOUR));
    rows.push(row("run_a_ok", a, "succeeded", 3 * HOUR));
    rows.push(row("run_a_old_failed", a, "failed", 10 * DAY));
    rows.push(row("run_a_long", a, "running", 2 * HOUR, { startedAt: new Date(now - LONG_RUNNING_MS - 5 * MIN) }));
    for (const r of rows) await ctx.db.insert(agentRuns).values(r);
  });

  it("defaults to failed and long-running runs inside 7 days, across workspaces, with workspace names and no content", async () => {
    const r = await listAgentRuns(ctx.deps, {}, page("createdAt"));
    const ids = r.items.map((x) => x.id);
    expect(ids).toContain("run_b_failed_00");
    expect(ids).toContain("run_a_long");
    expect(ids).not.toContain("run_a_ok");
    expect(ids).not.toContain("run_a_old_failed");
    expect(ids).toHaveLength(14);
    const long = r.items.find((x) => x.id === "run_a_long")!;
    expect(long).toMatchObject({ orgId: a.orgId, workspaceName: "Alpha", status: "running", longRunning: true, agentName: "Alpha Bot" });
    expect(long.durationMs).toBeGreaterThan(LONG_RUNNING_MS);
    expect(r.items.find((x) => x.id === "run_b_failed_00")!.workspaceName).toBe("Beta");
    expect(JSON.stringify(r)).not.toContain(PLANTED);
  });

  it("filters by status, workspace and window", async () => {
    expect((await listAgentRuns(ctx.deps, { status: "succeeded" }, page("createdAt"))).items.map((x) => x.id)).toEqual(["run_a_ok"]);
    expect((await listAgentRuns(ctx.deps, { status: "long_running" }, page("createdAt"))).items.map((x) => x.id)).toEqual(["run_a_long"]);
    expect((await listAgentRuns(ctx.deps, { orgId: b.orgId }, page("createdAt"))).items.map((x) => x.id)).toEqual(["run_b_failed_00"]);
    const wide = await listAgentRuns(ctx.deps, { status: "failed", days: 30 }, page("createdAt"));
    expect(wide.items.map((x) => x.id)).toContain("run_a_old_failed");
    await expectHttp(listAgentRuns(ctx.deps, { status: "bogus" as never }, page("createdAt")), 422);
  });

  it("pages without duplicates or gaps in both directions", async () => {
    const all = (await listAgentRuns(ctx.deps, {}, page("createdAt", "desc", 200))).items.map((x) => x.id);
    for (const dir of ["desc", "asc"] as const) {
      const ids = await walk((cursor) => listAgentRuns(ctx.deps, {}, page("createdAt", dir, 3, cursor)), (x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual([...all].sort());
      if (dir === "asc") expect(ids).toEqual([...all].reverse());
    }
  });

  it("rejects a sort field outside the whitelist", async () => {
    expect(AGENT_RUN_SORT_FIELDS).toContain("createdAt");
    await expectHttp(listAgentRuns(ctx.deps, {}, page("result" as never)), 422, "invalid_sort");
    await expectHttp(listAgentRuns(ctx.deps, {}, page("createdAt", "sideways" as never)), 422, "invalid_sort");
    await expectHttp(listAgentRuns(ctx.deps, {}, page("createdAt", "desc", 5, { v: "not a number", id: "x" })), 400, "bad_cursor");
  });
});

describe("agent mutations reuse the workspace services", () => {
  let ctx: Ctx;
  let a: Awaited<ReturnType<typeof setupWorkspace>>;
  let op: ConsoleOperator;
  beforeEach(async () => {
    ctx = await makeTestApp();
    a = await setupWorkspace(ctx, "owner@alpha.test", "Alpha");
    op = await operator(ctx);
  });

  it("cancelAgentRun cancels a queued run, audits it in the workspace under the operator, and refuses a finished run", async () => {
    const run = (await a.c.post(`/api/tasks/${a.taskId}/runs`, { agentUserId: a.agentUserId })).body.run as { id: string; status: string };
    expect(run.status).toBe("queued");
    const r = await cancelAgentRun(ctx.deps, op, run.id, "Stuck for hours");
    expect(r).toEqual({ id: run.id, orgId: a.orgId, previousStatus: "queued", status: "cancelled" });
    const row = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get();
    expect(row?.status).toBe("cancelled");
    const logged = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "agent_run.cancelled"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ orgId: a.orgId, actorEmail: "ops@multies.test" });
    // Cancelling again answers unchanged, no second entry.
    expect((await cancelAgentRun(ctx.deps, op, run.id)).status).toBe("cancelled");
    expect(await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "agent_run.cancelled"))).toHaveLength(1);
    // A finished run is refused.
    await ctx.db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, run.id));
    await expectHttp(cancelAgentRun(ctx.deps, op, run.id), 409, "run_finished");
    await expectHttp(cancelAgentRun(ctx.deps, op, "run_nope"), 404);
  });

  it("setAgentTriggerPaused pauses and resumes a schedule, lists it by enabled and workspace, and never returns instructions", async () => {
    const t = (await a.c.post("/api/agent-triggers", { agentUserId: a.agentUserId, kind: "schedule", name: "Hourly", taskId: a.taskId, everyHours: 1, instructions: PLANTED })).body.trigger as { id: string; nextRunAt: string };
    expect(t.nextRunAt).toBeTruthy();
    const wh = await a.c.post("/api/agent-triggers", { agentUserId: a.agentUserId, kind: "webhook", name: "Hook", projectId: a.projectId, titleTemplate: "Alert", instructions: PLANTED });
    expect(wh.status).toBe(201);
    const paused = await setAgentTriggerPaused(ctx.deps, op, t.id, true);
    expect(paused).toMatchObject({ id: t.id, orgId: a.orgId, enabled: false, changed: true, nextRunAt: null });
    const off = await listAgentTriggers(ctx.deps, { enabled: false }, page("createdAt"));
    expect(off.items.map((x) => x.id)).toEqual([t.id]);
    expect(off.items[0]).toMatchObject({ workspaceName: "Alpha", kind: "schedule", agentName: "Alpha Bot", nextRunAt: null });
    const all = await listAgentTriggers(ctx.deps, { orgId: a.orgId }, page("createdAt", "asc"));
    expect(all.items).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain(PLANTED);
    expect(JSON.stringify(all)).not.toContain("secret");
    expect((await listAgentTriggers(ctx.deps, { orgId: "org_nope" }, page("createdAt"))).items).toEqual([]);
    const resumed = await setAgentTriggerPaused(ctx.deps, op, t.id, false);
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextRunAt).toBeTruthy();
    expect((await setAgentTriggerPaused(ctx.deps, op, t.id, false)).changed).toBe(false);
    const updates = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "agent_trigger.updated"));
    expect(updates.map((u) => u.actorEmail)).toEqual(["ops@multies.test", "ops@multies.test"]);
    await expectHttp(setAgentTriggerPaused(ctx.deps, op, "trg_nope", true), 404);
    await expectHttp(listAgentTriggers(ctx.deps, {}, page("instructions" as never)), 422, "invalid_sort");
  });
});

describe("approvals backlog, AI usage and AI key problems", () => {
  let ctx: Ctx;
  let alpha: string;
  let beta: string;
  const now = Date.now();
  beforeAll(async () => {
    ctx = await makeTestApp();
    for (const [email, name] of [["owner@alpha.test", "Alpha"], ["owner@beta.test", "Beta"], ["owner@gamma.test", "Gamma"]] as const) {
      await new Client(ctx.app).signup(email, "Owner", name);
    }
    alpha = await orgOf(ctx, "Alpha");
    beta = await orgOf(ctx, "Beta");
    const gamma = await orgOf(ctx, "Gamma");
    // A mail agent in Alpha (domain, agent mailbox, agent), with approvals waiting.
    await ctx.db.insert(domains).values({ id: "dom_alpha", orgId: alpha, name: "alpha.test", verificationToken: "v", dkimSelector: "s", dkimPublicKey: "p", dkimPrivateKeyEnc: "e" });
    await ctx.db.insert(mailboxes).values({ id: "mbx_agent", orgId: alpha, domainId: "dom_alpha", localPart: "bot", address: "bot@alpha.test", displayName: "Bot", quotaMb: 100, kind: "agent" });
    await ctx.db.insert(agents).values({ id: "agt_alpha", orgId: alpha, mailboxId: "mbx_agent", name: "Alpha Mailer" });
    const payload = JSON.stringify({ to: ["victim@example.com"], subject: PLANTED, text: PLANTED, html: `<p>${PLANTED}</p>` });
    const approvals: (typeof sendApprovals.$inferInsert)[] = [];
    for (let i = 0; i < 7; i++) {
      approvals.push({ id: `apr_${i}`, orgId: alpha, agentId: "agt_alpha", mailboxId: "mbx_agent", payload, status: "pending", createdAt: new Date(now - (i + 1) * HOUR), expiresAt: new Date(now + (i - 2) * HOUR) });
    }
    approvals.push({ id: "apr_sent", orgId: alpha, agentId: "agt_alpha", mailboxId: "mbx_agent", payload, status: "sent", createdAt: new Date(now - HOUR), expiresAt: new Date(now + DAY) });
    for (const r of approvals) await ctx.db.insert(sendApprovals).values(r);
    // AI usage: Gamma heaviest, Beta tied on units with Alpha but more calls; an old day and the account row.
    const day = (ago: number) => new Date(now - ago * DAY).toISOString().slice(0, 10);
    await ctx.db.insert(aiUsageDaily).values([
      { day: day(0), orgId: alpha, units: 50, calls: 5 }, { day: day(1), orgId: alpha, units: 50, calls: 5 },
      { day: day(0), orgId: beta, units: 100, calls: 20 },
      { day: day(2), orgId: gamma, units: 500, calls: 9 },
      { day: day(20), orgId: beta, units: 9999, calls: 1 },
      { day: day(0), orgId: "*", units: 700, calls: 39 },
    ]);
    // AI keys: two refused, one fine. The key and its hint must never come back.
    const key = (orgId: string, problem: "key_refused" | "no_credit" | null, at: number | null) => ({
      orgId, provider: "openai" as const, model: "gpt-x", keyEnc: `enc-${PLANTED}`, keyHint: "Zq9!", problem, problemAt: at === null ? null : new Date(at), updatedAt: new Date(now - DAY),
    });
    await ctx.db.insert(aiKeys).values([key(alpha, "key_refused", now - HOUR), key(beta, "no_credit", now - 2 * HOUR), key(gamma, null, null)]);
  });

  it("lists pending approvals with age, oldest first, without the message", async () => {
    const r = await listPendingSendApprovals(ctx.deps, {}, page("createdAt", "asc"));
    expect(r.items.map((x) => x.id)).toEqual(["apr_6", "apr_5", "apr_4", "apr_3", "apr_2", "apr_1", "apr_0"]);
    expect(r.items[0]).toMatchObject({ orgId: alpha, workspaceName: "Alpha", agentName: "Alpha Mailer", mailboxId: "mbx_agent", overdue: false });
    expect(r.items[6].overdue).toBe(true);
    expect(r.items[0].ageMs).toBeGreaterThanOrEqual(7 * HOUR - 1000);
    const text = JSON.stringify(r);
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain("victim@example.com");
    const ids = await walk((cursor) => listPendingSendApprovals(ctx.deps, {}, page("expiresAt", "desc", 2, cursor)), (x) => x.id);
    expect(ids).toEqual(["apr_6", "apr_5", "apr_4", "apr_3", "apr_2", "apr_1", "apr_0"]);
    expect((await listPendingSendApprovals(ctx.deps, { orgId: beta }, page("createdAt"))).items).toEqual([]);
    await expectHttp(listPendingSendApprovals(ctx.deps, {}, page("payload" as never)), 422, "invalid_sort");
  });

  it("ranks workspaces by AI use in the window, pages on the aggregate, and reports the account total", async () => {
    const r = await aiUsageTopWorkspaces(ctx.deps, { days: 7 }, page("units"));
    expect(r.items).toHaveLength(3);
    // Alpha and Beta tie on units: the tie breaks on the workspace id, in the sort's direction.
    expect(r.items.slice(1).map((x) => x.orgId)).toEqual([alpha, beta].sort().reverse());
    expect(r.items[0]).toMatchObject({ workspaceName: "Gamma", units: 500, calls: 9, days: 1 });
    expect(r.items.slice(1).map((x) => x.units)).toEqual([100, 100]);
    expect(r.items.find((x) => x.orgId === alpha)).toMatchObject({ units: 100, calls: 10, days: 2 });
    expect(r.items.some((x) => x.orgId === "*")).toBe(false);
    expect(r.account).toEqual({ units: 700, calls: 39 });
    const byCalls = await aiUsageTopWorkspaces(ctx.deps, { days: 7 }, page("calls"));
    expect(byCalls.items.map((x) => x.workspaceName)).toEqual(["Beta", "Alpha", "Gamma"]);
    const ids = await walk((cursor) => aiUsageTopWorkspaces(ctx.deps, { days: 7 }, page("units", "desc", 1, cursor)), (x) => x.orgId);
    expect(ids).toEqual(r.items.map((x) => x.orgId));
    const month = await aiUsageTopWorkspaces(ctx.deps, { days: 30 }, page("units"));
    expect(month.items[0]).toMatchObject({ orgId: beta, units: 10099 });
    await expectHttp(aiUsageTopWorkspaces(ctx.deps, {}, page("orgId" as never)), 422, "invalid_sort");
  });

  it("lists AI keys the provider refused, never the key", async () => {
    const r = await listAiKeyProblems(ctx.deps, {}, page("problemAt"));
    expect(r.items.map((x) => [x.workspaceName, x.problem])).toEqual([["Alpha", "key_refused"], ["Beta", "no_credit"]]);
    expect(r.items[0]).toMatchObject({ orgId: alpha, provider: "openai", model: "gpt-x" });
    const text = JSON.stringify(r);
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain("Zq9!");
    expect((await listAiKeyProblems(ctx.deps, { problem: "no_credit" }, page("problemAt"))).items.map((x) => x.orgId)).toEqual([beta]);
    const ids = await walk((cursor) => listAiKeyProblems(ctx.deps, {}, page("problemAt", "asc", 1, cursor)), (x) => x.orgId);
    expect(ids).toEqual([beta, alpha]);
    await expectHttp(listAiKeyProblems(ctx.deps, {}, page("keyEnc" as never)), 422, "invalid_sort");
  });
});
