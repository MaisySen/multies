/**
 * OPS1: /api/console/users, Users.
 *
 * GET  /                                  { items, nextCursor }: ?q (email, name, id) &banned &unverified &operator
 *                                          &twoFactor (true | false) &sort (createdAt | email | name : asc | desc) &limit &cursor
 * GET  /:id                               profile, workspaces, sign in methods, two-step state, lockout
 * GET  /:id/sessions                      { items, nextCursor: null }, newest first (at most 100), never a token
 * POST /:id/sessions/:sessionId/revoke    { reason }  users.sessions
 * POST /:id/sessions/revoke-all           { reason }  users.sessions
 * POST /:id/ban                           { reason, expiresInDays? }  users.ban, step up
 * POST /:id/unban                         { reason }  users.ban, step up
 * POST /:id/clear-lockout                        { reason }  users.unlock
 * POST /:id/verify                        { reason }  users.verify
 * DELETE /:id                             { reason }  users.delete (owners), step up
 *
 * Every change: a reason, one platform audit row (user.*), refused on yourself (400 self), and ban, delete and
 * session changes are refused on any operator (403 target_is_operator: operators are managed on the Operators page).
 * Changes that affect who is signed in drop this isolate's cached sessions (clearAuthCache), so the next request
 * reads the database.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../context";
import { parseBody, parseQuery } from "../../middleware";
import { operatorSession, requireOperator } from "../../auth/operator";
import { clearAuthCache } from "../../auth/guards";
import { HttpError, notFound } from "../../lib/errors";
import { users } from "../../db/schema";
import { beforeUserDelete } from "../../services/privacy";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import { decodeCursor, encodeCursor } from "../../services/console/listing";
import {
  BAN_MAX_DAYS, banUser, clearUserLockout, getUserDetail, getUserTarget, listUserSessions, listUsers, markEmailVerified,
  revokeAllUserSessions, revokeUserSession, unbanUser, type UserTarget,
} from "../../services/console/users";
import type { PageRequest } from "../../services/console/workspaces";

const flag = z.enum(["true", "false", ""]).optional().transform((v) => (v === "true" ? true : v === "false" ? false : undefined));

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.string().max(5).optional(),
  cursor: z.string().max(500).optional(),
  sort: z.string().max(40).optional(),
  banned: flag,
  unverified: flag,
  operator: flag,
  twoFactor: flag,
}).passthrough();

const idSchema = z.string().min(1).max(100);
const Reason = z.object({ reason: reasonSchema });
const BanBody = z.object({
  reason: reasonSchema,
  expiresInDays: z.number().int("Give the ban length in whole days.").min(1, "A ban lasts at least 1 day.").max(BAN_MAX_DAYS, `A ban lasts at most ${BAN_MAX_DAYS} days.`).nullish(),
});

/** ?sort=field:dir, ?limit and ?cursor in the service's paging shape (an unknown sort field is a 400 there). */
function pageOf(query: { limit?: string; cursor?: string; sort?: string }): PageRequest {
  const [field, dir] = (query.sort || "createdAt:desc").split(":");
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const n = Number.parseInt(query.limit ?? "", 10);
  return {
    limit: Number.isFinite(n) && n > 0 ? n : 50,
    cursor: cursor ? { v: cursor.sort instanceof Date ? cursor.sort.getTime() : cursor.sort, id: cursor.id } : null,
    sort: { field: field ?? "", dir: (dir || "desc") as PageRequest["sort"]["dir"] },
  };
}

const userId = (c: Context<AppEnv>) => {
  const r = idSchema.safeParse(c.req.param("id"));
  if (!r.success) throw notFound("User");
  return r.data;
};

/** The account a change is about, after the rules every change shares. */
async function targetFor(c: Context<AppEnv>, opts: { notOperator?: string } = {}): Promise<UserTarget> {
  const id = userId(c);
  if (id === c.var.auth.userId) throw new HttpError(400, "self", "You can't do this to your own account here. Use your account settings.");
  const target = await getUserTarget(c.var.deps, id);
  if (opts.notOperator && target.operator) {
    throw new HttpError(403, "target_is_operator", `This person is a platform operator, so you can't ${opts.notOperator} here. Change their access on the Operators page first.`);
  }
  return target;
}

export function usersRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/", requireOperator("users.read"), async (c) => {
      const query = parseQuery(c, ListQuery);
      const out = await listUsers(c.var.deps, {
        q: query.q,
        filters: { banned: query.banned, unverified: query.unverified, operator: query.operator, twoFactor: query.twoFactor },
        page: pageOf(query),
      });
      c.header("cache-control", "no-store");
      return c.json({ items: out.items, nextCursor: out.next ? encodeCursor(out.next.v, out.next.id) : null });
    })
    .get("/:id", requireOperator("users.read"), async (c) => {
      c.header("cache-control", "no-store");
      return c.json(await getUserDetail(c.var.deps, userId(c)));
    })
    .get("/:id/sessions", requireOperator("users.read"), async (c) => {
      c.header("cache-control", "no-store");
      return c.json({ items: await listUserSessions(c.var.deps, userId(c)), nextCursor: null });
    })
    .post("/:id/sessions/revoke-all", requireOperator("users.sessions"), async (c) => {
      const { reason } = await parseBody(c, Reason);
      const t = await targetFor(c, { notOperator: "sign them out" });
      const r = await operatorAction(c, {
        action: "user.sessions_revoked", targetType: "user", targetId: t.id, reason, metadata: { email: t.email },
        after: (x: { sessionsEnded: number }) => x,
      }, () => revokeAllUserSessions(c.var.deps, t.id));
      clearAuthCache();
      return c.json({ ok: true, sessionsEnded: r.sessionsEnded });
    })
    .post("/:id/sessions/:sessionId/revoke", requireOperator("users.sessions"), async (c) => {
      const { reason } = await parseBody(c, Reason);
      const t = await targetFor(c, { notOperator: "sign them out" });
      const sessionId = idSchema.safeParse(c.req.param("sessionId"));
      if (!sessionId.success) throw notFound("Session");
      type R = Awaited<ReturnType<typeof revokeUserSession>>;
      await operatorAction(c, {
        action: "user.session_revoked", targetType: "user", targetId: t.id, reason,
        before: (x: R) => x, metadata: { email: t.email },
      }, () => revokeUserSession(c.var.deps, t.id, sessionId.data));
      clearAuthCache();
      return c.json({ ok: true });
    })
    .post("/:id/ban", requireOperator("users.ban", { stepUp: true }), async (c) => {
      const body = await parseBody(c, BanBody);
      const t = await targetFor(c, { notOperator: "ban them" });
      type R = Awaited<ReturnType<typeof banUser>>;
      const r = await operatorAction(c, {
        action: "user.banned", targetType: "user", targetId: t.id, reason: body.reason,
        before: (x: R) => x.before, after: (x: R) => x.after, metadata: { email: t.email, expiresInDays: body.expiresInDays ?? null },
      }, () => banUser(c.var.deps, t.id, { reason: body.reason, expiresInDays: body.expiresInDays ?? null }));
      clearAuthCache();
      return c.json({ ok: true, ...r.after, sessionsEnded: r.sessionsEnded });
    })
    .post("/:id/unban", requireOperator("users.ban", { stepUp: true }), async (c) => {
      const { reason } = await parseBody(c, Reason);
      const t = await targetFor(c);
      type R = Awaited<ReturnType<typeof unbanUser>>;
      const r = await operatorAction(c, {
        action: "user.unbanned", targetType: "user", targetId: t.id, reason,
        before: (x: R) => x.before, after: (x: R) => x.after, metadata: { email: t.email },
      }, () => unbanUser(c.var.deps, t.id));
      clearAuthCache();
      return c.json({ ok: true, ...r.after });
    })
    .post("/:id/clear-lockout", requireOperator("users.unlock"), async (c) => {
      const { reason } = await parseBody(c, Reason);
      const t = await targetFor(c);
      type R = Awaited<ReturnType<typeof clearUserLockout>>;
      const r = await operatorAction(c, {
        action: "user.lockout_cleared", targetType: "user", targetId: t.id, reason,
        before: (x: R) => ({ locked: x.wasLocked, failures: x.failures }), after: { locked: false, failures: 0 }, metadata: { email: t.email },
      }, () => clearUserLockout(c.var.deps, t.id));
      return c.json({ ok: true, wasLocked: r.wasLocked });
    })
    .post("/:id/verify", requireOperator("users.verify"), async (c) => {
      const { reason } = await parseBody(c, Reason);
      const t = await targetFor(c);
      type R = Awaited<ReturnType<typeof markEmailVerified>>;
      const r = await operatorAction(c, {
        action: "user.email_verified", targetType: "user", targetId: t.id, reason,
        before: (x: R) => ({ emailVerified: x.alreadyVerified }), after: { emailVerified: true }, metadata: { email: t.email },
      }, () => markEmailVerified(c.var.deps, t.id));
      clearAuthCache();
      return c.json({ ok: true, alreadyVerified: r.alreadyVerified });
    })
    // The same path as DELETE /api/admin/users/:id: workspaces where they are the only member go with the account,
    // and it is refused (409) while they are the only owner of a shared workspace.
    .delete("/:id", requireOperator("users.delete", { stepUp: true }), async (c) => {
      const { reason } = await parseBody(c, Reason);
      const t = await targetFor(c, { notOperator: "delete their account" });
      const { deps } = c.var;
      await operatorAction(c, { action: "user.deleted", targetType: "user", targetId: t.id, reason, before: { email: t.email } }, async () => {
        await beforeUserDelete(deps, t.id);
        await deps.db.delete(users).where(eq(users.id, t.id));
      });
      clearAuthCache();
      return c.json({ ok: true });
    });
}
