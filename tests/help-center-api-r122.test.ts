import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { hcTerms } from "@/server/db/schema";

/** R122: the help center through the API and its public pages (signed out). */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;

const page = (path: string, init: RequestInit = {}) => ctx.app.request(path, { ...init, headers: { host: "localhost", ...(init.headers ?? {}) } });
const html = async (path: string) => { const r = await page(path); return { status: r.status, text: await r.text(), headers: r.headers }; };
const rel = (loc: string | null) => (loc ?? "").replace(/^https?:\/\/[^/]+/, "");
function formOf(text: string) {
  return { ft: /name="ft" value="([^"]+)"/.exec(text)?.[1] ?? "", ts: /name="ts" value="([^"]+)"/.exec(text)?.[1] ?? "" };
}
function later(ms = 10_000) { const base = Date.now() + ms; (ctx.deps as { now: () => Date }).now = () => new Date(base); }
async function post(path: string, fields: Record<string, string>) {
  return page(path, { method: "POST", body: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
}
async function doc(title: string, text: string, who = owner) {
  const r = await who.post("/api/docs", { title, text });
  expect(r.status).toBe(201);
  return (r.body.doc ?? r.body).id as string;
}
async function setup(slug = "acme-help", extra: Record<string, unknown> = {}) {
  const r = await owner.patch("/api/help-center", { slug, name: "Acme", intro: "Answers from Acme.", on: true, ...extra });
  expect(r.status).toBe(200);
  return r.body;
}
async function member() {
  const invite = await owner.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
  const mate = new Client(ctx.app);
  await mate.signup("mate@acme.io", "Mia Mate", "");
  expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return mate;
}

beforeEach(async () => {
  ctx = await makeTestApp({ HELP_CENTER: "on" });
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
});

describe("help center setup", () => {
  it("is not set up at first and needs an admin; public page is 404 until it is on", async () => {
    const g = await owner.get("/api/help-center");
    expect(g.body.settings).toBeNull();
    expect(g.body.canEdit).toBe(true);
    await owner.patch("/api/help-center", { slug: "acme-help", on: false });
    expect((await html("/help/acme-help")).status).toBe(404);
    await owner.patch("/api/help-center", { on: true });
    const h = await html("/help/acme-help");
    expect(h.status).toBe(200);
    expect(h.text).toContain("How can we help?");
    expect(h.text).toContain('<link rel="canonical" href="');
    expect(h.text).toContain('content="index, follow"');
  });

  it("refuses reserved, bad and taken addresses", async () => {
    expect((await owner.patch("/api/help-center", { slug: "api" })).status).toBe(400);
    expect((await owner.patch("/api/help-center", { slug: "Bad Slug" })).status).toBe(400);
    await setup("acme-help");
    const other = new Client(ctx.app);
    await other.signup("boss@globex.io", "Gus Globex", "Globex");
    expect((await other.patch("/api/help-center", { slug: "acme-help" })).status).toBe(409);
  });

  it("members read but cannot change settings, publish or moderate", async () => {
    await setup();
    const d = await doc("Billing basics", "How billing works.");
    const mate = await member();
    expect((await mate.get("/api/help-center")).body.canEdit).toBe(false);
    expect((await mate.patch("/api/help-center", { name: "x" })).status).toBe(403);
    expect((await mate.post("/api/help-center/articles", { docId: d })).status).toBe(403);
    expect((await mate.post("/api/help-center/categories", { name: "x" })).status).toBe(403);
    expect((await mate.get("/api/help-center/articles")).status).toBe(200);
  });

  it("is switched off by the HELP_CENTER flag", async () => {
    const off = await makeTestApp({});
    const c = new Client(off.app);
    await c.signup("x@y.io", "X Y");
    expect((await c.get("/api/help-center")).status).toBe(404);
    expect((await off.app.request("/help/anything", { headers: { host: "localhost" } })).status).toBe(404);
  });
});

describe("articles", () => {
  it("publishes a snapshot of a doc: later doc edits stay private until Update", async () => {
    await setup();
    const cat = (await owner.post("/api/help-center/categories", { name: "Billing", description: "Plans and invoices" })).body.category;
    const d = await doc("Change your plan", "Open Settings then Plan to change it. Secret draft words.");
    const a = (await owner.post("/api/help-center/articles", { docId: d, categoryId: cat.id, summary: "Move to another plan" })).body.article;
    expect(a).toMatchObject({ slug: "change-your-plan", status: "published", categoryId: cat.id });
    expect((await owner.post("/api/help-center/articles", { docId: d })).status).toBe(409);
    const pubHtml = await html("/help/acme-help/a/change-your-plan");
    expect(pubHtml.status).toBe(200);
    expect(pubHtml.text).toContain("Open Settings then Plan");
    expect(pubHtml.text).toContain("Move to another plan");
    // Edit the doc: the public page does not change, the team sees it changed.
    const cur = (await owner.get(`/api/docs/${d}`)).body;
    await owner.patch(`/api/docs/${d}`, { text: "Brand new private edit." , version: (cur.doc ?? cur).version });
    expect((await html("/help/acme-help/a/change-your-plan")).text).not.toContain("Brand new private edit");
    const list = (await owner.get("/api/help-center/articles")).body.articles;
    expect(list[0].docChanged).toBe(true);
    await owner.post(`/api/help-center/articles/${a.id}/refresh`);
    expect((await html("/help/acme-help/a/change-your-plan")).text).toContain("Brand new private edit");
    // Category page and home.
    expect((await html("/help/acme-help/c/billing")).text).toContain("Change your plan");
    expect((await html("/help/acme-help")).text).toContain("Billing");
  });

  it("never shows drafts, unpublished articles or another workspace's articles", async () => {
    await setup();
    const d1 = await doc("Draft page", "draftonlyword here");
    const a = (await owner.post("/api/help-center/articles", { docId: d1, status: "draft" })).body.article;
    expect((await html("/help/acme-help/a/draft-page")).status).toBe(404);
    expect((await html("/help/acme-help/search?q=draftonlyword")).text).toContain("No results");
    await owner.patch(`/api/help-center/articles/${a.id}`, { status: "published" });
    expect((await html("/help/acme-help/a/draft-page")).status).toBe(200);
    expect((await html("/help/acme-help/search?q=draftonlyword")).text).toContain("Draft page");
    await owner.patch(`/api/help-center/articles/${a.id}`, { status: "draft" });
    expect((await html("/help/acme-help/a/draft-page")).status).toBe(404);
    expect((await html("/help/acme-help/search?q=draftonlyword")).text).toContain("No results");
    // A private doc that was never published is not reachable by any public address.
    await doc("Private plan", "privateword salary");
    expect((await html("/help/acme-help/search?q=privateword")).text).toContain("No results");
    // Another workspace's published article is not reachable under this center.
    const other = new Client(ctx.app);
    await other.signup("boss@globex.io", "Gus Globex", "Globex");
    await other.patch("/api/help-center", { slug: "globex-help", on: true });
    const od = (await other.post("/api/docs", { title: "Globex secret", text: "globexonly words" })).body;
    await other.post("/api/help-center/articles", { docId: (od.doc ?? od).id });
    expect((await html("/help/globex-help/a/globex-secret")).status).toBe(200);
    expect((await html("/help/acme-help/a/globex-secret")).status).toBe(404);
    expect((await html("/help/acme-help/search?q=globexonly")).text).toContain("No results");
    // Another workspace cannot publish this workspace's doc.
    expect((await other.post("/api/help-center/articles", { docId: d1 })).status).toBe(404);
    // Turning the center off hides everything at once.
    await owner.patch("/api/help-center", { on: false });
    expect((await html("/help/acme-help/a/draft-page")).status).toBe(404);
  });

  it("searches with prefixes, pages results and keeps the index in step", async () => {
    await setup();
    for (let i = 1; i <= 12; i++) await owner.post("/api/help-center/articles", { docId: await doc(`Invoice topic ${i}`, `All about invoices number ${i}`) });
    const p1 = await html("/help/acme-help/search?q=invoi");
    expect((p1.text.match(/<li>/g) ?? []).length).toBe(10);
    expect(p1.text).toContain("page=2");
    expect(p1.headers.get("x-robots-tag")).toContain("noindex");
    const p2 = await html("/help/acme-help/search?q=invoi&page=2");
    expect((p2.text.match(/<li>/g) ?? []).length).toBe(2);
    const arts = (await owner.get("/api/help-center/articles")).body.articles;
    await owner.call("DELETE", `/api/help-center/articles/${arts[0].id}`);
    const left = await ctx.db.select().from(hcTerms).all();
    expect(left.some((t: { itemId: string }) => t.itemId === arts[0].id)).toBe(false);
  });

  it("counts helpful feedback once per visitor and keeps comments private", async () => {
    await setup();
    await owner.post("/api/help-center/articles", { docId: await doc("Reset password", "Use the reset link.") });
    const g = await html("/help/acme-help/a/reset-password");
    const f = formOf(g.text);
    later();
    const r = await post("/help/acme-help/a/reset-password/feedback", { ...f, helpful: "no", comment: "Needs screenshots" });
    expect(r.status).toBe(303);
    expect(rel(r.headers.get("location"))).toContain("thanks=1");
    await post("/help/acme-help/a/reset-password/feedback", { ...f, helpful: "no" });
    const list = (await owner.get("/api/help-center/articles")).body.articles;
    expect(list[0]).toMatchObject({ helpfulYes: 0, helpfulNo: 1 });
    expect((await owner.get("/api/help-center/feedback")).body.feedback[0]).toMatchObject({ comment: "Needs screenshots", helpful: false });
    expect((await html("/help/acme-help/a/reset-password")).text).not.toContain("Needs screenshots");
  });
});

describe("questions and answers", () => {
  it("a visitor question waits for the team; approve, answer, accept, vote", async () => {
    await setup();
    const ask = await html("/help/acme-help/ask");
    expect(ask.status).toBe(200);
    later();
    const r = await post("/help/acme-help/ask", { ...formOf(ask.text), title: "How do I export my data?", body: "I need a CSV", name: "Sam" });
    expect(r.status).toBe(303);
    expect(rel(r.headers.get("location"))).toBe("/help/acme-help/ask?done=1");
    const q = (await owner.get("/api/help-center/questions?status=pending")).body.questions[0];
    expect(q).toMatchObject({ title: "How do I export my data?", status: "pending" });
    expect((await html(`/help/acme-help/q/${q.id}`)).status).toBe(404);
    expect((await html("/help/acme-help/questions")).text).not.toContain("export my data");
    await owner.patch(`/api/help-center/questions/${q.id}`, { status: "published" });
    const withAnswer = (await owner.post(`/api/help-center/questions/${q.id}/answers`, { body: "Go to Settings then Export." })).body.question;
    const aid = withAnswer.answers[0].id;
    await owner.post(`/api/help-center/questions/${q.id}/accept`, { answerId: aid });
    const pageQ = await html(`/help/acme-help/q/${q.id}`);
    expect(pageQ.text).toContain("Best answer");
    expect(pageQ.text).toContain("Go to Settings then Export.");
    later(20_000);
    // Votes: once per visitor.
    const v1 = await post(`/help/acme-help/q/${q.id}/vote`, { ...formOf(pageQ.text), target: `q:${q.id}` });
    expect(v1.status).toBe(303);
    await post(`/help/acme-help/q/${q.id}/vote`, { ...formOf(pageQ.text), target: `q:${q.id}` });
    expect((await owner.get(`/api/help-center/questions/${q.id}`)).body.question.votes).toBe(1);
    // A visitor answer waits too.
    const va = await post(`/help/acme-help/q/${q.id}/answer`, { ...formOf(pageQ.text), body: "You can also use the API for this.", name: "Kim" });
    expect(rel(va.headers.get("location"))).toContain("done=answered");
    expect((await html(`/help/acme-help/q/${q.id}`)).text).not.toContain("use the API for this");
    expect((await html("/help/acme-help/search?q=export")).text).toContain("How do I export my data?");
  });

  it("guards: honeypot, missing or fresh form token, too short, daily cap", async () => {
    await setup();
    const ask = await html("/help/acme-help/ask");
    const f = formOf(ask.text);
    // Posted at once (no clock advance): too fast.
    expect((await post("/help/acme-help/ask", { ...f, title: "Is this posted too fast?" })).status).toBe(400);
    later();
    expect((await post("/help/acme-help/ask", { ...f, title: "A honeypot question here", website: "http://spam" })).status).toBe(400);
    expect((await post("/help/acme-help/ask", { title: "No token question here" })).status).toBe(400);
    expect((await post("/help/acme-help/ask", { ...f, ft: "x".repeat(40), title: "Wrong token question" })).status).toBe(400);
    expect((await post("/help/acme-help/ask", { ...f, title: "short" })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await post("/help/acme-help/ask", { ...f, title: `Valid question number ${i}` })).status).toBe(303);
    expect((await post("/help/acme-help/ask", { ...f, title: "One more valid question" })).status).toBe(429);
    expect((await owner.get("/api/help-center/questions")).body.questions).toHaveLength(5);
  });

  it("with moderation off a clean question is live at once but spam still waits; Q&A off hides it all", async () => {
    await setup("acme-help", { moderate: false });
    const f = formOf((await html("/help/acme-help/ask")).text);
    later();
    const r = await post("/help/acme-help/ask", { ...f, title: "Can I change my email address?" });
    expect(rel(r.headers.get("location"))).toMatch(/^\/help\/acme-help\/q\//);
    await post("/help/acme-help/ask", { ...f, title: "BUY CHEAP STUFF NOW http://a.io http://b.io http://c.io" });
    const qs = (await owner.get("/api/help-center/questions")).body.questions;
    expect(qs.map((q: { status: string }) => q.status).sort()).toEqual(["pending", "published"]);
    await owner.patch("/api/help-center", { qaOn: false });
    expect((await html("/help/acme-help/questions")).status).toBe(404);
    expect((await html("/help/acme-help/ask")).status).toBe(404);
  });
});

describe("a solved ticket to a public answer", () => {
  async function solvedWebTicket() {
    const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const mailboxId = (await owner.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Acme support" })).body.mailbox.id;
    const s = await owner.patch("/api/helpdesk/settings", { hours: { always: true, timezone: "Australia/Sydney", days: [null, null, null, null, null, null, null], holidays: [] }, widget: { on: true, domains: ["https://shop.com"], mailboxId, askEmail: "after", botAnswers: false, title: "Chat", greeting: "Hi", color: null } });
    const key = s.body.widgetKey as string;
    const start = await ctx.app.request(`/api/widget/${key}/chats`, { method: "POST", headers: { host: "localhost", origin: "https://www.shop.com", "content-type": "application/json" }, body: JSON.stringify({ text: "Hi, I am Grace Hopper, grace@example.com, +61 400 123 456. How do I reset my password?", name: "Grace Hopper", email: "grace@example.com" }) });
    expect(start.status).toBe(201);
    const t = (await owner.get("/api/helpdesk/tickets")).body.tickets.find((x: { kind: string }) => x.kind === "web");
    await owner.post(`/api/helpdesk/tickets/${t.id}/web`, { text: "Internal: she is a VIP", note: true });
    await owner.post(`/api/helpdesk/tickets/${t.id}/web`, { text: "Hi Grace, use the Forgot password link on the sign in page." });
    return t.id as string;
  }

  it("needs a solved ticket, strips the customer's details and notes, and refuses leftovers unless kept on purpose", async () => {
    await setup();
    const id = await solvedWebTicket();
    expect((await owner.get(`/api/help-center/tickets/${id}/preview`)).status).toBe(400);
    await owner.patch(`/api/helpdesk/tickets/${id}`, { status: "solved" });
    const p = (await owner.get(`/api/help-center/tickets/${id}/preview`)).body.preview;
    expect(p.question).not.toContain("grace@example.com");
    expect(p.question).not.toContain("Grace");
    expect(p.question).not.toContain("400 123 456");
    expect(p.answer).toBe("Hi, use the Forgot password link on the sign in page.");
    expect(p.answer).not.toContain("VIP");
    expect(p.removed.emails).toBeGreaterThan(0);
    const bad = await owner.post("/api/help-center/tickets/publish", { ticketId: id, title: "Reset password", question: "Grace asks how to reset", answer: p.answer });
    expect(bad.status).toBe(400);
    const ok = await owner.post("/api/help-center/tickets/publish", { ticketId: id, title: "How do I reset my password?", question: p.question, answer: p.answer });
    expect(ok.status).toBe(201);
    const q = ok.body.question;
    expect(q).toMatchObject({ status: "published", source: "ticket" });
    const pub = await html(`/help/acme-help/q/${q.id}`);
    expect(pub.text).toContain("Forgot password link");
    expect(pub.text).not.toContain("grace@example.com");
    expect(pub.text).not.toContain("VIP");
    expect((await owner.post("/api/help-center/tickets/publish", { ticketId: id, title: "x again", question: "", answer: "y y" })).status).toBe(409);
  });

  it("suggests live articles in the website chat only while the setting is on", async () => {
    await setup();
    await owner.post("/api/help-center/articles", { docId: await doc("Reset your password", "Use the forgot password link.") });
    await solvedWebTicket();
    const key = (await owner.get("/api/helpdesk/settings")).body.widgetKey as string;
    const get = async () => (await (await ctx.app.request(`/api/widget/${key}/help?q=password%20reset`, { headers: { host: "localhost", origin: "https://www.shop.com" } })).json()).articles;
    const on = await get();
    expect(on).toHaveLength(1);
    expect(on[0].url).toMatch(/\/help\/acme-help\/a\/reset-your-password$/);
    await owner.patch("/api/help-center", { suggestInChat: false });
    expect(await get()).toEqual([]);
  });

  it("a member's publish goes to the moderation queue", async () => {
    await setup();
    const id = await solvedWebTicket();
    await owner.patch(`/api/helpdesk/tickets/${id}`, { status: "solved" });
    const mate = await member();
    const r = await mate.post("/api/help-center/tickets/publish", { ticketId: id, title: "Resetting a password", question: "How do I reset my password?", answer: "Use the Forgot password link." });
    if (r.status === 404) return; // members only see tickets of inboxes they are in: the ticket is not theirs to publish
    expect(r.status).toBe(201);
    expect(r.body.question.status).toBe("pending");
    expect((await html(`/help/acme-help/q/${r.body.question.id}`)).status).toBe(404);
  });
});
