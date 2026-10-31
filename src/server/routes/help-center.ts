/**
 * R122: help center.
 *   /api/help-center/*   settings, categories, articles (published snapshots of docs), questions, answers, feedback and
 *                        "publish a solved ticket" for the team (signed in; owners and admins change, members read and answer)
 *   /help/<slug>/*       the public pages (server rendered, plain form posts, abuse guarded); only published rows
 * Behind HELP_CENTER=on; each workspace also turns its own help center on.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { hmacSha256Hex } from "../lib/crypto";
import { RateLimiter } from "../lib/rate-limit";
import { formToken, publicPostOk } from "../services/tools/p2-public";
import { isBotAgent } from "@/shared/links";
import { pageOf } from "@/shared/help-center";
import {
  acceptAnswer, answerQuestion, articleFeedback, askQuestion, centerBySlug, centerUrl, countView, deleteArticle, deleteCategory, deleteQuestion, getArticle,
  getCenter, getQuestion, listArticles, listCategories, listFeedback, listQuestions, moderateAnswer, moderateQuestion, publicArticle, publicCategory,
  publicHome, publicQuestion, publicQuestions, publicSearch, publishDoc, publishTicket, refreshArticle, saveCategory, saveCenter, sitemap, teamAnswer,
  ticketPreview, updateArticle, visitorOf, vote, type LiveCenter,
} from "../services/help-center";
import { articlePage, askPage, categoryPage, homePage, missingPage, questionPage, questionsPage, searchPage, sitemapXml } from "../services/help-center-pages";

const Status = z.enum(["pending", "published", "hidden"]);
const SettingsPatch = z.object({
  on: z.boolean().optional(), slug: z.string().max(60).optional(), name: z.string().max(200).optional(), intro: z.string().max(600).optional(),
  qaOn: z.boolean().optional(), moderate: z.boolean().optional(), suggestInChat: z.boolean().optional(),
}).strict();
const CategoryIn = z.object({ name: z.string().max(200).optional(), description: z.string().max(400).optional(), position: z.number().finite().optional() }).strict();
const PublishDoc = z.object({ docId: z.string().min(1).max(80), categoryId: z.string().max(80).nullable().optional(), summary: z.string().max(600).optional(), slug: z.string().max(60).optional(), title: z.string().max(300).optional(), status: z.enum(["draft", "published"]).optional() }).strict();
const ArticlePatch = z.object({ title: z.string().max(300).optional(), summary: z.string().max(600).optional(), categoryId: z.string().max(80).nullable().optional(), slug: z.string().max(60).optional(), status: z.enum(["draft", "published"]).optional(), position: z.number().finite().optional() }).strict();
const QuestionPatch = z.object({ status: Status.optional(), categoryId: z.string().max(80).nullable().optional(), title: z.string().max(300).optional(), body: z.string().max(8000).optional() }).strict();
const AnswerIn = z.object({ body: z.string().max(16000) }).strict();
const AnswerPatch = z.object({ status: Status }).strict();
const Accept = z.object({ answerId: z.string().max(80).nullable() }).strict();
const PublishTicket = z.object({ ticketId: z.string().min(1).max(80), title: z.string().max(400), question: z.string().max(8000), answer: z.string().max(16000), categoryId: z.string().max(80).nullable().optional(), keepPrivate: z.boolean().optional() }).strict();

export function helpCenterRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await getCenter(c.var.deps, c.var.auth)))
    .patch("/", async (c) => c.json(await saveCenter(c.var.deps, c.var.auth, await parseBody(c, SettingsPatch))))
    .get("/categories", async (c) => c.json({ categories: await listCategories(c.var.deps, c.var.auth.orgId) }))
    .post("/categories", async (c) => c.json({ category: await saveCategory(c.var.deps, c.var.auth, await parseBody(c, CategoryIn)) }, 201))
    .patch("/categories/:id", async (c) => c.json({ category: await saveCategory(c.var.deps, c.var.auth, await parseBody(c, CategoryIn), c.req.param("id")) }))
    .delete("/categories/:id", async (c) => c.json(await deleteCategory(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/articles", async (c) => c.json({ articles: await listArticles(c.var.deps, c.var.auth) }))
    .post("/articles", async (c) => c.json({ article: await publishDoc(c.var.deps, c.var.auth, await parseBody(c, PublishDoc)) }, 201))
    .get("/articles/:id", async (c) => c.json({ article: await getArticle(c.var.deps, c.var.auth, c.req.param("id")) }))
    .patch("/articles/:id", async (c) => c.json({ article: await updateArticle(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, ArticlePatch)) }))
    .post("/articles/:id/refresh", async (c) => c.json({ article: await refreshArticle(c.var.deps, c.var.auth, c.req.param("id")) }))
    .delete("/articles/:id", async (c) => c.json(await deleteArticle(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/questions", async (c) => { const s = c.req.query("status"); const st = s ? Status.safeParse(s) : null; return c.json({ questions: await listQuestions(c.var.deps, c.var.auth, st?.success ? st.data : undefined) }); })
    .get("/questions/:id", async (c) => c.json({ question: await getQuestion(c.var.deps, c.var.auth, c.req.param("id")) }))
    .patch("/questions/:id", async (c) => c.json({ question: await moderateQuestion(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, QuestionPatch)) }))
    .delete("/questions/:id", async (c) => c.json(await deleteQuestion(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/questions/:id/answers", async (c) => c.json({ question: await teamAnswer(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, AnswerIn)).body) }, 201))
    .post("/questions/:id/accept", async (c) => c.json({ question: await acceptAnswer(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, Accept)).answerId) }))
    .patch("/answers/:id", async (c) => c.json({ question: await moderateAnswer(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, AnswerPatch)).status) }))
    .get("/feedback", async (c) => c.json({ feedback: await listFeedback(c.var.deps, c.var.auth) }))
    .get("/tickets/:id/preview", async (c) => c.json({ preview: await ticketPreview(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/tickets/publish", async (c) => c.json({ question: await publishTicket(c.var.deps, c.var.auth, await parseBody(c, PublishTicket)) }, 201));
}

// ---------------------------------------------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------------------------------------------

const HTML_HEADERS = { "cache-control": "private, max-age=0", "x-robots-tag": "index, follow", "referrer-policy": "strict-origin-when-cross-origin" } as const;
const NOINDEX = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "strict-origin-when-cross-origin" } as const;
/** A form must be at least this old: a bot that posts as soon as it reads the page is turned away. */
export const MIN_FORM_AGE_MS = 2_000;
const MAX_FORM_AGE_MS = 6 * 3_600_000;

function later(c: Context<AppEnv>, p: Promise<unknown>) {
  try { c.executionCtx.waitUntil(p); } catch { void p.catch(() => undefined); }
}
const missing = (c: Context<AppEnv>, status: 404 | 429 = 404, title?: string, text?: string) => c.html(missingPage(title, text), status, NOINDEX);

async function formFor(c: Context<AppEnv>, center: LiveCenter) {
  const t = String(c.var.deps.now().getTime());
  const sig = (await hmacSha256Hex(c.var.deps.config.appSecret, `r122ts:${center.orgId}:${t}`)).slice(0, 32);
  return { ft: await formToken(c, "hc", center.orgId), ts: `${t}.${sig}` };
}

/** Same site, signed form token, honeypot empty, form neither instant nor stale. */
async function postOk(c: Context<AppEnv>, center: LiveCenter, fd: FormData | null): Promise<boolean> {
  if (!fd) return false;
  const hp = fd.get("website");
  if (typeof hp === "string" && hp.trim()) return false;
  const ft = fd.get("ft");
  if (!(await publicPostOk(c, "hc", center.orgId, typeof ft === "string" ? ft : null))) return false;
  const ts = fd.get("ts");
  if (typeof ts !== "string") return false;
  const [t, sig] = ts.split(".");
  const want = (await hmacSha256Hex(c.var.deps.config.appSecret, `r122ts:${center.orgId}:${t}`)).slice(0, 32);
  if (sig !== want) return false;
  const age = c.var.deps.now().getTime() - Number(t);
  return age >= MIN_FORM_AGE_MS && age <= MAX_FORM_AGE_MS;
}

const str = (fd: FormData | null, k: string) => { const v = fd?.get(k); return typeof v === "string" ? v : ""; };
const msgOf = (e: unknown) => (e instanceof HttpError ? e.message : "Something went wrong. Try again.");

export function helpPublicRoutes() {
  const opens = new RateLimiter(240, 60_000);
  const posts = new RateLimiter(10, 60_000);
  const app = new Hono<AppEnv>();
  // Every page: the center must exist and be on (centerBySlug), else the same 404 as an unknown address.
  async function center(c: Context<AppEnv>) {
    if (!opens.take(c.var.ip)) return { err: missing(c, 429, "Too many requests", "Wait a minute, then try again.") };
    const ctr = await centerBySlug(c.var.deps, (c.req.param("slug") ?? "").toLowerCase());
    if (!ctr) return { err: missing(c) };
    return { ctr, base: centerUrl(c.var.deps, ctr.s.slug) };
  }
  const visitor = (c: Context<AppEnv>, ctr: LiveCenter) => visitorOf(c.var.deps, ctr.orgId, c.var.ip, c.req.header("user-agent"));
  const see = (to: string) => new Response(null, { status: 303, headers: { location: to, "cache-control": "private, no-store" } });

  app.get("/:slug", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    return c.html(homePage(r.ctr, r.base, await publicHome(c.var.deps, r.ctr)), 200, HTML_HEADERS);
  });
  app.get("/:slug/sitemap.xml", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    return c.body(sitemapXml(r.base, await sitemap(c.var.deps, r.ctr)), 200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" });
  });
  app.get("/:slug/search", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    const q = (c.req.query("q") ?? "").slice(0, 200);
    const page = pageOf(c.req.query("page"));
    return c.html(searchPage(r.ctr, r.base, q, page, await publicSearch(c.var.deps, r.ctr, q, page)), 200, NOINDEX);
  });
  app.get("/:slug/c/:cat", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    const page = pageOf(c.req.query("page"));
    const d = await publicCategory(c.var.deps, r.ctr, c.req.param("cat").toLowerCase(), page);
    return d ? c.html(categoryPage(r.ctr, r.base, page, d), 200, HTML_HEADERS) : missing(c);
  });
  app.get("/:slug/a/:article", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    const a = await publicArticle(c.var.deps, r.ctr, c.req.param("article").toLowerCase());
    if (!a) return missing(c);
    if (!isBotAgent(c.req.header("user-agent")) && !c.req.query("thanks")) later(c, countView(c.var.deps, r.ctr, a.id));
    return c.html(articlePage(r.ctr, r.base, a, await formFor(c, r.ctr), { thanks: c.req.query("thanks") === "1" }), 200, HTML_HEADERS);
  });
  app.post("/:slug/a/:article/feedback", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    const slug = c.req.param("article").toLowerCase();
    const back = `${r.base}/a/${slug}`;
    if (!posts.take(c.var.ip)) return missing(c, 429, "Too many tries", "Wait a minute, then try again.");
    const fd = await c.req.formData().catch(() => null);
    if (!(await postOk(c, r.ctr, fd))) return see(`${back}#feedback`);
    try { await articleFeedback(c.var.deps, r.ctr, await visitor(c, r.ctr), slug, str(fd, "helpful") === "yes", str(fd, "comment")); }
    catch (e) { if (e instanceof HttpError && e.status === 404) return missing(c); throw e; }
    return see(`${back}?thanks=1#feedback`);
  });
  app.get("/:slug/questions", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    if (!r.ctr.s.qaOn) return missing(c);
    const sort = c.req.query("sort") === "top" ? "top" : "new";
    const page = pageOf(c.req.query("page"));
    return c.html(questionsPage(r.ctr, r.base, sort, page, await publicQuestions(c.var.deps, r.ctr, sort, page)), 200, HTML_HEADERS);
  });
  const NOTICES: Record<string, string> = {
    answered: "Thanks. The team checks answers before they show here.", answered_live: "Thanks, your answer is live.", voted: "Thanks for your vote.",
  };
  app.get("/:slug/q/:id", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    if (!r.ctr.s.qaOn) return missing(c);
    const q = await publicQuestion(c.var.deps, r.ctr, c.req.param("id"));
    if (!q) return missing(c);
    return c.html(questionPage(r.ctr, r.base, q, await formFor(c, r.ctr), { notice: NOTICES[c.req.query("done") ?? ""] }), 200, HTML_HEADERS);
  });
  app.post("/:slug/q/:id/vote", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    const id = c.req.param("id");
    const back = `${r.base}/q/${encodeURIComponent(id)}`;
    if (!posts.take(c.var.ip)) return missing(c, 429, "Too many tries", "Wait a minute, then try again.");
    const fd = await c.req.formData().catch(() => null);
    if (!(await postOk(c, r.ctr, fd))) return see(back);
    const [kind, target] = str(fd, "target").split(":");
    if ((kind !== "q" && kind !== "a") || !target) return see(back);
    try { await vote(c.var.deps, r.ctr, await visitor(c, r.ctr), kind, target); } catch (e) { if (e instanceof HttpError && e.status === 404) return missing(c); throw e; }
    return see(`${back}?done=voted`);
  });
  app.post("/:slug/q/:id/answer", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    const id = c.req.param("id");
    const back = `${r.base}/q/${encodeURIComponent(id)}`;
    if (!posts.take(c.var.ip)) return missing(c, 429, "Too many tries", "Wait a minute, then try again.");
    const fd = await c.req.formData().catch(() => null);
    if (!(await postOk(c, r.ctr, fd))) return see(back);
    try {
      const res = await answerQuestion(c.var.deps, r.ctr, await visitor(c, r.ctr), id, { body: str(fd, "body"), name: str(fd, "name") });
      return see(`${back}?done=${res.live ? "answered_live" : "answered"}`);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return missing(c);
      const q = await publicQuestion(c.var.deps, r.ctr, id);
      if (!q) return missing(c);
      return c.html(questionPage(r.ctr, r.base, q, await formFor(c, r.ctr), { error: msgOf(e) }), e instanceof HttpError && e.status === 429 ? 429 : 400, NOINDEX);
    }
  });
  app.get("/:slug/ask", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    if (!r.ctr.s.qaOn) return missing(c);
    return c.html(askPage(r.ctr, r.base, await formFor(c, r.ctr), { done: c.req.query("done") === "1" ? "pending" : undefined }), 200, NOINDEX);
  });
  app.post("/:slug/ask", async (c) => {
    const r = await center(c); if ("err" in r) return r.err;
    if (!r.ctr.s.qaOn) return missing(c);
    if (!posts.take(c.var.ip)) return missing(c, 429, "Too many tries", "Wait a minute, then try again.");
    const fd = await c.req.formData().catch(() => null);
    const keep = { title: str(fd, "title").slice(0, 160), body: str(fd, "body").slice(0, 4000), name: str(fd, "name").slice(0, 60) };
    if (!(await postOk(c, r.ctr, fd))) return c.html(askPage(r.ctr, r.base, await formFor(c, r.ctr), { ...keep, error: "Please post the form again." }), 400, NOINDEX);
    try {
      const res = await askQuestion(c.var.deps, r.ctr, await visitor(c, r.ctr), keep);
      return see(res.live ? `${r.base}/q/${res.id}` : `${r.base}/ask?done=1`);
    } catch (e) {
      return c.html(askPage(r.ctr, r.base, await formFor(c, r.ctr), { ...keep, error: msgOf(e) }), e instanceof HttpError && e.status === 429 ? 429 : 400, NOINDEX);
    }
  });
  return app;
}
