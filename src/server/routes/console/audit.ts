/**
 * OPS1: the platform audit log.
 * GET /api/console/audit: { items, nextCursor }, newest first. Filters: actor (email contains, or a user id), action
 *   (prefix), targetType, targetId, orgId, from and to (ISO dates), plus the list convention (q, limit, cursor).
 *   Each item also carries targetLabel (a workspace's name, a person's email, a flag's label) and orgName, read in
 *   batches for the page (withAuditNames), never per row.
 * GET /api/console/audit/export: the same filters as CSV, up to 5,000 rows (owners only; the export is audited).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context";
import { parseQuery } from "../../middleware";
import { operatorSession, requireOperator } from "../../auth/operator";
import { auditActor, listPlatformAudit, platformAudit, withAuditNames, type PlatformAuditFilter, type PlatformAuditRow } from "../../services/console/audit";

const date = z.string().max(40).optional().transform((v, ctx) => {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) { ctx.addIssue({ code: "custom", message: "Use a date like 2026-11-21." }); return z.NEVER; }
  return d;
});

const FilterQuery = z.object({
  actor: z.string().trim().max(200).optional(),
  action: z.string().trim().max(100).optional(),
  targetType: z.string().trim().max(60).optional(),
  targetId: z.string().trim().max(100).optional(),
  orgId: z.string().trim().max(100).optional(),
  from: date,
  to: date,
}).passthrough();

const filterOf = (c: Context<AppEnv>): PlatformAuditFilter => {
  const f = parseQuery(c, FilterQuery);
  return { actor: f.actor || undefined, action: f.action || undefined, targetType: f.targetType || undefined, targetId: f.targetId || undefined, orgId: f.orgId || undefined, from: f.from, to: f.to };
};

const EXPORT_MAX = 5000;
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : v instanceof Date ? v.toISOString() : JSON.stringify(v);
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const COLUMNS: (keyof PlatformAuditRow)[] = ["createdAt", "actorEmail", "actorRole", "action", "targetType", "targetId", "orgId", "reason", "before", "after", "metadata", "ip", "requestId"];

export function auditRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/", requireOperator("audit.read"), async (c) => {
      c.header("cache-control", "no-store");
      const page = await listPlatformAudit(c.var.deps.db, c.req.query(), filterOf(c));
      return c.json({ items: await withAuditNames(c.var.deps.db, page.items), nextCursor: page.nextCursor });
    })
    .get("/export", requireOperator("audit.export"), async (c) => {
      const filter = filterOf(c);
      const rows: PlatformAuditRow[] = [];
      let cursor: string | undefined;
      while (rows.length < EXPORT_MAX) {
        const page = await listPlatformAudit(c.var.deps.db, { limit: "200", ...(cursor ? { cursor } : {}), q: c.req.query("q") }, filter);
        rows.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const out = rows.slice(0, EXPORT_MAX);
      await platformAudit(c.var.deps.db, { ...auditActor(c), action: "audit.exported", metadata: { rows: out.length, filter: { ...filter, from: filter.from?.toISOString(), to: filter.to?.toISOString() } } });
      const csv = [COLUMNS.join(","), ...out.map((r) => COLUMNS.map((k) => csvCell(r[k])).join(","))].join("\n");
      c.header("content-type", "text/csv; charset=utf-8");
      c.header("content-disposition", `attachment; filename="platform-audit-${c.var.deps.now().toISOString().slice(0, 10)}.csv"`);
      c.header("cache-control", "no-store");
      return c.body(csv);
    });
}
