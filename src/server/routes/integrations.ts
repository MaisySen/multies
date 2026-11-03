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
const ImageBody = z.object({ contentType: z.string().max(64), dataB64: z.string().min(1).max(1_400_000) });
const PostBody = z.object({
  text: z.string().max(6000),
  // 1 MB of image is about 1.34 MB of base64.
  image: ImageBody.nullable().optional(),
  // R117: drafts may have no accounts yet (the service asks for one before anything is sent or submitted).
  targets: z.array(z.object({ accountId: z.string().min(3).max(64), target: z.string().max(200).nullable().optional(), targetName: z.string().max(200).nullable().optional() })).max(20),
  runAt: z.string().max(40).nullable().optional(),
  images: z.array(z.union([ImageBody, z.object({ mediaId: z.string().min(3).max(64) })])).max(10).nullable().optional(),
  format: z.enum(["text", "image", "carousel", "video", "story"]).nullable().optional(),
  texts: z.record(z.string().max(20), z.string().max(6000)).nullable().optional(),
  extras: z.object({
    firstComment: z.string().max(2000).nullable().optional(),
    poll: z.object({ question: z.string().max(200), options: z.array(z.string().max(60)).max(4), days: z.number().int().min(1).max(14) }).nullable().optional(),
    linkCard: z.boolean().optional(),
    // R132: per network details (cleaned to known fields by the service; kept only when SOCIAL_P3_R132 is on).
    pin: z.object({ title: z.string().max(300).nullable().optional(), link: z.string().max(2200).nullable().optional(), alt: z.string().max(700).nullable().optional() }).nullable().optional(),
    youtube: z.object({ title: z.string().max(300).nullable().optional(), privacy: z.enum(["private", "unlisted", "public"]).nullable().optional() }).nullable().optional(),
    gbp: z.object({
      type: z.enum(["update", "event", "offer"]).nullable().optional(), title: z.string().max(200).nullable().optional(), start: z.string().max(40).nullable().optional(),
      end: z.string().max(40).nullable().optional(), coupon: z.string().max(200).nullable().optional(), terms: z.string().max(6000).nullable().optional(), redeem: z.string().max(2200).nullable().optional(),
    }).nullable().optional(),
  }).nullable().optional(),
  campaign: z.string().max(60).nullable().optional(),
  evergreen: z.boolean().optional(),
  mode: z.enum(["send", "draft", "submit"]).optional(),
});
const WriteBody = z.object({ action: z.enum(["shorter", "friendlier", "formal", "hashtags", "fit"]), text: z.string().max(6000), apps: z.array(z.string().max(40)).max(12).optional() }); // R132
const p3 = () => import("../services/integrations/social-p3"); // R132
const NoteBody = z.object({ note: z.string().max(1000).optional() });
const SlotsBody = z.object({ tz: z.string().min(1).max(64), slots: z.array(z.object({ accountId: z.string().max(120).nullable().optional(), weekday: z.number().int().min(0).max(6), minute: z.number().int().min(0).max(1439) })).max(84) });
const LibraryBody = z.object({ kind: z.enum(["image", "caption", "hashtags"]), name: z.string().max(120), body: z.string().max(6000).nullable().optional(), image: ImageBody.nullable().optional(), campaign: z.string().max(60).nullable().optional() });
const LibraryPatch = z.object({ name: z.string().max(120).optional(), body: z.string().max(6000).nullable().optional(), campaign: z.string().max(60).nullable().optional() });
const p2 = () => import("../services/integrations/social-p2");
const p2b = () => import("../services/integrations/social-p2b"); // R118
const soc1 = () => import("../services/integrations/social-pages-soc1"); // SOC1
const PagesBody = z.object({ pageIds: z.array(z.string().regex(/^[\w.-]{1,64}$/)).max(500) });
const TextBody = z.object({ text: z.string().max(4000) });
const InboxPatch = z.object({ status: z.enum(["open", "done"]).optional(), assigneeId: z.string().max(64).nullable().optional(), contactId: z.string().max(64).nullable().optional() });
const SavedBody = z.object({ title: z.string().max(200), body: z.string().max(4000) });
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
    .get("/accounts/:id/targets", async (c) => c.json({ targets: await (await svc()).listTargets(c.var.deps, c.var.auth, c.req.param("id")) }))
    // SOC1 (flag SOCIAL_MULTI_SOC1; 404 when off): Pages per login, chosen by an admin, each its own post target.
    .get("/accounts/:id/pages", async (c) => c.json(await (await soc1()).listAvailable(c.var.deps, c.var.auth, c.req.param("id"))))
    .put("/accounts/:id/pages", async (c) => c.json({ pages: await (await soc1()).savePages(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, PagesBody)).pageIds, clientIp(c)) }))
    .get("/pages", async (c) => c.json({ pages: await (await soc1()).listPages(c.var.deps, c.var.auth) }))
    .delete("/pages/:key", async (c) => c.json(await (await soc1()).removePage(c.var.deps, c.var.auth, c.req.param("key"), clientIp(c))));
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
    // R117: ?all=1 adds drafts and posts waiting for approval; from and to (ISO) read a planner range; status filters.
    .get("/posts", async (c) => c.json({ posts: await (await social()).listPosts(c.var.deps, c.var.auth, { all: c.req.query("all") === "1", from: c.req.query("from"), to: c.req.query("to"), status: c.req.query("status") }) }))
    .get("/approvals", async (c) => c.json({ posts: await (await p2()).approvalQueue(c.var.deps, c.var.auth) }))
    .post("/posts/:id/approve", async (c) => {
      const s = await p2();
      const r = await s.approvePost(c.var.deps, c.var.auth, c.req.param("id"), clientIp(c));
      if (r.sendNow) { const deps = c.var.deps; void runLater(c, () => s.sendNow(deps, r.post.id)); }
      return c.json({ post: r.post });
    })
    .post("/posts/:id/changes", async (c) => c.json({ post: (await (await p2()).askForChanges(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, NoteBody)).note ?? "", clientIp(c))).post }))
    .post("/posts/:id/reject", async (c) => c.json({ post: (await (await p2()).rejectPost(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, NoteBody)).note ?? "", clientIp(c))).post }))
    .post("/posts/:id/discard", async (c) => c.json(await (await p2()).discardPost(c.var.deps, c.var.auth, c.req.param("id"), clientIp(c))))
    .post("/posts/:id/move", async (c) => c.json({ post: await (await p2()).movePost(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, z.object({ runAt: z.string().max(40) }))).runAt, clientIp(c)) }))
    .patch("/posts/:id", async (c) => {
      const b = await parseBody(c, PostBody);
      const s = await social();
      const post = await s.updatePost(c.var.deps, c.var.auth, c.req.param("id"), b, { ip: clientIp(c) });
      const deps = c.var.deps; const auth = c.var.auth;
      if (post.status === "review") void runLater(c, async () => (await p2()).tellApprovers(deps, auth, post));
      if (post.status === "scheduled" && Date.parse(post.runAt) <= deps.now().getTime()) void runLater(c, () => s.sendNow(deps, post.id));
      return c.json({ post });
    })
    .get("/slots", async (c) => c.json({ slots: await (await p2()).listSlots(c.var.deps, c.var.auth) }))
    .put("/slots", async (c) => { const b = await parseBody(c, SlotsBody); return c.json({ slots: await (await p2()).saveSlots(c.var.deps, c.var.auth, b.slots, b.tz) }); })
    .get("/slots/next", async (c) => c.json(await (await p2()).nextSlots(c.var.deps, c.var.auth, (c.req.query("accounts") ?? "").split(",").filter(Boolean), Number(c.req.query("limit") ?? 5) || 5)))
    .get("/library", async (c) => c.json(await (await p2()).listLibrary(c.var.deps, c.var.auth)))
    .post("/library", async (c) => c.json({ item: await (await p2()).addLibraryItem(c.var.deps, c.var.auth, await parseBody(c, LibraryBody)) }, 201))
    .patch("/library/:id", async (c) => c.json({ item: await (await p2()).updateLibraryItem(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, LibraryPatch)) }))
    .delete("/library/:id", async (c) => c.json(await (await p2()).removeLibraryItem(c.var.deps, c.var.auth, c.req.param("id"))))
    // R118: Social inbox, saved replies, analytics, and the staging only test network.
    .get("/inbox", async (c) => c.json(await (await p2b()).listInbox(c.var.deps, c.var.auth, c.req.query())))
    .post("/inbox/sync", async (c) => c.json(await (await p2b()).syncNow(c.var.deps, c.var.auth)))
    .get("/inbox/:id", async (c) => c.json(await (await p2b()).getThread(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/inbox/:id", async (c) => c.json({ item: await (await p2b()).updateItem(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, InboxPatch)) }))
    .post("/inbox/:id/notes", async (c) => c.json({ note: await (await p2b()).addNote(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, TextBody)).text) }, 201))
    .post("/inbox/:id/reply", async (c) => c.json(await (await p2b()).reply(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, TextBody)).text), 201))
    .post("/inbox/:id/task", async (c) => c.json(await (await p2b()).makeTask(c.var.deps, c.var.auth, c.req.param("id")), 201))
    .get("/saved-replies", async (c) => c.json({ replies: await (await p2b()).listSavedReplies(c.var.deps, c.var.auth) }))
    .post("/saved-replies", async (c) => c.json({ reply: await (await p2b()).saveReply(c.var.deps, c.var.auth, await parseBody(c, SavedBody)) }, 201))
    .patch("/saved-replies/:id", async (c) => c.json({ reply: await (await p2b()).saveReply(c.var.deps, c.var.auth, await parseBody(c, SavedBody), c.req.param("id")) }))
    .delete("/saved-replies/:id", async (c) => c.json(await (await p2b()).removeSavedReply(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/analytics", async (c) => c.json(await (await p2b()).analytics(c.var.deps, c.var.auth, c.req.query("range"))))
    .post("/analytics/sync", async (c) => c.json(await (await p2b()).syncStatsNow(c.var.deps, c.var.auth)))
    .get("/test-network", async (c) => c.json(await (await p2b()).testStatus(c.var.deps, c.var.auth)))
    .post("/test-network", async (c) => c.json(await (await p2b()).connectTest(c.var.deps, c.var.auth), 201))
    .post("/test-network/signed-out", async (c) => c.json(await (await p2b()).setTestBroken(c.var.deps, c.var.auth, (await parseBody(c, z.object({ broken: z.boolean() }))).broken)))
    .delete("/test-network", async (c) => c.json(await (await p2b()).removeTest(c.var.deps, c.var.auth)))
    // Oct 31: each social account checked without posting (sign in works, posting allowed, a Page reachable).
    // R132: best times to post (top 3 from the workspace's own results) and writing help on the free AI tier.
    .get("/best-times", async (c) => c.json(await (await p3()).bestTimesFor(c.var.deps, c.var.auth, c.req.query("apps"), c.req.query("tz"))))
    .post("/write-help", async (c) => c.json(await (await p3()).writeHelp(c.var.deps, c.var.auth, await parseBody(c, WriteBody))))
    .get("/health", async (c) => c.json({ accounts: await (await social()).accountHealth(c.var.deps, c.var.auth, { fresh: c.req.query("fresh") === "1" }) }))
    .get("/posts/:id", async (c) => c.json({ post: await (await social()).getPost(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .post("/posts", async (c) => {
      const b = await parseBody(c, PostBody);
      const s = await social();
      const post = await s.createPost(c.var.deps, c.var.auth, b, { ip: clientIp(c) });
      if (post.status === "review") { const deps = c.var.deps; const auth = c.var.auth; void runLater(c, async () => (await p2()).tellApprovers(deps, auth, post)); }
      // A post set for now goes out right after this answer (the cron pass would take it within 15 minutes anyway).
      if (post.status === "scheduled" && Date.parse(post.runAt) <= c.var.deps.now().getTime()) {
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
      const evergreen = c.req.query("evergreen") === "1" ? await (await p2()).runEvergreen(deps, { now, orgId: auth.orgId }) : undefined;
      return c.json({ ...(await (await social()).runDueSocialPosts(deps, { now, orgId: auth.orgId })), ...(evergreen ? { evergreen } : {}) });
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
