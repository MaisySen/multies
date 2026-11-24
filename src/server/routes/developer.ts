import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import { MAX_KEY_EXPIRY_DAYS, createApiKey, deleteApiKey, listApiKeys, updateApiKeyScope } from "../services/developer/api-keys";
import { ALL_SCOPES, SCOPE_AREAS, SCOPE_PRESETS, normalizeScopes } from "../lib/api-scopes";
import { HttpError } from "../lib/errors";

/** R36: a preset ("full", "read") or a list of per area scopes. */
const scopeInput = z.union([z.enum(["full", "read"]), z.array(z.string().max(32)).min(1, "Pick at least one scope.").max(ALL_SCOPES.length * 2)]);
const toStoredScope = (input: string | string[]) => {
  const n = normalizeScopes(input);
  if (!n.ok) throw new HttpError(422, "invalid_scope", `Unknown scope: ${n.unknown.join(", ")}. Use ${ALL_SCOPES.join(", ")}.`);
  return n.value;
};
import {
  WEBHOOK_EVENTS, createEndpoint, deleteEndpoint, endpointSecret, listDeliveries, listEndpoints, sendTestEvent, updateEndpoint, replayFailed,
} from "../services/developer/webhooks";

const eventsSchema = z.array(z.enum([...WEBHOOK_EVENTS, "*"])).min(1, "Pick at least one event.").max(WEBHOOK_EVENTS.length + 1);

/** Dashboard management of API keys and webhooks (session auth, workspace admins). */
export function developerRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth, requireAdmin)
    .get("/events", (c) => c.json({ events: WEBHOOK_EVENTS }))
    .get("/keys", async (c) => c.json({ apiKeys: await listApiKeys(c.var.deps, c.var.auth.orgId) }))
    // R36: the scope list and presets the create and edit sheets show.
    .get("/scopes", (c) => c.json({ areas: SCOPE_AREAS, presets: SCOPE_PRESETS }))
    .post("/keys", async (c) => {
      const input = await parseBody(c, z.object({ name: z.string().trim().min(1, "Name the key after what uses it.").max(60), scope: scopeInput.default("full"), showOnlyUsableTools: z.boolean().optional(),
        // Round 2: optional end date, in whole days from now. Left out or null: the key never ends.
        expiresInDays: z.number().int("Pick a whole number of days.").min(1, "A key lasts at least 1 day.").max(MAX_KEY_EXPIRY_DAYS, `A key can last at most ${MAX_KEY_EXPIRY_DAYS} days.`).nullable().optional() }));
      const { auth, deps } = c.var;
      const scope = toStoredScope(input.scope);
      // R37: a new key with picked areas hides the tools it can't use unless the admin turns it off. The two
      // presets keep their pre-R37 behaviour (Full never hides; Read only hides only when asked).
      const showOnlyUsableTools = scope === "full" ? false : scope === "read" ? input.showOnlyUsableTools ?? false : input.showOnlyUsableTools ?? true;
      const out = await createApiKey(deps, auth, { name: input.name, scope, showOnlyUsableTools, expiresInDays: input.expiresInDays ?? null });
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "api_key.created", targetType: "api_key", targetId: out.apiKey.id, metadata: { name: input.name, prefix: out.apiKey.prefix, scope, showOnlyUsableTools, expiresAt: out.apiKey.expiresAt?.toISOString() ?? null }, ip: c.var.ip });
      return c.json(out, 201);
    })
    // R36: edit a key's scopes. Essential write (one row on an admin's click).
    .patch("/keys/:id", async (c) => {
      // R37: scope, the tool list option, or both. Leaving one out keeps it as it was.
      const input = await parseBody(c, z.object({ scope: scopeInput.optional(), showOnlyUsableTools: z.boolean().optional() }).refine((v) => v.scope !== undefined || v.showOnlyUsableTools !== undefined, "Send scope or showOnlyUsableTools."));
      const { auth, deps } = c.var;
      const scope = input.scope === undefined ? undefined : toStoredScope(input.scope);
      const apiKey = await updateApiKeyScope(deps, auth.orgId, c.req.param("id"), scope, input.showOnlyUsableTools);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "api_key.scope_changed", targetType: "api_key", targetId: apiKey.id, metadata: { name: apiKey.name, prefix: apiKey.prefix, scope: apiKey.scope, showOnlyUsableTools: apiKey.showOnlyUsableTools }, ip: c.var.ip });
      return c.json({ apiKey });
    })
    .delete("/keys/:id", async (c) => {
      const { auth, deps } = c.var;
      const k = await deleteApiKey(deps, auth.orgId, c.req.param("id"));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "api_key.deleted", targetType: "api_key", targetId: k.id, metadata: { name: k.name, prefix: k.prefix }, ip: c.var.ip });
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
    .post("/webhooks/:id/test", async (c) => c.json({ delivery: await sendTestEvent(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    // Dead letters: send failed deliveries again (all, or the ids given), re-enabling the endpoint.
    .post("/webhooks/:id/replay", async (c) => {
      const { ids } = await parseBody(c, z.object({ ids: z.array(z.string().max(64)).max(500).optional() }));
      return c.json({ replayed: await replayFailed(c.var.deps, c.var.auth.orgId, c.req.param("id"), ids) });
    });
}
