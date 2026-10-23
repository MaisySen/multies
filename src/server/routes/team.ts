import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import { getPlan } from "../services/plans";
import {
  acceptInvite, createInvite, describeInvite, listInvites, listMembers, removeMember, revokeInvite, seatsUsed,
  transferOwnership, updateMember,
} from "../services/team";
import { RateLimiter } from "../lib/rate-limit";
import { tooMany } from "../lib/errors";

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  role: z.enum(["admin", "member"]).default("member"),
  mailboxIds: z.array(z.string()).max(500).default([]),
});
const updateSchema = z.object({ role: z.enum(["admin", "member"]).optional(), mailboxIds: z.array(z.string()).max(500).optional() });

export function teamRoutes() {
  const inviteLimiter = new RateLimiter(30, 60 * 60_000);
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const { db, now } = c.var.deps;
      const { orgId } = c.var.auth;
      const [members, invites, plan, seats] = await Promise.all([
        listMembers(db, orgId), c.var.auth.role === "member" ? [] : listInvites(db, orgId, now()), getPlan(db, orgId), seatsUsed(db, orgId, now()),
      ]);
      return c.json({ members, invites, seats: { ...seats, limit: plan.limits.seats } });
    })
    .post("/invites", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      if (!inviteLimiter.take(auth.orgId)) throw tooMany("Too many invitations in the last hour.");
      const input = await parseBody(c, inviteSchema);
      const res = await createInvite(deps, auth, input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "member.invited", targetType: "invitation", targetId: res.id, metadata: { email: input.email, role: input.role }, ip: c.var.ip });
      return c.json(res, 201);
    })
    .post("/invites/:id/resend", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      const inv = await revokeInvite(deps.db, auth.orgId, c.req.param("id"), deps.now());
      const res = await createInvite(deps, auth, { email: inv.email, role: inv.role, mailboxIds: JSON.parse(inv.mailboxIds) });
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "member.invite_resent", metadata: { email: inv.email }, ip: c.var.ip });
      return c.json(res, 201);
    })
    .delete("/invites/:id", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      const inv = await revokeInvite(deps.db, auth.orgId, c.req.param("id"), deps.now());
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "member.invite_revoked", metadata: { email: inv.email }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .patch("/members/:userId", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      const input = await parseBody(c, updateSchema);
      const res = await updateMember(deps.db, auth, c.req.param("userId"), input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "member.updated", targetType: "user", targetId: c.req.param("userId"), metadata: { email: res.email, role: res.role, from: res.previousRole, mailboxes: input.mailboxIds?.length }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .delete("/members/:userId", async (c) => {
      const { auth, deps } = c.var;
      const target = await removeMember(deps.db, auth, c.req.param("userId"));
      const self = c.req.param("userId") === auth.userId;
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: self ? "member.left" : "member.removed", targetType: "user", targetId: c.req.param("userId"), metadata: { email: target.email }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .post("/transfer", async (c) => {
      const { auth, deps } = c.var;
      const { userId, password } = await parseBody(c, z.object({ userId: z.string(), password: z.string().min(1) }));
      const target = await transferOwnership(deps.db, auth, userId, password);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.ownership_transferred", targetType: "user", targetId: userId, metadata: { email: target.email }, ip: c.var.ip });
      return c.json({ ok: true });
    });
}

/** Invite links: readable without signing in, accepted once signed in. */
export function inviteRoutes() {
  return new Hono<AppEnv>()
    .get("/:token", async (c) => c.json({ invite: await describeInvite(c.var.deps.db, c.req.param("token"), c.var.deps.now()) }))
    .post("/:token/accept", requireAuth, async (c) => {
      const { auth, deps } = c.var;
      const res = await acceptInvite(deps, auth, c.req.param("token"));
      await audit(deps.db, { orgId: res.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "member.joined", metadata: { email: auth.email, role: res.role }, ip: c.var.ip });
      return c.json(res);
    });
}
