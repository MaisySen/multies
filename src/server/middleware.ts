import type { Context, MiddlewareHandler } from "hono";
import { z, type ZodType } from "zod";
import { and, eq } from "drizzle-orm";
import type { AppEnv, AuthContext, Deps } from "./context";
import { forbidden, HttpError, unauthorized, zodToHttp } from "./lib/errors";
import { SSO_METHODS, authFor } from "./auth";
import { members, organizations, sessions, users } from "./db/schema";
import { newId } from "./lib/crypto";
import { audit } from "./services/audit";

/**
 * Resolves the Better Auth session and the workspace it points at. Someone with no
 * workspace yet (a brand-new or social sign-in) gets a personal one here, so every
 * sign-in path ends in the same place.
 */
export async function resolveAuth(deps: Deps, headers: Headers): Promise<AuthContext | null> {
  const s = await authFor(deps).api.getSession({ headers });
  if (!s) return null;
  const { db } = deps;
  // The membership and the workspace's SSO rule in one query: on D1 each query is a round trip.
  const memberWithOrg = (where: ReturnType<typeof and>) => db.select({ member: members, requireSso: organizations.requireSso })
    .from(members).innerJoin(organizations, eq(organizations.id, members.organizationId)).where(where).get();
  let found = s.session.activeOrganizationId
    ? await memberWithOrg(and(eq(members.userId, s.user.id), eq(members.organizationId, s.session.activeOrganizationId)))
    : undefined;
  found ??= await memberWithOrg(eq(members.userId, s.user.id));
  let member = found?.member;
  let requireSso = found?.requireSso ?? false;
  if (!member) {
    const orgId = newId("org");
    await db.insert(organizations).values({ id: orgId, name: `${s.user.name.split("@")[0].split(" ")[0] || "My"}'s workspace`, slug: orgId });
    const memberId = newId("mem");
    await db.insert(members).values({ id: memberId, organizationId: orgId, userId: s.user.id, role: "owner" });
    member = (await db.select().from(members).where(eq(members.id, memberId)).get())!;
    requireSso = false;
    await audit(db, { orgId, actorUserId: s.user.id, actorEmail: s.user.email, action: "account.created" });
  }
  if (member.organizationId !== s.session.activeOrganizationId) {
    await db.update(sessions).set({ activeOrganizationId: member.organizationId }).where(eq(sessions.id, s.session.id));
  }
  let platformRole = s.user.role ?? "user";
  // Bootstrap operators: listed user ids, or listed emails once the address is verified
  // (an unverified address proves nothing; anyone could have signed up with it).
  const listed = deps.config.platformAdmins.includes(s.user.id.toLowerCase())
    || (s.user.emailVerified && deps.config.platformAdmins.includes(s.user.email.toLowerCase()));
  if (platformRole !== "admin" && listed) {
    await db.update(users).set({ role: "admin" }).where(eq(users.id, s.user.id));
    platformRole = "admin";
  }
  // Workspaces that require SSO: everyone but the owner (the break glass account) must
  // have signed in this session through an SSO provider.
  const loginMethod = (s.session as { loginMethod?: string | null }).loginMethod ?? "email";
  const ssoBlocked = requireSso && member.role !== "owner" && !SSO_METHODS.has(loginMethod);
  return {
    ssoBlocked, loginMethod,
    userId: s.user.id, email: s.user.email, name: s.user.name, orgId: member.organizationId, role: member.role,
    sessionId: s.session.id, emailVerified: s.user.emailVerified, twoFactor: !!s.user.twoFactorEnabled,
    platformRole,
  };
}

/** Requires a valid session; populates `c.var.auth`. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = await resolveAuth(c.var.deps, c.req.raw.headers);
  if (!auth) throw unauthorized();
  // A workspace that requires SSO only lets password sessions reach account level routes
  // (profile, export, switching workspaces), so the person can still move or leave.
  if (auth.ssoBlocked && !c.req.path.startsWith("/api/account")) {
    throw new HttpError(403, "sso_required", "This workspace requires single sign on. Sign out, then sign in with your company's SSO.");
  }
  c.set("auth", auth);
  await next();
};

/** Operators only (Better Auth admin role). */
export const requirePlatformAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.auth.platformRole !== "admin") throw forbidden("Only platform operators can do that.");
  await next();
};

/** Owners and admins only. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.auth.role === "member") throw forbidden("Only workspace admins can do that.");
  await next();
};

/**
 * CSRF defence for cookie-authenticated, state-changing requests: the request must
 * be JSON (a cross-site form cannot send that without a CORS preflight) and, when the
 * browser sends an Origin, it must match this host.
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  const origin = c.req.header("origin");
  if (origin) {
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
    let originHost = "";
    try { originHost = new URL(origin).host; } catch { /* invalid origin */ }
    if (!host || originHost !== host) throw new HttpError(403, "bad_origin", "Cross-site request blocked.");
  }
  const ct = c.req.header("content-type") ?? "";
  const hasBody = c.req.header("content-length") !== "0" && (m === "POST" || m === "PUT" || m === "PATCH");
  if (hasBody && !ct.includes("application/json")) throw new HttpError(403, "bad_content_type", "Requests must be JSON.");
  await next();
};

export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text) {
    try { raw = JSON.parse(text); } catch { throw new HttpError(400, "bad_json", "Malformed JSON body."); }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw zodToHttp(parsed.error);
  return parsed.data;
}

/** Validates the query string with zod (all values arrive as strings; use z.coerce). */
export function parseQuery<T>(c: Context, schema: ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw zodToHttp(parsed.error);
  return parsed.data;
}

/** Common list query: page size and a created-before cursor. */
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime({ offset: true }).optional().transform((v) => (v ? new Date(v) : undefined)),
});

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
