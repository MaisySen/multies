/**
 * OPS1 (migration 0177): the console's cross-workspace lists read an index, or a bounded rowid range, never a full
 * scan of a busy table. Busy tables only have PARTIAL indexes (D1 bills each index entry as a row written), which
 * SQLite uses only when the query repeats the index's condition. The statements are the ones the services really
 * send: each call is recorded at the SQLite client and then explained with the same parameters.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { deliveryFailureRateByWorkspace, listDeliveries } from "@/server/services/console/mail";
import { listAgentRuns, listPendingSendApprovals } from "@/server/services/console/agents";
import { listOAuthClients, listOAuthGrants, listWebhookDeliveries } from "@/server/services/console/developer";
import { systemSnapshot } from "@/server/services/console/system";

type Stmt = Record<string, (...a: unknown[]) => unknown>;
type Raw = { prepare: (q: string) => Stmt };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;

beforeAll(async () => { ctx = await makeTestApp(); }, 120_000);

/** Runs `fn` and returns every statement it sent to SQLite whose main table is `table`, with its parameters. */
async function recorded(table: string, fn: () => Promise<unknown>): Promise<{ sql: string; params: unknown[] }[]> {
  const client = (ctx.db as unknown as { $client: Raw }).$client;
  const prepare = client.prepare;
  const seen: { sql: string; params: unknown[] }[] = [];
  client.prepare = (q: string) => {
    const st = prepare.call(client, q);
    if (!new RegExp(`^select .*? from ["\`]${table}["\`]`, "is").test(q)) return st;
    for (const m of ["all", "get", "run", "values", "raw"]) {
      const orig = st[m];
      if (typeof orig !== "function") continue;
      st[m] = (...a: unknown[]) => { if (m !== "raw") seen.push({ sql: q, params: a }); return orig.apply(st, a); };
    }
    return st;
  };
  try { await fn(); } finally { client.prepare = prepare; }
  return seen;
}

function plan(q: { sql: string; params: unknown[] }): string {
  const client = (ctx.db as unknown as { $client: Raw }).$client;
  const out = (client.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as { detail: string }[]).map((r) => r.detail).join(" | ");
  if (process.env.SHOW_PLANS) console.log(`${q.sql}\n  => ${out}`);
  return out;
}

/** The plan of the first statement `fn` sends whose main table is `table`. */
async function planOf(table: string, fn: () => Promise<unknown>): Promise<string> {
  const qs = await recorded(table, fn);
  expect(qs.length).toBeGreaterThan(0);
  return plan(qs[0]);
}

/** No full scan of the table (a SCAN through an index, or a rowid range, is fine). */
const noScan = (p: string, table: string) => expect(p).not.toMatch(new RegExp(`SCAN ${table}(?! USING)`));
const ROWID_RANGE = (table: string) => new RegExp(`SEARCH ${table} USING INTEGER PRIMARY KEY \\(rowid>\\?\\)`);

const page = { limit: 50, cursor: null, sort: { field: "createdAt", dir: "desc" as const } };

describe("console indexes (0177)", () => {
  it("Delivery problems: the default failures list reads the partial deliveries_failed_created_idx", async () => {
    const p = await planOf("deliveries", () => listDeliveries(ctx.deps, {}, page));
    expect(p).toMatch(/deliveries_failed_created_idx/);
    noScan(p, "deliveries");
    // A narrower failure filter repeats the index's condition too.
    expect(await planOf("deliveries", () => listDeliveries(ctx.deps, { status: ["bounced"] }, page))).toMatch(/deliveries_failed_created_idx/);
  });

  it("Delivery problems: other statuses across workspaces read only the newest rows; one workspace uses deliveries_org_idx", async () => {
    const p = await planOf("deliveries", () => listDeliveries(ctx.deps, { status: ["delivered"] }, page));
    expect(p).toMatch(ROWID_RANGE("deliveries"));
    noScan(p, "deliveries");
    expect(await planOf("deliveries", () => listDeliveries(ctx.deps, { status: ["delivered"], orgId: "org_x" }, page))).toMatch(/deliveries_org_idx/);
  });

  it("Delivery problems: the failure rate finds failing workspaces from the partial index, then their totals by org_id", async () => {
    await new Client(ctx.app).signup();
    await ctx.db.run(sql`insert into deliveries (id, org_id, direction, from_address, to_address, subject, status, provider, created_at)
      select 'dlv_plan', id, 'outbound', 'a@a.io', 'b@b.io', '', 'bounced', 'log', ${Date.now()} from organizations limit 1`);
    const qs = await recorded("deliveries", () => deliveryFailureRateByWorkspace(ctx.deps, {}));
    expect(qs).toHaveLength(2);
    const [failing, totals] = qs.map(plan);
    expect(failing).toMatch(/deliveries_failed_created_idx/);
    expect(totals).toMatch(/deliveries_org_idx/);
    noScan(failing, "deliveries");
    noScan(totals, "deliveries");
  });

  it("Agent runs: attention reads failed runs from the partial index and long-running ones from the active runs index", async () => {
    const qs = await recorded("agent_runs", () => listAgentRuns(ctx.deps, {}, page));
    expect(qs).toHaveLength(2);
    const [active, list] = qs.map(plan);
    expect(active).toMatch(/agent_runs_(active_uq|queued_idx)/);
    expect(list).toMatch(/agent_runs_failed_created_idx/);
    noScan(active, "agent_runs");
    noScan(list, "agent_runs");
    expect(await planOf("agent_runs", () => listAgentRuns(ctx.deps, { status: "failed" }, page))).toMatch(/agent_runs_failed_created_idx/);
    expect(await planOf("agent_runs", () => listAgentRuns(ctx.deps, { status: "all" }, page))).toMatch(ROWID_RANGE("agent_runs"));
  });

  it("Agent runs: with a long-running run, attention is the failed index or that run by id", async () => {
    const client = (ctx.db as unknown as { $client: Raw }).$client;
    client.prepare("pragma foreign_keys = OFF").run();
    const old = Date.now() - 2 * 3_600_000;
    client.prepare("insert into agent_runs (id, org_id, task_id, agent_user_id, status, started_at, steps, step_count, created_at, updated_at) values ('run_plan_long', 'org_x', 'tsk_x', 'usr_x', 'running', ?, '[]', 0, ?, ?)").run(old, old, old);
    client.prepare("pragma foreign_keys = ON").run();
    const qs = await recorded("agent_runs", () => listAgentRuns(ctx.deps, {}, page));
    expect(qs).toHaveLength(2);
    const list = plan(qs[1]);
    expect(list).toMatch(/MULTI-INDEX OR/);
    expect(list).toMatch(/agent_runs_failed_created_idx/);
    noScan(list, "agent_runs");
  });

  it("Waiting approvals read the partial send_approvals_pending_created_idx", async () => {
    const p = await planOf("send_approvals", () => listPendingSendApprovals(ctx.deps, {}, page));
    expect(p).toMatch(/send_approvals_pending_created_idx/);
    noScan(p, "send_approvals");
  });

  it("Webhook failures read the existing webhook_deliveries_due_idx (status first); delivered ones only the newest rows", async () => {
    const p = await planOf("webhook_deliveries", () => listWebhookDeliveries(ctx.deps, {}, page));
    expect(p).toMatch(/webhook_deliveries_due_idx \(status=\?\)/);
    noScan(p, "webhook_deliveries");
    expect(await planOf("webhook_deliveries", () => listWebhookDeliveries(ctx.deps, { status: ["delivered"] }, page))).toMatch(ROWID_RANGE("webhook_deliveries"));
  });

  it("OAuth clients and grants (no index: one would cost a write per registration or sign in) read only the newest rows", async () => {
    expect(await planOf("oauth_clients", () => listOAuthClients(ctx.deps, {}, page))).toMatch(ROWID_RANGE("oauth_clients"));
    expect(await planOf("oauth_grants", () => listOAuthGrants(ctx.deps, {}, page))).toMatch(ROWID_RANGE("oauth_grants"));
    expect(await planOf("oauth_grants", () => listOAuthGrants(ctx.deps, { orgId: "org_x" }, page))).toMatch(/oauth_grants_org_idx/);
  });

  it("the busiest workspaces probe usage_counters by primary key per workspace, never a scan", async () => {
    const qs = await recorded("usage_counters", () => systemSnapshot(ctx.deps));
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      const p = plan(q);
      expect(p).toMatch(/SEARCH usage_counters USING (INDEX sqlite_autoindex_usage_counters_1|PRIMARY KEY)/);
      noScan(p, "usage_counters");
    }
  });

  it("0177 creates exactly the kept indexes, and none of the dropped ones", async () => {
    const client = (ctx.db as unknown as { $client: Raw }).$client;
    const names = (client.prepare("select name from sqlite_master where type = 'index'").all() as { name: string }[]).map((r) => r.name);
    for (const n of [
      "deliveries_failed_created_idx", "agent_runs_failed_created_idx", "send_approvals_pending_created_idx",
      "suppressions_created_idx", "import_jobs_created_idx", "data_moves_created_idx", "users_created_idx",
    ]) expect(names).toContain(n);
    for (const n of [
      "deliveries_status_created_idx", "deliveries_direction_created_idx", "webhook_deliveries_status_created_idx", "oauth_grants_created_idx",
      "oauth_grants_client_idx", "oauth_clients_created_idx", "agent_runs_status_created_idx", "send_approvals_status_created_idx",
      "usage_counters_period_metric_idx", "webhook_deliveries_failed_created_idx",
    ]) expect(names).not.toContain(n);
  });
});
