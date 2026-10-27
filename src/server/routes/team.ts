import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import { getPlan } from "../services/plans";
import {
  acceptInvite, createInvite, describeInvite, getInvite, listInvites, listMembers, removeMember, revokeInvite, seatsUsed,
  transferOwnership, updateMember,
} from "../services/team";
import { RateLimiter } from "../lib/rate-limit";
import { tooMany } from "../lib/errors";
import { agentMemberCount, createAgentMemberKey, listAgentMemberKeys, listPeople, revokeAgentMemberKey, updateProfile } from "../services/people";
import { createAgentMemberR26, listAgentMembers, updateAgentMember } from "../services/suite/agent-members-r26";

export const InviteBody = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  role: z.enum(["admin", "member"]).default("member"),
  mailboxIds: z.array(z.string()).max(500).default([]),
  /** R25 (DF-4): the title and bio the new member starts with. */
  title: z.string().max(80).nullable().optional(),
  bio: z.string().max(500).nullable().optional(),
});
const inviteSchema = InviteBody;
export const ProfileBody = z.object({
  title: z.string().max(80).nullable().optional(),
  bio: z.string().max(500).nullable().optional(),
  name: z.string().max(80).optional(),
});
export const AgentMemberBody = z.object({
  name: z.string().trim().min(1, "Give the agent a name.").max(80),
  title: z.string().max(80).nullable().optional(),
  bio: z.string().max(500).nullable().optional(),
  scope: z.enum(["full", "read"]).default("full"),
  /** R26 (DF-3): avatar colour (#rrggbb) and an optional agent inbox to link. */
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour as #rrggbb.").nullable().optional(),
  inboxAgentId: z.string().min(1).max(64).nullable().optional(),
});
/** R26 (DF-3): edit an agent member. disabled pauses it (its keys are refused) or resumes it. */
export const AgentMemberPatchBody = z.object({
  name: z.string().trim().min(1, "Give the agent a name.").max(80).optional(),
  title: z.string().max(80).nullable().optional(),
  bio: z.string().max(500).nullable().optional(),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour as #rrggbb.").nullable().optional(),
  disabled: z.boolean().optional(),
  inboxAgentId: z.string().min(1).max(64).nullable().optional(),
});
export const AgentKeyBody = z.object({ name: z.string().max(80).optional(), scope: z.enum(["full", "read"]).default("full") });
const updateSchema = z.object({ role: z.enum(["admin", "member"]).optional(), mailboxIds: z.array(z.string()).max(500).optional() });

export function teamRoutes() {
  const inviteLimiter = new RateLimiter(30, 60 * 60_000);
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const { db, now } = c.var.deps;
      const { orgId } = c.var.auth;
      const [members, invites, plan, seats, agentMembers] = await Promise.all([
        listMembers(db, orgId), c.var.auth.role === "member" ? [] : listInvites(db, orgId, now()), getPlan(db, orgId), seatsUsed(db, orgId, now()), agentMemberCount(c.var.deps, orgId),
      ]);
      return c.json({ members, invites, seats: { ...seats, limit: plan.limits.seats }, agentMembers: { used: agentMembers, limit: plan.limits.agentMembers } });
    })
    .get("/people", async (c) => c.json({ people: await listPeople(c.var.deps, c.var.auth.orgId) }))
    .patch("/people/:userId", async (c) => {
      const person = await updateProfile(c.var.deps, c.var.auth, c.req.param("userId"), await parseBody(c, ProfileBody));
      return c.json({ person });
    })
    .post("/agents", requireAdmin, async (c) => c.json(await createAgentMemberR26(c.var.deps, c.var.auth, await parseBody(c, AgentMemberBody)), 201))
    // R26 (DF-3): list with avatar, paused state and inbox; edit and pause.
    .get("/agents", async (c) => c.json({ agents: await listAgentMembers(c.var.deps, c.var.auth.orgId) }))
    .patch("/agents/:userId", requireAdmin, async (c) => c.json({ agent: await updateAgentMember(c.var.deps, c.var.auth, c.req.param("userId"), await parseBody(c, AgentMemberPatchBody)) }))
    .get("/agents/:userId/keys", requireAdmin, async (c) => c.json({ keys: await listAgentMemberKeys(c.var.deps, c.var.auth, c.req.param("userId")) }))
    .post("/agents/:userId/keys", requireAdmin, async (c) => c.json(await createAgentMemberKey(c.var.deps, c.var.auth, c.req.param("userId"), await parseBody(c, AgentKeyBody)), 201))
    .delete("/agents/:userId/keys/:keyId", requireAdmin, async (c) => {
      await revokeAgentMemberKey(c.var.deps, c.var.auth, c.req.param("userId"), c.req.param("keyId"));
      return c.json({ ok: true });
    })
    .post("/invites", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      if (!inviteLimiter.take(auth.orgId)) throw tooMany("Too many invitations in the last hour.");
      const input = await parseBody(c, inviteSchema);
      const res = await createInvite(deps, auth, c.req.raw.headers, input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "member.invited", targetType: "invitation", targetId: res.id, metadata: { email: input.email, role: input.role, ...(input.title ? { title: input.title } : {}) }, ip: c.var.ip });
      return c.json(res, 201);
    })
    .post("/invites/:id/resend", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      const inv = await getInvite(deps.db, auth.orgId, c.req.param("id"));
      const role = inv.role === "admin" ? "admin" : "member";
      const res = await createInvite(deps, auth, c.req.raw.headers, { email: inv.email, role, mailboxIds: JSON.parse(inv.mailboxIds ?? "[]") });
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "member.invite_resent", metadata: { email: inv.email }, ip: c.var.ip });
      return c.json(res, 201);
    })
    .delete("/invites/:id", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      const inv = await revokeInvite(deps, auth, c.req.raw.headers, c.req.param("id"));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "member.invite_revoked", metadata: { email: inv.email }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .patch("/members/:userId", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      const input = await parseBody(c, updateSchema);
      const res = await updateMember(deps, auth, c.req.raw.headers, c.req.param("userId"), input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "member.updated", targetType: "user", targetId: c.req.param("userId"), metadata: { email: res.email, role: res.role, from: res.previousRole, mailboxes: input.mailboxIds?.length }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .delete("/members/:userId", async (c) => {
      const { auth, deps } = c.var;
      const target = await removeMember(deps, auth, c.req.raw.headers, c.req.param("userId"));
      const self = c.req.param("userId") === auth.userId;
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: self ? "member.left" : "member.removed", targetType: "user", targetId: c.req.param("userId"), metadata: { email: target.email }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .post("/transfer", async (c) => {
      const { auth, deps } = c.var;
      const { userId, password } = await parseBody(c, z.object({ userId: z.string(), password: z.string().max(200).default("") }));
      const target = await transferOwnership(deps, auth, c.req.raw.headers, userId, password);
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
      const res = await acceptInvite(deps, auth, c.req.raw.headers, c.req.param("token"));
      await audit(deps.db, { orgId: res.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "member.joined", metadata: { email: auth.email, role: res.role }, ip: c.var.ip });
      return c.json(res);
    });
}
