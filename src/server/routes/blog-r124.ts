/**
 * R124: the blog (BLOG_R124). Team API under /api/sites/blog (signed in; editors write and publish, admins email posts and
 * see subscribers) and the public pages under /site/<site>/blog: index with pages, post, tag, author, RSS 2.0, the
 * subscribe box (double opt in through R109) and images used by live posts. Public pages are server rendered from the
 * live snapshot; the only script is the subscribe box.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { audit } from "../services/audit";
import { issueChallenge, requireShield } from "../services/spam-shield";
import { readDocImage } from "../services/suite/doc-images-r32";
import { resolveSite, siteUrl, type PublicSite } from "../services/sites";
import * as B from "../services/blog-r124";
import { escHtml, renderPageHtml, type RenderLinks } from "@/shared/sites";
import { SHIELD_MIN_FILL_MS, type ShieldAnswer } from "@/shared/spam-shield";
import {
  BLOG_CSS, PER_PAGE, autoExcerpt, fmtPostDate, pageNumber, pagerHtml, postCardsHtml, postMetaHtml, publicImage, rssXml, subscribeBoxHtml, tagSlug, tagsHtml, type CardPost,
} from "@/shared/blog-r124";
import { missingSitePage } from "./sites";

const Start = z.object({ title: z.string().max(200).optional(), description: z.string().max(400).optional() });
const BlogPatch = z.object({
  title: z.string().max(200).optional(), description: z.string().max(400).optional(), subscribeOn: z.boolean().optional(), newsletter: z.boolean().optional(),
  mailboxId: z.string().max(64).nullable().optional(), senderName: z.string().max(120).optional(), senderAddress: z.string().max(300).optional(),
});
const NewPost = z.object({ title: z.string().max(400).optional() });
const PostPatch = z.object({
  title: z.string().max(400).optional(), slug: z.string().max(100).optional(), excerpt: z.string().max(600).optional(), cover: z.string().max(2100).optional(),
  tags: z.array(z.string().max(80)).max(30).optional(), authorId: z.string().max(80).nullable().optional(), emailOnPublish: z.boolean().optional(),
});
const Publish = z.object({ at: z.number().nullable().optional() });
const AuthorPatch = z.object({ name: z.string().max(200).optional(), bio: z.string().max(800).optional(), photo: z.string().max(2100).optional(), slug: z.string().max(100).optional() });

const log = (c: Context<AppEnv>, action: string, targetId: string, metadata: Record<string, unknown> = {}) =>
  audit(c.var.deps.db, { orgId: c.var.auth.orgId, actorUserId: c.var.auth.userId, actorEmail: c.var.auth.email, action, targetType: "blog_post", targetId, metadata }).catch(() => undefined);

export function blogRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await B.getBlog(c.var.deps, c.var.auth)))
    .post("/", async (c) => c.json(await B.startBlog(c.var.deps, c.var.auth, await parseBody(c, Start)), 201))
    .patch("/", async (c) => c.json(await B.updateBlog(c.var.deps, c.var.auth, await parseBody(c, BlogPatch))))
    .get("/posts", async (c) => c.json(await B.listPosts(c.var.deps, c.var.auth, { q: c.req.query("q"), status: c.req.query("status"), tag: c.req.query("tag"), author: c.req.query("author") })))
    .post("/posts", async (c) => c.json(await B.createPost(c.var.deps, c.var.auth, await parseBody(c, NewPost)), 201))
    .get("/posts/:id", async (c) => c.json(await B.getPost(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/posts/:id", async (c) => c.json(await B.savePost(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, PostPatch))))
    .delete("/posts/:id", async (c) => { const r = await B.deletePost(c.var.deps, c.var.auth, c.req.param("id")); await log(c, "blog.post_deleted", c.req.param("id")); return c.json(r); })
    .post("/posts/:id/publish", async (c) => {
      const r = await B.publishPost(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, Publish));
      await log(c, "blog.post_published", r.post.id, { status: r.post.status, email: r.email.status });
      return c.json(r);
    })
    .post("/posts/:id/unpublish", async (c) => { const r = await B.unpublishPost(c.var.deps, c.var.auth, c.req.param("id")); await log(c, "blog.post_unpublished", r.id); return c.json(r); })
    .get("/posts/:id/preview", async (c) => {
      const deps = c.var.deps;
      const { s, b, p, snap, author } = await B.previewPost(deps, c.var.auth, c.req.param("id"));
      const site = await resolveSite(deps, s.slug);
      const fake: PublicSite = site ?? { id: s.id, orgId: s.orgId, slug: s.slug, name: s.name, description: s.description, commentsOn: false, homePageId: null, brandColor: null, logoUrl: null, nav: [] };
      const base = B.blogBase(deps, s.slug);
      const cover = previewImage(p.cover);
      const body = `<p class="note">Preview. Visitors don't see this until you publish.</p><article class="post"><h1>${escHtml(p.title)}</h1>${postMetaHtml({ publishedAt: deps.now().getTime(), readMins: snap.meta.readMins, authorName: author?.name ?? "", authorHref: null })}`
        + `${cover ? `<img class="cover" src="${escHtml(cover)}" alt="">` : ""}<div class="body">${previewHtml(snap.html, base)}</div>${tagsHtml(snap.meta.tags, base)}</article>`;
      const html = renderPageHtml(shell(deps, fake, b.title, "blog"), { title: p.title, blocks: [], description: p.excerpt }, linksFor(deps), { preview: true, bodyHtml: body, headExtra: `<style>${BLOG_CSS}</style>` });
      return c.html(html, 200, { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", "content-security-policy": "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; frame-ancestors 'self'" });
    })
    .get("/authors", async (c) => c.json(await B.listAuthors(c.var.deps, c.var.auth)))
    .patch("/authors/:userId", async (c) => c.json(await B.saveAuthor(c.var.deps, c.var.auth, c.req.param("userId"), await parseBody(c, AuthorPatch))))
    .get("/subscribers", async (c) => c.json(await B.subscribers(c.var.deps, c.var.auth, { search: c.req.query("q"), status: c.req.query("status") || undefined, offset: Number(c.req.query("offset") ?? 0) || 0 })))
    .get("/subscribers.csv", async (c) => {
      const csv = await B.subscribersCsv(c.var.deps, c.var.auth);
      await log(c, "blog.subscribers_exported", "list");
      return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=\"blog-subscribers.csv\"", "cache-control": "private, no-store" });
    })
    .delete("/subscribers/:id", async (c) => { const r = await B.removeSubscriber(c.var.deps, c.var.auth, c.req.param("id")); await log(c, "blog.subscriber_removed", c.req.param("id")); return c.json(r); });
}

/** In the signed in preview, uploaded images load through the signed in image address. */
const previewImage = (src: string) => { const m = /^\/api\/doc-images\/(dim_[A-Za-z0-9]{6,40})$/.exec(src.trim()); return m ? src.trim() : publicImage(src, ""); };
const previewHtml = (html: string, base: string) => html.split(`${base}/img/`).join("/api/doc-images/");

function linksFor(deps: Deps): RenderLinks {
  const app = deps.config.appUrl.replace(/\/+$/, "");
  return { formHref: (s) => `${app}/f/${encodeURIComponent(s)}`, bookingHref: (s) => `${app}/book/${encodeURIComponent(s)}` };
}

/** The site's header and nav with the blog in it (current when on a blog page). */
function shell(deps: Deps, site: PublicSite, blogTitle: string, current: "blog" | null) {
  const base = siteUrl(deps, site.slug);
  const nav = site.nav.map((n) => ({ title: n.title, href: n.id === site.homePageId ? base : `${base}/${n.slug}`, current: false }));
  nav.push({ title: blogTitle, href: `${base}/blog`, current: current === "blog" });
  return { name: site.name, brandColor: site.brandColor, logoUrl: site.logoUrl, homeHref: base, nav };
}

const HTML_HEADERS = { "cache-control": "public, max-age=60", "x-robots-tag": "index, follow", "referrer-policy": "strict-origin-when-cross-origin" } as const;
const NOINDEX = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "strict-origin-when-cross-origin" } as const;

export const BLOG_JS = `(function(){var f=document.getElementById("blog-subscribe");if(!f)return;var st=document.getElementById("sub-status");var ch=null;var got=0;
function zeros(u){var n=0;for(var i=0;i<u.length;i++){if(u[i]===0){n+=8;continue}return n+Math.clz32(u[i])-24}return n}
function get(){return fetch(f.getAttribute("data-shield"),{credentials:"omit"}).then(function(r){return r.json()}).then(function(j){ch=j.challenge;got=Date.now();return ch})}
function solve(c){var e=new TextEncoder();var n=0;return new Promise(function(res,rej){function step(){var k=0;(function one(){if(n>Math.pow(2,Math.min(c.difficulty,22)+6))return rej(new Error("work"));crypto.subtle.digest("SHA-256",e.encode(c.salt+":"+n)).then(function(d){if(zeros(new Uint8Array(d))>=c.difficulty)return res(n);n++;k++;if(k<4000)one();else setTimeout(step,0)})})()}step()})}
get().catch(function(){});
f.addEventListener("submit",function(ev){ev.preventDefault();var b=f.querySelector("button");var em=f.elements.email.value.trim();
if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(em)){st.textContent="Enter a valid email address.";f.elements.email.focus();return}
b.disabled=true;st.textContent="Sending";var wait=ch?Math.max(0,${SHIELD_MIN_FILL_MS + 300}-(Date.now()-got)):${SHIELD_MIN_FILL_MS + 300};
new Promise(function(r){setTimeout(r,wait)}).then(function(){return ch||get().then(function(c){return new Promise(function(r){setTimeout(function(){r(c)},${SHIELD_MIN_FILL_MS + 300})})})}).then(function(c){return solve(c).then(function(nonce){return fetch(f.action,{method:"POST",credentials:"omit",headers:{"content-type":"application/json"},body:JSON.stringify({email:em,shield:{challenge:c,nonce:nonce,hp:f.elements.website.value}})})})})
.then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})}).then(function(x){ch=null;if(x.ok){f.reset();st.textContent="Check your inbox. Open the email we sent and confirm to finish."}else{st.textContent=(x.j&&x.j.error&&x.j.error.message)||"That did not go through. Try again."}})
.catch(function(){st.textContent="That did not go through. Check your connection and try again."}).then(function(){b.disabled=false})})})();`;
export const BLOG_JS_HEADERS = { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=600" } as const;

export function blogPublicRoutes() {
  const opens = new RateLimiter(240, 60_000);
  const subs = new RateLimiter(5, 60_000);
  const app = new Hono<AppEnv>();

  const live = async (c: Context<AppEnv>) => {
    if (!opens.take(c.var.ip)) return { err: c.html(missingSitePage("Too many requests", "Wait a minute, then try again."), 429, NOINDEX) };
    const site = await resolveSite(c.var.deps, c.req.param("slug") ?? "");
    const blog = site ? await B.resolveBlog(c.var.deps, site) : null;
    if (!site || !blog) return { err: c.html(missingSitePage(), 404, NOINDEX) };
    return { site, blog };
  };
  const authorOf = (blog: B.PublicBlog, id: string | null) => (id ? blog.authors.find((a) => a.userId === id) ?? null : null);
  const cards = (deps: Deps, site: PublicSite, blog: B.PublicBlog, list: B.PublicPost[]): CardPost[] => {
    const base = B.blogBase(deps, site.slug);
    return list.map((p) => { const a = authorOf(blog, p.authorId); return { slug: p.slug, title: p.title, excerpt: p.excerpt, cover: publicImage(p.cover, base), tags: p.tags, authorName: a?.name ?? "", authorSlug: a?.slug ?? null, publishedAt: p.publishedAt, readMins: p.readMins }; });
  };
  const page = (c: Context<AppEnv>, site: PublicSite, blog: B.PublicBlog, o: { title: string; description: string; canonical: string; image?: string | null; body: string; ogType?: string; head?: string; subscribe?: boolean }) => {
    const deps = c.var.deps;
    const base = B.blogBase(deps, site.slug);
    const box = o.subscribe !== false && blog.subscribe.ok ? subscribeBoxHtml({ action: `${base}/subscribe`, shield: `${base}/_shield`, blogTitle: blog.title, senderName: blog.subscribe.senderName }) : "";
    const feed = `<p class="feed-link"><a href="${escHtml(`${base}/rss.xml`)}">RSS feed</a></p>`;
    const appUrl = deps.config.appUrl.replace(/\/+$/, "");
    const html = renderPageHtml(shell(deps, site, blog.title, "blog"), { title: o.title, blocks: [], description: o.description, image: o.image || site.logoUrl || `${appUrl}/og-image.png`, canonical: o.canonical }, linksFor(deps), {
      bodyHtml: o.body + box + feed, ogType: o.ogType, footer: site.name, scriptSrc: box ? "/site-assets/blog.js" : null,
      headExtra: `<link rel="alternate" type="application/rss+xml" title="${escHtml(`${blog.title} | ${site.name}`)}" href="${escHtml(`${base}/rss.xml`)}">${o.head ?? ""}<style>${BLOG_CSS}</style>`,
    });
    return c.html(html, 200, HTML_HEADERS);
  };
  const listing = (c: Context<AppEnv>, site: PublicSite, blog: B.PublicBlog, list: B.PublicPost[], o: { title: string; heading: string; intro: string; canonical: string; empty: string; head?: string; image?: string | null }) => {
    const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    const n = pageNumber(c.req.query("page"), pages);
    const slice = list.slice((n - 1) * PER_PAGE, n * PER_PAGE);
    const href = (k: number) => (k === 1 ? o.canonical : `${o.canonical}?page=${k}`);
    const base = B.blogBase(c.var.deps, site.slug);
    const body = `<header class="blog-head"><h1>${escHtml(o.heading)}</h1>${o.intro ? `<p>${escHtml(o.intro)}</p>` : ""}</header>${o.head ?? ""}${postCardsHtml(cards(c.var.deps, site, blog, slice), base, o.empty)}${pagerHtml(n, pages, href)}`;
    return page(c, site, blog, { title: n > 1 ? `${o.title}, page ${n}` : o.title, description: o.intro || `${o.heading} on ${site.name}`, canonical: href(n), body, image: o.image });
  };

  app.get("/:slug/blog", async (c) => {
    const r = await live(c); if (r.err) return r.err;
    const { site, blog } = r;
    return listing(c, site, blog, blog.posts, { title: blog.title, heading: blog.title, intro: blog.description, canonical: B.blogBase(c.var.deps, site.slug), empty: "No posts yet. Check back soon." });
  });
  app.get("/:slug/blog/rss.xml", async (c) => {
    const r = await live(c); if (r.err) return r.err;
    const { site, blog } = r;
    const base = B.blogBase(c.var.deps, site.slug);
    const items = blog.posts.map((p) => ({ title: p.title, url: `${base}/${p.slug}`, excerpt: p.excerpt, publishedAt: p.publishedAt, author: authorOf(blog, p.authorId)?.name, tags: p.tags, cover: publicImage(p.cover, base) }));
    const body = rssXml({ title: `${blog.title} | ${site.name}`, description: blog.description || site.description || blog.title, link: base, self: `${base}/rss.xml`, updated: blog.posts[0]?.publishedAt ?? null }, items);
    return c.body(body, 200, { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=600" });
  });
  app.get("/:slug/blog/_shield", async (c) => {
    const r = await live(c);
    if (r.err || !r.blog.subscribe.ok) return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
    return c.json({ challenge: await issueChallenge(c.var.deps, "blog_subscribe") }, 200, { "cache-control": "no-store" });
  });
  app.post("/:slug/blog/subscribe", async (c) => {
    if (!subs.take(c.var.ip)) return c.json({ error: { code: "rate_limited", message: "Too many tries. Wait a minute, then try again." } }, 429);
    const site = await resolveSite(c.var.deps, c.req.param("slug"));
    const blog = site ? await B.resolveBlog(c.var.deps, site) : null;
    if (!site || !blog) return c.json({ error: { code: "not_found", message: "This blog doesn't exist." } }, 404);
    if (!blog.subscribe.ok) return c.json({ error: { code: "not_found", message: "Subscriptions are closed on this blog." } }, 404);
    let body: { email?: unknown; shield?: ShieldAnswer };
    try { body = (await c.req.json()) as typeof body; } catch {
      // A browser without the subscribe script posts the form itself: answer with a real page, not raw JSON.
      if (!(c.req.header("content-type") ?? "").includes("application/json")) {
        const base = B.blogBase(c.var.deps, site.slug);
        const res = page(c, site, blog, { title: "Turn on JavaScript to subscribe", description: `Subscribe to ${blog.title}`, canonical: base, subscribe: false,
          body: `<section class="blog-note"><h1>Turn on JavaScript to subscribe</h1><p>The subscribe box needs JavaScript so we can keep spam out. Turn it on, then try again.</p><p><a href="${escHtml(base)}">Back to the blog</a></p></section>`, head: '<meta name="robots" content="noindex">' });
        return new Response(res.body, { status: 400, headers: res.headers });
      }
      return c.json({ error: { code: "bad_request", message: "Turn on JavaScript to subscribe." } }, 400);
    }
    try {
      await requireShield(c.var.deps, "blog_subscribe", body.shield);
      await B.subscribe(c.var.deps, site, String(body.email ?? "").slice(0, 254));
    } catch (e) {
      if (e instanceof HttpError) return c.json({ error: { code: e.code, message: e.message } }, e.status as 400);
      throw e;
    }
    return c.json({ ok: true, message: "Check your inbox to confirm." }, 202);
  });
  app.get("/:slug/blog/img/:id", async (c) => {
    const site = await resolveSite(c.var.deps, c.req.param("slug"));
    const id = c.req.param("id");
    if (!site || !(await B.publicImageOk(c.var.deps, site, id))) return c.body("Not found", 404, { "cache-control": "no-store" });
    try {
      const img = await readDocImage(c.var.deps, site.orgId, id);
      return new Response(img.bytes as BodyInit, { headers: { "content-type": img.contentType, "content-length": String(img.bytes.length), "x-content-type-options": "nosniff", "cache-control": "public, max-age=3600", "content-security-policy": "default-src 'none'; sandbox" } });
    } catch { return c.body("Not found", 404, { "cache-control": "no-store" }); }
  });
  app.get("/:slug/blog/tag/:tag", async (c) => {
    const r = await live(c); if (r.err) return r.err;
    const { site, blog } = r;
    const t = tagSlug(decodeURIComponent(c.req.param("tag")));
    const list = blog.posts.filter((p) => p.tags.some((x) => tagSlug(x) === t));
    if (!list.length) return c.html(missingSitePage("No posts with this tag", "It may have been removed. Go back to the blog to see every post."), 404, NOINDEX);
    const name = list[0]!.tags.find((x) => tagSlug(x) === t) ?? t;
    return listing(c, site, blog, list, { title: `${name} | ${blog.title}`, heading: name, intro: `Posts tagged ${name}`, canonical: `${B.blogBase(c.var.deps, site.slug)}/tag/${encodeURIComponent(t)}`, empty: "No posts with this tag yet." });
  });
  app.get("/:slug/blog/author/:author", async (c) => {
    const r = await live(c); if (r.err) return r.err;
    const { site, blog } = r;
    const a = blog.authors.find((x) => x.slug === c.req.param("author"));
    const list = a ? blog.posts.filter((p) => p.authorId === a.userId) : [];
    if (!a || !list.length) return c.html(missingSitePage("This author has no posts here", "Go back to the blog to see every post."), 404, NOINDEX);
    const base = B.blogBase(c.var.deps, site.slug);
    const photo = publicImage(a.photo, base);
    const head = `<div class="author-head">${photo ? `<img src="${escHtml(photo)}" alt="">` : ""}<div>${a.bio ? `<p>${escHtml(a.bio)}</p>` : ""}</div></div>`;
    return listing(c, site, blog, list, { title: `${a.name} | ${blog.title}`, heading: a.name, intro: "", head, canonical: `${base}/author/${a.slug}`, empty: "No posts yet.", image: photo });
  });
  app.get("/:slug/blog/:post", async (c) => {
    const r = await live(c); if (r.err) return r.err;
    const { site, blog } = r;
    const deps = c.var.deps;
    const p = await B.resolvePost(deps, site, c.req.param("post"));
    if (!p) return c.html(missingSitePage("This post doesn't exist", "It may have been moved or unpublished. Go back to the blog to see every post."), 404, NOINDEX);
    const base = B.blogBase(deps, site.slug);
    const meta = blog.posts.find((x) => x.id === p.id);
    const publishedAt = meta?.publishedAt ?? p.publishAt;
    const a = authorOf(blog, p.meta.authorId);
    const cover = publicImage(p.meta.cover, base);
    const aPhoto = a ? publicImage(a.photo, base) : null;
    const authorCard = a ? `<aside class="author-card" aria-label="About the author">${aPhoto ? `<img src="${escHtml(aPhoto)}" alt="">` : ""}<div><p><a href="${escHtml(`${base}/author/${a.slug}`)}" rel="author"><b>${escHtml(a.name)}</b></a></p>${a.bio ? `<p>${escHtml(a.bio)}</p>` : ""}</div></aside>` : "";
    const body = `<article class="post"><p class="meta"><a href="${escHtml(base)}">${escHtml(blog.title)}</a></p><h1>${escHtml(p.meta.title)}</h1>`
      + postMetaHtml({ publishedAt, readMins: p.meta.readMins || 1, authorName: a?.name ?? "", authorHref: a ? `${base}/author/${a.slug}` : null })
      + `${cover ? `<img class="cover" src="${escHtml(cover)}" alt="">` : ""}<div class="body">${p.html}</div>${tagsHtml(p.meta.tags, base)}${authorCard}</article>`;
    const iso = new Date(publishedAt).toISOString();
    const head = `<meta property="article:published_time" content="${iso}">${a ? `<meta property="article:author" content="${escHtml(a.name)}">` : ""}${p.meta.tags.map((t) => `<meta property="article:tag" content="${escHtml(t)}">`).join("")}`;
    return page(c, site, blog, { title: p.meta.title, description: p.meta.excerpt || autoExcerpt(p.meta.text ?? "", 160) || `${fmtPostDate(publishedAt)} on ${blog.title}`, canonical: `${base}/${c.req.param("post")}`, image: cover, body, ogType: "article", head });
  });
  return app;
}

/** Sitemap lines for the blog (index, posts, tags, authors with posts). */
export async function blogSitemapUrls(deps: Deps, site: PublicSite): Promise<string[]> {
  const blog = await B.resolveBlog(deps, site);
  if (!blog || !blog.posts.length) return [];
  const base = B.blogBase(deps, site.slug);
  const tags = new Set(blog.posts.flatMap((p) => p.tags.map((t) => tagSlug(t))).filter(Boolean));
  const authors = new Set(blog.posts.map((p) => p.authorId).filter(Boolean));
  return [base, ...blog.posts.map((p) => `${base}/${p.slug}`), ...[...tags].map((t) => `${base}/tag/${encodeURIComponent(t)}`),
    ...blog.authors.filter((a) => authors.has(a.userId)).map((a) => `${base}/author/${a.slug}`)];
}

/** The blog's nav entry on the site's own pages, once it has a live post. */
export async function blogNavItem(deps: Deps, site: PublicSite): Promise<{ title: string; href: string } | null> {
  const blog = await B.resolveBlog(deps, site);
  return blog && blog.posts.length ? { title: blog.title, href: B.blogBase(deps, site.slug) } : null;
}

