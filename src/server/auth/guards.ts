import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppEnv, AuthContext, Deps } from "../context";
import { forbidden, HttpError, unauthorized } from "../lib/errors";
import { isLostRequestState, withAuthRequestState } from "../lib/request-state";
import { members, organizations, sessions, users } from "../db/schema";
import { newId } from "../lib/crypto";
import { audit } from "../services/audit";
import { authFor } from "./options";
import { SSO_METHODS } from "./session";
import { DEFAULT_COUNTRY, DEFAULT_TIMEZONE, isCountry } from "@/shared/locale";

/*
 * Route guards. Every route that acts for a person goes through requireAuth (the session
 * cookie, from any sign in path), then requireAdmin or requirePlatformAdmin where the action
 * needs a role. API keys and MCP tokens for agents have their own guard in routes/v1.ts and
 * routes/mcp.ts, so a person's session and an agent's key never stand in for each other.
 */

/**
 * Resolves the Better Auth session and the workspace it points at. Someone with no
 * workspace yet (a brand-new or social sign-in) gets a personal one here, so every
 * sign-in path ends in the same place.
 */
export async function resolveAuth(deps: Deps, headers: Headers): Promise<AuthContext | null> {
  const getSession = () => authFor(deps).api.getSession({ headers });
  let s: Awaited<ReturnType<typeof getSession>>;
  try {
    s = await getSession();
  } catch (err) {
    if (!isLostRequestState(err)) throw err;
    s = await withAuthRequestState(getSession);
  }
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
    // No zone is assumed: UTC until onboarding saves the person's own (from their browser). The
    // country starts from the edge's guess (Cloudflare's CF-IPCountry) when it is a real country.
    const edgeCountry = (headers.get("cf-ipcountry") ?? "").toUpperCase();
    await db.insert(organizations).values({
      id: orgId, name: `${s.user.name.split("@")[0].split(" ")[0] || "My"}'s workspace`, slug: orgId,
      timezone: DEFAULT_TIMEZONE, country: isCountry(edgeCountry) ? edgeCountry : DEFAULT_COUNTRY,
    });
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

