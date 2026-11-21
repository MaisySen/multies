import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AppEnv } from "../context";
import { parseBody } from "../middleware";
import { abuseEvents, organizations, users } from "../db/schema";
import { audit } from "../services/audit";
import { operatorSession, requireOperator } from "../auth/operator";
import { auditActor, operatorAction, optionalReasonSchema, platformAudit } from "../services/console/audit";
import { platformOverview } from "../services/console/overview";
import { beforeUserDelete } from "../services/privacy";
import { HttpError, notFound } from "../lib/errors";
import { listJobs, queueStats, replayJobs } from "../services/jobs";
import { getOrg } from "../services/plans";
import { inIds } from "../lib/sql-chunks";
import { containsAny } from "../lib/like-search";

/**
 * The older operator API, kept for the moved Overview and scripts with unchanged answers. OPS1: every route checks the
 * operator's permission (src/shared/operator-permissions.ts) through operatorSession, which never applies the operator's
 * own workspace SSO rule or write budget, and every change is written to the platform audit log (an optional reason).
 */
export function adminRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    // QUAL1 (audit row 36): the health detail that used to be public: the release, pending migrations, the account's
    // D1 writes and reads with their budgets and shed levels, the production and staging split and the busiest
    // workspaces (counts only). The public /api/health answers { ok, db } only.
    .get("/health", requireOperator("system.read"), async (c) => {
      const r = await (await import("../services/health")).operatorHealth(c.var.deps);
      c.header("cache-control", "no-store");
      return c.json(r.body, r.status);
    })
    // QUAL1 (audit row 69): the status page with the last 24 hours of mail volume, which the public page no longer shows.
    .get("/status", requireOperator("system.read"), async (c) => {
      const { systemStatus } = await import("../services/status");
      c.header("cache-control", "no-store");
      return c.json(await systemStatus(c.var.deps));
    })
    .get("/overview", requireOperator("overview.read"), async (c) => c.json(await platformOverview(c.var.deps)))
    // Abuse controls: open signals, suspensions and send caps. Every action is audited on the workspace.
    /** Find accounts by email or name (support and clean up). */
    .get("/users", requireOperator("users.read"), async (c) => {
      const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 100);
      const rows = await c.var.deps.db.select({ id: users.id, email: users.email, name: users.name, createdAt: users.createdAt }).from(users)
        .where(q ? containsAny([users.email, users.name], q) : undefined)
        .orderBy(desc(users.createdAt)).limit(50);
      return c.json({ users: rows });
    })
    /**
     * Deletes an account, as DELETE /api/account would for the person: workspaces where they
     * are the only member go with it. Refused (409) while they are the only owner of a shared
     * workspace. Audited.
     */
    .delete("/users/:id", requireOperator("users.delete", { stepUp: true }), async (c) => {
      const { deps, auth } = c.var;
      const { reason } = await parseBody(c, z.object({ reason: optionalReasonSchema }));
      const id = c.req.param("id");
      if (id === auth.userId) throw new HttpError(400, "use_account_delete", "Delete your own account from Settings.");
      const user = await deps.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, id)).get();
      if (!user) throw notFound("User");
      await operatorAction(c, { action: "user.deleted", targetType: "user", targetId: id, reason, before: { email: user.email } }, async () => {
        await beforeUserDelete(deps, id);
        await deps.db.delete(users).where(eq(users.id, id));
      });
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "admin.user_deleted", targetType: "user", targetId: id, metadata: { email: user.email } });
      return c.json({ ok: true });
    })
    .get("/abuse", requireOperator("moderation.read"), async (c) => {
      const { db } = c.var.deps;
      const events = await db.select({
        id: abuseEvents.id, orgId: abuseEvents.orgId, workspace: organizations.name, kind: abuseEvents.kind, score: abuseEvents.score,
        detail: abuseEvents.detail, createdAt: abuseEvents.createdAt,
      }).from(abuseEvents).innerJoin(organizations, eq(organizations.id, abuseEvents.orgId))
        .where(isNull(abuseEvents.resolvedAt)).orderBy(desc(abuseEvents.createdAt)).limit(100);
      return c.json({ events });
    })
    .post("/abuse/resolve", requireOperator("moderation.act"), async (c) => {
      const { ids, reason } = await parseBody(c, z.object({ ids: z.array(z.string().max(64)).min(1).max(500), reason: optionalReasonSchema }));
      await operatorAction(c, { action: "abuse.resolved", targetType: "abuse_event", reason, metadata: { ids: ids.slice(0, 100), count: ids.length } },
        () => c.var.deps.db.update(abuseEvents).set({ resolvedAt: c.var.deps.now() }).where(and(inIds(abuseEvents.id, ids), isNull(abuseEvents.resolvedAt))));
      return c.json({ ok: true });
    })
    .post("/workspaces/:id/suspend", requireOperator("workspaces.suspend"), async (c) => {
      const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(3, "Give a reason; the workspace sees it.").max(300) }));
      const { deps } = c.var;
      const org = await getOrg(deps.db, c.req.param("id"));
      await operatorAction(c, { action: "workspace.suspended", targetType: "workspace", targetId: org.id, orgId: org.id, reason, before: { suspendedAt: org.suspendedAt, suspendedReason: org.suspendedReason }, workspaceAudit: true },
        () => deps.db.update(organizations).set({ suspendedAt: deps.now(), suspendedReason: reason }).where(eq(organizations.id, org.id)));
      return c.json({ ok: true });
    })
    .post("/workspaces/:id/unsuspend", requireOperator("workspaces.suspend"), async (c) => {
      const { reason } = await parseBody(c, z.object({ reason: optionalReasonSchema }));
      const { deps } = c.var;
      const org = await getOrg(deps.db, c.req.param("id"));
      await operatorAction(c, { action: "workspace.unsuspended", targetType: "workspace", targetId: org.id, orgId: org.id, reason, before: { suspendedAt: org.suspendedAt, suspendedReason: org.suspendedReason }, workspaceAudit: true }, async () => {
        await deps.db.update(organizations).set({ suspendedAt: null, suspendedReason: null }).where(eq(organizations.id, org.id));
        await deps.db.update(abuseEvents).set({ resolvedAt: deps.now() }).where(and(eq(abuseEvents.orgId, org.id), isNull(abuseEvents.resolvedAt)));
      });
      return c.json({ ok: true });
    })
    .put("/workspaces/:id/send-cap", requireOperator("workspaces.limits"), async (c) => {
      const { cap, reason } = await parseBody(c, z.object({ cap: z.number().int().min(0).max(1_000_000).nullable(), reason: optionalReasonSchema }));
      const { deps } = c.var;
      const org = await getOrg(deps.db, c.req.param("id"));
      await operatorAction(c, { action: "workspace.send_cap_changed", targetType: "workspace", targetId: org.id, orgId: org.id, reason, before: { cap: org.sendCapDaily }, after: { cap }, metadata: { cap }, workspaceAudit: true },
        () => deps.db.update(organizations).set({ sendCapDaily: cap }).where(eq(organizations.id, org.id)));
      return c.json({ ok: true, sendCapDaily: cap });
    })
    // R34 (MB-169): the per-workspace kill switch. Off = sendCapDaily 0 (sends refused with a clear message);
    // on = back to the plan's cap (null). Audited.
    .put("/workspaces/:id/sending", requireOperator("workspaces.limits"), async (c) => {
      const { enabled, reason } = await parseBody(c, z.object({ enabled: z.boolean(), reason: optionalReasonSchema }));
      const { deps } = c.var;
      const org = await getOrg(deps.db, c.req.param("id"));
      const cap = enabled ? null : 0;
      await operatorAction(c, { action: enabled ? "workspace.sending_on" : "workspace.sending_off", targetType: "workspace", targetId: org.id, orgId: org.id, reason, before: { cap: org.sendCapDaily }, after: { cap }, workspaceAudit: true },
        () => deps.db.update(organizations).set({ sendCapDaily: cap }).where(eq(organizations.id, org.id)));
      return c.json({ ok: true, sending: enabled, sendCapDaily: cap });
    })
    // R34 (MB-166): messages a sending limit queued until tomorrow, and "Send anyway" (operator only).
    .get("/workspaces/:id/queued-sends", requireOperator("workspaces.read"), async (c) => {
      const { listQueuedSends } = await import("../services/mail/send-queue-r34");
      return c.json({ queued: await listQueuedSends(c.var.deps, c.req.param("id")) });
    })
    .post("/workspaces/:id/queued-sends/:sid/send", requireOperator("workspaces.limits"), async (c) => {
      const { sendQueuedAnyway } = await import("../services/mail/send-queue-r34");
      const { reason } = await parseBody(c, z.object({ reason: optionalReasonSchema }));
      const { deps } = c.var;
      const orgId = c.req.param("id");
      const out = await operatorAction(c, { action: "message.queued_send_forced", targetType: "schedule", targetId: c.req.param("sid"), orgId, reason, workspaceAudit: true },
        () => sendQueuedAnyway(deps, orgId, c.req.param("sid")));
      return c.json(out);
    })
    // R34 (MB-171): a workspace's call minutes a month. null goes back to the plan's rule (free 1,000, paid none); 0 blocks new calls.
    .put("/workspaces/:id/meeting-cap", requireOperator("workspaces.limits"), async (c) => {
      const { cap, reason } = await parseBody(c, z.object({ cap: z.number().int().min(0).max(10_000_000).nullable(), reason: optionalReasonSchema }));
      const { deps } = c.var;
      const org = await getOrg(deps.db, c.req.param("id"));
      await operatorAction(c, { action: "workspace.meeting_cap_changed", targetType: "workspace", targetId: org.id, orgId: org.id, reason, before: { cap: org.meetingMinutesCap }, after: { cap }, metadata: { cap }, workspaceAudit: true },
        () => deps.db.update(organizations).set({ meetingMinutesCap: cap }).where(eq(organizations.id, org.id)));
      return c.json({ ok: true, meetingMinutesCap: cap });
    })
    // Job queue: backlog, dead letters and replay.
    .get("/jobs", requireOperator("jobs.read"), async (c) => {
      const { deps } = c.var;
      const [stats, dead] = await Promise.all([queueStats(deps), listJobs(deps, "dead", 50)]);
      return c.json({ stats, dead: dead.map((j) => ({ id: j.id, type: j.type, orgId: j.orgId, attempts: j.attempts, lastError: j.lastError, updatedAt: j.updatedAt })) });
    })
    .post("/jobs/replay", requireOperator("jobs.manage"), async (c) => {
      const { ids, reason } = await parseBody(c, z.object({ ids: z.array(z.string().max(64)).min(1).max(500), reason: optionalReasonSchema }));
      const replayed = await operatorAction(c, { action: "jobs.replayed", targetType: "job", reason, metadata: { ids: ids.slice(0, 100), count: ids.length }, after: (n: number) => ({ replayed: n }) },
        () => replayJobs(c.var.deps, ids));
      return c.json({ replayed });
    })
    /** Sends one test error to Sentry, to check error tracking end to end. */
    .post("/sentry-test", requireOperator("system.manage"), async (c) => {
      const { deps } = c.var;
      if (!deps.config.sentry.dsnApi || !deps.reportError) return c.json({ configured: false, eventId: null });
      const eventId = deps.reportError(new Error(`Multies API test event (${new Date().toISOString()})`), { test: true, by: c.var.auth.email });
      await platformAudit(deps.db, { ...auditActor(c), action: "system.sentry_test", metadata: { eventId: eventId ?? null } });
      return c.json({ configured: true, eventId: eventId ?? null });
    });
}
