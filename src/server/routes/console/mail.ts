/**
 * OPS1: /api/console/mail, Mail and deliverability. Mounted by routes/console/index.ts.
 *
 * Reads (mail.read), each { items, nextCursor } with ?limit=&cursor=&sort=field:dir (an unknown sort field is a 400):
 *   GET /deliveries      ?status=a,b&orgId=&direction=inbound|outbound&window=<days>  default: failures, last 7 days.
 *                        No subject, body or addresses: status, direction, workspace, provider, error detail, time.
 *   GET /failure-rates   ?window=<days>&limit=  { items } worst outbound failure rate first (no paging)
 *   GET /domains         ?status=a,b&orgId=&q=
 *   GET /suppressions    ?reason=a,b&orgId=&q=&window=<days>  (default last 30 days without orgId)
 *   GET /queued-sends    ?orgId=   messages a sending limit held (no subject, body or recipients)
 *   GET /connections     ?status=a,b&orgId=&q=   connected outside mailboxes (never credentials)
 *   GET /imports         ?status=a,b&orgId=&window=<days>
 * Changes, each with { reason } and one platform audit row (plus the workspace's own audit row):
 *   DELETE /suppressions/:id            mail.manage         mail.suppression_removed
 *   POST   /domains/:id/recheck         mail.manage         mail.domain_rechecked
 *   POST   /queued-sends/:id/send       mail.manage         mail.queued_send_forced
 *   PUT    /workspaces/:id/sending      workspaces.limits   workspace.sending_on | workspace.sending_off  { enabled, reason }
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context";
import { parseBody, parseQuery } from "../../middleware";
import { operatorSession, requireOperator } from "../../auth/operator";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import { decodeCursor, encodeCursor } from "../../services/console/listing";
import {
  DELIVERY_STATUSES, deliveryFailureRateByWorkspace, forceQueuedSend, getDomainRef, getQueuedSendRef, getSuppression,
  listDeliveries, listDomains, listImportJobs, listMailConnections, listQueuedSendsAll, listSuppressions, recheckDomain,
  removeSuppression, setWorkspaceSending, WINDOW_MAX_DAYS, type Page, type PageCursor, type PageRequest, type TimeWindow,
} from "../../services/console/mail";

const DAY = 86_400_000;
const DOMAIN_STATUSES = ["pending", "verified", "failed"] as const;
const SUPPRESSION_REASONS = ["hard_bounce", "complaint", "manual"] as const;
const CONNECTION_STATUSES = ["active", "syncing", "auth_failed", "error", "paused"] as const;
const IMPORT_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;

/** Ids are short opaque strings; anything else can't name a row. */
const idOk = (id: string) => /^[A-Za-z0-9_-]{1,100}$/.test(id);
function idParam(c: Context<AppEnv>, what: string): string {
  const id = c.req.param("id") ?? "";
  if (!idOk(id)) throw notFound(what);
  return id;
}

/** "a,b" checked against a list of allowed values (an unknown one is a 400 naming it). */
function csv<T extends string>(raw: string | undefined, allowed: readonly T[], what: string): T[] | undefined {
  const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  for (const p of parts) if (!(allowed as readonly string[]).includes(p)) throw badRequest(`Unknown ${what} "${p.slice(0, 40)}".`);
  return parts as T[];
}

const ListQuery = z.object({
  limit: z.string().max(6).optional(),
  cursor: z.string().max(500).optional(),
  sort: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
  orgId: z.string().trim().max(100).optional(),
  window: z.string().max(4).optional(),
}).passthrough();

/** Phase 0's list query (?limit, ?cursor, ?sort=field:dir) as the data layer's page request. */
function pageOf(c: Context<AppEnv>, defaultSort: `${string}:${"asc" | "desc"}`) {
  const qy = parseQuery(c, ListQuery);
  const n = Number.parseInt(qy.limit ?? "", 10);
  const [defField, defDir] = defaultSort.split(":") as [string, "asc" | "desc"];
  const [field, dir] = (qy.sort || defaultSort).split(":");
  if (dir !== undefined && dir !== "asc" && dir !== "desc") throw badRequest("Sort as field:asc or field:desc.");
  let cursor: PageCursor | null = null;
  if (qy.cursor) {
    const d = decodeCursor(qy.cursor);
    cursor = { v: d.sort instanceof Date ? d.sort.getTime() : d.sort, id: d.id };
  }
  const page: PageRequest = { limit: Number.isFinite(n) && n > 0 ? n : 50, cursor, sort: { field: field || defField, dir: (dir as "asc" | "desc" | undefined) ?? defDir } };
  const orgId = qy.orgId || undefined;
  if (orgId && !idOk(orgId)) throw badRequest("That workspace id is not valid.");
  return { page, q: qy.q?.trim().slice(0, 100) || undefined, orgId, window: windowOf(c, qy.window) };
}

/** ?window=<days> as a time range ending now (1 to 90 days). */
function windowOf(c: Context<AppEnv>, raw: string | undefined): TimeWindow | undefined {
  if (!raw) return undefined;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > WINDOW_MAX_DAYS) throw badRequest(`Pick a time range of 1 to ${WINDOW_MAX_DAYS} days.`);
  return { from: new Date(c.var.deps.now().getTime() - days * DAY) };
}

/** The data layer's { items, next } as the console's { items, nextCursor }. */
function out<T>(p: Page<T>) {
  return { items: p.items, nextCursor: p.next ? encodeCursor(p.next.v, p.next.id) : null };
}

const SendingBody = z.object({ enabled: z.boolean({ error: "Say whether sending is on or off." }), reason: reasonSchema });
const ReasonBody = z.object({ reason: reasonSchema });

export function mailRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); })
    .get("/deliveries", requireOperator("mail.read"), async (c) => {
      const { page, orgId, window } = pageOf(c, "createdAt:desc");
      const dir = c.req.query("direction") || undefined;
      if (dir && dir !== "inbound" && dir !== "outbound") throw badRequest("Direction is inbound or outbound.");
      const direction = dir as "inbound" | "outbound" | undefined;
      const status = csv(c.req.query("status"), DELIVERY_STATUSES, "delivery status");
      const p = await listDeliveries(c.var.deps, { status, orgId, direction, window }, page);
      // No addresses: the console shows what happened, not who wrote to whom.
      return c.json(out({ ...p, items: p.items.map((d) => ({ id: d.id, orgId: d.orgId, orgName: d.orgName, direction: d.direction, status: d.status, provider: d.provider, detail: d.detail, createdAt: d.createdAt })) }));
    })
    .get("/failure-rates", requireOperator("mail.read"), async (c) => {
      const { window } = pageOf(c, "createdAt:desc");
      const n = Number.parseInt(c.req.query("limit") ?? "", 10);
      return c.json({ items: await deliveryFailureRateByWorkspace(c.var.deps, { window, limit: Number.isFinite(n) && n > 0 ? n : 10 }) });
    })
    .get("/domains", requireOperator("mail.read"), async (c) => {
      const { page, q, orgId } = pageOf(c, "createdAt:desc");
      const status = csv(c.req.query("status"), DOMAIN_STATUSES, "domain state");
      return c.json(out(await listDomains(c.var.deps, { status, orgId, q }, page)));
    })
    .get("/suppressions", requireOperator("mail.read"), async (c) => {
      const { page, q, orgId, window } = pageOf(c, "createdAt:desc");
      const reason = csv(c.req.query("reason"), SUPPRESSION_REASONS, "reason");
      return c.json(out(await listSuppressions(c.var.deps, { reason, orgId, q, window }, page)));
    })
    .get("/queued-sends", requireOperator("mail.read"), async (c) => {
      const { page, orgId } = pageOf(c, "dueAt:asc");
      return c.json(out(await listQueuedSendsAll(c.var.deps, { orgId }, page)));
    })
    .get("/connections", requireOperator("mail.read"), async (c) => {
      const { page, q, orgId } = pageOf(c, "createdAt:desc");
      const status = csv(c.req.query("status"), CONNECTION_STATUSES, "connection state");
      return c.json(out(await listMailConnections(c.var.deps, { status, orgId, q }, page)));
    })
    .get("/imports", requireOperator("mail.read"), async (c) => {
      const { page, orgId, window } = pageOf(c, "createdAt:desc");
      const status = csv(c.req.query("status"), IMPORT_STATUSES, "import state");
      return c.json(out(await listImportJobs(c.var.deps, { status, orgId, window }, page)));
    })
    .delete("/suppressions/:id", requireOperator("mail.manage"), async (c) => {
      const { reason } = await parseBody(c, ReasonBody);
      const s = await getSuppression(c.var.deps, idParam(c, "Suppressed address"));
      await operatorAction(c, {
        action: "mail.suppression_removed", targetType: "suppression", targetId: s.id, orgId: s.orgId, reason,
        before: { address: s.address, reason: s.reason }, after: { suppressed: false }, workspaceAudit: true,
      }, () => removeSuppression(c.var.deps, s.id));
      return c.json({ ok: true, id: s.id });
    })
    .post("/domains/:id/recheck", requireOperator("mail.manage"), async (c) => {
      const { reason } = await parseBody(c, ReasonBody);
      const d = await getDomainRef(c.var.deps, idParam(c, "Domain"));
      type R = Awaited<ReturnType<typeof recheckDomain>>;
      const r = await operatorAction(c, {
        action: "mail.domain_rechecked", targetType: "domain", targetId: d.id, orgId: d.orgId, reason,
        before: { name: d.name, status: d.status }, after: (x: R) => ({ status: x.status, verified: x.verified, failingRecords: x.failingRecords }),
        workspaceAudit: true,
      }, () => recheckDomain(c.var.deps, d.id));
      return c.json({ ok: true, id: r.id, status: r.status, verified: r.verified, changed: r.changed, failingRecords: r.failingRecords });
    })
    .post("/queued-sends/:id/send", requireOperator("mail.manage"), async (c) => {
      const { reason } = await parseBody(c, ReasonBody);
      const s = await getQueuedSendRef(c.var.deps, idParam(c, "Queued message"));
      if (s.status === "returned") throw conflict("That message has already gone out.");
      const r = await operatorAction(c, {
        action: "mail.queued_send_forced", targetType: "schedule", targetId: s.id, orgId: s.orgId, reason,
        before: { status: s.status, dueAt: s.dueAt.toISOString() }, after: (x: { dueAt: string }) => ({ status: "pending", dueAt: x.dueAt, force: true }),
        workspaceAudit: true,
      }, () => forceQueuedSend(c.var.deps, s.orgId, s.id));
      return c.json({ ok: true, id: r.id, dueAt: r.dueAt });
    })
    .put("/workspaces/:id/sending", requireOperator("workspaces.limits"), async (c) => {
      const { enabled, reason } = await parseBody(c, SendingBody);
      const orgId = idParam(c, "Workspace");
      type R = Awaited<ReturnType<typeof setWorkspaceSending>>;
      const r = await operatorAction(c, {
        action: enabled ? "workspace.sending_on" : "workspace.sending_off", targetType: "workspace", targetId: orgId, orgId, reason,
        before: (x: R) => ({ cap: x.before.sendCapDaily }), after: (x: R) => ({ cap: x.sendCapDaily }), workspaceAudit: true,
      }, () => setWorkspaceSending(c.var.deps, orgId, enabled));
      return c.json({ ok: true, sending: r.sending, sendCapDaily: r.sendCapDaily });
    });
}
