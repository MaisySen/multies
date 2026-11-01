/**
 * R109: mail merge plus (flag merge_plus_r109): merge fields and fallbacks, the Spam Act rules (consent,
 * sender identity, one click unsubscribe, never re-added), journey timing in time zones, throttling to the
 * daily cap, permissions (member vs admin), opens and clicks, signup with double opt in, journeys.
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { runDueJobs } from "@/server/services/jobs";
import { linkSig } from "@/server/services/campaigns/r109";
import {
  allowedBy, canSend, fillMerge, missingFields, nextDayStart, renderEmail, sendPlan, skipStep, startStatus, stepSendAt, tzOffsetMinutes, unsubscribeHeaders,
  type Block,
} from "@/shared/campaigns-r109";

const ON = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: "k".repeat(40), TOOLS_TOKEN_KEY: "t".repeat(40), TOOLS_FEATURES: "all" };
const JOBS = { types: ["campaign.batch", "campaign.send", "journey.step"] as ("campaign.batch" | "campaign.send" | "journey.step")[] };
const consent = { kind: "express", source: "Signup form" };

describe("R109 rules", () => {
  const ctx = { workspace: "Acme" };
  it("fills merge fields with fallbacks and escapes for HTML", () => {
    const p = { email: "jo@x.io", name: "Jo Lee", fields: { City: "Perth" } };
    expect(fillMerge("Hi {{first_name}} from {{ city }} at {{workspace}}", p, ctx)).toBe("Hi Jo from Perth at Acme");
    expect(fillMerge("Hi {{first_name | there}}", { email: "a@x.io" }, ctx)).toBe("Hi there");
    expect(fillMerge("{{last_name}}|{{plan|free}}", p, ctx)).toBe("Lee|free");
    expect(fillMerge("{{name}}", { email: "a@x.io", name: "<b>x</b>" }, ctx, true)).toBe("&lt;b&gt;x&lt;/b&gt;");
    expect(missingFields(["{{first_name}} {{city|here}} {{plan}}"], { email: "a@x.io" }, ctx)).toEqual(["first_name", "plan"]);
  });

  it("puts the sender, the reason and the unsubscribe link in every email, and counts only when asked", () => {
    const blocks: Block[] = [{ type: "heading", text: "Hi {{first_name|there}}" }, { type: "text", text: "Read https://acme.io/news now" }, { type: "button", label: "Shop", url: "https://acme.io/shop" }, { type: "button", label: "Broken", url: "https://" }];
    const base = { ...ctx, brandColor: "#112233", senderName: "Acme Pty Ltd", senderAddress: "1 George St, Sydney NSW 2000", listName: "Monthly news", unsubscribeUrl: "https://app/u/t" };
    const plain = renderEmail(blocks, { email: "jo@x.io", name: "Jo" }, base);
    expect(plain.html).toContain("Sent by Acme Pty Ltd, 1 George St, Sydney NSW 2000.");
    expect(plain.html).toContain('href="https://app/u/t"');
    expect(plain.html).toContain("You get this email because you joined Monthly news.");
    expect(plain.html).toContain("#112233");
    expect(plain.html).not.toContain("Broken");
    expect(plain.html).not.toContain('width="1"');
    expect(plain.text).toContain("Unsubscribe at any time: https://app/u/t");
    const tracked = renderEmail(blocks, { email: "jo@x.io" }, { ...base, pixelUrl: "https://app/o/t.gif", trackLink: (u) => `https://app/c?u=${encodeURIComponent(u)}` });
    expect(tracked.html).toContain('src="https://app/o/t.gif"');
    expect(tracked.html).toContain("https://app/c?u=https%3A%2F%2Facme.io%2Fshop");
    expect(unsubscribeHeaders("https://app/u/t")).toEqual({ "List-Unsubscribe": "<https://app/u/t>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });

  it("sends only with recorded consent, and inferred consent only where the list allows it", () => {
    const ok = { status: "subscribed" as const, consentKind: "express" as const, consentAt: 1, consentSource: "Signup form" };
    expect(canSend(ok, { allowInferred: false }, false).ok).toBe(true);
    expect(canSend(ok, { allowInferred: false }, true).ok).toBe(false);
    expect(canSend({ ...ok, consentSource: " " }, { allowInferred: false }, false).ok).toBe(false);
    expect(canSend({ ...ok, consentAt: null }, { allowInferred: false }, false).ok).toBe(false);
    expect(canSend({ ...ok, consentKind: "inferred" }, { allowInferred: false }, false).ok).toBe(false);
    expect(canSend({ ...ok, consentKind: "inferred" }, { allowInferred: true }, false).ok).toBe(true);
    expect(canSend({ ...ok, status: "pending" }, { allowInferred: true }, false).ok).toBe(false);
    expect(startStatus(true, "signup")).toBe("pending");
    expect(startStatus(false, "signup")).toBe("subscribed");
    expect(startStatus(true, "import")).toBe("subscribed");
  });

  it("times journey steps in the list's time zone across daylight saving", () => {
    expect(tzOffsetMinutes("Australia/Sydney", Date.UTC(2026, 0, 10))).toBe(660);
    expect(tzOffsetMinutes("Australia/Sydney", Date.UTC(2026, 6, 10))).toBe(600);
    // Sat 3 Oct 10:00 AEST, wait 2 days, 9 AM: Mon 5 Oct 09:00 AEDT (daylight saving began 4 Oct) = 4 Oct 22:00 UTC.
    expect(new Date(stepSendAt(Date.UTC(2026, 9, 3, 0), 2, 9, "Australia/Sydney")).toISOString()).toBe("2026-10-04T22:00:00.000Z");
    expect(new Date(stepSendAt(Date.UTC(2026, 9, 3, 0), 1, 9, "America/New_York")).toISOString()).toBe("2026-10-03T13:00:00.000Z");
    expect(stepSendAt(123456, 0, 9, "UTC")).toBe(123456);
    expect(new Date(nextDayStart(Date.UTC(2026, 9, 3, 18), "UTC")).toISOString()).toBe("2026-10-04T00:05:00.000Z");
  });

  it("plans sends within today's limit, skips follow ups that were opened, and keeps staging to the QA mailbox", () => {
    expect(sendPlan(10, 4)).toEqual({ today: 4, later: 6 });
    expect(sendPlan(3, 10)).toEqual({ today: 3, later: 0 });
    expect(sendPlan(3, -2)).toEqual({ today: 0, later: 3 });
    expect(skipStep({ onlyIfNotOpened: true }, true)).toBe(true);
    expect(skipStep({ onlyIfNotOpened: true }, false)).toBe(false);
    expect(skipStep({ onlyIfNotOpened: false }, true)).toBe(false);
    expect(allowedBy([], "a@b.io")).toBe(true);
    expect(allowedBy(["@qa.test", "me@x.io"], "Box@QA.test")).toBe(true);
    expect(allowedBy(["@qa.test"], "someone@gmail.com")).toBe(false);
  });
});

async function setup(env: Record<string, string> = ON) {
  const ctx = await makeTestApp(env);
  let clock = Date.now();
  ctx.deps.now = () => new Date(clock);
  const c = new Client(ctx.app);
  await c.signup(undefined, "Ada Lovelace", "Acme");
  const orgId = ((await c.get("/api/account/me")).body as { organization?: { id: string } }).organization?.id ?? "";
  return { ...ctx, c, orgId, tick: (ms: number) => { clock += ms; } };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function mailbox(ctx: Ctx) {
  const domainId = (await ctx.c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await ctx.c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await ctx.c.post(`/api/domains/${domainId}/verify`);
  return (await ctx.c.post("/api/mailboxes", { domainId, localPart: "news", displayName: "Acme news" })).body.mailbox.id as string;
}

async function readyList(ctx: Ctx, extra: Record<string, unknown> = {}) {
  const mailboxId = await mailbox(ctx);
  const l = await ctx.c.post("/api/tools/campaigns/lists", { name: "Monthly news", mailboxId, senderName: "Acme Pty Ltd", senderAddress: "1 George St, Sydney NSW 2000", ...extra });
  expect(l.status).toBe(201);
  return { list: l.body, mailboxId };
}

async function drain(ctx: Ctx, rounds = 6) {
  for (let i = 0; i < rounds; i++) { await runDueJobs(ctx.deps, 50, JOBS); ctx.tick(5_000); }
}

const news = (ctx: Ctx) => ctx.outbound.sent.filter((m) => m.from.address.startsWith("news@"));
const sentTo = (ctx: Ctx) => news(ctx).map((m) => m.to[0]);
const form = (ctx: Ctx, path: string, body: Record<string, string>) =>
  ctx.app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

describe("R109 API", () => {
  it("is not found while merge_plus_r109 is off", async () => {
    const ctx = await setup({ ...ON, TOOLS_FEATURES: "merge_mail" });
    expect((await ctx.c.get("/api/tools/campaigns/lists")).status).toBe(404);
  });

  it("records consent with source, refuses inferred consent on express lists, and never re-adds the unsubscribed or bounced", async () => {
    const ctx = await setup();
    const { list } = await readyList(ctx);
    const url = `/api/tools/campaigns/lists/${list.id}/members`;
    expect((await ctx.c.post(url, { people: [{ email: "a@x.io" }], consent: { kind: "express", source: "" } })).status).toBe(422);
    const inferred = await ctx.c.post(url, { people: [{ email: "a@x.io" }], consent: { kind: "inferred", source: "Customer who bought from us" } });
    expect(inferred.status).toBe(400);
    expect(inferred.body.error.message).toMatch(/express consent/);
    await ctx.db.run(sql`insert into suppressions (id, org_id, address, reason, created_at) values ('s1', ${ctx.orgId}, 'bounce@x.io', 'hard_bounce', 1)`);
    await ctx.db.run(sql`insert into merge_unsubscribes (org_id, email, created_at) values (${ctx.orgId}, 'gone@x.io', ${Date.now() - 1000})`);
    const r = await ctx.c.post(url, { people: [{ email: "Jo@X.io", name: "Jo Lee" }, { email: "jo@x.io" }, { email: "nope" }, { email: "bounce@x.io" }, { email: "gone@x.io" }], consent });
    expect(r.body).toMatchObject({ added: 1, skippedInvalid: 1, skippedBounced: 1, skippedUnsubscribed: 1 });
    const m = await ctx.c.get(`/api/tools/campaigns/lists/${list.id}`);
    expect(m.body.members).toHaveLength(1);
    expect(m.body.members[0]).toMatchObject({ email: "jo@x.io", status: "subscribed", consentKind: "express", consentSource: "Signup form", canSend: true });
  });

  it("lets members use workspace lists but only admins send to them", async () => {
    const ctx = await setup();
    const { list } = await readyList(ctx);
    const invite = await ctx.c.post("/api/team/invites", { email: "mate-r109@example.com", role: "member" });
    const mate = new Client(ctx.app);
    await mate.signup("mate-r109@example.com", "Mate", "");
    expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    expect((await mate.get("/api/tools/campaigns/lists")).body.lists.map((l: { id: string; canSend: boolean }) => [l.id, l.canSend])).toEqual([[list.id, false]]);
    expect((await mate.post("/api/tools/campaigns/lists", { name: "Everyone", visibility: "workspace" })).status).toBe(403);
    const mine = await mate.post("/api/tools/campaigns/lists", { name: "My clients" });
    expect(mine.body).toMatchObject({ visibility: "private", canSend: true });
    expect((await ctx.c.get("/api/tools/campaigns/lists")).body.lists).toHaveLength(2);
    expect((await mate.post(`/api/tools/campaigns/lists/${list.id}/members`, { people: [{ email: "z@x.io" }], consent })).status).toBe(403);
    const n = await mate.post("/api/tools/campaigns/newsletters", { listId: list.id, name: "October" });
    expect(n.status).toBe(201);
    const s = await mate.post(`/api/tools/campaigns/newsletters/${n.body.id}/schedule`, { at: null });
    expect(s.status).toBe(403);
    expect(s.body.error.message).toMatch(/Only admins/);
  });

  it("sends a newsletter with merge fields, sender details and one click unsubscribe headers, then honours the unsubscribe at once everywhere", async () => {
    const ctx = await setup();
    const { list } = await readyList(ctx);
    const other = (await ctx.c.post("/api/tools/campaigns/lists", { name: "Events", senderName: "Acme", senderAddress: "1 George St, Sydney" })).body;
    await ctx.c.post(`/api/tools/campaigns/lists/${list.id}/members`, { people: [{ email: "jo@x.io", name: "Jo Lee" }, { email: "sam@x.io" }], consent });
    await ctx.c.post(`/api/tools/campaigns/lists/${other.id}/members`, { people: [{ email: "jo@x.io" }], consent });
    const n = (await ctx.c.post("/api/tools/campaigns/newsletters", { listId: list.id, name: "October" })).body;
    const noSubject = await ctx.c.post(`/api/tools/campaigns/newsletters/${n.id}/schedule`, { at: null });
    expect(noSubject.status).toBe(400);
    expect(noSubject.body.error.message).toMatch(/Add a subject/);
    await ctx.c.patch(`/api/tools/campaigns/newsletters/${n.id}`, { subject: "News for {{first_name|you}}", blocks: [{ type: "text", text: "Hi {{first_name | there}}, see https://acme.io/news" }] });
    const s = await ctx.c.post(`/api/tools/campaigns/newsletters/${n.id}/schedule`, { at: null });
    expect(s.status).toBe(200);
    await drain(ctx);
    const got = await ctx.c.get(`/api/tools/campaigns/newsletters/${n.id}`);
    expect(got.body).toMatchObject({ status: "sent", stats: { total: 2, sent: 2, failed: 0 } });
    const jo = news(ctx).find((m) => m.to[0] === "jo@x.io")!;
    expect(jo.subject).toBe("News for Jo");
    expect(jo.html).toContain("Hi Jo, see");
    expect(jo.html).toContain("Sent by Acme Pty Ltd, 1 George St, Sydney NSW 2000.");
    expect(jo.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const unsub = jo.headers!["List-Unsubscribe"].slice(1, -1);
    expect(unsub).toMatch(/\/api\/campaign-public\/u\/[0-9a-f]{32}$/);
    expect(news(ctx).find((m) => m.to[0] === "sam@x.io")!.subject).toBe("News for you");
    // One click, the way mail apps do it.
    const res = await form(ctx, new URL(unsub).pathname, { "List-Unsubscribe": "One-Click" });
    expect(res.status).toBe(200);
    expect((await ctx.c.get(`/api/tools/campaigns/newsletters/${n.id}`)).body.stats.unsubscribed).toBe(1);
    expect((await ctx.c.get(`/api/tools/campaigns/lists/${other.id}`)).body.members[0].status).toBe("unsubscribed");
    expect((await ctx.c.get("/api/tools/campaigns/suppressions")).body.items.map((i: { email: string }) => i.email)).toContain("jo@x.io");
    const again = await ctx.c.post(`/api/tools/campaigns/lists/${list.id}/members`, { people: [{ email: "jo@x.io" }], consent });
    expect(again.body.skippedUnsubscribed).toBe(1);
  });

  it("counts the first open and click only, and refuses unsigned redirects", async () => {
    const ctx = await setup();
    const { list } = await readyList(ctx);
    await ctx.c.post(`/api/tools/campaigns/lists/${list.id}/members`, { people: [{ email: "jo@x.io" }], consent });
    const n = (await ctx.c.post("/api/tools/campaigns/newsletters", { listId: list.id, name: "Oct" })).body;
    await ctx.c.patch(`/api/tools/campaigns/newsletters/${n.id}`, { subject: "Hi" });
    await ctx.c.post(`/api/tools/campaigns/newsletters/${n.id}/schedule`, { at: null });
    await drain(ctx);
    const token = (await ctx.db.get<{ token: string }>(sql`select token from campaign_recipients where campaign_id = ${n.id}`))!.token;
    expect(news(ctx)[0].html).toContain(`/o/${token}.gif`);
    await ctx.app.request(`/api/campaign-public/o/${token}.gif`);
    await ctx.app.request(`/api/campaign-public/o/${token}.gif`);
    const u = "https://example.com/shop";
    expect((await ctx.app.request(`/api/campaign-public/c/${token}?u=${encodeURIComponent("https://evil.test")}&s=00000000000000000000`)).status).toBe(400);
    const ok = await ctx.app.request(`/api/campaign-public/c/${token}?u=${encodeURIComponent(u)}&s=${await linkSig(ctx.deps, token, u)}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe(u);
    expect((await ctx.c.get(`/api/tools/campaigns/newsletters/${n.id}`)).body.stats).toMatchObject({ opened: 1, clicked: 1 });
  });

  it("sends what today's limit allows and the rest tomorrow", async () => {
    const ctx = await setup();
    const { list } = await readyList(ctx);
    await ctx.c.post(`/api/tools/campaigns/lists/${list.id}/members`, { people: [{ email: "a@x.io" }, { email: "b@x.io" }, { email: "c@x.io" }], consent });
    const day = new Date(ctx.deps.now()).toISOString().slice(0, 10);
    await ctx.db.run(sql`insert into merge_daily (org_id, day, n) values (${ctx.orgId}, ${day}, 49)`);
    const n = (await ctx.c.post("/api/tools/campaigns/newsletters", { listId: list.id, name: "Oct" })).body;
    await ctx.c.patch(`/api/tools/campaigns/newsletters/${n.id}`, { subject: "Hi" });
    await ctx.c.post(`/api/tools/campaigns/newsletters/${n.id}/schedule`, { at: null });
    await drain(ctx);
    expect(news(ctx)).toHaveLength(1);
    expect((await ctx.c.get(`/api/tools/campaigns/newsletters/${n.id}`)).body).toMatchObject({ status: "sending", error: expect.stringMatching(/tomorrow/) });
    ctx.tick(26 * 3600_000);
    await drain(ctx);
    expect(news(ctx)).toHaveLength(3);
    expect((await ctx.c.get(`/api/tools/campaigns/newsletters/${n.id}`)).body.status).toBe("sent");
  });

  it("on staging sends only to the QA mailbox", async () => {
    const ctx = await setup({ ...ON, CAMPAIGN_SEND_ALLOW: "@qa.test" });
    const { list } = await readyList(ctx);
    await ctx.c.post(`/api/tools/campaigns/lists/${list.id}/members`, { people: [{ email: "box@qa.test" }, { email: "real@gmail.com" }], consent });
    const n = (await ctx.c.post("/api/tools/campaigns/newsletters", { listId: list.id, name: "Oct" })).body;
    await ctx.c.patch(`/api/tools/campaigns/newsletters/${n.id}`, { subject: "Hi" });
    await ctx.c.post(`/api/tools/campaigns/newsletters/${n.id}/schedule`, { at: null });
    await drain(ctx);
    expect(sentTo(ctx)).toEqual(["box@qa.test"]);
    expect((await ctx.c.get(`/api/tools/campaigns/newsletters/${n.id}`)).body.stats).toMatchObject({ sent: 1, skipped: 1 });
  });

  it("signs people up with double opt in and starts the welcome journey only once they confirm, skipping the follow up when they opened", async () => {
    const ctx = await setup();
    const { list } = await readyList(ctx, { signupOn: true });
    const j = (await ctx.c.post("/api/tools/campaigns/journeys", { listId: list.id, name: "Welcome", starter: "welcome" })).body;
    expect(j.steps).toHaveLength(2);
    expect((await ctx.c.post(`/api/tools/campaigns/journeys/${j.id}/start`)).body.status).toBe("active");
    const key = (await ctx.c.get("/api/tools/campaigns/lists")).body.lists[0].signupKey;
    expect((await ctx.app.request(`/api/campaign-public/s/${key}`)).status).toBe(200);
    expect((await form(ctx, `/api/campaign-public/s/${key}`, { email: "new@x.io", name: "Nia" })).status).toBe(400); // no tick
    expect((await form(ctx, `/api/campaign-public/s/${key}`, { email: "new@x.io", name: "Nia", consent: "1" })).status).toBe(200);
    const confirmMail = news(ctx).find((m) => m.to[0] === "new@x.io")!;
    const token = confirmMail.text.match(/confirm\/([0-9a-f]{32})/)![1];
    await drain(ctx);
    expect(news(ctx)).toHaveLength(1); // nothing before the confirm
    expect((await form(ctx, `/api/campaign-public/confirm/${token}`, {})).status).toBe(200);
    expect((await form(ctx, `/api/campaign-public/confirm/${token}`, {})).status).toBe(400);
    const member = (await ctx.c.get(`/api/tools/campaigns/lists/${list.id}`)).body.members[0];
    expect(member).toMatchObject({ status: "subscribed", consentSource: "Signup form, confirmed by email" });
    await drain(ctx);
    expect(news(ctx).map((m) => m.subject)).toEqual([expect.stringMatching(/Confirm/), "Welcome to Acme"]);
    const t = (await ctx.db.get<{ token: string }>(sql`select token from campaign_recipients where email = 'new@x.io'`))!.token;
    await ctx.app.request(`/api/campaign-public/o/${t}.gif`);
    ctx.tick(4 * 86_400_000);
    await drain(ctx);
    expect(news(ctx)).toHaveLength(2); // the follow up was skipped: the welcome was opened
    expect((await ctx.db.get<{ status: string }>(sql`select status from journey_enrollments where email = 'new@x.io'`))!.status).toBe("done");
  });

  it("holds journey emails while paused and sends them on resume", async () => {
    const ctx = await setup();
    const { list } = await readyList(ctx);
    const j = (await ctx.c.post("/api/tools/campaigns/journeys", { listId: list.id, name: "Welcome", starter: "welcome" })).body;
    await ctx.c.post(`/api/tools/campaigns/journeys/${j.id}/start`);
    expect((await ctx.c.patch(`/api/tools/campaigns/journeys/${j.id}`, { name: "x" })).status).toBe(400);
    await ctx.c.post(`/api/tools/campaigns/journeys/${j.id}/pause`);
    await ctx.c.post(`/api/tools/campaigns/lists/${list.id}/members`, { people: [{ email: "jo@x.io" }], consent });
    await drain(ctx);
    expect(news(ctx)).toHaveLength(0);
    await ctx.c.post(`/api/tools/campaigns/journeys/${j.id}/start`);
    await ctx.c.post(`/api/tools/campaigns/lists/${list.id}/members`, { people: [{ email: "sam@x.io" }], consent });
    await drain(ctx);
    expect(sentTo(ctx)).toEqual(["sam@x.io"]);
    expect((await ctx.c.get(`/api/tools/campaigns/journeys/${j.id}`)).body).toMatchObject({ enrolled: 1, status: "active" });
  });
});
