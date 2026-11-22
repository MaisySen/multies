/**
 * OPS1: guards for the operator console (/api/console) and the older operator routes (/api/admin).
 *
 * operatorSession reads the session afresh on every request (no in-isolate copy, so a role change or a revoked
 * session shows at once), and, unlike requireAuth, never applies the operator's own workspace rules: no SSO block and
 * no workspace write budget (those protect a customer workspace, not the platform). It refuses:
 * - no session (401), an impersonation session (403 impersonating), anyone without an operator role (403 forbidden);
 * - an operator without two-step sign in or an approved SSO sign in, when config.operator.requireTwoFactor is on
 *   (production by default, or OPERATOR_REQUIRE_2FA=on) (403 two_factor_required);
 * - OPS1 security (M2): with that rule on, a session created at or before the account's two-step enrolment (it never
 *   asked for the second step; auth/two-factor-enrolment.ts) (403 two_factor_required, "sign in again").
 *
 * requireOperator(permission, { stepUp }) then checks the role's permission (403 forbidden), and with stepUp asks for a
 * sign in within config.operator.freshMinutes (403 step_up_required; the console offers to sign in again).
 *
 * The returned middleware carries `permission` and `stepUp` so tests can list every console route's rule
 * (tests/console-rbac.test.ts).
 */
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, AuthContext, Deps } from "../context";
import { HttpError, unauthorized } from "../lib/errors";
import { noteRequestCaller } from "../lib/request-caller";
import { resolveAuth } from "./guards";
import { can, isOperatorRole, type OperatorRole, type Permission } from "@/shared/operator-permissions";
import { IMPERSONATION_STOP_PATH } from "../services/console/impersonation"; // OPS1 impersonation
import { sessionPostdatesEnrolment } from "./two-factor-enrolment"; // OPS1 security (M2)

export const NOT_OPERATOR_MESSAGE = "Only platform operators can do that.";

/** Whether this operator's sign in meets the console's two-step rule. */
export function meetsTwoFactorRule(deps: Pick<Deps, "config">, auth: Pick<AuthContext, "twoFactor" | "loginMethod">): boolean {
  if (!deps.config.operator.requireTwoFactor) return true;
  if (auth.twoFactor) return true;
  const method = (auth.loginMethod ?? "").toLowerCase();
  return !!method && deps.config.operator.ssoMethods.includes(method);
}

/** True when the console's two-step rule is met by the account's two-step sign in (not by an approved SSO method). */
function twoFactorRuleApplies(deps: Pick<Deps, "config">, auth: Pick<AuthContext, "twoFactor" | "loginMethod">): boolean {
  if (!deps.config.operator.requireTwoFactor || !auth.twoFactor) return false;
  const method = (auth.loginMethod ?? "").toLowerCase();
  return !(method && deps.config.operator.ssoMethods.includes(method));
}

/** True when the session signed in within the fresh window. */
export function isFreshSignIn(deps: Pick<Deps, "config" | "now">, auth: Pick<AuthContext, "sessionCreatedAt">): boolean {
  if (!auth.sessionCreatedAt) return false;
  const age = deps.now().getTime() - auth.sessionCreatedAt.getTime();
  return age <= deps.config.operator.freshMinutes * 60_000;
}

/*
 * OPS1 security review L4 (a): a refused privileged attempt on a console change (403 forbidden from requireOperator,
 * step_up_required, impersonating, two_factor_required) writes one platform audit row "access.denied" with the
 * permission, method and path (never the body). Reads are not logged. At most one row per operator per route per
 * minute, and at most DENIED_PER_MINUTE rows per operator per minute, in this isolate's memory, so one client cannot
 * flood the table. An account with no operator role is not logged (anyone can make one).
 */
const DENIED_WINDOW_MS = 60_000;
const DENIED_PER_MINUTE = 20;
const DENIED_KEYS_MAX = 5_000;
const deniedSeen = new Map<string, number>();
const deniedCount = new Map<string, { n: number; since: number }>();

/** Test hook: forgets the rate limit of access.denied rows. */
export function resetDeniedLog() { deniedSeen.clear(); deniedCount.clear(); }

async function recordDenied(c: Context<AppEnv>, auth: AuthContext, code: string, permission?: Permission): Promise<void> {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return;
  const actorId = auth.impersonatedBy ?? auth.userId;
  if (!actorId) return;
  const now = Date.now();
  const route = c.req.routePath && c.req.routePath !== "/*" ? c.req.routePath : c.req.path;
  const key = `${actorId}|${c.req.method} ${route}`;
  const last = deniedSeen.get(key);
  if (last !== undefined && now - last < DENIED_WINDOW_MS) return;
  const cnt = deniedCount.get(actorId);
  if (cnt && now - cnt.since < DENIED_WINDOW_MS) {
    if (cnt.n >= DENIED_PER_MINUTE) return;
    cnt.n++;
  } else {
    deniedCount.set(actorId, { n: 1, since: now });
  }
  if (deniedSeen.size >= DENIED_KEYS_MAX) deniedSeen.delete(deniedSeen.keys().next().value as string);
  if (deniedCount.size >= DENIED_KEYS_MAX) deniedCount.delete(deniedCount.keys().next().value as string);
  deniedSeen.set(key, now);
  try {
    const { platformAudit } = await import("../services/console/audit");
    await platformAudit(c.var.deps.db, {
      actorUserId: actorId, actorEmail: auth.impersonatedBy ? null : auth.email, actorRole: auth.impersonatedBy ? null : auth.platformRole ?? null,
      ip: c.var.ip ?? null, userAgent: c.req.header("user-agent") ?? null, requestId: c.var.requestId ?? null,
      action: "access.denied", targetType: "route", targetId: `${c.req.method} ${route}`.slice(0, 200),
      metadata: { code, permission: permission ?? null, method: c.req.method, path: c.req.path.slice(0, 300), ...(auth.impersonatedBy ? { impersonating: auth.userId } : {}) },
    });
  } catch (err) {
    c.var.deps.reportError?.(err, { where: "console.access_denied" });
  }
}

/** Resolves and checks the operator for this request, once (a second call in the same request is a no-op). */
export const operatorSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.operator) return next();
  const auth = await resolveAuth(c.var.deps, c.req.raw.headers);
  if (!auth) throw unauthorized();
  // OPS1 impersonation: Stop is the one console route an impersonated session reaches; it is not an operator here
  // (c.var.operator stays unset) and the route's own guard checks the session (routes/console/impersonation.ts).
  if (auth.impersonatedBy && c.req.method === "POST" && c.req.path === IMPERSONATION_STOP_PATH) {
    c.set("auth", auth);
    noteRequestCaller(auth);
    return next();
  }
  c.set("auth", auth); // OPS1 security (L4): the access log names who asked, refused or not (app.ts reads it back)
  if (auth.impersonatedBy) {
    await recordDenied(c, auth, "impersonating");
    throw new HttpError(403, "impersonating", "Stop viewing as this person first. The operator console is not available while you view as someone else.");
  }
  if (!isOperatorRole(auth.platformRole)) throw new HttpError(403, "forbidden", NOT_OPERATOR_MESSAGE);
  if (!meetsTwoFactorRule(c.var.deps, auth)) {
    await recordDenied(c, auth, "two_factor_required");
    throw new HttpError(403, "two_factor_required", "Turn on two-step sign in for your account, then sign in again to open the operator console.");
  }
  // OPS1 security (M2): the rule is about this session, not only the account flag. A session created at or before
  // the account's two-step enrolment never passed the second step (auth/two-factor-enrolment.ts), so sign in again.
  if (twoFactorRuleApplies(c.var.deps, auth) && !(await sessionPostdatesEnrolment(c.var.deps.db, auth))) {
    await recordDenied(c, auth, "two_factor_required");
    throw new HttpError(403, "two_factor_required", "Sign in again to open the operator console. This session started before two-step sign in was turned on, so it never asked for your code.");
  }
  c.set("auth", auth);
  c.set("operator", { role: auth.platformRole as OperatorRole });
  noteRequestCaller(auth);
  await next();
};

type OperatorGuard = MiddlewareHandler<AppEnv> & { permission: Permission; stepUp: boolean };

/** Requires the operator's role to have this permission; with stepUp, a recent sign in too. Use after operatorSession. */
export function requireOperator(permission: Permission, opts: { stepUp?: boolean } = {}): OperatorGuard {
  const stepUp = !!opts.stepUp;
  const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
    const role = c.var.operator?.role ?? c.var.auth?.platformRole;
    if (!can(role, permission)) {
      if (c.var.auth && isOperatorRole(role)) await recordDenied(c, c.var.auth, "forbidden", permission); // OPS1 security (L4)
      throw new HttpError(403, "forbidden", "Your operator role can't do that.");
    }
    if (stepUp && !isFreshSignIn(c.var.deps, c.var.auth)) {
      await recordDenied(c, c.var.auth, "step_up_required", permission); // OPS1 security (L4)
      throw new HttpError(403, "step_up_required", `Sign in again to do this. It needs a sign in from the last ${c.var.deps.config.operator.freshMinutes} minutes.`, { freshMinutes: c.var.deps.config.operator.freshMinutes });
    }
    await next();
  };
  return Object.assign(guard, { permission, stepUp });
}

/** The operator's role in a handler (after operatorSession). */
export function operatorRole(c: Context<AppEnv>): OperatorRole {
  const role = c.var.operator?.role;
  if (!role) throw new HttpError(403, "forbidden", NOT_OPERATOR_MESSAGE);
  return role;
}
