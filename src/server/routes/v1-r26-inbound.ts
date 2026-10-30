/**
 * R26 (DF-18): inbound keys in the public API (v1). The Email Worker signs each delivery with a workspace's inbound
 * key; until now a key could only be made in Settings, Inbound. A workspace key (not a read only, agent or agent
 * member key) can list, make and revoke them. The secret is shown once, at creation. Owners and admins only.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import { audit } from "../services/audit";
import { createInboundKey, deleteInboundKey, listInboundKeys } from "../services/mail/inbound-keys";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;
const adminOnly = (c: Context<AppEnv>) => {
  if (c.var.auth.role !== "owner" && c.var.auth.role !== "admin") throw new HttpError(403, "forbidden", "Only an owner or admin key can manage inbound keys.");
};

export function registerInboundKeyRoutes(api: OpenAPIHono<AppEnv>) {
  const responses = { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("A read only, agent or member key."), 404: err("Not found.") };

  api.openapi(createRoute({
    method: "get", path: "/inbound-keys", tags: ["Mailboxes"], summary: "List inbound keys", security: [{ bearerAuth: [] }],
    description: "The workspace's inbound keys (id, created, last used). Secrets are never shown again.", responses,
  }), async (c) => {
    adminOnly(c);
    return send(c, { keys: await listInboundKeys(c.var.deps, c.var.auth.orgId) });
  });

  api.openapi(createRoute({
    method: "post", path: "/inbound-keys", tags: ["Mailboxes"], summary: "Make an inbound key", security: [{ bearerAuth: [] }],
    description: "Makes a key for the Email Worker (email-worker/, MYMAIL_ROUTES). Returns { key: { id, secret }, webhookUrl }; the secret is shown only this once. One row plus one audit row.",
    responses,
  }), async (c) => {
    adminOnly(c);
    const { auth, deps } = c.var;
    const key = await createInboundKey(deps, auth.orgId);
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "inbound_key.created", targetType: "inbound_key", targetId: key.id, metadata: { via: "api" }, ip: c.var.ip });
    return send(c, { key, webhookUrl: `${deps.config.appUrl}/api/inbound/cloudflare` }, 201);
  });

  api.openapi(createRoute({
    method: "delete", path: "/inbound-keys/{id}", tags: ["Mailboxes"], summary: "Revoke an inbound key", security: [{ bearerAuth: [] }],
    request: { params: Id }, responses,
  }), async (c) => {
    adminOnly(c);
    const { auth, deps } = c.var;
    const id = c.req.valid("param").id;
    await deleteInboundKey(deps, auth.orgId, id);
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "inbound_key.revoked", targetType: "inbound_key", targetId: id, metadata: { via: "api" }, ip: c.var.ip });
    return send(c, { ok: true });
  });
}
