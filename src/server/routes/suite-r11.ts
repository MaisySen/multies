/**
 * Round 11 in the app (cookie session): integrations (connector catalogue and incoming
 * webhooks), plus the public endpoint /api/hooks/in/<token>. Built on the first request that needs it (see app.ts).
 * Public calls are limited per isolate in memory (no database write for the limit itself).
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { RateLimiter } from "../lib/rate-limit";
import { WEBHOOK_EVENTS, deleteEndpoint, sendTestEvent, updateEndpoint } from "../services/developer/webhooks";
import {
  CATALOGUE, connectIntegration, createIncomingHook, deleteIncomingHook, getIncomingHook, listIncomingHooks, listIntegrations, readHookPayload, receiveIncoming, updateIncomingHook,
} from "../services/suite/integrations";
import type { SuiteActor } from "../services/suite/common";

const Event = z.string().refine((e) => e === "*" || (WEBHOOK_EVENTS as readonly string[]).includes(e), "Unknown event.");
export const ConnectBody = z.object({ connector: z.string().max(40), url: z.string().url().max(2000), events: z.array(Event).max(60).optional(), name: z.string().max(80).optional() });
export const ConnectionPatch = z.object({ enabled: z.boolean().optional(), events: z.array(Event).min(1).max(60).optional(), url: z.string().url().max(2000).optional(), name: z.string().max(80).optional() });
const Mapping = z.record(z.string().max(20), z.string().max(80));
const HookConfig = z.object({ projectId: z.string().max(64).optional(), channelId: z.string().max(64).optional(), mapping: Mapping.optional() });
export const HookCreate = z.object({ name: z.string().trim().min(1).max(80), action: z.enum(["task", "chat", "contact"]), config: HookConfig.optional() });
export const HookPatch = z.object({ name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(), config: HookConfig.optional() });

const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;

/** A per-isolate limit plus the shared Cloudflare binding when one is bound. */
function publicLimit(limit: number, key: (c: Context<AppEnv>) => string): MiddlewareHandler<AppEnv> {
  const local = new RateLimiter(limit, 60_000);
  return async (c, next) => {
    const k = key(c);
    let ok = local.take(k);
    const bound = c.var.deps.rateLimiters?.webhooks;
    if (ok && bound && c.req.method !== "GET") ok = (await bound.limit({ key: `pub:${k}` })).success;
    if (!ok) {
      c.header("retry-after", "60");
      return c.json({ error: { code: "rate_limited", message: "Too many requests. Try again in a minute." } }, 429);
    }
    return next();
  };
}

export function connectorRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await listIntegrations(c.var.deps, c.var.auth.orgId)))
    .get("/catalogue", (c) => c.json({ catalogue: CATALOGUE }))
    .post("/", requireAdmin, async (c) => c.json(await connectIntegration(c.var.deps, actor(c), await parseBody(c, ConnectBody)), 201))
    .patch("/:id", requireAdmin, async (c) => {
      const b = await parseBody(c, ConnectionPatch);
      return c.json({ connection: await updateEndpoint(c.var.deps, c.var.auth.orgId, c.req.param("id"), { enabled: b.enabled, events: b.events, url: b.url, description: b.name }) });
    })
    .post("/:id/test", requireAdmin, async (c) => c.json({ delivery: await sendTestEvent(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .delete("/:id", requireAdmin, async (c) => c.json({ connection: await deleteEndpoint(c.var.deps, c.var.auth.orgId, c.req.param("id")) }));
}

export function incomingHookRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ hooks: await listIncomingHooks(c.var.deps, c.var.auth.orgId) }))
    .post("/", requireAdmin, async (c) => c.json(await createIncomingHook(c.var.deps, actor(c), await parseBody(c, HookCreate)), 201))
    .get("/:id", async (c) => c.json({ hook: await getIncomingHook(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .patch("/:id", requireAdmin, async (c) => c.json({ hook: await updateIncomingHook(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, HookPatch)) }))
    .delete("/:id", requireAdmin, async (c) => c.json(await deleteIncomingHook(c.var.deps, actor(c), c.req.param("id"))));
}

/** The public receiver. No cookies, no CSRF: the token in the path is the credential. */
export function hookInRoutes() {
  return new Hono<AppEnv>()
    .use("/:token", publicLimit(60, (c) => `hook:${c.req.param("token")?.slice(0, 12) ?? ""}`))
    .use("/:token", publicLimit(240, (c) => `ip:${c.var.ip}`))
    .post("/:token", async (c) => c.json(await receiveIncoming(c.var.deps, c.req.param("token"), await readHookPayload(c.req.raw)), 201))
    .all("/:token", (c) => c.json({ error: { code: "method_not_allowed", message: "Send a POST with a JSON or form body." } }, 405));
}

type ParentVars = { deps: AppEnv["Variables"]["deps"]; ip: string; requestId: string; log: AppEnv["Variables"]["log"] };

/** One router for every round 11 path, mounted lazily by app.ts. */
export function r11Routes(parentVars: WeakMap<Request, ParentVars>) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      const p = parentVars.get(c.req.raw);
      if (p) { c.set("deps", p.deps); c.set("ip", p.ip); c.set("requestId", p.requestId); c.set("log", p.log); }
      await next();
    })
    .route("/api/connectors", connectorRoutes())
    .route("/api/incoming-hooks", incomingHookRoutes())
    .route("/api/hooks/in", hookInRoutes());
}
