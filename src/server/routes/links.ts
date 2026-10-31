/**
 * R87: Links in Tools.
 *   GET    /api/links                    short links of the workspace and the base address
 *   POST   /api/links                    { url, code?, title?, tags?, expiresAt?, maxClicks?, password? }
 *   POST   /api/links/bulk               { rows: [{ url, code?, title?, tags? }] } (500 at most)
 *   GET    /api/links/check?code=        { free }
 *   GET    /api/links/:id                one link
 *   PATCH  /api/links/:id                any field above, enabled, clearPassword
 *   DELETE /api/links/:id                the link and its clicks
 *   GET    /api/links/:id/stats?days=    per day, countries, referrers, devices, browsers, systems
 *   GET    /api/links/:id/clicks.csv     counted clicks as CSV
 *   GET|PUT /api/links/bio?scope=workspace|me, GET /api/links/bio/stats
 *   GET|POST /api/links/go, PATCH|DELETE /api/links/go/:id, GET /api/links/go/open/:name
 *   GET|PUT|DELETE /api/links/host, POST /api/links/host/check
 *   GET /l/<code>, POST /l/<code> (password), GET /bio/<slug>, GET /bio/<slug>/go/<item>
 * Behind the Tools feature "links"; public pages answer 404 while it is off.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth } from "../auth/guards";
import { HttpError, badRequest } from "../lib/errors";
import { verifyPassword } from "../lib/crypto";
import { RateLimiter } from "../lib/rate-limit";
import { CODE_RE, SLUG_RE, STATS_DAYS, normCode } from "@/shared/links";
import { bulkCreate, codeFree, checkCode, createLink, deleteLink, getLink, linkCsv, linkStats, listLinks, updateLink } from "../services/links/core";
import { bioStats, getBio, renderBio, saveBio, type BioScope } from "../services/links/bio";
import { createGo, deleteGo, listGo, openGo, updateGo } from "../services/links/go";
import { checkHost, getHost, removeHost, setHost } from "../services/links/host";
import { clickOf, orgForHost, passwordHashOf, queue, resolveBio, resolveCode, takeLimitedClick, type ResolvedLink } from "../services/links/public";
import { PUBLIC_HEADERS, esc, formToken, gateP2, publicOn, publicPage, publicPostOk } from "../services/tools/p2-public";

const LinkBody = z.object({
  url: z.string().max(4096), code: z.string().max(64).nullish(), title: z.string().max(400).nullish(), tags: z.array(z.string().max(64)).max(20).optional(),
  expiresAt: z.string().max(40).nullish(), maxClicks: z.number().int().nullish(), password: z.string().max(200).nullish(), enabled: z.boolean().optional(),
});
const PatchBody = LinkBody.partial().extend({ clearPassword: z.boolean().optional() });
const BulkBody = z.object({ rows: z.array(z.object({ url: z.string().max(4096), code: z.string().max(64).optional(), title: z.string().max(400).optional(), tags: z.union([z.string().max(400), z.array(z.string())]).optional() })).max(500) });
const BioBody = z.object({
  slug: z.string().max(64), title: z.string().max(200), bio: z.string().max(1000).optional(), avatar: z.enum(["logo", "photo", "none"]), theme: z.enum(["brand", "light", "dark"]),
  items: z.array(z.object({ id: z.string().max(64).optional(), title: z.string().max(200), url: z.string().max(4096), icon: z.string().max(20).optional(), on: z.boolean().optional() })).max(60),
  socials: z.array(z.object({ kind: z.string().max(20), url: z.string().max(4096) })).max(20), published: z.boolean(),
});
const GoBody = z.object({ name: z.string().max(64), targetKind: z.enum(["url", "doc", "task", "project"]), targetId: z.string().max(64).nullish(), url: z.string().max(4096).nullish(), description: z.string().max(400).nullish() });

async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>, msg: string): Promise<T> {
  const p = schema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) throw badRequest(msg);
  return p.data;
}
const daysOf = (c: Context<AppEnv>) => { const d = Number(c.req.query("days") ?? 30); return (STATS_DAYS as readonly number[]).includes(d) ? d : 30; };
const scopeOf = (c: Context<AppEnv>): BioScope => (c.req.query("scope") === "workspace" ? "workspace" : "me");

function later(c: Context<AppEnv>, p: Promise<unknown>) {
  try { c.executionCtx.waitUntil(p); } catch { void p.catch(() => undefined); /* Node: the timer runs in the process */ }
}

export function linksRoutes() {
  const creates = new RateLimiter(300, 60 * 60_000); // 300 new links an hour per person, in memory
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { await gateP2(c, "links"); await next(); })
    .get("/", async (c) => c.json(await listLinks(c.var.deps, c.var.auth)))
    .post("/", async (c) => {
      if (!creates.take(c.var.auth.userId)) throw new HttpError(429, "rate_limited", "Too many new links in the last hour. Try again later.");
      return c.json({ link: await createLink(c.var.deps, c.var.auth, await body(c, LinkBody, "Add the address the link opens.")) }, 201);
    })
    .post("/bulk", async (c) => {
      const b = await body(c, BulkBody, "The file needs a url column and up to 500 rows.");
      if (!creates.take(c.var.auth.userId)) throw new HttpError(429, "rate_limited", "Too many new links in the last hour. Try again later.");
      return c.json(await bulkCreate(c.var.deps, c.var.auth, b.rows), 201);
    })
    .get("/check", async (c) => {
      const raw = c.req.query("code") ?? "";
      let code: string;
      try { code = checkCode(raw); } catch (e) { return c.json({ free: false, message: (e as Error).message }); }
      return c.json({ free: await codeFree(c.var.deps, code), code });
    })
    .get("/bio", async (c) => c.json({ page: await getBio(c.var.deps, c.var.auth, scopeOf(c)) }))
    .put("/bio", async (c) => c.json({ page: await saveBio(c.var.deps, c.var.auth, scopeOf(c), await body(c, BioBody, "Check the page details and try again.")) }))
    .get("/bio/stats", async (c) => c.json(await bioStats(c.var.deps, c.var.auth, scopeOf(c), daysOf(c))))
    .get("/go", async (c) => c.json({ links: await listGo(c.var.deps, c.var.auth) }))
    .post("/go", async (c) => c.json({ link: await createGo(c.var.deps, c.var.auth, await body(c, GoBody, "Add a name and what it opens.")) }, 201))
    .get("/go/open/:name", async (c) => c.json(await openGo(c.var.deps, c.var.auth, c.req.param("name"))))
    .patch("/go/:id", async (c) => c.json({ link: await updateGo(c.var.deps, c.var.auth, c.req.param("id"), await body(c, GoBody.partial(), "Check the go link and try again.")) }))
    .delete("/go/:id", async (c) => c.json(await deleteGo(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/host", async (c) => c.json(await getHost(c.var.deps, c.var.auth)))
    .put("/host", async (c) => c.json(await setHost(c.var.deps, c.var.auth, await body(c, z.object({ domainId: z.string().max(64), sub: z.string().max(64) }), "Pick a domain and a name."))))
    .post("/host/check", async (c) => c.json(await checkHost(c.var.deps, c.var.auth)))
    .delete("/host", async (c) => c.json(await removeHost(c.var.deps, c.var.auth)))
    .get("/:id", async (c) => c.json({ link: await getLink(c.var.deps, c.var.auth, c.req.param("id")) }))
    .patch("/:id", async (c) => c.json({ link: await updateLink(c.var.deps, c.var.auth, c.req.param("id"), await body(c, PatchBody, "Check the link details and try again.")) }))
    .delete("/:id", async (c) => c.json(await deleteLink(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/:id/stats", async (c) => c.json(await linkStats(c.var.deps, c.var.auth, c.req.param("id"), daysOf(c))))
    .get("/:id/clicks.csv", async (c) => {
      const f = await linkCsv(c.var.deps, c.var.auth, c.req.param("id"));
      return new Response(f.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${f.name}"`, "cache-control": "no-store" } });
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------------------------------------------

const GONE: Record<string, [string, string, number]> = {
  missing: ["This link doesn't exist", "Check the address, or ask the person who sent it for a new one.", 404],
  off: ["This link is turned off", "The person who made it turned it off. Ask them for a new one.", 410],
  expired: ["This link has ended", "It was set to stop working after a date. Ask the person who sent it for a new one.", 410],
  used_up: ["This link has been used up", "It reached its click limit. Ask the person who sent it for a new one.", 410],
  locked: ["Too many tries", "Wait a minute, then try again.", 429],
  bio_missing: ["This page doesn't exist", "Check the address and try again.", 404],
};

function gone(c: Context<AppEnv>, kind: keyof typeof GONE) {
  const [h, p, status] = GONE[kind];
  return c.html(publicPage(h, `<header class="top"><span class="brand">Multies</span></header><main><div class="card"><h1>${h}</h1><p class="muted">${p}</p></div></main>`), status as 404, { ...PUBLIC_HEADERS, ...(status === 429 ? { "retry-after": "60" } : {}) });
}

async function passwordPage(c: Context<AppEnv>, r: ResolvedLink, code: string, error?: string) {
  const ft = await formToken(c, "link", r.id);
  return c.html(publicPage("Enter the password", `<header class="top"><span class="brand">Multies</span></header>
<main><div class="card"><h1>This link has a password</h1><p class="muted">Enter it to open the link.</p>
<form method="post" action="/l/${esc(code)}" autocomplete="off"><input type="hidden" name="ft" value="${ft}">
<label for="pw">Password</label><input id="pw" name="password" type="password" required maxlength="128" autofocus>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}<div class="row"><button type="submit" class="full">Open link</button></div></form></div></main>`), error ? 401 : 200, PUBLIC_HEADERS);
}

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, "cache-control": "private, no-store", "x-robots-tag": "noindex", "referrer-policy": "strict-origin-when-cross-origin" } });

function stateOf(r: ResolvedLink, now: number): keyof typeof GONE | null {
  if (!r.enabled) return "off";
  if (r.expiresAt !== null && r.expiresAt <= now) return "expired";
  if (r.maxClicks !== null && r.clicks >= r.maxClicks) return "used_up";
  return null;
}

const ownHost = (c: Context<AppEnv>) => { try { return new URL(c.var.deps.config.appUrl).hostname; } catch { return ""; } };

/** Counts the visit (after the response) and sends it on. A click limited link takes its click first. */
async function sendOn(c: Context<AppEnv>, r: ResolvedLink) {
  const deps = c.var.deps;
  const click = await clickOf(deps, { headers: c.req.raw.headers, ip: c.var.ip, ownHost: ownHost(c) }, r.orgId, r.id);
  if (r.maxClicks !== null) {
    if (click) {
      if (!(await takeLimitedClick(deps, r.id))) return gone(c, "used_up");
      later(c, queue(deps, click, null));
    } else later(c, queue(deps, null, null, r.id));
  } else later(c, queue(deps, click, click ? { table: "short", id: r.id } : null, click ? undefined : r.id));
  return redirect(r.url);
}

/** A link domain request: its workspace, or null on our own hosts. */
async function hostOrg(c: Context<AppEnv>): Promise<string | null | undefined> {
  const h = (c.req.header("x-link-host") ?? "").toLowerCase();
  return h ? orgForHost(c.var.deps, h) : undefined;
}

export function linkPublicRoutes() {
  const opens = new RateLimiter(240, 60_000);
  const posts = new RateLimiter(10, 60_000);
  return new Hono<AppEnv>()
    .get("/:code", async (c) => {
      if (!publicOn(c, "links")) return gone(c, "missing");
      if (!opens.take(c.var.ip)) return gone(c, "locked");
      const code = normCode(c.req.param("code"));
      if (!CODE_RE.test(code)) return gone(c, "missing");
      const r = await resolveCode(c.var.deps, code);
      const org = await hostOrg(c);
      if (!r || (org !== undefined && org !== r.orgId)) return gone(c, "missing");
      const st = stateOf(r, c.var.deps.now().getTime());
      if (st) return gone(c, st);
      if (r.hasPassword) return passwordPage(c, r, code);
      return sendOn(c, r);
    })
    .post("/:code", async (c) => {
      if (!publicOn(c, "links")) return gone(c, "missing");
      if (!posts.take(c.var.ip)) return gone(c, "locked");
      const code = normCode(c.req.param("code"));
      const r = CODE_RE.test(code) ? await resolveCode(c.var.deps, code, true) : null;
      if (!r) return gone(c, "missing");
      const st = stateOf(r, c.var.deps.now().getTime());
      if (st) return gone(c, st);
      const fd = await c.req.formData().catch(() => null);
      const ft = fd?.get("ft");
      if (!(await publicPostOk(c, "link", r.id, typeof ft === "string" ? ft : null))) return passwordPage(c, r, code, "Open the link again and enter the password.");
      const pw = fd?.get("password");
      const hash = r.hasPassword ? await passwordHashOf(c.var.deps, r.id) : null;
      if (hash && !(typeof pw === "string" && pw.length <= 128 && (await verifyPassword(pw, hash)))) return passwordPage(c, r, code, "That password is not right.");
      return sendOn(c, r);
    });
}

export function bioPublicRoutes() {
  const opens = new RateLimiter(240, 60_000);
  return new Hono<AppEnv>()
    .get("/:slug", async (c) => {
      if (!publicOn(c, "links")) return gone(c, "bio_missing");
      if (!opens.take(c.var.ip)) return gone(c, "locked");
      const slug = c.req.param("slug").toLowerCase();
      const b = SLUG_RE.test(slug) ? await resolveBio(c.var.deps, slug) : null;
      if (!b || !b.published) return gone(c, "bio_missing");
      const click = await clickOf(c.var.deps, { headers: c.req.raw.headers, ip: c.var.ip, ownHost: ownHost(c) }, b.orgId, b.id);
      // A page view is a counter only (no click row): people see it as Views beside the page.
      if (click) later(c, queue(c.var.deps, null, { table: "bio_views", id: b.id }));
      return c.html(renderBio(b, c.var.deps.config.appUrl.replace(/\/+$/, "")), 200, { "cache-control": "private, max-age=0", "x-robots-tag": "index, follow", "referrer-policy": "strict-origin-when-cross-origin" });
    })
    .get("/:slug/go/:item", async (c) => {
      if (!publicOn(c, "links")) return gone(c, "bio_missing");
      if (!opens.take(c.var.ip)) return gone(c, "locked");
      const slug = c.req.param("slug").toLowerCase();
      const b = SLUG_RE.test(slug) ? await resolveBio(c.var.deps, slug) : null;
      const item = b?.published ? b.items.find((i) => i.id === c.req.param("item") && i.on) : undefined;
      if (!b || !item) return gone(c, "bio_missing");
      const click = await clickOf(c.var.deps, { headers: c.req.raw.headers, ip: c.var.ip, ownHost: ownHost(c) }, b.orgId, item.id);
      if (click) later(c, queue(c.var.deps, click, null));
      return redirect(item.url);
    });
}
