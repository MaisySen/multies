/**
 * R93 Forms plus: hidden fields and variables, rating (NPS and CSAT), the signed webhook (signature, timeout, one
 * attempt, pause), feedback boards (one vote per person, merge moves votes, statuses, roadmap, approval), calls for
 * submissions (assignment, rubric, blind review, shortlist), roles (admin, maker, reviewer, member, public), flag off.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { solveWork } from "@/shared/spam-shield";
import { checkAnswers, ratingRange } from "@/shared/form-logic";
import { assignReviewers, blindAnswers, csatOf, fillVariables, identityFieldIds, normalisePlus, npsOf, pickHidden, rubricTotal, variablesIn } from "@/shared/forms-plus";
import { signFormWebhook } from "@/server/services/forms-plus/plus";
import { isFormsPlusExcluded } from "@/server/services/forms-plus/plus";
import { hmacSha256Hex } from "@/server/lib/crypto";
import { metaFor } from "@/web/components/seo-meta";
import { users } from "@/server/db/schema";
import { eq } from "drizzle-orm";

const ON = { FORMS_PLUS_R93: "true", SHIELD_DIFFICULTY: "4", APP_URL: "http://localhost" };
let ipN = 1;
type Hit = { url: string; init: RequestInit };

async function setup(env: Record<string, string> = ON, target?: (url: string, init: RequestInit) => Promise<Response>) {
  const hits: Hit[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://cloudflare-dns.com/")) return new Response(JSON.stringify({ Answer: url.includes("type=A&") || url.endsWith("type=A") ? [{ type: 1, data: url.includes("privnet") ? "10.0.0.5" : "93.184.216.34" }] : [] }), { headers: { "content-type": "application/json" } });
    hits.push({ url, init });
    return target ? target(url, init) : new Response("ok", { status: 200 });
  }) as typeof fetch;
  const ctx = await makeTestApp(env, { fetch: fetchImpl });
  let clock = Date.parse("2026-11-02T00:00:00Z");
  ctx.deps.now = () => new Date(clock);
  const owner = new Client(ctx.app);
  await owner.signup("ada@acme.io", "Ada Lovelace", "Acme");
  return { ...ctx, owner, hits, advance: (ms: number) => { clock += ms; } };
}
type T = Awaited<ReturnType<typeof setup>>;

async function member(t: T, email = "mate@acme.io", role = "member") {
  const invite = await t.owner.post("/api/team/invites", { email, role });
  const mate = new Client(t.app);
  await mate.signup(email, `${email.split("@")[0]} Person`, "");
  expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const u = await t.deps.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  return Object.assign(mate, { userId: u!.id });
}

async function pub(t: T, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await t.app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { host: "localhost", "content-type": "application/json", "cf-connecting-ip": `10.9.${Math.floor(ipN / 200)}.${ipN++ % 200}`, ...headers } });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

async function shield(t: T, form: string) {
  const c = (await pub(t, "GET", `/api/pub/forms/shield?form=${form}`)).body.challenge;
  const nonce = await solveWork(c.salt, c.difficulty);
  t.advance(2000);
  return { challenge: c, nonce, hp: "" };
}

const NPS_FIELDS = [
  { id: "name", label: "Your name", type: "text", required: false },
  { id: "score", label: "How likely are you to recommend us?", type: "rating", required: true, rules: { min: 0, max: 10 } },
  { id: "improve", label: "What would make it a 10, {{name}}?", type: "textarea", required: false, logic: { join: "all", conditions: [{ field: "score", op: "lt", value: "9" }] } },
];

async function makeForm(t: T, body: Record<string, unknown> = {}) {
  const r = await t.owner.post("/api/forms", { name: "Survey", fields: NPS_FIELDS, successMessage: "Thanks {{name}}, see you at {{ref}}.", ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.form as { id: string; slug: string };
}

async function answer(t: T, slug: string, answers: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return pub(t, "POST", `/api/public/forms/${slug}`, { answers, elapsedMs: 5000, shield: await shield(t, "fplus"), ...extra });
}

describe("R93 shared rules", () => {
  it("normalises settings, hidden fields and variables", () => {
    const p = normalisePlus({ hiddenFields: ["Ref", "ref", "utm source", "1bad", "x".repeat(60)], bubbleLabel: "  Talk   to us ", template: "nps", review: { rubric: [{ label: "Impact", max: 99, weight: 0 }, { label: "" }], perEntry: 9 } });
    expect(p.hiddenFields).toEqual(["ref", "utm_source", "x".repeat(40)]);
    expect(p.bubbleLabel).toBe("Talk to us");
    expect(p.review).toEqual({ rubric: [{ id: "impact", label: "Impact", max: 10, weight: 1 }], perEntry: 5, blind: true, deadline: null });
    expect(normalisePlus(null).bubbleLabel).toBe("Chat with us");
    expect(pickHidden(["ref", "plan"], new URLSearchParams("ref=ads&evil=1&plan=%0Apro"))).toEqual({ ref: "ads", plan: "pro" });
    expect(pickHidden(["ref"], { ref: "a".repeat(300) }).ref).toHaveLength(200);
    expect(fillVariables("Hi {{ Name }}, from {{ref}}{{missing}}!", { name: "Ann" }, { ref: "ads" })).toBe("Hi Ann, from ads!");
    expect(fillVariables("{{name}}", { name: "<b>x</b>" })).toBe("<b>x</b>");
    expect(variablesIn("{{a}} and {{b}} {{a}}")).toEqual(["a", "b"]);
  });

  it("branches skip questions and rating answers are checked", () => {
    const f = NPS_FIELDS.map((x) => ({ ...x })) as Parameters<typeof checkAnswers>[0];
    expect(checkAnswers(f, { score: "10" }).shown.has("improve")).toBe(false);
    expect(checkAnswers(f, { score: "3", improve: "faster" }).answers).toEqual({ score: "3", improve: "faster" });
    expect(checkAnswers(f, { score: "11" }).errors.score).toMatch(/from 0 to 10/);
    expect(checkAnswers(f, { score: "4.5" }).errors.score).toBeTruthy();
    expect(ratingRange({ rules: { min: 1, max: 5 } })).toEqual({ min: 1, max: 5 });
    expect(ratingRange({ rules: null })).toEqual({ min: 0, max: 10 });
  });

  it("scores NPS and CSAT", () => {
    expect(npsOf([10, 9, 8, 7, 6, 0])).toMatchObject({ n: 6, promoters: 2, passives: 2, detractors: 2, score: 0 });
    expect(npsOf([10, 10, 9]).score).toBe(100);
    expect(npsOf([]).score).toBeNull();
    expect(csatOf([5, 4, 3, 1, 9])).toMatchObject({ n: 4, satisfied: 2, score: 50, average: 3.3 });
  });

  it("totals a weighted rubric and refuses missing or out of range scores", () => {
    const rubric = [{ id: "impact", label: "Impact", max: 5, weight: 2 }, { id: "fit", label: "Fit", max: 10, weight: 1 }];
    expect(rubricTotal(rubric, { impact: 5, fit: 10 })).toEqual({ total: 100, scores: { impact: 5, fit: 10 } });
    expect(rubricTotal(rubric, { impact: 1, fit: 5 })).toMatchObject({ total: 35 });
    expect(rubricTotal(rubric, { impact: 6, fit: 5 })).toEqual({ error: 'Give "Impact" a score from 1 to 5.' });
    expect(rubricTotal(rubric, { impact: 2 })).toHaveProperty("error");
    expect(rubricTotal([], {})).toHaveProperty("error");
  });

  it("blind review hides names, emails, phones and marked questions", () => {
    const fields = [{ id: "full_name", label: "Full name", type: "text" as const }, { id: "mail", label: "Contact", type: "email" as const }, { id: "tel", label: "Mobile", type: "phone" as const },
      { id: "org", label: "Company", type: "text" as const, identity: true }, { id: "pitch", label: "Your pitch", type: "textarea" as const }];
    expect([...identityFieldIds(fields)].sort()).toEqual(["full_name", "mail", "org", "tel"]);
    expect(blindAnswers(fields, { full_name: "Ann", mail: "a@b.co", tel: "1", org: "X", pitch: "Great" })).toEqual({ pitch: "Great" });
  });

  it("assigns reviewers evenly, never the same pair twice", () => {
    const pairs = assignReviewers(["e1", "e2", "e3"], ["r1", "r2"], 2, [{ entryId: "e1", reviewerId: "r1" }]);
    expect(pairs).toEqual([{ entryId: "e1", reviewerId: "r2" }, { entryId: "e2", reviewerId: "r1" }, { entryId: "e2", reviewerId: "r2" }, { entryId: "e3", reviewerId: "r1" }, { entryId: "e3", reviewerId: "r2" }]);
    expect(assignReviewers(["e1"], ["r1"], 3)).toHaveLength(1);
    expect(assignReviewers(["e1"], [], 2)).toEqual([]);
    const spread = assignReviewers(["a", "b", "c", "d"], ["r1", "r2", "r3"], 1);
    expect(new Set(spread.slice(0, 3).map((p) => p.reviewerId)).size).toBe(3);
  });

  it("keeps vv8k out and gives public pages real titles", () => {
    expect(isFormsPlusExcluded({ id: "org_1", slug: "vv8k-team", name: "Client" })).toBe(true);
    expect(isFormsPlusExcluded({ id: "org_2", slug: "acme", name: "Acme" }, "beta")).toBe(false);
    expect(isFormsPlusExcluded({ id: "org_2", slug: "beta", name: "Beta" }, "beta")).toBe(true);
    expect(metaFor("/f/abc").title).toBe("Form | Multies");
    expect(metaFor("/f/abc/embed").title).toBe("Form | Multies");
    expect(metaFor("/fb/ideas-1").title).toBe("Feedback board | Multies");
    expect(metaFor("/fb/ideas-1").description.length).toBeGreaterThan(30);
  });
});

describe("R93 forms: chat style, hidden fields, score, webhook", () => {
  it("stores hidden values and the score, fills variables in the thank you, and needs the shield", async () => {
    const t = await setup();
    const f = await makeForm(t);
    expect((await t.owner.put(`/api/forms-plus/forms/${f.id}/settings`, { mode: "chat", plus: { hiddenFields: ["ref"] } })).status).toBe(200);
    const page = await pub(t, "GET", `/api/public/forms/${f.slug}`);
    expect(page.body.form.plus).toMatchObject({ mode: "chat", hiddenFields: ["ref"] });
    const noShield = await pub(t, "POST", `/api/public/forms/${f.slug}`, { answers: { score: "9" }, elapsedMs: 5000 });
    expect(noShield.status).toBe(422);
    expect(noShield.body.error.code).toBe("spam_check_failed");
    const ok = await answer(t, f.slug, { name: "Ann", score: "6", improve: "Speed" }, { hidden: { ref: "newsletter", other: "x" } });
    expect(ok.status).toBe(200);
    expect(ok.body.message).toBe("Thanks Ann, see you at newsletter.");
    await answer(t, f.slug, { score: "10" });
    await answer(t, f.slug, { score: "9" });
    const score = await t.owner.get(`/api/forms-plus/forms/${f.id}/score`);
    expect(score.body.score).toMatchObject({ kind: "nps", n: 3, promoters: 2, detractors: 1, score: 33 });
    const rows = await t.deps.db.all<{ meta: string | null; score: number }>(`select meta, score from form_submissions order by created_at` as never);
    expect(rows.some((r) => r.meta === JSON.stringify({ hidden: { ref: "newsletter" } }))).toBe(true);
  });

  it("signs the webhook, sends once, logs failures and pauses after ten in a row", async () => {
    let status = 200;
    const t = await setup(ON, async () => new Response("x", { status }));
    const f = await makeForm(t);
    const bad = await t.owner.put(`/api/forms-plus/forms/${f.id}/settings`, { webhookUrl: "http://example.com/hook" });
    expect(bad.status).toBe(422);
    expect((await t.owner.put(`/api/forms-plus/forms/${f.id}/settings`, { webhookUrl: "https://hooks.privnet.net/x" })).status).toBe(200);
    const priv = await t.owner.post(`/api/forms-plus/forms/${f.id}/webhook/test`);
    expect(priv.body).toMatchObject({ ok: false, error: "Use a public https address for the webhook." });
    const saved = await t.owner.put(`/api/forms-plus/forms/${f.id}/settings`, { webhookUrl: "https://hooks.example.com/in" });
    expect(saved.body.secret).toBeUndefined(); // the secret was minted with the first address and is kept
    const rotated = await t.owner.post(`/api/forms-plus/forms/${f.id}/webhook/secret`);
    const secret = rotated.body.secret as string;
    expect(secret).toMatch(/^whsec_/);
    t.hits.length = 0;
    await answer(t, f.slug, { name: "Ann", score: "10" });
    expect(t.hits).toHaveLength(1);
    const h = t.hits[0].init.headers as Record<string, string>;
    const body = String(t.hits[0].init.body);
    expect(t.hits[0].init.redirect).toBe("manual");
    expect(h["x-multies-signature"]).toBe(await signFormWebhook(secret, Number(h["x-multies-timestamp"]), body));
    expect(h["x-multies-signature"]).toBe(`sha256=${await hmacSha256Hex(secret, `${h["x-multies-timestamp"]}.${body}`)}`);
    expect(JSON.parse(body)).toMatchObject({ event: "form.submitted", form: { id: f.id }, submission: { answers: { name: "Ann", score: "10" }, score: 10 } });
    status = 500;
    for (let i = 0; i < 10; i++) await answer(t, f.slug, { score: "5" });
    expect(t.hits).toHaveLength(11); // one attempt each, no retries
    const log = await t.owner.get(`/api/forms-plus/forms/${f.id}/webhook/log`);
    expect(log.body.deliveries.length).toBeLessThanOrEqual(20);
    expect(log.body.deliveries[0]).toMatchObject({ ok: false, status: 500, error: "The address answered 500." });
    const st = await t.owner.get(`/api/forms-plus/forms/${f.id}/settings`);
    expect(st.body.webhook).toMatchObject({ paused: true, failures: 10, hasSecret: true });
    expect(JSON.stringify(st.body)).not.toContain("whsec_");
    await answer(t, f.slug, { score: "5" });
    expect(t.hits).toHaveLength(11); // paused
    await t.owner.put(`/api/forms-plus/forms/${f.id}/settings`, { resumeWebhook: true });
    status = 200;
    await answer(t, f.slug, { score: "5" });
    expect(t.hits).toHaveLength(12);
  });

  it("times out a slow webhook after 5 seconds", async () => {
    const t = await setup(ON, (_u, init) => new Promise((_r, reject) => { init.signal?.addEventListener("abort", () => reject(new Error("aborted"))); }));
    const f = await makeForm(t);
    await t.owner.put(`/api/forms-plus/forms/${f.id}/settings`, { webhookUrl: "https://slow.example.com/x" });
    const started = Date.now();
    const r = await t.owner.post(`/api/forms-plus/forms/${f.id}/webhook/test`);
    expect(r.body.ok).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
  }, 30_000);

  it("only admins and the maker change settings; members cannot", async () => {
    const t = await setup();
    const f = await makeForm(t);
    const mate = await member(t);
    expect((await mate.put(`/api/forms-plus/forms/${f.id}/settings`, { mode: "chat" })).status).toBe(403);
    expect((await mate.get(`/api/forms-plus/forms/${f.id}/settings`)).status).toBe(403);
  });

  it("is off with the flag off: no settings, no shield needed, no review forms", async () => {
    const t = await setup({ APP_URL: "http://localhost" });
    const f = await makeForm(t);
    expect((await t.owner.get(`/api/forms-plus/forms/${f.id}/settings`)).status).toBe(404);
    expect((await t.owner.get("/api/forms-plus/boards")).status).toBe(404);
    const ok = await pub(t, "POST", `/api/public/forms/${f.slug}`, { answers: { score: "9" }, elapsedMs: 5000 });
    expect(ok.status).toBe(200);
    expect((await t.owner.post("/api/forms", { name: "Call", target: "review", fields: NPS_FIELDS })).status).toBe(422);
    expect((await pub(t, "GET", "/forms-embed.js")).status).toBe(404);
  });

  it("serves the bubble script for other sites and lets only the embed page be framed", async () => {
    const t = await setup();
    const js = await pub(t, "GET", "/forms-embed.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(String(js.body)).toContain("/embed");
  });
});

describe("R93 feedback boards", () => {
  it("one vote per person, take back with the token, members by account", async () => {
    const t = await setup();
    const b = (await t.owner.post("/api/forms-plus/boards", { name: "Product ideas", moderate: false })).body.board;
    const post = (await t.owner.post(`/api/forms-plus/boards/${b.id}/posts`, { title: "Dark mode for invoices" })).body.post;
    expect(post.votes).toBe(1);
    const v1 = await pub(t, "POST", `/api/pub/forms/boards/${b.slug}/posts/${post.id}/votes`, { email: "Fan@Example.com", shield: await shield(t, "vote") });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ votes: 2, already: false });
    const v2 = await pub(t, "POST", `/api/pub/forms/boards/${b.slug}/posts/${post.id}/votes`, { email: "fan@example.com ", shield: await shield(t, "vote") });
    expect(v2.body).toMatchObject({ votes: 2, already: true });
    const noShield = await pub(t, "POST", `/api/pub/forms/boards/${b.slug}/posts/${post.id}/votes`, { email: "x@example.com" });
    expect(noShield.status).toBe(422);
    const badEmail = await pub(t, "POST", `/api/pub/forms/boards/${b.slug}/posts/${post.id}/votes`, { email: "nope", shield: await shield(t, "vote") });
    expect(badEmail.status).toBe(422);
    expect((await pub(t, "DELETE", `/api/pub/forms/boards/${b.slug}/posts/${post.id}/votes/${v1.body.voteId}`, undefined, { "x-vote-token": "wrong" })).status).toBe(404);
    const un = await pub(t, "DELETE", `/api/pub/forms/boards/${b.slug}/posts/${post.id}/votes/${v1.body.voteId}`, undefined, { "x-vote-token": v1.body.token });
    expect(un.body).toMatchObject({ voted: false, votes: 1 });
    const mate = await member(t);
    expect((await mate.post(`/api/forms-plus/posts/${post.id}/vote`, { on: true })).body.votes).toBe(2);
    expect((await mate.post(`/api/forms-plus/posts/${post.id}/vote`, { on: true })).body).toMatchObject({ votes: 2, already: true });
    expect((await mate.post(`/api/forms-plus/posts/${post.id}/vote`, { on: false })).body.votes).toBe(1);
    const pubList = await pub(t, "GET", `/api/pub/forms/boards/${b.slug}`);
    expect(JSON.stringify(pubList.body)).not.toMatch(/@|authorEmail/);
  });

  it("statuses, roadmap, approval and member limits", async () => {
    const t = await setup();
    const b = (await t.owner.post("/api/forms-plus/boards", { name: "Roadmap" })).body.board;
    const idea = await pub(t, "POST", `/api/pub/forms/boards/${b.slug}/posts`, { title: "Calendar sync", email: "v@example.com", name: "Vera Visitor", shield: await shield(t, "idea") });
    expect(idea.body).toMatchObject({ pending: true, post: null });
    expect((await pub(t, "GET", `/api/pub/forms/boards/${b.slug}`)).body.posts).toHaveLength(0);
    const admin = await t.owner.get(`/api/forms-plus/boards/${b.id}`);
    const pending = admin.body.posts[0];
    expect(pending).toMatchObject({ status: "pending", authorEmail: "v@example.com" });
    const mate = await member(t);
    const mateView = await mate.get(`/api/forms-plus/boards/${b.id}`);
    expect(mateView.body.posts).toHaveLength(0);
    expect(mateView.body.canManage).toBe(false);
    expect((await mate.patch(`/api/forms-plus/posts/${pending.id}`, { status: "planned" })).status).toBe(403);
    expect((await mate.post("/api/forms-plus/boards", { name: "Mine" })).status).toBe(403);
    expect((await t.owner.patch(`/api/forms-plus/posts/${pending.id}`, { status: "planned" })).body.post.status).toBe("planned");
    expect((await t.owner.patch(`/api/forms-plus/posts/${pending.id}`, { status: "merged" })).status).toBe(422);
    const road = await pub(t, "GET", `/api/pub/forms/boards/${b.slug}/roadmap`);
    expect(road.body.roadmap.planned[0]).toMatchObject({ title: "Calendar sync", author: "Vera", votes: 1 });
    expect(road.body.roadmap.progress).toEqual([]);
    await t.owner.patch(`/api/forms-plus/boards/${b.id}`, { isPublic: false });
    expect((await pub(t, "GET", `/api/pub/forms/boards/${b.slug}`)).status).toBe(404);
  });

  it("merging a duplicate moves votes without double counting", async () => {
    const t = await setup();
    const b = (await t.owner.post("/api/forms-plus/boards", { name: "Ideas", moderate: false })).body.board;
    const a = (await t.owner.post(`/api/forms-plus/boards/${b.id}/posts`, { title: "Export to CSV" })).body.post;
    const dup = (await t.owner.post(`/api/forms-plus/boards/${b.id}/posts`, { title: "CSV export please" })).body.post;
    for (const e of ["one@x.co", "two@x.co"]) await pub(t, "POST", `/api/pub/forms/boards/${b.slug}/posts/${dup.id}/votes`, { email: e, shield: await shield(t, "vote") });
    await pub(t, "POST", `/api/pub/forms/boards/${b.slug}/posts/${a.id}/votes`, { email: "one@x.co", shield: await shield(t, "vote") });
    const m = await t.owner.post(`/api/forms-plus/posts/${dup.id}/merge`, { intoId: a.id });
    expect(m.status).toBe(200);
    expect(m.body.into.votes).toBe(3); // owner, one, two (owner and one voted on both)
    const gone = await pub(t, "GET", `/api/pub/forms/boards/${b.slug}/posts/${dup.id}`);
    expect(gone.body.post.status).toBe("merged");
    expect(gone.body.mergedInto.id).toBe(a.id);
    expect((await t.owner.post(`/api/forms-plus/posts/${dup.id}/merge`, { intoId: a.id })).status).toBe(422);
    expect((await t.owner.post(`/api/forms-plus/posts/${a.id}/merge`, { intoId: a.id })).status).toBe(422);
    const other = (await t.owner.post("/api/forms-plus/boards", { name: "Other" })).body.board;
    const p2 = (await t.owner.post(`/api/forms-plus/boards/${other.id}/posts`, { title: "Different board" })).body.post;
    expect((await t.owner.post(`/api/forms-plus/posts/${p2.id}/merge`, { intoId: a.id })).status).toBe(422);
  });

  it("boards never cross workspaces", async () => {
    const t = await setup();
    const b = (await t.owner.post("/api/forms-plus/boards", { name: "Private" })).body.board;
    const stranger = new Client(t.app);
    await stranger.signup("eve@other.io", "Eve", "Other");
    expect((await stranger.get(`/api/forms-plus/boards/${b.id}`)).status).toBe(404);
    expect((await stranger.get("/api/forms-plus/boards")).body.boards).toEqual([]);
  });
});

describe("R93 calls for submissions", () => {
  async function call(t: T, blind = true) {
    const f = (await t.owner.post("/api/forms", { name: "Speaker call", target: "review", fields: [
      { id: "full_name", label: "Full name", type: "text", required: true }, { id: "email", label: "Email", type: "email", required: true },
      { id: "talk", label: "Talk title", type: "text", required: true }, { id: "abstract", label: "Abstract", type: "textarea", required: false },
    ] })).body.form;
    await t.owner.put(`/api/forms-plus/forms/${f.id}/settings`, { plus: { review: { rubric: [{ label: "Relevance", max: 5, weight: 2 }, { label: "Clarity", max: 5, weight: 1 }], perEntry: 1, blind, deadline: null } } });
    return f as { id: string; slug: string };
  }

  it("makes no task, assigns reviewers, hides identity in blind review, scores and shortlists", async () => {
    const t = await setup();
    const f = await call(t);
    const sent = await answer(t, f.slug, { full_name: "Ann Speaker", email: "ann@talks.io", talk: "Edge caching", abstract: "Why it matters" });
    expect(sent.body.created).toBeNull();
    await answer(t, f.slug, { full_name: "Bob Speaker", email: "bob@talks.io", talk: "Queues" });
    const r1 = await member(t, "rev1@acme.io");
    const r2 = await member(t, "rev2@acme.io");
    expect((await r1.post(`/api/forms-plus/forms/${f.id}/assign`, { reviewerIds: [r1.userId] })).status).toBe(403);
    const a = await t.owner.post(`/api/forms-plus/forms/${f.id}/assign`, { reviewerIds: [r1.userId, r2.userId] });
    expect(a.body.assigned).toBe(2);
    expect((await t.owner.post(`/api/forms-plus/forms/${f.id}/assign`, { reviewerIds: [r1.userId, r2.userId] })).body.assigned).toBe(0);
    const q1 = (await r1.get("/api/forms-plus/reviews")).body.reviews;
    expect(q1).toHaveLength(1);
    const view = JSON.stringify(q1[0]);
    expect(view).not.toMatch(/Ann Speaker|Bob Speaker|talks\.io|createdAt/);
    expect(q1[0].entry.answers.talk).toBeTruthy();
    const q2 = (await r2.get("/api/forms-plus/reviews")).body.reviews;
    expect(q2).toHaveLength(1);
    expect(q2[0].id).not.toBe(q1[0].id);
    expect((await r2.get(`/api/forms-plus/reviews/${q1[0].id}`)).status).toBe(404);
    expect((await r2.put(`/api/forms-plus/reviews/${q1[0].id}`, { scores: { relevance: 5, clarity: 5 } })).status).toBe(404);
    expect((await r1.get(`/api/forms-plus/forms/${f.id}/entries`)).status).toBe(403);
    expect((await r1.put(`/api/forms-plus/reviews/${q1[0].id}`, { scores: { relevance: 9, clarity: 5 } })).status).toBe(422);
    const done = await r1.put(`/api/forms-plus/reviews/${q1[0].id}`, { scores: { relevance: 4, clarity: 3 }, comment: "Solid" });
    expect(done.body.review).toMatchObject({ status: "done", total: 73.3 });
    const list = await t.owner.get(`/api/forms-plus/forms/${f.id}/entries`);
    const scored = list.body.entries.find((e: { average: number | null }) => e.average !== null);
    expect(scored.average).toBe(73.3);
    expect(scored.answers.email).toMatch(/talks\.io/); // admins see everything
    const st = await t.owner.post(`/api/forms-plus/forms/${f.id}/entries/${scored.id}/state`, { state: "shortlisted" });
    expect(st.body.state).toBe("shortlisted");
    expect((await t.owner.get(`/api/forms-plus/forms/${f.id}/entries?state=shortlisted`)).body.entries).toHaveLength(1);
    const csv = await t.app.request(`/api/forms-plus/forms/${f.id}/entries.csv`, { headers: { host: "localhost", cookie: t.owner.cookie } });
    expect(await csv.text()).toContain("shortlisted");
    const tasks = await t.owner.get("/api/tasks");
    expect(JSON.stringify(tasks.body)).not.toContain("Edge caching");
  });

  it("without blind review the reviewer sees names; reviewers must be workspace people", async () => {
    const t = await setup();
    const f = await call(t, false);
    await answer(t, f.slug, { full_name: "Ann Speaker", email: "ann@talks.io", talk: "Edge caching" });
    const r1 = await member(t, "rev1@acme.io");
    expect((await t.owner.post(`/api/forms-plus/forms/${f.id}/assign`, { reviewerIds: ["usr_nobody"] })).status).toBe(422);
    await t.owner.post(`/api/forms-plus/forms/${f.id}/assign`, { reviewerIds: [r1.userId] });
    const q = (await r1.get("/api/forms-plus/reviews")).body.reviews;
    expect(q[0].entry.answers.full_name).toBe("Ann Speaker");
    expect(q[0].blind).toBe(false);
  });
});
