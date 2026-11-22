/**
 * OPS1: /api/console/impersonation, "View as" a person. Mounted by routes/console/index.ts.
 *
 * GET  /                 impersonation.read             active and recent sessions ({ items, nextCursor }); ?status=active|ended,
 *                                                        ?operator=<userId>, ?target=<userId>, ?orgId=, plus q, limit, cursor, sort.
 * POST /                 impersonation.view (stepUp)    { userId, orgId?, mode: "view" | "act", reason }; act also needs
 *                                                        impersonation.act. Opens a 30 minute session as the person in THIS
 *                                                        browser (Set-Cookie forwarded) and writes the platform audit row and a
 *                                                        support.session_started row in the person's workspace.
 * POST /stop             the impersonated session       back to the operator's own session (or signed out when that is gone).
 *                                                        The one console route an impersonated session reaches (auth/operator.ts).
 * POST /:id/end          impersonation.act              ends someone's session from the console (ops_admin and owner), { reason }.
 *
 * What an impersonated session may do is in services/console/impersonation.ts (enforced by requireAuth and the Better Auth
 * hook in auth/options.ts). Better Auth's own /api/auth/admin/* stays 404 over HTTP; this file calls it in process.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv, AuthContext } from "../../context";
import { parseBody, parseQuery } from "../../middleware";
import { operatorSession, requireOperator } from "../../auth/operator";
import { authFor } from "../../auth/options";
import { clearAuthCache, forgetCachedAuth } from "../../auth/guards";
import { authHeaders } from "../../lib/host-cookie";
import { HttpError, notFound, unauthorized } from "../../lib/errors";
import { newId } from "../../lib/crypto";
import { operatorImpersonations, sessions, users } from "../../db/schema";
import { audit } from "../../services/audit";
import { auditActor, operatorAction, platformAudit, reasonSchema } from "../../services/console/audit";
import {
  closeImpersonationSockets, endImpersonationRow, IMPERSONATION_SECONDS, impersonationBySession, listImpersonations, membershipsOf, type ImpersonationEndReason,
} from "../../services/console/impersonation";
import { can, isOperatorRole, type Permission } from "@/shared/operator-permissions";

const StartBody = z.object({
  userId: z.string().trim().min(1, "Pick a person.").max(100),
  orgId: z.string().trim().min(1).max(100).optional(),
  mode: z.enum(["view", "act"]).default("view"),
  reason: reasonSchema,
});

const ListQuery = z.object({
  status: z.enum(["active", "ended", "all"]).optional(),
  operator: z.string().trim().max(100).optional(),
  target: z.string().trim().max(100).optional(),
  orgId: z.string().trim().max(100).optional(),
}).passthrough();

const prod = (c: Context<AppEnv>) => c.var.deps.config.mode === "production";

/** One Set-Cookie line that removes a cookie (same name, path and security as Better Auth set it). */
function expireCookieLine(name: string, attrs: { path?: string; secure?: boolean; sameSite?: string | boolean; httpOnly?: boolean } = {}): string {
  const parts = [`${name}=`, "Max-Age=0", `Path=${attrs.path ?? "/"}`];
  if (attrs.httpOnly !== false) parts.push("HttpOnly");
  if (attrs.secure) parts.push("Secure");
  const same = typeof attrs.sameSite === "string" ? attrs.sameSite : "Lax";
  parts.push(`SameSite=${same[0].toUpperCase()}${same.slice(1).toLowerCase()}`);
  return parts.join("; ");
}

/**
 * The Stop route's guard. The console router has already run operatorSession, which lets only this path through for an
 * impersonated session. A normal operator session needs impersonation.view (it gets a 400: nothing to stop); the
 * permission is on the guard so the console RBAC test lists it like every other route.
 */
const stopGuard: MiddlewareHandler<AppEnv> & { permission: Permission; stepUp: boolean } = Object.assign(
  (async (c, next) => {
    const auth = c.var.auth as AuthContext | undefined;
    if (!auth) throw unauthorized();
    if (!auth.impersonatedBy && !can(c.var.operator?.role, "impersonation.view")) throw new HttpError(403, "forbidden", "Your operator role can't do that.");
    await next();
  }) as MiddlewareHandler<AppEnv>,
  { permission: "impersonation.view" as Permission, stepUp: false },
);

export function impersonationRoutes() {
  return new Hono<AppEnv>()
    // No blanket operatorSession here: Stop is reached by an impersonated session. Every other route takes it itself
    // (the console router already ran it, so it is a no-op there).
    .get("/", operatorSession, requireOperator("impersonation.read"), async (c) => {
      const f = parseQuery(c, ListQuery);
      c.header("cache-control", "no-store");
      const status = f.status === "all" ? undefined : f.status;
      return c.json(await listImpersonations(c.var.deps.db, c.req.query(), { status, operator: f.operator || undefined, target: f.target || undefined, orgId: f.orgId || undefined }, c.var.deps.now()));
    })

    .post("/stop", stopGuard, async (c) => {
      const auth = c.var.auth;
      const { deps } = c.var;
      if (!auth.impersonatedBy) throw new HttpError(400, "not_impersonating", "You are not viewing as anyone right now.");
      const ba = authFor(deps);
      const actx = await ba.$context;
      const headers = authHeaders(c.req.raw.headers, prod(c));
      const row = await impersonationBySession(deps.db, auth.sessionId);
      let reason: ImpersonationEndReason = "stopped";
      let signedOut = false;
      const res = await ba.api.stopImpersonating({ headers, asResponse: true });
      const lines = res.ok ? res.headers.getSetCookie() : [];
      for (const line of lines) c.header("set-cookie", line, { append: true });
      if (!res.ok) {
        // The operator's own session is gone (revoked or expired): Better Auth answers 500 and keeps the impersonation
        // session. End it here and sign this browser out.
        const s = await deps.db.select({ token: sessions.token }).from(sessions).where(eq(sessions.id, auth.sessionId)).get();
        if (s) await actx.internalAdapter.deleteSession(s.token);
        await deps.db.delete(sessions).where(eq(sessions.id, auth.sessionId));
        const { sessionToken, sessionData } = actx.authCookies;
        c.header("set-cookie", expireCookieLine(sessionToken.name, sessionToken.attributes), { append: true });
        c.header("set-cookie", expireCookieLine(sessionData.name, sessionData.attributes), { append: true });
        const admin = actx.createAuthCookie("admin_session");
        c.header("set-cookie", expireCookieLine(admin.name, admin.attributes), { append: true });
        reason = "operator_session_gone";
        signedOut = true;
      }
      // Better Auth leaves the impersonation's dont_remember cookie behind; unless Stop just set it again for the
      // operator's own session, remove it so their session keeps rolling as before.
      const dr = actx.authCookies.dontRememberToken;
      const restoredDontRemember = lines.some((l) => l.startsWith(`${dr.name}=`) && !/^[^=]+=;/.test(l) && !/max-age=0/i.test(l));
      if (!restoredDontRemember) c.header("set-cookie", expireCookieLine(dr.name, dr.attributes), { append: true });

      const now = deps.now();
      if (row) await endImpersonationRow(deps.db, row.id, reason, now);
      await closeImpersonationSockets(deps, { sessionId: auth.sessionId, targetUserId: auth.userId }); // OPS1 security (L2)
      const operator = await deps.db.select({ id: users.id, email: users.email, role: users.role }).from(users).where(eq(users.id, auth.impersonatedBy)).get();
      await platformAudit(deps.db, {
        actorUserId: auth.impersonatedBy, actorEmail: operator?.email ?? row?.operatorEmail ?? null, actorRole: operator?.role ?? null,
        ip: c.var.ip ?? null, userAgent: c.req.header("user-agent") ?? null, requestId: c.var.requestId ?? null,
        action: "impersonation.stopped", targetType: "user", targetId: auth.userId, orgId: row?.targetOrgId ?? auth.orgId,
        metadata: { mode: row?.mode ?? null, endedReason: reason }, impersonationId: row?.id ?? null,
      });
      const orgId = row?.targetOrgId ?? auth.orgId;
      if (orgId) {
        await audit(deps.db, {
          orgId, actorUserId: auth.impersonatedBy, actorEmail: operator?.email ?? row?.operatorEmail ?? null, action: "support.session_ended",
          targetType: "user", targetId: auth.userId, metadata: { by: "operator", email: auth.email, mode: row?.mode ?? null, endedReason: reason }, ip: c.var.ip,
        });
      }
      forgetCachedAuth(c.req.raw.headers);
      clearAuthCache();
      return c.json({ ok: true, signedOut, returnTo: `/console/users/${encodeURIComponent(auth.userId)}` });
    })

    .post("/", operatorSession, requireOperator("impersonation.view", { stepUp: true }), async (c) => {
      const body = await parseBody(c, StartBody);
      const { deps } = c.var;
      const op = c.var.auth;
      const role = c.var.operator?.role;
      if (body.mode === "act" && !can(role, "impersonation.act")) {
        throw new HttpError(403, "forbidden", "Your operator role can view as a person, but not act as them.");
      }
      if (body.userId === op.userId) throw new HttpError(400, "cannot_impersonate_self", "You can't view as yourself.");
      const target = await deps.db.select().from(users).where(eq(users.id, body.userId)).get();
      if (!target) throw notFound("Person");
      // Operators are never targets (the plugin refuses them too, as admin roles), nor anyone the bootstrap list would
      // make an operator on their next sign in.
      const listed = deps.config.platformAdmins.includes(target.id.toLowerCase()) || deps.config.platformAdmins.includes(target.email.toLowerCase());
      if (isOperatorRole(target.role) || listed) throw new HttpError(403, "cannot_impersonate_operator", "Operators can't be viewed as. Ask them to share their screen instead.");
      const now = deps.now();
      if (target.banned && (!target.banExpires || target.banExpires.getTime() > now.getTime())) {
        throw new HttpError(409, "user_banned", "This person is banned. Unban them first if you need to view as them.");
      }
      const orgIds = await membershipsOf(deps.db, target.id);
      if (body.orgId && !orgIds.includes(body.orgId)) throw new HttpError(404, "not_a_member", "This person is not a member of that workspace.");
      if (!orgIds.length) throw new HttpError(409, "no_workspace", "This person has no workspace yet, so there is nothing to view.");

      const ba = authFor(deps);
      const res = await ba.api.impersonateUser({ headers: authHeaders(c.req.raw.headers, prod(c)), body: { userId: target.id }, asResponse: true });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { message?: string } | null;
        deps.log?.warn?.("impersonation.start_failed", { status: res.status, error: String(err?.message ?? "").slice(0, 200) });
        if (res.status === 403) throw new HttpError(403, "forbidden", "This person can't be viewed as.");
        throw new HttpError(502, "impersonation_failed", "Couldn't start the session. Try again.");
      }
      const out = (await res.json()) as { session: { id: string; token: string; expiresAt: string | Date; activeOrganizationId?: string | null } };
      const session = out.session;
      // Our own expiry: never later than Better Auth's, never more than 30 minutes from now.
      const expiresAt = new Date(Math.min(new Date(session.expiresAt).getTime(), now.getTime() + IMPERSONATION_SECONDS * 1000));
      const orgId = body.orgId ?? (session.activeOrganizationId && orgIds.includes(session.activeOrganizationId) ? session.activeOrganizationId : orgIds[0]);
      const id = newId("imp");
      try {
        await deps.db.insert(operatorImpersonations).values({
          id, operatorUserId: op.userId, operatorEmail: op.email, targetUserId: target.id, targetOrgId: orgId, sessionId: session.id,
          mode: body.mode, reason: body.reason, startedAt: now, expiresAt,
        });
        if (session.activeOrganizationId !== orgId) await deps.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.id, session.id));
      } catch (err) {
        // No row means the session would be refused anyway; remove it now and keep the operator's own cookies.
        await (await ba.$context).internalAdapter.deleteSession(session.token).catch(() => undefined);
        throw err;
      }
      await platformAudit(deps.db, {
        ...auditActor(c), action: "impersonation.started", targetType: "user", targetId: target.id, orgId, reason: body.reason,
        after: { mode: body.mode, expiresAt: expiresAt.toISOString() }, impersonationId: id,
      });
      // The customer's own activity log says support opened their account, when, by whom, how and why.
      await audit(deps.db, {
        orgId, actorUserId: op.userId, actorEmail: op.email, action: "support.session_started", targetType: "user", targetId: target.id,
        metadata: { by: "operator", email: target.email, mode: body.mode, expiresAt: expiresAt.toISOString(), reason: body.reason }, ip: c.var.ip,
      });
      // Every cookie Better Auth set: the operator's session moves to admin_session, the new session cookie, and
      // dont_remember (without it the 30 minute session would roll forward to 30 days).
      for (const line of res.headers.getSetCookie()) c.header("set-cookie", line, { append: true });
      return c.json({ ok: true, impersonation: { id, mode: body.mode, expiresAt: expiresAt.toISOString(), userId: target.id, orgId } }, 201);
    })

    .post("/:id/end", operatorSession, requireOperator("impersonation.act"), async (c) => {
      const { reason } = await parseBody(c, z.object({ reason: reasonSchema }));
      const { deps } = c.var;
      const row = await deps.db.select().from(operatorImpersonations).where(eq(operatorImpersonations.id, c.req.param("id"))).get();
      if (!row) throw notFound("Session");
      const now = deps.now();
      if (row.endedAt || row.expiresAt.getTime() <= now.getTime()) throw new HttpError(409, "already_ended", "That session has already ended.");
      await operatorAction(c, {
        action: "impersonation.ended", targetType: "user", targetId: row.targetUserId, orgId: row.targetOrgId, reason,
        before: { mode: row.mode, operatorUserId: row.operatorUserId, expiresAt: row.expiresAt.toISOString() }, after: { endedReason: "revoked" },
        metadata: { impersonationId: row.id }, workspaceAudit: { action: "support.session_ended", metadata: { endedReason: "revoked", email: (await deps.db.select({ email: users.email }).from(users).where(eq(users.id, row.targetUserId)).get())?.email ?? null } },
      }, async () => {
        if (row.sessionId) await deps.db.delete(sessions).where(and(eq(sessions.id, row.sessionId), eq(sessions.userId, row.targetUserId)));
        await endImpersonationRow(deps.db, row.id, "revoked", now);
      });
      await closeImpersonationSockets(deps, row); // OPS1 security (L2): its live sockets end with it
      // The 15 second read cache in this isolate must not keep answering for the ended session.
      clearAuthCache();
      return c.json({ ok: true });
    });
}

