/**
 * Invitations in the public API (v1), R25 (DF-7): an org setup script invites the team with a
 * workspace key instead of signing in with a password. The key acts as its creator: inviting an
 * admin needs the creator to be the owner, the plan's seats apply, and the invitation email and
 * link are the same as the app's. Agent keys, agent member keys and read only keys can't invite.
 * AIS1 (audit row 1): a key's invite is held (status awaiting_approval, nothing emailed) until a person confirms it.
 * Members are listed by GET /people.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../services/audit";
import { createInvite, listInvites, revokeInvite } from "../services/team";
import { RateLimiter } from "../lib/rate-limit";
import { tooMany } from "../lib/errors";
import { InviteBody } from "./team";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;

export function registerInviteRoutes(api: OpenAPIHono<AppEnv>) {
  // The same budget as the app's invite button: 30 an hour per workspace.
  const limiter = new RateLimiter(30, 60 * 60_000);
  const route = (method: "get" | "post" | "delete", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["People"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 402: err("No seats left on the plan."), 403: err("The key can't do this."), 404: err("Not found."), 409: err("Already a member."), 422: err("Validation failed."), 429: err("Too many invitations in the last hour.") } });

  api.openapi(route("get", "/invites", "List pending invitations", "Invitations not yet accepted, newest first, each with its role, mailbox access, title and bio. Members who joined are in GET /people."),
    async (c) => send(c, { invites: await listInvites(c.var.deps.db, c.var.auth.orgId, c.var.deps.now()) }));

  api.openapi(route("post", "/invites", "Invite a member", "Body: { email, role?: admin | member, mailboxIds?, title?, bio? }. A key's invite waits for a person: nothing is emailed and the link doesn't work until an owner or admin confirms it in Multies (Settings, Team), which sends the invitation email. The answer carries status awaiting_approval, emailed false and the link (it works for 7 days from the confirmation, once, only for that address). The title and bio become the member's own when they join. Inviting an admin needs a key created by the workspace owner. Inviting the same address again holds its invitation again with the new details. An address whose mail reaches an AI agent (its inbox, a +tag, an alias or a catch-all) is refused with 422 agent_address. Nobody is invited as owner: transfer ownership in the app once they have joined.", { request: { body: { required: true, content: { "application/json": { schema: InviteBody } } } } }),
    async (c) => {
      const { auth, deps } = c.var;
      const input = InviteBody.parse(await c.req.json().catch(() => ({})));
      if (!limiter.take(auth.orgId)) throw tooMany("Too many invitations in the last hour.");
      const res = await createInvite(deps, auth, c.req.raw.headers, input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "member.invited", targetType: "invitation", targetId: res.id, metadata: { email: input.email, role: input.role, via: "api", ...(res.status === "awaiting_approval" ? { awaitingApproval: true } : {}), ...(input.title ? { title: input.title } : {}) }, ip: c.var.ip });
      return send(c, res, 201);
    });

  api.openapi(route("delete", "/invites/{id}", "Revoke an invitation", "The link stops working at once. Revoking one that was accepted, revoked or belongs to another workspace answers 404.", { request: { params: Id } }),
    async (c) => {
      const { auth, deps } = c.var;
      const inv = await revokeInvite(deps, auth, c.req.raw.headers, c.req.param("id") ?? "");
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "member.invite_revoked", metadata: { email: inv.email, via: "api" }, ip: c.var.ip });
      return send(c, { ok: true });
    });
}
