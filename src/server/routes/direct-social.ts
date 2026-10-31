/**
 * R83: our own TikTok and Threads connections. /api/direct (session; members read, owners and admins write),
 * the sign in start and return under /api/connections/oauth/{tiktok,threads}/ (see connections.ts), the TikTok webhook
 * at /api/connections/webhooks/tiktok (signed, no session) and the Threads uninstall and delete callbacks, which POST
 * signed_request to /delete-account. The services load on first use.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { audit } from "../services/audit";

const svc = () => import("../services/direct-social");
const tiktok = () => import("../services/direct-social/tiktok");
const threads = () => import("../services/direct-social/threads");
const store = () => import("../services/direct-social/store");

const ThreadsBody = z.object({
  text: z.string().max(2000),
  image: z.object({ contentType: z.string().max(64), dataB64: z.string().min(1).max(1_400_000) }).nullable().optional(),
});

function fromB64(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function directSocialRoutes() {
  const posts = new RateLimiter(10, 15 * 60_000);
  const take = (userId: string) => { if (!posts.take(userId)) throw new HttpError(429, "too_many", "Too many posts in a short time. Wait a few minutes, then try again."); };
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/status", async (c) => c.json(await (await svc()).directStatus(c.var.deps, c.var.auth)))
    .delete("/:provider", async (c) => {
      const s = await svc();
      return c.json(await s.disconnect(c.var.deps, c.var.auth, s.parseProvider(c.req.param("provider"))));
    })
    .get("/tiktok/creator", async (c) => c.json({ creator: await (await tiktok()).creatorInfo(c.var.deps, c.var.auth) }))
    .get("/tiktok/videos", async (c) => {
      const t = await tiktok();
      const [videos, publishes] = await Promise.all([t.listVideos(c.var.deps, c.var.auth), t.listPublishes(c.var.deps, c.var.auth)]);
      return c.json({ videos, publishes });
    })
    .post("/tiktok/videos", async (c) => {
      (await store()).requireManager(c.var.auth);
      take(c.var.auth.userId);
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > 52 * 1024 * 1024) throw new HttpError(413, "too_big", "That video is over 50 MB. Pick a shorter one.");
      let form: FormData;
      try { form = await c.req.formData(); } catch { throw new HttpError(400, "bad_request", "The video didn't arrive. Try again."); }
      const file = form.get("video");
      if (!file || typeof file === "string") throw new HttpError(400, "bad_file", "Pick a video to post.");
      const f = form.get.bind(form);
      const yes = (k: string) => f(k) === "true";
      const publish = await (await tiktok()).postVideo(c.var.deps, c.var.auth, {
        title: String(f("title") ?? ""), privacy: String(f("privacy") ?? ""),
        allowComment: yes("allowComment"), allowDuet: yes("allowDuet"), allowStitch: yes("allowStitch"),
        yourBrand: yes("yourBrand"), brandedContent: yes("brandedContent"), consent: yes("consent"),
        file: { bytes: new Uint8Array(await (file as Blob).arrayBuffer()), type: (file as Blob).type },
      });
      await audit(c.var.deps.db, { orgId: c.var.auth.orgId, actorUserId: c.var.auth.userId, actorEmail: c.var.auth.email, action: "social.direct_posted", targetType: "connection", targetId: publish.id, metadata: { provider: "tiktok" } });
      return c.json({ publish }, 201);
    })
    .get("/threads/profile", async (c) => c.json(await (await threads()).threadsProfile(c.var.deps, c.var.auth)))
    .post("/threads/posts", async (c) => {
      (await store()).requireManager(c.var.auth);
      take(c.var.auth.userId);
      const b = await parseBody(c, ThreadsBody);
      const post = await (await threads()).threadsPost(c.var.deps, c.var.auth, { text: b.text, image: b.image ? { bytes: fromB64(b.image.dataB64), type: b.image.contentType } : null });
      await audit(c.var.deps.db, { orgId: c.var.auth.orgId, actorUserId: c.var.auth.userId, actorEmail: c.var.auth.email, action: "social.direct_posted", targetType: "connection", targetId: post.id, metadata: { provider: "threads" } });
      return c.json({ post }, 201);
    });
}

/** Sign in start and return for both networks. Mounted inside connectionRoutes (session already checked). */
export function directOAuthRoutes() {
  const back = (q: Record<string, string>) => `/app/settings/apps/social?${new URLSearchParams(q)}`;
  return new Hono<AppEnv>()
    .get("/oauth/tiktok/start", async (c) => {
      (await store()).requireManager(c.var.auth);
      return c.redirect(await (await tiktok()).tiktokStart(c.var.deps, c.var.auth));
    })
    .get("/oauth/threads/start", async (c) => {
      (await store()).requireManager(c.var.auth);
      return c.redirect(await (await threads()).threadsStart(c.var.deps, c.var.auth));
    })
    .get("/oauth/:p{tiktok|threads}/callback", async (c) => {
      const p = c.req.param("p") as "tiktok" | "threads";
      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!code || !state) {
        const denied = c.req.query("error") === "access_denied" || c.req.query("error_reason") === "user_denied";
        return c.redirect(back({ error: denied ? "You cancelled the sign in." : "The sign in didn't finish. Try again.", network: p }));
      }
      const { deps, auth } = c.var;
      try {
        (await store()).requireManager(auth);
        await (p === "tiktok" ? await (await tiktok()).tiktokFinish(deps, auth, code, state) : await (await threads()).threadsFinish(deps, auth, code, state));
        await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "connection.direct_connected", targetType: "connection", targetId: p, metadata: { provider: p } });
        return c.redirect(back({ connected: p }));
      } catch (err) {
        return c.redirect(back({ error: err instanceof HttpError ? err.message : "The sign in didn't finish. Try again.", network: p }));
      }
    });
}

/** TikTok's webhook. Verified with the client secret, applied, answered 200 at once (TikTok retries anything else). */
export function directWebhookRoutes() {
  return new Hono<AppEnv>()
    .post("/tiktok", async (c) => {
      const deps = c.var.deps;
      const t = deps.config.direct.tiktok;
      if (!t) return c.json({ ok: false }, 404);
      const raw = await c.req.text();
      if (raw.length > 64_000) return c.json({ ok: false }, 413);
      const s = await svc();
      if (!(await s.verifyTikTokSignature(c.req.header("tiktok-signature"), raw, t.secrets, deps.now().getTime()))) return c.json({ ok: false }, 401);
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(raw) as Record<string, unknown>; } catch { return c.json({ ok: true }); }
      const work = s.handleTikTokEvent(deps, ev).catch((err) => { deps.log?.warn("tiktok.webhook_failed", { error: err instanceof Error ? err.message.slice(0, 120) : "?" }); });
      try { c.executionCtx.waitUntil(work); } catch { await work; }
      return c.json({ ok: true });
    })
    // The developer portal checks the address with a GET first.
    .get("/tiktok", (c) => c.json({ ok: true }));
}

/** POST /delete-account: Threads uninstall and data deletion callbacks (signed_request). */
export function deleteAccountCallbackRoutes() {
  return new Hono<AppEnv>()
    .post("/delete-account", async (c) => {
      let signed = "";
      try {
        const ct = c.req.header("content-type") ?? "";
        if (ct.includes("application/json")) signed = String(((await c.req.json()) as { signed_request?: string }).signed_request ?? "");
        else signed = String((await c.req.parseBody()).signed_request ?? "");
      } catch { signed = ""; }
      if (!signed || signed.length > 4000) return c.json({ error: { code: "bad_request", message: "signed_request is missing." } }, 400);
      const r = await (await threads()).handleThreadsCallback(c.var.deps, signed);
      if (r.status !== 200) return c.json({ error: { code: r.status === 404 ? "not_found" : "bad_signature", message: r.status === 404 ? "Not set up here." : "That request is not signed by our app." } }, r.status);
      return c.json(r.body);
    });
}
