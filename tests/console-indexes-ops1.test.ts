/**
 * OPS1 (migration 0177): the console's default cross-workspace lists run on an index instead of a full table scan.
 * The statements are the ones the services really send: each call is recorded at the SQLite client and then
 * explained with the same parameters.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers";
import { deliveryFailureRateByWorkspace, listDeliveries } from "@/server/services/console/mail";
import { listAgentRuns } from "@/server/services/console/agents";

type Stmt = Record<string, (...a: unknown[]) => unknown>;
type Raw = { prepare: (q: string) => Stmt };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;

beforeAll(async () => { ctx = await makeTestApp(); }, 120_000);

/** Runs `fn` and returns every statement it sent to SQLite that reads `table`, with its parameters. */
async function recorded(table: string, fn: () => Promise<unknown>): Promise<{ sql: string; params: unknown[] }[]> {
  const client = (ctx.db as unknown as { $client: Raw }).$client;
  const prepare = client.prepare;
  const seen: { sql: string; params: unknown[] }[] = [];
  client.prepare = (q: string) => {
    const st = prepare.call(client, q);
    if (!new RegExp(`from ["\`]${table}["\`]`, "i").test(q)) return st;
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
  return (client.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as { detail: string }[]).map((r) => r.detail).join(" | ");
}

const page = { limit: 50, cursor: null, sort: { field: "createdAt", dir: "desc" as const } };

describe("console indexes (0177)", () => {
  it("Delivery problems: the failures list uses deliveries_status_created_idx", async () => {
    const qs = await recorded("deliveries", () => listDeliveries(ctx.deps, {}, page));
    expect(qs).toHaveLength(1);
    const p = plan(qs[0]);
    expect(p).toMatch(/deliveries_status_created_idx/);
    expect(p).not.toMatch(/SCAN deliveries(?! USING)/);
  });

  it("Delivery problems: the failure rate by workspace uses deliveries_direction_created_idx", async () => {
    const qs = await recorded("deliveries", () => deliveryFailureRateByWorkspace(ctx.deps, {}));
    expect(qs).toHaveLength(1);
    const p = plan(qs[0]);
    expect(p).toMatch(/deliveries_direction_created_idx/);
    expect(p).not.toMatch(/SCAN deliveries(?! USING)/);
  });

  it("Agent runs: the default attention list uses agent_runs_status_created_idx", async () => {
    const qs = await recorded("agent_runs", () => listAgentRuns(ctx.deps, {}, page));
    expect(qs).toHaveLength(1);
    const p = plan(qs[0]);
    expect(p).toMatch(/agent_runs_status_created_idx/);
    expect(p).not.toMatch(/SCAN agent_runs(?! USING)/);
  });

  it("every 0177 index exists after migrations", async () => {
    const client = (ctx.db as unknown as { $client: Raw }).$client;
    const names = (client.prepare("select name from sqlite_master where type = 'index'").all() as { name: string }[]).map((r) => r.name);
    for (const n of [
      "deliveries_status_created_idx", "deliveries_direction_created_idx", "suppressions_created_idx", "webhook_deliveries_status_created_idx",
      "oauth_grants_created_idx", "oauth_grants_client_idx", "oauth_clients_created_idx", "import_jobs_created_idx", "agent_runs_status_created_idx",
      "send_approvals_status_created_idx", "data_moves_created_idx", "usage_counters_period_metric_idx", "users_created_idx",
    ]) expect(names).toContain(n);
  });
});
