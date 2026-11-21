/**
 * OPS1: /api/console/agents, Agents and AI.
 *
 * Reads (agents.read), each { items, nextCursor } with ?q=&limit=&cursor=&sort=field:dir:
 *   GET  /runs              ?status=attention|failed|long_running|queued|running|succeeded|cancelled|all|any &orgId= &days=1..90
 *                           (default attention: failed plus long-running, last 7 days; sort createdAt|updatedAt)
 *   GET  /triggers          ?enabled=true|false &kind=schedule|webhook &orgId=   (sort createdAt|updatedAt|fireCount)
 *   GET  /approvals         ?orgId=   agent sends waiting for a person (sort createdAt|expiresAt, oldest first)
 *   GET  /ai-usage          ?days=7|30   top workspaces by units or calls, plus { window, account }
 *   GET  /ai-key-problems   ?problem=key_refused|no_credit|model_unavailable   (sort problemAt|updatedAt)
 * Changes (agents.manage), each with { reason } and a platform audit row; the workspace's own audit log gets its usual
 * entry naming the operator from the workspace service the change runs through:
 *   POST /runs/:id/cancel          agent_run.cancelled
 *   POST /triggers/:id/pause       agent_trigger.paused
 *   POST /triggers/:id/resume      agent_trigger.resumed
 *
 * Never returned: run input, steps or results, trigger instructions, approval messages, AI keys or their hints.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../context";
import { agentRuns, agentTriggers } from "../../db/schema";
import { parseBody, parseQuery } from "../../middleware";
import { notFound } from "../../lib/errors";
import { operatorSession, requireOperator } from "../../auth/operator";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import { decodeCursor, encodeCursor } from "../../services/console/listing";
import type { ConsoleCursor, ConsolePage, ConsolePageResult, SortDir } from "../../services/console/jobs";
import {
  aiUsageTopWorkspaces, cancelAgentRun, listAgentRuns, listAgentTriggers, listAiKeyProblems, listPendingSendApprovals, setAgentTriggerPaused,
  AGENT_RUN_STATUS_FILTERS, type AgentRunStatusFilter, type ConsoleOperator,
} from "../../services/console/agents";

/** Ids are short tokens; anything else cannot name a row, so it is a 404 like an unknown one. */
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const days = z.coerce.number().int().min(1).max(90).optional();

/** The service page from ?limit, ?cursor and ?sort (field:dir; a field outside the list's whitelist is a 422 there). */
function pageOf<F extends string>(c: Context<AppEnv>, defaultSort: `${F}:${SortDir}`): ConsolePage<F> {
  const q = c.req.query();
  const [defField, defDir] = defaultSort.split(":") as [string, SortDir];
  const [field, dir] = (q.sort || defaultSort).split(":");
  const n = Number.parseInt(q.limit ?? "", 10);
  let cursor: ConsoleCursor | null = null;
  if (q.cursor) {
    const d = decodeCursor(q.cursor);
    cursor = { v: d.sort instanceof Date ? d.sort.getTime() : d.sort, id: d.id };
  }
  return {
    limit: Number.isFinite(n) && n > 0 ? n : 50,
    cursor,
    sort: { field: field || defField, dir: (dir || defDir) as SortDir },
  };
}

/** { items, next } from the service as the console's { items, nextCursor }. */
function asPage<T>(r: ConsolePageResult<T>): { items: T[]; nextCursor: string | null } {
  return { items: r.items, nextCursor: r.next ? encodeCursor(r.next.v, r.next.id) : null };
}

function operatorOf(c: Context<AppEnv>): ConsoleOperator {
  const a = c.var.auth;
  return { userId: a.userId, email: a.email, name: a.name };
}

function idParam(c: Context<AppEnv>, what: string): string {
  const id = c.req.param("id") ?? "";
  if (!ID_RE.test(id)) throw notFound(what);
  return id;
}

const RunsQuery = z.object({
  // "any" is the console's word for every status (its list control leaves out the value "all").
  status: z.preprocess((v) => (v === "any" ? "all" : v === "" ? undefined : v), z.enum(AGENT_RUN_STATUS_FILTERS as [AgentRunStatusFilter, ...AgentRunStatusFilter[]]).optional()),
  orgId: optionalText(100),
  days,
  q: optionalText(100),
}).passthrough();

const TriggersQuery = z.object({
  enabled: z.enum(["true", "false", "all", ""]).optional(),
  kind: z.enum(["schedule", "webhook", "all", ""]).optional(),
  orgId: optionalText(100),
  q: optionalText(100),
}).passthrough();

const ApprovalsQuery = z.object({ orgId: optionalText(100), q: optionalText(100) }).passthrough();
const UsageQuery = z.object({ days: z.enum(["7", "30"]).optional() }).passthrough();
const KeyProblemsQuery = z.object({
  problem: z.enum(["key_refused", "no_credit", "model_unavailable", "all", ""]).optional(),
  q: optionalText(100),
}).passthrough();

const ReasonBody = z.object({ reason: reasonSchema });

export function agentsRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/runs", requireOperator("agents.read"), async (c) => {
      const f = parseQuery(c, RunsQuery);
      c.header("cache-control", "no-store");
      const r = await listAgentRuns(c.var.deps, {
        status: f.status as AgentRunStatusFilter | undefined, orgId: f.orgId, days: f.days, q: f.q,
      }, pageOf(c, "createdAt:desc"));
      return c.json(asPage(r));
    })
    .get("/triggers", requireOperator("agents.read"), async (c) => {
      const f = parseQuery(c, TriggersQuery);
      c.header("cache-control", "no-store");
      const r = await listAgentTriggers(c.var.deps, {
        enabled: f.enabled === "true" ? true : f.enabled === "false" ? false : undefined,
        kind: f.kind === "schedule" || f.kind === "webhook" ? f.kind : undefined,
        orgId: f.orgId, q: f.q,
      }, pageOf(c, "createdAt:desc"));
      return c.json(asPage(r));
    })
    .get("/approvals", requireOperator("agents.read"), async (c) => {
      const f = parseQuery(c, ApprovalsQuery);
      c.header("cache-control", "no-store");
      return c.json(asPage(await listPendingSendApprovals(c.var.deps, { orgId: f.orgId, q: f.q }, pageOf(c, "createdAt:asc"))));
    })
    .get("/ai-usage", requireOperator("agents.read"), async (c) => {
      const f = parseQuery(c, UsageQuery);
      c.header("cache-control", "no-store");
      const r = await aiUsageTopWorkspaces(c.var.deps, { days: f.days ? Number(f.days) : 7 }, pageOf(c, "units:desc"));
      return c.json({ ...asPage(r), window: r.window, account: r.account });
    })
    .get("/ai-key-problems", requireOperator("agents.read"), async (c) => {
      const f = parseQuery(c, KeyProblemsQuery);
      c.header("cache-control", "no-store");
      const problem = f.problem === "key_refused" || f.problem === "no_credit" || f.problem === "model_unavailable" ? f.problem : undefined;
      return c.json(asPage(await listAiKeyProblems(c.var.deps, { problem, q: f.q }, pageOf(c, "problemAt:desc"))));
    })
    .post("/runs/:id/cancel", requireOperator("agents.manage"), async (c) => {
      const { reason } = await parseBody(c, ReasonBody);
      const id = idParam(c, "Run");
      const row = await c.var.deps.db.select({ orgId: agentRuns.orgId }).from(agentRuns).where(eq(agentRuns.id, id)).get();
      if (!row) throw notFound("Run");
      type R = Awaited<ReturnType<typeof cancelAgentRun>>;
      // The workspace's own audit entry (agent_run.cancelled, naming the operator, with the reason) comes from the run service.
      const r = await operatorAction(c, {
        action: "agent_run.cancelled", targetType: "agent_run", targetId: id, orgId: row.orgId, reason,
        before: (x: R) => ({ status: x.previousStatus }), after: (x: R) => ({ status: x.status }),
      }, () => cancelAgentRun(c.var.deps, operatorOf(c), id, reason));
      return c.json({ ok: true, id: r.id, status: r.status, previousStatus: r.previousStatus });
    })
    .post("/triggers/:id/pause", requireOperator("agents.manage"), async (c) => setPaused(c, true))
    .post("/triggers/:id/resume", requireOperator("agents.manage"), async (c) => setPaused(c, false));
}

async function setPaused(c: Context<AppEnv>, paused: boolean) {
  const { reason } = await parseBody(c, ReasonBody);
  const id = idParam(c, "Trigger");
  const row = await c.var.deps.db.select({ orgId: agentTriggers.orgId }).from(agentTriggers).where(eq(agentTriggers.id, id)).get();
  if (!row) throw notFound("Trigger");
  type R = Awaited<ReturnType<typeof setAgentTriggerPaused>>;
  // The workspace's own audit entry (agent_trigger.updated, naming the operator) comes from the trigger service.
  const r = await operatorAction(c, {
    action: paused ? "agent_trigger.paused" : "agent_trigger.resumed", targetType: "agent_trigger", targetId: id, orgId: row.orgId, reason,
    before: (x: R) => ({ enabled: x.changed ? !x.enabled : x.enabled }), after: (x: R) => ({ enabled: x.enabled, nextRunAt: x.nextRunAt }),
  }, () => setAgentTriggerPaused(c.var.deps, operatorOf(c), id, paused));
  return c.json({ ok: true, id: r.id, enabled: r.enabled, changed: r.changed, nextRunAt: r.nextRunAt });
}
