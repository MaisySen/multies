/**
 * R123: Sites.
 *   /api/sites/*          the team side: the site, pages (draft, versions, publish now or later), comments to moderate,
 *                         page view counts (signed in; owners, admins and site editors change; members read)
 *   /site/<slug>[/<page>] the public pages, server rendered from the live snapshot only; comments post as JSON after the
 *                         spam shield (the small same origin script /site-assets/comments.js does the work)
 * Behind SITES_R123=on.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { issueChallenge, requireShield } from "../services/spam-shield";
import { deviceOf, isBotAgent, referrerOf } from "@/shared/links";
import { SHIELD_HONEYPOT_NAME, type ShieldAnswer } from "@/shared/spam-shield";
import { escHtml, renderPageHtml, type RenderLinks } from "@/shared/sites";
import { blogNavItem, blogSitemapUrls } from "./blog-r124";
import {
  createPage, deletePage, getPage, getSite, linkables, listComments, listPages, listVersions, moderateComment, postComment, publicComments, publishPage,
  queueView, resolvePage, sitesInUse, resolveSite, restoreVersion, savePage, siteStats, siteUrl, startSite, unpublishPage, updateSite, type PublicSite,
} from "../services/sites";

const Start = z.object({ name: z.string().max(200), slug: z.string().max(60) });
const SitePatch = z.object({
  name: z.string().max(200).optional(), slug: z.string().max(60).optional(), description: z.string().max(400).optional(), commentsOn: z.boolean().optional(),
  editors: z.array(z.string().max(80)).max(50).optional(), homePageId: z.string().max(80).optional(),
});
const NewPage = z.object({ title: z.string().max(400), slug: z.string().max(80).optional() });
const PagePatch = z.object({
  title: z.string().max(400).optional(), slug: z.string().max(80).optional(), blocks: z.array(z.unknown()).max(200).optional(), seoTitle: z.string().max(200).optional(),
  description: z.string().max(400).optional(), image: z.string().max(2100).optional(), membersCanView: z.boolean().optional(), commentsOn: z.boolean().optional(),
});
const Publish = z.object({ at: z.number().nullable().optional() });
const Moderate = z.object({ status: z.enum(["approved", "rejected", "pending", "delete"]) });

export function sitesRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await getSite(c.var.deps, c.var.auth)))
    .get("/in-use", async (c) => c.json(await sitesInUse(c.var.deps, c.var.auth)))
    .post("/", async (c) => c.json(await startSite(c.var.deps, c.var.auth, await parseBody(c, Start)), 201))
    .patch("/", async (c) => c.json(await updateSite(c.var.deps, c.var.auth, await parseBody(c, SitePatch))))
    .get("/linkables", async (c) => c.json(await linkables(c.var.deps, c.var.auth)))
    .get("/pages", async (c) => c.json(await listPages(c.var.deps, c.var.auth)))
    .post("/pages", async (c) => c.json(await createPage(c.var.deps, c.var.auth, await parseBody(c, NewPage)), 201))
    .get("/pages/:id", async (c) => c.json(await getPage(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/pages/:id", async (c) => c.json(await savePage(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, PagePatch))))
    .delete("/pages/:id", async (c) => c.json(await deletePage(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/pages/:id/publish", async (c) => c.json(await publishPage(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, Publish))))
    .post("/pages/:id/unpublish", async (c) => c.json(await unpublishPage(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/pages/:id/versions", async (c) => c.json(await listVersions(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/pages/:id/versions/:vid/restore", async (c) => c.json(await restoreVersion(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("vid"))))
    .get("/comments", async (c) => {
      const s = c.req.query("status");
      return c.json(await listComments(c.var.deps, c.var.auth, s === "approved" || s === "rejected" ? s : "pending"));
    })
    .patch("/comments/:id", async (c) => c.json(await moderateComment(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, Moderate)).status)))
    .get("/stats", async (c) => c.json(await siteStats(c.var.deps, c.var.auth, Number(c.req.query("days") ?? 30))));
}

const HTML_HEADERS = { "cache-control": "private, max-age=0", "x-robots-tag": "index, follow", "referrer-policy": "strict-origin-when-cross-origin" } as const;
const NOINDEX = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "strict-origin-when-cross-origin" } as const;

export function missingSitePage(title = "This page doesn't exist", text = "Check the address and try again.") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escHtml(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#18181b;background:#fff}@media (prefers-color-scheme:dark){body{color:#f4f4f5;background:#0f0f11}}</style></head><body><main><h1>${escHtml(title)}</h1><p>${escHtml(text)}</p></main></body></html>`;
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Sydney" });

function commentsHtml(site: PublicSite, pageSlug: string, list: { id: string; name: string; body: string; at: number }[], open: boolean): string {
  const items = list.length
    ? list.map((x) => `<article class="comment"><b>${escHtml(x.name)}</b><time datetime="${new Date(x.at).toISOString()}">${fmtDate(x.at)}</time><p>${escHtml(x.body).replace(/\n/g, "<br>")}</p></article>`).join("")
    : `<p class="empty">No comments yet.</p>`;
  const form = open
    ? `<form id="site-comment" method="post" action="/site/${escHtml(site.slug)}/${escHtml(pageSlug)}/comments" data-shield="/site/${escHtml(site.slug)}/_shield" novalidate>
<h3>Leave a comment</h3><p class="note">Comments show here after the team approves them.</p>
<label for="c-name">Your name</label><input id="c-name" name="name" maxlength="80" autocomplete="name" required>
<label for="c-body">Comment</label><textarea id="c-body" name="body" rows="4" maxlength="2000" required></textarea>
<div class="hp" aria-hidden="true"><label for="c-hp">Leave this empty</label><input id="c-hp" name="${SHIELD_HONEYPOT_NAME}" tabindex="-1" autocomplete="off"></div>
<p role="status" aria-live="polite" class="note" id="c-status"></p>
<p><button class="btn" type="submit">Post comment</button></p><noscript><p class="note">Turn on JavaScript to post a comment.</p></noscript></form>`
    : "";
  return `<section class="comments" aria-labelledby="c-title"><h2 id="c-title">Comments</h2>${items}${form}</section>`;
}

export const COMMENTS_JS = `(function(){var f=document.getElementById("site-comment");if(!f)return;var st=document.getElementById("c-status");var ch=null;var loaded=Date.now();
function hex(b){return new Uint8Array(b)}function zeros(u){var n=0;for(var i=0;i<u.length;i++){if(u[i]===0){n+=8;continue}return n+Math.clz32(u[i])-24}return n}
function get(){return fetch(f.getAttribute("data-shield"),{credentials:"omit"}).then(function(r){return r.json()}).then(function(j){ch=j.challenge;return ch})}
function solve(c){var e=new TextEncoder();var n=0;return new Promise(function(res,rej){function step(){var k=0;(function one(){if(n>Math.pow(2,Math.min(c.difficulty,22)+6))return rej(new Error("work"));crypto.subtle.digest("SHA-256",e.encode(c.salt+":"+n)).then(function(d){if(zeros(hex(d))>=c.difficulty)return res(n);n++;k++;if(k<4000)one();else setTimeout(step,0)})})()}step()})}
get().catch(function(){});
f.addEventListener("submit",function(ev){ev.preventDefault();var b=f.querySelector("button");var name=f.elements.name.value.trim(),body=f.elements.body.value.trim();
if(!name){st.textContent="Add your name.";f.elements.name.focus();return}if(!body){st.textContent="Write a comment first.";f.elements.body.focus();return}
b.disabled=true;st.textContent="Sending";var wait=Math.max(0,1600-(Date.now()-loaded));
new Promise(function(r){setTimeout(r,wait)}).then(function(){return ch||get()}).then(function(c){return solve(c).then(function(nonce){return fetch(f.action,{method:"POST",credentials:"omit",headers:{"content-type":"application/json"},body:JSON.stringify({name:name,body:body,shield:{challenge:c,nonce:nonce,hp:f.elements.${SHIELD_HONEYPOT_NAME}.value}})})})})
.then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})}).then(function(x){ch=null;get().catch(function(){});if(x.ok){f.reset();st.textContent="Thanks. Your comment shows here once the team approves it."}else{st.textContent=(x.j&&x.j.error&&x.j.error.message)||"That did not go through. Try again."}})
.catch(function(){st.textContent="That did not go through. Check your connection and try again."}).then(function(){b.disabled=false})})})();`;

export const COMMENTS_JS_HEADERS = { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=600" } as const;

function linksFor(deps: Deps): RenderLinks {
  const app = deps.config.appUrl.replace(/\/+$/, "");
  return { formHref: (s) => `${app}/f/${encodeURIComponent(s)}`, bookingHref: (s) => `${app}/book/${encodeURIComponent(s)}` };
}

export function sitePublicRoutes() {
  const opens = new RateLimiter(240, 60_000);
  const posts = new RateLimiter(10, 60_000);
  const app = new Hono<AppEnv>();

  const live = async (c: Context<AppEnv>) => {
    if (!opens.take(c.var.ip)) return { err: c.html(missingSitePage("Too many requests", "Wait a minute, then try again."), 429, NOINDEX) };
    const site = await resolveSite(c.var.deps, c.req.param("slug") ?? "");
    if (!site) return { err: c.html(missingSitePage(), 404, NOINDEX) };
    return { site };
  };

  const render = async (c: Context<AppEnv>, site: PublicSite, pageSlug: string | null) => {
    const deps = c.var.deps;
    const page = await resolvePage(deps, site, pageSlug);
    if (!page) return c.html(missingSitePage(), 404, NOINDEX);
    const isHome = page.id === site.homePageId;
    if (!isHome && pageSlug === null) return c.html(missingSitePage(), 404, NOINDEX);
    const base = siteUrl(deps, site.slug);
    const canonical = isHome ? base : `${base}/${page.slug}`;
    const open = site.commentsOn && page.commentsOn;
    const list = open ? await publicComments(deps, site, page.id) : [];
    const appUrl = deps.config.appUrl.replace(/\/+$/, "");
    const nav = site.nav.map((n) => ({ title: n.title, href: n.id === site.homePageId ? base : `${base}/${n.slug}`, current: n.id === page.id }));
    const blogNav = deps.config.blogR124 ? await blogNavItem(deps, site) : null; // R124: the blog joins the nav once it has a live post
    if (blogNav) nav.push({ ...blogNav, current: false });
    const html = renderPageHtml(
      { name: site.name, brandColor: site.brandColor, logoUrl: site.logoUrl, homeHref: base, nav },
      { title: page.snap.title, blocks: page.snap.blocks, seoTitle: page.snap.seoTitle, description: page.snap.description || site.description, image: page.snap.image || site.logoUrl || `${appUrl}/og-image.png`, canonical },
      linksFor(deps),
      { extraHtml: open ? commentsHtml(site, page.slug, list, true) : "", scriptSrc: open ? "/site-assets/comments.js" : null, footer: site.name },
    );
    const ua = c.req.header("user-agent");
    const purpose = `${c.req.header("sec-purpose") ?? ""} ${c.req.header("purpose") ?? ""}`;
    if (!isBotAgent(ua) && !/prefetch|prerender|preview/i.test(purpose)) {
      const p = queueView(deps, { orgId: site.orgId, pageId: page.id, source: referrerOf(c.req.header("referer"), new URL(c.req.url).host), device: deviceOf(ua) });
      try { c.executionCtx.waitUntil(p); } catch { void p.catch(() => undefined); }
    }
    return c.html(html, 200, HTML_HEADERS);
  };

  app.get("/:slug", async (c) => { const r = await live(c); return r.err ?? render(c, r.site, null); });
  app.get("/:slug/sitemap.xml", async (c) => {
    const r = await live(c);
    if (r.err) return r.err;
    const base = siteUrl(c.var.deps, r.site.slug);
    const urls = r.site.nav.length ? r.site.nav : [];
    const all = await Promise.all(urls.map(async (n) => ((await resolvePage(c.var.deps, r.site, n.id === r.site.homePageId ? null : n.slug)) ? (n.id === r.site.homePageId ? base : `${base}/${n.slug}`) : null)));
    if (c.var.deps.config.blogR124) all.push(...(await blogSitemapUrls(c.var.deps, r.site))); // R124
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${all.filter(Boolean).map((u) => `<url><loc>${escHtml(u!)}</loc></url>`).join("")}</urlset>\n`;
    return c.body(body, 200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" });
  });
  app.get("/:slug/_shield", async (c) => {
    const r = await live(c);
    if (r.err) return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
    return c.json({ challenge: await issueChallenge(c.var.deps, "site_comment") }, 200, { "cache-control": "no-store" });
  });
  app.get("/:slug/:page", async (c) => { const r = await live(c); return r.err ?? render(c, r.site, c.req.param("page")); });
  app.post("/:slug/:page/comments", async (c) => {
    if (!posts.take(c.var.ip)) return c.json({ error: { code: "rate_limited", message: "Too many tries. Wait a minute, then try again." } }, 429);
    const site = await resolveSite(c.var.deps, c.req.param("slug"));
    const page = site ? await resolvePage(c.var.deps, site, c.req.param("page")) : null;
    if (!site || !page) return c.json({ error: { code: "not_found", message: "This page doesn't exist." } }, 404);
    if (!site.commentsOn || !page.commentsOn) return c.json({ error: { code: "forbidden", message: "Comments are off on this page." } }, 403);
    let body: { name?: unknown; body?: unknown; shield?: ShieldAnswer };
    try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: { code: "bad_request", message: "Turn on JavaScript to post a comment." } }, 400); }
    try {
      await requireShield(c.var.deps, "site_comment", body.shield);
      await postComment(c.var.deps, site, page.id, { name: String(body.name ?? ""), body: String(body.body ?? ""), ip: c.var.ip, ua: c.req.header("user-agent") });
    } catch (e) {
      if (e instanceof HttpError) return c.json({ error: { code: e.code, message: e.message } }, e.status as 400);
      throw e;
    }
    return c.json({ ok: true, status: "pending" }, 201);
  });
  return app;
}
