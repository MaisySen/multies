/**
 * OPS1: /api/console/moderation, Moderation and abuse.
 *
 * Reads (moderation.read):
 *   GET  /reports            { items, nextCursor }  ?status=open|resolved|dismissed|all (open) &reason &workspace &q &sort=createdAt:dir
 *   GET  /reports/counts     { open, olderThan12h, olderThan24h, oldestAt }
 *   GET  /abuse              { items, nextCursor }  ?status=open|resolved|all (open; "any", the console's
 *                            older word for all, is still accepted) &kind &workspace &sort=createdAt|score:dir
 *   GET  /abuse/summary      { items }  workspaces with open signals, highest score first
 *   GET  /suspended          { items, nextCursor }  ?sort=suspendedAt|name:dir
 * Changes (each takes a reason and writes a platform audit row):
 *   POST /reports/:id/action        { action: dismiss|resolve|remove_message|suspend_user, note?, reason } (moderation.act;
 *                                   suspend_user also needs users.ban and a recent sign in, and refuses an operator account)
 *   POST /abuse/resolve             { ids } or { workspace }, reason (moderation.act)
 *   POST /workspaces/:id/suspend    { reason } (workspaces.suspend), audit action "workspace.suspended" on targetType
 *                                   "workspace": the suspended list reads who suspended from exactly that row
 *   POST /workspaces/:id/unsuspend  { reason } (workspaces.suspend), also resolves the workspace's open abuse signals
 *
 * Sign in lockouts live under /api/console/system/lockouts (the Moderation page shows them in a tab).
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../../context";
import { contentReports, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { parseBody, parseQuery } from "../../middleware";
import { isFreshSignIn, operatorSession, requireOperator } from "../../auth/operator";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import {
  abuseSummaryByWorkspace, actOnReportForConsole, listAbuseEvents, listReports, listSuspendedWorkspaces, reportCounts, resolveAbuseEvents,
  suspendWorkspace, unsuspendWorkspace, type PageCursor, type PageRequest, type Paged,
} from "../../services/console/moderation";
import { getOrg } from "../../services/plans";
import { REPORT_REASONS } from "../../services/suite/reports-r35";
import { can, isOperatorRole } from "@/shared/operator-permissions";

// ---------------------------------------------------------------- the data layer's paging, as the console's list convention

const STALE = "That page link is out of date. Start the list again.";

function encodeCursor(c: PageCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: c.v, id: c.id }));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(s: string): PageCursor {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))) as PageCursor;
    if (!o || typeof o.id !== "string" || !o.id || (typeof o.v !== "string" && typeof o.v !== "number")) throw new Error("shape");
    return { v: o.v, id: o.id };
  } catch {
    throw new HttpError(400, "bad_cursor", STALE);
  }
}

/** ?limit, ?cursor and ?sort=field:dir as the data layer's page request (the data layer checks the sort field). */
function pageOf<F extends string>(c: Context<AppEnv>, defaultSort: `${F}:${"asc" | "desc"}`): PageRequest<F> {
  const q = c.req.query();
  const n = Number.parseInt(q.limit ?? "", 10);
  const [df, dd] = defaultSort.split(":") as [F, "asc" | "desc"];
  const [f, d] = (q.sort ?? "").split(":");
  return {
    limit: Number.isFinite(n) && n > 0 ? n : 50,
    cursor: q.cursor ? decodeCursor(q.cursor) : null,
    sort: { field: (f || df) as F, dir: d === "asc" || d === "desc" ? d : dd },
  };
}

const answer = <T>(p: Paged<T>) => ({ items: p.items, nextCursor: p.next ? encodeCursor(p.next) : null });

const id = z.string().trim().min(1).max(100);
const optional = (s: z.ZodString) => z.preprocess((v) => (v === "" ? undefined : v), s.optional());

const ReportsQuery = z.object({
  status: z.enum(["open", "resolved", "dismissed", "all"]).default("open"),
  reason: z.preprocess((v) => (v === "" ? undefined : v), z.enum(REPORT_REASONS).optional()),
  workspace: optional(z.string().trim().max(100)),
  q: optional(z.string().max(200)),
}).passthrough();

const AbuseQuery = z.object({
  status: z.enum(["open", "resolved", "all", "any"]).default("open"),
  kind: optional(z.string().trim().max(64)),
  workspace: optional(z.string().trim().max(100)),
}).passthrough();

const ReportActionBody = z.object({
  action: z.enum(["dismiss", "resolve", "remove_message", "suspend_user"]),
  note: z.string().trim().max(1000).optional(),
  reason: reasonSchema,
});

const ResolveBody = z.object({
  ids: z.array(id).min(1, "Pick at least one signal.").max(500).optional(),
  workspace: id.optional(),
  reason: reasonSchema,
}).refine((b) => !!b.ids !== !!b.workspace, { message: "Give either the signals or the workspace, not both.", path: ["ids"] });

const REPORT_AUDIT = { dismiss: "report.dismissed", resolve: "report.resolved", remove_message: "report.message_removed", suspend_user: "report.user_suspended" } as const;

export function moderationRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/reports", requireOperator("moderation.read"), async (c) => {
      const f = parseQuery(c, ReportsQuery);
      c.header("cache-control", "no-store");
      return c.json(answer(await listReports(c.var.deps, { status: f.status, reason: f.reason, orgId: f.workspace, q: f.q, page: pageOf(c, "createdAt:desc") })));
    })
    .get("/reports/counts", requireOperator("moderation.read"), async (c) => {
      c.header("cache-control", "no-store");
      return c.json(await reportCounts(c.var.deps));
    })
    .get("/abuse", requireOperator("moderation.read"), async (c) => {
      const f = parseQuery(c, AbuseQuery);
      c.header("cache-control", "no-store");
      const resolved = f.status === "all" || f.status === "any" ? undefined : f.status === "resolved";
      return c.json(answer(await listAbuseEvents(c.var.deps, { resolved, kind: f.kind, orgId: f.workspace, page: pageOf(c, "createdAt:desc") })));
    })
    .get("/abuse/summary", requireOperator("moderation.read"), async (c) => {
      const n = Number.parseInt(c.req.query("limit") ?? "", 10);
      c.header("cache-control", "no-store");
      return c.json({ items: await abuseSummaryByWorkspace(c.var.deps, { limit: Number.isFinite(n) && n > 0 ? n : 50 }) });
    })
    .get("/suspended", requireOperator("moderation.read"), async (c) => {
      c.header("cache-control", "no-store");
      return c.json(answer(await listSuspendedWorkspaces(c.var.deps, pageOf(c, "suspendedAt:desc"))));
    })
    .post("/reports/:id/action", requireOperator("moderation.act"), async (c) => {
      const body = await parseBody(c, ReportActionBody);
      const { deps, auth } = c.var;
      const reportId = c.req.param("id");
      const r = await deps.db.select({ orgId: contentReports.orgId, status: contentReports.status, targetUserId: contentReports.targetUserId })
        .from(contentReports).where(eq(contentReports.id, reportId)).get();
      if (!r) throw notFound("Report");
      if (r.status !== "open") throw new HttpError(409, "already_closed", "Someone already acted on this report. Reload the list.");
      if (body.action === "suspend_user") {
        if (!can(c.var.operator?.role, "users.ban")) throw new HttpError(403, "forbidden", "Your operator role can't do that.");
        if (!isFreshSignIn(deps, auth)) {
          throw new HttpError(403, "step_up_required", `Sign in again to do this. It needs a sign in from the last ${deps.config.operator.freshMinutes} minutes.`, { freshMinutes: deps.config.operator.freshMinutes });
        }
        if (r.targetUserId) {
          const target = await deps.db.select({ role: users.role }).from(users).where(eq(users.id, r.targetUserId)).get();
          if (isOperatorRole(target?.role)) throw new HttpError(409, "operator_account", "This person is a platform operator. Remove their operator role before suspending them.");
        }
      }
      const touchesWorkspace = body.action === "remove_message" || body.action === "suspend_user";
      const out = await operatorAction(c, {
        action: REPORT_AUDIT[body.action], targetType: "report", targetId: reportId, orgId: r.orgId, reason: body.reason,
        before: (x: Awaited<ReturnType<typeof actOnReportForConsole>>) => x.before,
        after: (x: Awaited<ReturnType<typeof actOnReportForConsole>>) => x.after,
        metadata: { action: body.action, ...(r.targetUserId ? { targetUserId: r.targetUserId } : {}) },
        workspaceAudit: touchesWorkspace && !!r.orgId,
      }, () => actOnReportForConsole(deps, { userId: auth.userId }, reportId, { action: body.action, note: body.note || body.reason }));
      return c.json({ ok: true, report: out.report });
    })
    .post("/abuse/resolve", requireOperator("moderation.act"), async (c) => {
      const body = await parseBody(c, ResolveBody);
      const { deps } = c.var;
      const org = body.workspace ? await getOrg(deps.db, body.workspace) : null;
      type R = Awaited<ReturnType<typeof resolveAbuseEvents>>;
      const out = await operatorAction(c, {
        action: "abuse.resolved", targetType: org ? "workspace" : "abuse_event", targetId: org ? org.id : body.ids!.length === 1 ? body.ids![0] : undefined,
        orgId: org?.id ?? null, reason: body.reason, before: (x: R) => x.before, after: (x: R) => x.after,
        metadata: org ? { workspace: org.id } : { ids: body.ids!.slice(0, 100), asked: body.ids!.length },
      }, () => resolveAbuseEvents(deps, org ? { orgId: org.id } : { ids: body.ids! }));
      return c.json({ ok: true, resolved: out.after.count });
    })
    .post("/workspaces/:id/suspend", requireOperator("workspaces.suspend"), async (c) => {
      const { reason } = await parseBody(c, z.object({ reason: reasonSchema }));
      const { deps } = c.var;
      const org = await getOrg(deps.db, c.req.param("id"));
      if (org.suspendedAt) throw new HttpError(409, "already_suspended", "This workspace is already suspended.");
      type R = Awaited<ReturnType<typeof suspendWorkspace>>;
      const out = await operatorAction(c, {
        action: "workspace.suspended", targetType: "workspace", targetId: org.id, orgId: org.id, reason,
        before: (x: R) => x.before, after: (x: R) => x.after, workspaceAudit: true,
      }, () => suspendWorkspace(deps, org.id, reason));
      return c.json({ ok: true, suspendedAt: out.after.suspendedAt });
    })
    .post("/workspaces/:id/unsuspend", requireOperator("workspaces.suspend"), async (c) => {
      const { reason } = await parseBody(c, z.object({ reason: reasonSchema }));
      const { deps } = c.var;
      const org = await getOrg(deps.db, c.req.param("id"));
      if (!org.suspendedAt) throw new HttpError(409, "not_suspended", "This workspace isn't suspended.");
      type R = Awaited<ReturnType<typeof unsuspendWorkspace>>;
      const out = await operatorAction(c, {
        action: "workspace.unsuspended", targetType: "workspace", targetId: org.id, orgId: org.id, reason,
        before: (x: R) => x.before, after: (x: R) => ({ ...x.after, resolvedAbuseEvents: x.resolvedAbuseEvents }), workspaceAudit: true,
      }, () => unsuspendWorkspace(deps, org.id));
      return c.json({ ok: true, resolvedAbuseEvents: out.resolvedAbuseEvents });
    });
}
