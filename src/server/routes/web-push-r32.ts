/**
 * R32: browser notifications (web push). Session routes at /api/push/web:
 *  GET    /            { enabled, publicKey, subscriptions }
 *  POST   /            { endpoint, keys: { p256dh, auth } }  saves this browser
 *  DELETE /            { endpoint }                          forgets this browser (also on sign out)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { deleteSubscription, listSubscriptions, saveSubscription } from "../services/suite/web-push-r32";

const b64url = z.string().min(16).max(200).regex(/^[A-Za-z0-9_-]+=*$/);
export const WebPushSubscriptionBody = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: b64url, auth: z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+=*$/) }),
});

export function webPushRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ enabled: !!c.var.deps.config.webPush, publicKey: c.var.deps.config.webPush?.publicKey ?? null, subscriptions: await listSubscriptions(c.var.deps, c.var.auth) }))
    .post("/", async (c) => {
      const b = await parseBody(c, WebPushSubscriptionBody);
      return c.json(await saveSubscription(c.var.deps, c.var.auth, { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh.replace(/=+$/, ""), auth: b.keys.auth.replace(/=+$/, "") }, userAgent: c.req.header("user-agent") }), 201);
    })
    .delete("/", async (c) => {
      const b = await parseBody(c, z.object({ endpoint: z.string().url().max(1000) }));
      return c.json(await deleteSubscription(c.var.deps, c.var.auth, b.endpoint));
    });
}
