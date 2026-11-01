/**
 * R93 Forms plus routes (flag FORMS_PLUS_R93; every service checks the flag per workspace, vv8k always off).
 *   Signed in, /api/forms-plus:
 *     GET  /forms/:id/settings, PUT /forms/:id/settings   chat style, hidden fields, bubble, review setup, webhook (admins or the maker)
 *     POST /forms/:id/webhook/secret | /webhook/test, GET /forms/:id/webhook/log
 *     GET  /forms/:id/score                               NPS or CSAT
 *     GET|POST /boards, GET|PATCH /boards/:id, GET /boards/:id/roadmap, POST /boards/:id/posts
 *     PATCH|DELETE /posts/:id, POST /posts/:id/vote { on }, POST /posts/:id/merge { intoId }
 *     GET  /forms/:id/entries[.csv], POST /forms/:id/assign, POST /forms/:id/entries/:sid/state, DELETE /assignments/:id
 *     GET  /reviews, GET|PUT /reviews/:id                 the signed in reviewer's own queue
 *   Public, /api/pub/forms (per IP limits; the spam shield on every write):
 *     GET /shield?form=fplus|vote|idea, GET /boards/:slug, GET /boards/:slug/roadmap, GET /boards/:slug/posts/:id,
 *     POST /boards/:slug/posts, POST /boards/:slug/posts/:id/votes, DELETE /boards/:slug/posts/:id/votes/:voteId
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import type { SuiteActor } from "../services/suite/common";
import { issueChallenge, requireShield } from "../services/spam-shield";
import { formScore, managedForm, plusSettingsOf, rotateWebhookSecret, savePlusSettings, testWebhook, webhookLog } from "../services/forms-plus/plus";
import { boardDetail, boardRoadmap, deletePost, listBoards, memberPost, memberVote, mergePosts, publicBoard, publicIdea, publicPost, publicRoadmap, publicUnvote, publicVote, saveBoard, updatePost } from "../services/forms-plus/boards";
import { assign, entriesCsv, getReview, listEntries, myReviews, setEntryState, submitReview, unassign } from "../services/forms-plus/review";
import { publicLimit, ShieldBody } from "./booking-plus";

const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
const SHIELD_FORMS = new Set(["fplus", "vote", "idea"]);

const Criterion = z.object({ id: z.string().max(40).optional(), label: z.string().max(120), max: z.number().int().min(2).max(10), weight: z.number().int().min(1).max(5) });
const SettingsBody = z.object({
  mode: z.enum(["classic", "chat"]).optional(),
  plus: z.object({
    hiddenFields: z.array(z.string().max(40)).max(10).optional(),
    bubbleLabel: z.string().max(40).optional(),
    template: z.enum(["nps", "csat"]).nullable().optional(),
    review: z.object({ rubric: z.array(Criterion).max(10), perEntry: z.number().int().min(1).max(5), blind: z.boolean(), deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }).nullable().optional(),
  }).optional(),
  webhookUrl: z.string().max(600).nullable().optional(),
  resumeWebhook: z.boolean().optional(),
});
const BoardBody = z.object({ name: z.string().max(120).optional(), description: z.string().max(2000).optional(), isPublic: z.boolean().optional(), allowIdeas: z.boolean().optional(), moderate: z.boolean().optional(), archived: z.boolean().optional() });
const PostBody = z.object({ title: z.string().max(300).optional(), body: z.string().max(5000).optional(), status: z.string().max(20).optional() });
const PostsQuery = (c: Context<AppEnv>) => ({ sort: c.req.query("sort") === "new" ? "new" as const : "top" as const, status: c.req.query("status") ?? undefined, q: (c.req.query("q") ?? "").slice(0, 100), offset: Number(c.req.query("offset") ?? 0) || 0 });
const IdeaBody = z.object({ title: z.string().max(300), body: z.string().max(5000).optional(), name: z.string().max(200).optional(), email: z.string().max(300), shield: ShieldBody.optional() });
const VoteBody = z.object({ name: z.string().max(200).optional(), email: z.string().max(300), shield: ShieldBody.optional() });
const csv = (r: { filename: string; csv: string }) => new Response(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${r.filename.replace(/[^A-Za-z0-9._-]/g, "")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });

export function formsPlusRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/forms/:id/settings", async (c) => c.json(plusSettingsOf(await managedForm(c.var.deps, actor(c), c.req.param("id")))))
    .put("/forms/:id/settings", async (c) => c.json(await savePlusSettings(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, SettingsBody))))
    .post("/forms/:id/webhook/secret", async (c) => c.json(await rotateWebhookSecret(c.var.deps, actor(c), c.req.param("id"))))
    .post("/forms/:id/webhook/test", async (c) => c.json(await testWebhook(c.var.deps, actor(c), c.req.param("id"))))
    .get("/forms/:id/webhook/log", async (c) => c.json(await webhookLog(c.var.deps, actor(c), c.req.param("id"))))
    .get("/forms/:id/score", async (c) => c.json(await formScore(c.var.deps, actor(c).orgId, c.req.param("id"))))
    .get("/boards", async (c) => c.json(await listBoards(c.var.deps, actor(c))))
    .post("/boards", async (c) => c.json(await saveBoard(c.var.deps, actor(c), await parseBody(c, BoardBody)), 201))
    .get("/boards/:id", async (c) => c.json(await boardDetail(c.var.deps, actor(c), c.req.param("id"), PostsQuery(c))))
    .patch("/boards/:id", async (c) => c.json(await saveBoard(c.var.deps, actor(c), await parseBody(c, BoardBody), c.req.param("id"))))
    .get("/boards/:id/roadmap", async (c) => c.json(await boardRoadmap(c.var.deps, actor(c), c.req.param("id"))))
    .post("/boards/:id/posts", async (c) => c.json(await memberPost(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, PostBody)), 201))
    .patch("/posts/:id", async (c) => c.json(await updatePost(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, PostBody))))
    .delete("/posts/:id", async (c) => c.json(await deletePost(c.var.deps, actor(c), c.req.param("id"))))
    .post("/posts/:id/vote", async (c) => c.json(await memberVote(c.var.deps, actor(c), c.req.param("id"), (await parseBody(c, z.object({ on: z.boolean() }))).on)))
    .post("/posts/:id/merge", async (c) => c.json(await mergePosts(c.var.deps, actor(c), c.req.param("id"), (await parseBody(c, z.object({ intoId: z.string().max(60) }))).intoId)))
    .get("/forms/:id/entries", async (c) => c.json(await listEntries(c.var.deps, actor(c), c.req.param("id"), { state: c.req.query("state"), offset: Number(c.req.query("offset") ?? 0) || 0 })))
    .get("/forms/:id/entries.csv", async (c) => csv(await entriesCsv(c.var.deps, actor(c), c.req.param("id"))))
    .post("/forms/:id/assign", async (c) => c.json(await assign(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, z.object({ reviewerIds: z.array(z.string().max(80)).max(50), submissionIds: z.array(z.string().max(60)).max(500).optional() })))))
    .post("/forms/:id/entries/:sid/state", async (c) => c.json(await setEntryState(c.var.deps, actor(c), c.req.param("id"), c.req.param("sid"), (await parseBody(c, z.object({ state: z.enum(["new", "shortlisted", "declined"]) }))).state)))
    .delete("/assignments/:id", async (c) => c.json(await unassign(c.var.deps, actor(c), c.req.param("id"))))
    .get("/reviews", async (c) => c.json(await myReviews(c.var.deps, actor(c))))
    .get("/reviews/:id", async (c) => c.json(await getReview(c.var.deps, actor(c), c.req.param("id"))))
    .put("/reviews/:id", async (c) => c.json(await submitReview(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, z.object({ scores: z.record(z.string().max(40), z.number()), comment: z.string().max(4000).optional() })))));
}

export function formsPublicRoutes() {
  const reads = publicLimit(120, (c) => `fpr:${c.var.ip}`);
  const writes = publicLimit(15, (c) => `fpw:${c.var.ip}`);
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { await next(); c.header("cache-control", "private, no-store"); c.header("x-robots-tag", "noindex"); })
    .get("/shield", reads, async (c) => {
      const form = c.req.query("form") ?? "";
      if (!SHIELD_FORMS.has(form)) throw new HttpError(422, "validation_failed", "Unknown form.");
      return c.json({ challenge: await issueChallenge(c.var.deps, form) });
    })
    .get("/boards/:slug", reads, async (c) => c.json(await publicBoard(c.var.deps, c.req.param("slug"), PostsQuery(c))))
    .get("/boards/:slug/roadmap", reads, async (c) => c.json(await publicRoadmap(c.var.deps, c.req.param("slug"))))
    .get("/boards/:slug/posts/:id", reads, async (c) => c.json(await publicPost(c.var.deps, c.req.param("slug"), c.req.param("id"))))
    .post("/boards/:slug/posts", writes, async (c) => {
      const b = await parseBody(c, IdeaBody);
      await requireShield(c.var.deps, "idea", b.shield);
      return c.json(await publicIdea(c.var.deps, c.req.param("slug"), b, c.var.ip), 201);
    })
    .post("/boards/:slug/posts/:id/votes", writes, async (c) => {
      const b = await parseBody(c, VoteBody);
      await requireShield(c.var.deps, "vote", b.shield);
      return c.json(await publicVote(c.var.deps, c.req.param("slug"), c.req.param("id"), b), 201);
    })
    .delete("/boards/:slug/posts/:id/votes/:voteId", writes, async (c) => c.json(await publicUnvote(c.var.deps, c.req.param("slug"), c.req.param("id"), c.req.param("voteId"), c.req.header("x-vote-token") ?? "")));
}
