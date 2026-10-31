/**
 * R80C: Connections and social posts. /api/apps (accounts, connect, reconnect, disconnect, targets,
 * app logos) and /api/social (posts and their images). Session only; members read, owners and admins write (the
 * services check the role). The services load on first use, so these routes add nothing to a cold start.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { clientIp, parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { getOrg } from "../services/plans";

const svc = () => import("../services/integrations/service");
const social = () => import("../services/integrations/social");

// Built once per isolate (zod schema construction is real CPU on a warm request).
const ConnectBody = z.object({ app: z.string().regex(/^[a-z0-9_]{1,64}$/) });
const PostBody = z.object({
  text: z.string().max(6000),
  // 1 MB of image is about 1.34 MB of base64.
  image: z.object({ contentType: z.string().max(64), dataB64: z.string().min(1).max(1_400_000) }).nullable().optional(),
  targets: z.array(z.object({ accountId: z.string().min(3).max(64), target: z.string().max(200).nullable().optional(), targetName: z.string().max(200).nullable().optional() })).min(1).max(20),
  runAt: z.string().max(40).nullable().optional(),
});
const LOGO_HOST = "https://logos.composio.dev/api/";

function runLater(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, work: () => Promise<unknown>) {
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try { const ctx = c.executionCtx; waitUntil = ctx.waitUntil.bind(ctx); } catch { waitUntil = undefined; }
  const p = work().catch(() => undefined);
  if (waitUntil) waitUntil(p);
  return p;
}

export function appConnectionRoutes() {
  return new Hono<AppEnv>()
    // App logos, through us so the browser only talks to our own origin. Public images, cached a day.
    .get("/logo/:app", async (c) => {
      const app = c.req.param("app");
      if (!/^[a-z0-9_]{1,64}$/.test(app)) throw new HttpError(404, "not_found", "No such logo.");
      let res: Response;
      try { res = await c.var.deps.fetch(LOGO_HOST + app, { headers: { accept: "image/*" } }); } catch { res = new Response(null, { status: 502 }); }
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !/^image\/(png|jpeg|svg\+xml|webp|gif)/.test(type)) return new Response(null, { status: 404, headers: { "cache-control": "public, max-age=3600" } });
      return new Response(res.body, { headers: {
        "content-type": type, "cache-control": "public, max-age=86400, stale-while-revalidate=604800", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      } });
    })
    .use("*", requireAuth)
    .get("/status", async (c) => {
      const { isAdmin } = await svc();
      return c.json({ available: !!c.var.deps.config.integrations.composio, canManage: isAdmin(c.var.auth) });
    })
    .get("/accounts", async (c) => c.json({ accounts: await (await svc()).listAccounts(c.var.deps, c.var.auth) }))
    .post("/connect", async (c) => {
      const b = await parseBody(c, ConnectBody);
      return c.json(await (await svc()).startConnect(c.var.deps, c.var.auth, b.app, clientIp(c)), 201);
    })
    .post("/accounts/:id/confirm", async (c) => c.json({ account: await (await svc()).confirmConnect(c.var.deps, c.var.auth, c.req.param("id"), clientIp(c)) }))
    .post("/accounts/:id/reconnect", async (c) => c.json(await (await svc()).reconnect(c.var.deps, c.var.auth, c.req.param("id"), clientIp(c))))
    .delete("/accounts/:id", async (c) => c.json(await (await svc()).disconnect(c.var.deps, c.var.auth, c.req.param("id"), clientIp(c))))
    .get("/accounts/:id/targets", async (c) => c.json({ targets: await (await svc()).listTargets(c.var.deps, c.var.auth, c.req.param("id")) }));
}

export function socialRoutes() {
  return new Hono<AppEnv>()
    // The image a network fetches while posting: unguessable id and token, no session.
    .get("/media/:id/:token", async (c) => {
      const m = await (await social()).readMedia(c.var.deps, c.req.param("id"), c.req.param("token"));
      if (!m) throw new HttpError(404, "not_found", "Not found.");
      return new Response(m.bytes, { headers: { "content-type": m.contentType, "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff", "x-robots-tag": "noindex" } });
    })
    .use("*", requireAuth)
    .get("/posts", async (c) => c.json({ posts: await (await social()).listPosts(c.var.deps, c.var.auth) }))
    // Oct 31: each social account checked without posting (sign in works, posting allowed, a Page reachable).
    .get("/health", async (c) => c.json({ accounts: await (await social()).accountHealth(c.var.deps, c.var.auth, { fresh: c.req.query("fresh") === "1" }) }))
    .get("/posts/:id", async (c) => c.json({ post: await (await social()).getPost(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .post("/posts", async (c) => {
      const b = await parseBody(c, PostBody);
      const s = await social();
      const post = await s.createPost(c.var.deps, c.var.auth, b, { ip: clientIp(c) });
      // A post set for now goes out right after this answer (the cron pass would take it within 15 minutes anyway).
      if (Date.parse(post.runAt) <= c.var.deps.now().getTime()) {
        const deps = c.var.deps;
        void runLater(c, () => s.sendNow(deps, post.id));
      }
      return c.json({ post }, 201);
    })
    // Test clock for end to end runs: the cron pass for the caller's own demo workspace at a chosen time. Only with
    // the local stand in for the platform (never against the real one) and only inside a demo workspace.
    .post("/test-clock", async (c) => {
      const { deps, auth } = c.var;
      const cfg = deps.config.integrations.composio;
      const org = await getOrg(deps.db, auth.orgId);
      if (!cfg || new URL(cfg.baseUrl).hostname !== "composio.mock" || !deps.config.demoEnabled || !org.isDemo) throw new HttpError(404, "not_found", "Not found.");
      const b = await parseBody(c, z.object({ now: z.string().max(40) }));
      const now = new Date(b.now);
      if (Number.isNaN(now.getTime())) throw new HttpError(422, "bad_time", "That time isn't valid.");
      return c.json(await (await social()).runDueSocialPosts(deps, { now, orgId: auth.orgId }));
    })
    // Oct 31: the posts on screen asked against their network (Facebook; at most once per post per 5 minutes).
    .post("/posts/sync", async (c) => {
      const b = await parseBody(c, z.object({ ids: z.array(z.string().min(3).max(64)).max(50) }));
      return c.json({ posts: await (await social()).syncPosts(c.var.deps, c.var.auth, b.ids) });
    })
    // Oct 31: delete from Multies and, where the network allows, from the network too.
    .delete("/posts/:id", async (c) => c.json(await (await social()).deletePost(c.var.deps, c.var.auth, c.req.param("id"), clientIp(c))))
    .post("/posts/:id/cancel", async (c) => c.json({ post: await (await social()).cancelPost(c.var.deps, c.var.auth, c.req.param("id"), clientIp(c)) }))
    .post("/posts/:id/retry", async (c) => {
      const s = await social();
      const post = await s.retryPost(c.var.deps, c.var.auth, c.req.param("id"));
      const deps = c.var.deps;
      void runLater(c, () => s.sendNow(deps, post.id));
      return c.json({ post });
    });
}
