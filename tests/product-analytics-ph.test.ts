/**
 * ANALYTICS-PH: internal product usage analytics. Off by default; with it on, only allow listed events with short enum
 * properties and keyed hash ids leave, Do Not Track and Global Privacy Control turn it off, the client workspace (vv8k)
 * never sends, and there is no session replay or autocapture at all (no SDK is loaded). The network is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { members, organizations, users } from "../src/server/db/schema";
import { loadConfig } from "../src/server/config";
import { ANALYTICS_ACTIONS, areaFromPath, browserOptedOut, isAnalyticsEvent, sanitizeProps } from "../src/shared/product-analytics";
import {
  actionFor, captureEvents, clearOrgFactsCache, hashId, isExcludedWorkspace, productAnalyticsConfig, setAnalyticsTransport,
} from "../src/server/services/product-analytics";
import { createProductAnalytics } from "../src/web/lib/product-analytics";

const KEY = "phc_" + "A1b2C3d4".repeat(5);
const HASH = "h".repeat(48);
const ON = { ANALYTICS_PH: "on", POSTHOG_KEY: KEY, POSTHOG_HOST: "https://eu.i.posthog.com", ANALYTICS_HASH_KEY: HASH };

describe("ANALYTICS-PH config", () => {
  it("is off unless the flag and both keys are set", () => {
    expect(productAnalyticsConfig({})).toBeNull();
    expect(productAnalyticsConfig({ POSTHOG_KEY: KEY, ANALYTICS_HASH_KEY: HASH })).toBeNull();
    expect(productAnalyticsConfig({ ...ON, ANALYTICS_PH: "off" })).toBeNull();
    expect(productAnalyticsConfig({ ...ON, POSTHOG_KEY: "nope" })).toBeNull();
    expect(productAnalyticsConfig({ ...ON, ANALYTICS_HASH_KEY: "short" })).toBeNull();
    expect(productAnalyticsConfig({ ...ON, POSTHOG_HOST: "http://eu.i.posthog.com" })).toBeNull();
    expect(productAnalyticsConfig(ON)).toMatchObject({ key: KEY, host: "https://eu.i.posthog.com" });
    expect(loadConfig({}).productAnalytics).toBeNull();
  });
  it("always excludes the client workspace vv8k, even when the list is replaced", () => {
    const cfg = productAnalyticsConfig({ ...ON, ANALYTICS_EXCLUDE: "acme" })!;
    expect(cfg.exclude).toEqual(["acme", "vv8k"]);
    expect(isExcludedWorkspace(cfg, { id: "org_1", slug: "vv8k", name: "Client" })).toBe(true);
    expect(isExcludedWorkspace(cfg, { id: "org_vv8k_2", slug: null, name: null })).toBe(true);
    expect(isExcludedWorkspace(cfg, { id: "org_3", slug: "fintex", name: "Fintex" })).toBe(false);
  });
});

describe("ANALYTICS-PH rules", () => {
  it("keeps only area and tool names from a path", () => {
    expect(areaFromPath("/app/mail/thread/abc123?q=secret")).toEqual({ area: "mail" });
    expect(areaFromPath("/app")).toEqual({ area: "home" });
    expect(areaFromPath("/app/tools/convert/job_9")).toEqual({ area: "tools", tool: "convert" });
    expect(areaFromPath("/app/tools/somebody@example.com")).toEqual({ area: "tools", tool: "other" });
    expect(areaFromPath("/app/Jane-Doe-private")).toEqual({ area: "other" });
    expect(areaFromPath("/login")).toBeNull();
  });
  it("allows only listed events and short enum properties", () => {
    expect(isAnalyticsEvent("mail_sent")).toBe(true);
    expect(isAnalyticsEvent("$autocapture")).toBe(false);
    expect(isAnalyticsEvent("$snapshot")).toBe(false);
    expect(sanitizeProps({ area: "mail", subject: "Hello", email: "a@b.co", plan: "pro", tool: "nope", source: "Has Spaces" }))
      .toEqual({ area: "mail", plan: "pro", tool: "other" });
    expect(ANALYTICS_ACTIONS).toContain("upgrade_completed");
  });
  it("honours Do Not Track and Global Privacy Control", () => {
    expect(browserOptedOut({ doNotTrack: "1" })).toBe(true);
    expect(browserOptedOut({ globalPrivacyControl: true })).toBe(true);
    expect(browserOptedOut({ doNotTrack: null }, { doNotTrack: "1" })).toBe(true);
    expect(browserOptedOut({ doNotTrack: "0" })).toBe(false);
  });
  it("hashes ids with a key: stable, 32 hex, different per kind and key, never the id itself", async () => {
    const a = await hashId(HASH, "user", "usr_123");
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(await hashId(HASH, "user", "usr_123")).toBe(a);
    expect(await hashId(HASH, "workspace", "usr_123")).not.toBe(a);
    expect(await hashId("k".repeat(48), "user", "usr_123")).not.toBe(a);
    expect(a).not.toContain("123");
  });
  it("maps successful key action routes, and nothing else", () => {
    expect(actionFor("POST", "/api/mail/send", 200)).toEqual({ event: "mail_sent" });
    expect(actionFor("POST", "/api/mail/send", 422)).toBeNull();
    expect(actionFor("POST", "/api/tasks", 201)).toEqual({ event: "task_created" });
    expect(actionFor("POST", "/api/tasks/t1/comments", 201)).toBeNull();
    expect(actionFor("POST", "/api/docs", 201)).toEqual({ event: "doc_created" });
    expect(actionFor("POST", "/api/social/posts", 200)).toEqual({ event: "social_post_created" });
    expect(actionFor("POST", "/api/invites/invites", 200)).toEqual({ event: "invite_sent" });
    expect(actionFor("POST", "/api/billing/checkout", 200)).toEqual({ event: "upgrade_started" });
    expect(actionFor("GET", "/api/connections/oauth/google/callback", 302, "/app/settings/apps/mail?connected=x")).toEqual({ event: "mail_account_connected", source: "oauth" });
    expect(actionFor("GET", "/api/connections/oauth/google/callback", 302, "/app/settings/apps/mail?error=x")).toBeNull();
    expect(actionFor("GET", "/api/mail/threads", 200)).toBeNull();
  });
});

describe("ANALYTICS-PH browser queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("sends area names only, once per area, in one batch", async () => {
    const sent: string[] = [];
    const pa = createProductAnalytics({ sender: async (b) => { sent.push(b); }, optedOut: () => false });
    pa.pageOpened("/app/mail/thread/abc");
    pa.pageOpened("/app/mail/thread/def");
    pa.pageOpened("/app/tools/convert/job");
    pa.pageOpened("/login");
    expect(pa.pending()).toBe(2);
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({ events: [{ name: "area_opened", path: "/app/mail" }, { name: "area_opened", path: "/app/tools/convert" }] });
    expect(sent[0]).not.toMatch(/abc|def|job/);
  });
  it("does nothing with Do Not Track on", () => {
    const sender = vi.fn(async () => undefined);
    const pa = createProductAnalytics({ sender, optedOut: () => true });
    pa.pageOpened("/app/mail");
    pa.flush();
    expect(sender).not.toHaveBeenCalled();
  });
});

describe("ANALYTICS-PH API", () => {
  type Batch = { api_key: string; batch: Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }> };
  let calls: Array<{ url: string; body: Batch }> = [];
  beforeEach(() => {
    calls = [];
    clearOrgFactsCache();
    setAnalyticsTransport(async (url, body) => { calls.push({ url, body: JSON.parse(body) }); });
  });
  afterEach(() => setAnalyticsTransport(null));

  it("flag off: config says off and nothing is sent", async () => {
    const ctx = await makeTestApp({});
    const c = new Client(ctx.app);
    await c.signup("off-ph@acme.io");
    expect((await c.get("/api/config")).body.analyticsPh).toBe(false);
    expect((await c.post("/api/analytics/events", { events: [{ name: "area_opened", path: "/app/mail" }] })).body.accepted).toBe(0);
    await c.post("/api/tasks", { title: "Off task" });
    expect(calls).toHaveLength(0);
  });

  it("flag on: area opens and key actions leave with hashed ids and no content", async () => {
    const ctx = await makeTestApp(ON);
    const c = new Client(ctx.app);
    await c.signup("on-ph@acme.io", "Jane Private");
    expect((await c.get("/api/config")).body.analyticsPh).toBe(true);
    const r = await c.post("/api/analytics/events", { events: [{ name: "area_opened", path: "/app/docs/doc_secret_1" }, { name: "area_opened", path: "/app/tools/sign" }] });
    expect(r.body.accepted).toBe(2);
    const t = await c.post("/api/tasks", { title: "Secret launch plan" });
    expect(t.status).toBeLessThan(300);
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe("https://eu.i.posthog.com/batch/");
    const all = JSON.stringify(calls);
    expect(all).not.toMatch(/on-ph@acme\.io|Jane|Private|Secret|doc_secret/);
    const u = (await ctx.db.select().from(users).where(eq(users.email, "on-ph@acme.io")).get())!;
    expect(all).not.toContain(u.id);
    const ev = calls[0].body.batch;
    expect(ev.map((e) => e.event)).toEqual(["area_opened", "area_opened"]);
    expect(ev[0].properties).toMatchObject({ area: "docs", $process_person_profile: false });
    expect(ev[1].properties).toMatchObject({ area: "tools", tool: "sign" });
    expect(ev[0].distinct_id).toMatch(/^[a-f0-9]{32}$/);
    expect(calls[0].body.api_key).toBe(KEY);
    expect(calls[1].body.batch[0]).toMatchObject({ event: "task_created", distinct_id: ev[0].distinct_id });
    expect(calls[1].body.batch[0].properties.plan).toBe("starter");
  });

  it("Do Not Track or Global Privacy Control on the request: nothing is sent", async () => {
    const ctx = await makeTestApp(ON);
    const c = new Client(ctx.app);
    await c.signup("dnt-ph@acme.io");
    await c.call("POST", "/api/analytics/events", { events: [{ name: "area_opened", path: "/app/mail" }] }, { dnt: "1" });
    await c.call("POST", "/api/tasks", { title: "x" }, { "sec-gpc": "1" });
    expect(calls).toHaveLength(0);
  });

  it("the client workspace (vv8k) never sends, and unknown events are refused", async () => {
    const ctx = await makeTestApp(ON);
    const c = new Client(ctx.app);
    await c.signup("vv-ph@acme.io");
    const u = (await ctx.db.select().from(users).where(eq(users.email, "vv-ph@acme.io")).get())!;
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, u.id)).get())!.organizationId;
    expect((await c.post("/api/analytics/events", { events: [{ name: "$autocapture", path: "/app/mail" }] })).status).toBe(400);
    await ctx.db.update(organizations).set({ slug: "vv8k" }).where(eq(organizations.id, orgId));
    clearOrgFactsCache();
    await c.post("/api/analytics/events", { events: [{ name: "area_opened", path: "/app/mail" }] });
    await c.post("/api/tasks", { title: "Client task" });
    expect(calls).toHaveLength(0);
  });

  it("server only events (upgrade completed) use a workspace id, never a person", async () => {
    const ctx = await makeTestApp(ON);
    const c = new Client(ctx.app);
    await c.signup("srv-ph@acme.io");
    const u = (await ctx.db.select().from(users).where(eq(users.email, "srv-ph@acme.io")).get())!;
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, u.id)).get())!.organizationId;
    expect(await captureEvents(ctx.deps, { orgId, events: [{ name: "upgrade_completed" }] })).toBe(1);
    expect(calls[0].body.batch[0].distinct_id).toMatch(/^ws_[a-f0-9]{32}$/);
    setAnalyticsTransport(async () => { throw new Error("network down"); });
    expect(await captureEvents(ctx.deps, { orgId, events: [{ name: "upgrade_completed" }] })).toBe(0);
  });
});
