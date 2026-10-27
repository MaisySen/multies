/**
 * R48 (MB-235): a daily write budget per workspace, so one busy workspace can never spend the whole account's
 * D1 write allowance and push Multies into read only for everyone.
 *
 * The account wide guard (services/write-budget.ts) stays as it is: it reads Cloudflare analytics and protects
 * the account. This one counts the rows each workspace writes, from D1's own answer (`meta.rows_written`, which
 * includes index rows, the same unit Cloudflare bills), and holds that workspace alone to a share of the day:
 *
 *   ok     below `nearAt` of the workspace budget
 *   near   from `nearAt` (80%): admins get one calm email for the day, and writes answer `x-workspace-budget: near`
 *   over   at 100%: that workspace's API writes answer 429 `workspace_budget` until 00:00 UTC; reading, search,
 *          sign in, account and billing keep working, and every other workspace is untouched
 *
 * Counting is cheap on purpose. Each request's rows are added to a per isolate tally, and the tally is written to
 * `usage_counters` (period = the UTC day, metric `d1_rows`) as one upsert per workspace at most once a minute or
 * every FLUSH_ROWS rows. Checking reads that one counter row at most once a minute per workspace per isolate. An
 * evicted isolate can lose under a minute of its tally; the budget is a guard rail, not an invoice.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Deps } from "../context";
import { appSettings, usageCounters } from "../db/schema";

export const WORKSPACE_ROWS_METRIC = "d1_rows";
export const FLUSH_ROWS = 200;
export const FLUSH_MS = 60_000;
const READ_MS = 60_000;

export type WorkspaceBudgetLevel = "ok" | "near" | "over" | "off";

export const WORKSPACE_BUDGET_CODE = "workspace_budget";
export const workspaceBudgetMessage = () =>
  "This workspace has made a lot of changes today and reached its daily limit. Your data is safe and you can keep reading and searching. Changes open again at midnight UTC, and other workspaces are not affected.";

// ---- per request meter -----------------------------------------------------------------------------

const meterStore = new AsyncLocalStorage<{ rows: number }>();

/** Runs `fn` with a fresh write meter and answers the rows it wrote alongside its result. */
export async function runMetered<T>(fn: () => Promise<T>): Promise<{ result: T; rows: number }> {
  const meter = { rows: 0 };
  const result = await meterStore.run(meter, fn);
  return { result, rows: meter.rows };
}

/** Adds rows written by the statement just run to the current request's meter (no meter: nothing). */
export function noteRowsWritten(n: number) {
  const m = meterStore.getStore();
  if (m && Number.isFinite(n) && n > 0) m.rows += n;
}

const READ_SQL = /^\s*(select|with\b[\s\S]*?\)\s*select|pragma|explain)\b/i;
type Res = { meta?: { rows_written?: number; changes?: number } } | null | undefined;
const rowsOf = (r: Res) => {
  const m = r?.meta;
  if (!m) return 0;
  return typeof m.rows_written === "number" ? m.rows_written : typeof m.changes === "number" ? m.changes : 0;
};

/**
 * Wraps a D1 binding so every write statement's `meta.rows_written` reaches the request meter. Statement objects
 * are kept (methods wrapped in place), so `batch()` still receives real D1 statements. `raw()` answers no meta;
 * a write through it counts one row.
 */
export function withWriteMeter<T extends object>(db: T): T {
  const d = db as T & { prepare?: (sql: string) => unknown; batch?: (s: unknown[]) => Promise<Res[]>; __writeMeter?: boolean };
  if (typeof d.prepare !== "function" || d.__writeMeter) return db;
  type Stmt = Record<string, unknown>;
  const prepare = d.prepare.bind(db);
  const wrap = (stmt: Stmt, sql: string): Stmt => {
    if (!stmt || typeof stmt !== "object" || stmt.__writeMeter) return stmt;
    stmt.__writeMeter = true;
    if (typeof stmt.bind === "function") {
      const bind = (stmt.bind as (...a: unknown[]) => Stmt).bind(stmt);
      stmt.bind = (...args: unknown[]) => wrap(bind(...args), sql);
    }
    if (READ_SQL.test(sql)) return stmt;
    for (const m of ["run", "all", "first"] as const) {
      const fn = stmt[m];
      if (typeof fn !== "function") continue;
      const call = (fn as (...a: unknown[]) => Promise<unknown>).bind(stmt);
      stmt[m] = async (...args: unknown[]) => {
        const r = await call(...args);
        if (m !== "first") noteRowsWritten(rowsOf(r as Res));
        else noteRowsWritten(1);
        return r;
      };
    }
    if (typeof stmt.raw === "function") {
      const call = (stmt.raw as (...a: unknown[]) => Promise<unknown>).bind(stmt);
      stmt.raw = async (...args: unknown[]) => { const r = await call(...args); noteRowsWritten(1); return r; };
    }
    return stmt;
  };
  d.prepare = (sql: string) => wrap(prepare(sql) as Stmt, sql);
  if (typeof d.batch === "function") {
    const batch = d.batch.bind(db);
    d.batch = async (stmts: unknown[]) => {
      // Statements in a batch run through D1's batch, not their own methods, so their meta is read here.
      const r = await batch(stmts);
      if (Array.isArray(r)) for (const x of r) noteRowsWritten(rowsOf(x));
      return r;
    };
  }
  d.__writeMeter = true;
  return db;
}

// ---- per workspace tally ----------------------------------------------------------------------------

const dayOf = (now: Date) => now.toISOString().slice(0, 10);
const pending = new Map<string, { day: string; rows: number; since: number }>();
const stored = new Map<string, { day: string; rows: number; at: number }>();
const alertedHere = new Set<string>();

/** Test hook. */
export function resetWorkspaceBudget() { pending.clear(); stored.clear(); alertedHere.clear(); healthCache = null; }

export interface WorkspaceBudgetConfig { daily: number; nearAt: number }

export function workspaceLevel(used: number, cfg: WorkspaceBudgetConfig): WorkspaceBudgetLevel {
  if (!cfg.daily) return "off";
  if (used >= cfg.daily) return "over";
  if (used >= cfg.daily * cfg.nearAt) return "near";
  return "ok";
}

async function readStored(deps: Deps, orgId: string, day: string, force = false) {
  const hit = stored.get(orgId);
  const now = Date.now();
  if (!force && hit && hit.day === day && now - hit.at < READ_MS) return hit.rows;
  const row = await deps.db.select({ n: usageCounters.count }).from(usageCounters)
    .where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.period, day), eq(usageCounters.metric, WORKSPACE_ROWS_METRIC))).get();
  const rows = row?.n ?? 0;
  stored.set(orgId, { day, rows, at: now });
  return rows;
}

/** Rows this workspace wrote today: the stored counter (up to a minute old) plus this isolate's unflushed tally. */
export async function workspaceUsage(deps: Deps, orgId: string) {
  const cfg = deps.config.workspaceBudget;
  const day = dayOf(deps.now());
  const p = pending.get(orgId);
  const used = (await readStored(deps, orgId, day)) + (p && p.day === day ? p.rows : 0);
  return { used, budget: cfg.daily, level: workspaceLevel(used, cfg), resetAt: new Date(Date.UTC(deps.now().getUTCFullYear(), deps.now().getUTCMonth(), deps.now().getUTCDate() + 1)).toISOString() };
}

/**
 * Adds a request's rows to the workspace tally and writes the tally out when it is big or old enough. Returns the
 * promise of any flush (for waitUntil); never throws.
 */
export function recordWorkspaceWrites(deps: Deps, orgId: string, rows: number): Promise<void> | undefined {
  if (!deps.config.workspaceBudget.daily || !orgId || rows <= 0) return undefined;
  const day = dayOf(deps.now());
  const now = Date.now();
  let p = pending.get(orgId);
  if (!p || p.day !== day) { p = { day, rows: 0, since: now }; pending.set(orgId, p); }
  p.rows += rows;
  if (p.rows < FLUSH_ROWS && now - p.since < FLUSH_MS) return undefined;
  return flushWorkspace(deps, orgId).catch((err) => { deps.reportError?.(err, { where: "workspaceBudget.flush" }); });
}

/** Writes one workspace's tally (one upsert) and sends the admins' notice when a level is crossed. */
export async function flushWorkspace(deps: Deps, orgId: string) {
  const p = pending.get(orgId);
  if (!p || p.rows <= 0) return;
  pending.delete(orgId);
  const { day, rows } = p;
  const { sql } = await import("drizzle-orm");
  await deps.db.insert(usageCounters).values({ orgId, period: day, metric: WORKSPACE_ROWS_METRIC, count: rows })
    .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.period, usageCounters.metric], set: { count: sql`${usageCounters.count} + ${rows}` } });
  const before = stored.get(orgId);
  const total = before && before.day === day ? before.rows + rows : await readStored(deps, orgId, day, true);
  if (before && before.day === day) stored.set(orgId, { day, rows: total, at: before.at });
  const level = workspaceLevel(total, deps.config.workspaceBudget);
  if (level === "near" || level === "over") await notifyAdmins(deps, orgId, level, total).catch((err) => deps.reportError?.(err, { where: "workspaceBudget.notify" }));
}

/** Writes every unflushed tally (the cron calls this so a quiet isolate's rows are not held for long). */
export async function flushAllWorkspaces(deps: Deps) {
  for (const orgId of [...pending.keys()]) await flushWorkspace(deps, orgId).catch((err) => deps.reportError?.(err, { where: "workspaceBudget.flush" }));
}

async function notifyAdmins(deps: Deps, orgId: string, level: "near" | "over", used: number) {
  const day = dayOf(deps.now());
  const key = `ws_budget_alert:${orgId}:${day}:${level}`;
  if (alertedHere.has(key)) return;
  alertedHere.add(key);
  // One notice per workspace per level per day across every isolate: the settings row is the claim.
  const claimed = await deps.db.insert(appSettings).values({ key, value: String(used) }).onConflictDoNothing().returning({ key: appSettings.key });
  if (!claimed.length) return;
  const { organizations } = await import("../db/schema");
  const org = await deps.db.select({ name: organizations.name, isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, orgId)).get();
  if (!org || org.isDemo) return;
  const { billingContacts } = await import("./billing/dunning");
  const { sendSystemEmail } = await import("./system-mail");
  const budget = deps.config.workspaceBudget.daily;
  const pct = Math.min(100, Math.round((used / Math.max(1, budget)) * 100));
  const subject = level === "over" ? `${org.name} reached today's limit for changes` : `${org.name} has used ${pct}% of today's changes`;
  const text = level === "over"
    ? `${org.name} has made about ${used.toLocaleString("en-AU")} database changes today, its daily limit. Your data is safe, and everyone can keep reading and searching. Changes open again at midnight UTC. Other workspaces are not affected.\n\nThis usually means an import, an automation or an integration is writing a lot. If it is expected, nothing needs doing. If not, check Settings, Automations and Integrations, or reply to this email and we will help.`
    : `${org.name} has used ${pct}% of today's limit for changes (about ${used.toLocaleString("en-AU")} of ${budget.toLocaleString("en-AU")}). Nothing has stopped. If the workspace reaches the limit, changes pause until midnight UTC while reading keeps working.\n\nThis usually means an import, an automation or an integration is busy. If it is expected, nothing needs doing.`;
  for (const to of await billingContacts(deps, orgId)) {
    await sendSystemEmail(deps, { to, orgId, template: "workspace-budget", subject, text, action: { label: "Open Multies", url: `${deps.config.appUrl}/app` } }).catch(() => undefined);
  }
  if (deps.config.writeBudget.alertTo) {
    await sendSystemEmail(deps, { to: deps.config.writeBudget.alertTo, orgId, template: "ops-workspace-budget", subject: `[ops] ${subject}`, text: `${org.name} (${orgId}): ${used} rows written today, workspace budget ${budget}.` }).catch(() => undefined);
  }
}

// ---- enforcement ------------------------------------------------------------------------------------

/** Paths that keep working when a workspace is over its budget: the person must be able to sign in and out,
 * switch or leave a workspace, export, pay, and keep presence (which writes nothing). */
const EXEMPT = /^\/api\/(auth\/|account(\/|$)|billing(\/|$)|me(\/|$)|health$|_test-session$|threads\/[^/]+\/presence)/;

export function isBudgetExempt(method: string, path: string) {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  // MCP is JSON over POST for reads too; its writes still count toward the budget.
  return EXEMPT.test(path) || path.endsWith("/mcp");
}

/** The check run once a request knows its workspace. Answers the level ("off" when the budget is not set). */
export async function checkWorkspaceBudget(deps: Deps, orgId: string): Promise<WorkspaceBudgetLevel> {
  if (!deps.config.workspaceBudget.daily || !orgId) return "off";
  try {
    return (await workspaceUsage(deps, orgId)).level;
  } catch (err) {
    // A failed read never blocks work.
    deps.reportError?.(err, { where: "workspaceBudget.check" });
    return "ok";
  }
}

// ---- operator view ----------------------------------------------------------------------------------

let healthCache: { at: number; day: string; view: unknown } | null = null;
const HEALTH_MS = 10 * 60_000;

/** For /api/health: today's busiest workspaces by rows written, as counts only (no ids or names on a public route). */
export async function workspaceHealthView(deps: Deps) {
  const cfg = deps.config.workspaceBudget;
  if (!cfg.daily) return { budget: 0, level: "off" as const };
  const day = dayOf(deps.now());
  if (healthCache && healthCache.day === day && Date.now() - healthCache.at < HEALTH_MS) return healthCache.view;
  const rows = await deps.db.select({ n: usageCounters.count }).from(usageCounters)
    .where(and(eq(usageCounters.period, day), eq(usageCounters.metric, WORKSPACE_ROWS_METRIC))).orderBy(desc(usageCounters.count)).limit(5).all();
  const top = rows.map((r) => r.n);
  const view = {
    budget: cfg.daily, nearAt: Math.round(cfg.nearAt * 100),
    top, near: top.filter((n) => workspaceLevel(n, cfg) === "near").length, over: top.filter((n) => n >= cfg.daily).length,
    at: deps.now().toISOString(),
  };
  healthCache = { at: Date.now(), day, view };
  return view;
}

/** Old daily counters go after a week (the cron calls this once a day). */
export async function pruneWorkspaceCounters(deps: Deps) {
  const cutoff = dayOf(new Date(deps.now().getTime() - 7 * 86_400_000));
  await deps.db.delete(usageCounters).where(and(eq(usageCounters.metric, WORKSPACE_ROWS_METRIC), lt(usageCounters.period, cutoff)));
}
