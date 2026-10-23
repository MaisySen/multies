import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import { createApiKey, deleteApiKey, listApiKeys } from "../services/developer/api-keys";
import {
  WEBHOOK_EVENTS, createEndpoint, deleteEndpoint, endpointSecret, listDeliveries, listEndpoints, sendTestEvent, updateEndpoint,
} from "../services/developer/webhooks";

const eventsSchema = z.array(z.enum([...WEBHOOK_EVENTS, "*"])).min(1, "Pick at least one event.").max(WEBHOOK_EVENTS.length + 1);

/** Dashboard management of API keys and webhooks (session auth, workspace admins). */
export function developerRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth, requireAdmin)
    .get("/events", (c) => c.json({ events: WEBHOOK_EVENTS }))
    .get("/keys", async (c) => c.json({ apiKeys: await listApiKeys(c.var.deps, c.var.auth.orgId) }))
    .post("/keys", async (c) => {
      const input = await parseBody(c, z.object({ name: z.string().trim().min(1, "Name the key after what uses it.").max(60), scope: z.enum(["full", "read"]).default("full") }));
      const { auth, deps } = c.var;
      const out = await createApiKey(deps, auth, input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "api_key.created", targetType: "api_key", targetId: out.apiKey.id, metadata: { name: input.name, scope: input.scope }, ip: c.var.ip });
      return c.json(out, 201);
    })
    .delete("/keys/:id", async (c) => {
      const { auth, deps } = c.var;
      const k = await deleteApiKey(deps, auth.orgId, c.req.param("id"));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "api_key.deleted", targetType: "api_key", targetId: k.id, metadata: { name: k.name }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .get("/webhooks", async (c) => c.json({ endpoints: await listEndpoints(c.var.deps, c.var.auth.orgId) }))
    .post("/webhooks", async (c) => {
      const input = await parseBody(c, z.object({ url: z.string().trim().min(1).max(2000), events: eventsSchema, description: z.string().trim().max(200).optional() }));
      const { auth, deps } = c.var;
      const out = await createEndpoint(deps, auth.orgId, input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "webhook.created", targetType: "webhook", targetId: out.endpoint.id, metadata: { url: out.endpoint.url }, ip: c.var.ip });
      return c.json(out, 201);
    })
    .patch("/webhooks/:id", async (c) => {
      const patch = await parseBody(c, z.object({ url: z.string().trim().min(1).max(2000).optional(), events: eventsSchema.optional(), enabled: z.boolean().optional(), description: z.string().trim().max(200).nullable().optional() }));
      return c.json({ endpoint: await updateEndpoint(c.var.deps, c.var.auth.orgId, c.req.param("id"), patch) });
    })
    .delete("/webhooks/:id", async (c) => {
      const { auth, deps } = c.var;
      const e = await deleteEndpoint(deps, auth.orgId, c.req.param("id"));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "webhook.deleted", targetType: "webhook", targetId: e.id, metadata: { url: e.url }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .get("/webhooks/:id/secret", async (c) => c.json({ secret: await endpointSecret(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .get("/webhooks/:id/deliveries", async (c) => c.json({ deliveries: await listDeliveries(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .post("/webhooks/:id/test", async (c) => c.json({ delivery: await sendTestEvent(c.var.deps, c.var.auth.orgId, c.req.param("id")) }));
}
