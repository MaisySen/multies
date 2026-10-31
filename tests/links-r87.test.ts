import { describe, it, expect, beforeAll } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { flushClicks } from "@/server/services/links/public";
import { browserOf, deviceOf, isBotAgent, osOf, referrerOf, withUtm, readUtm, csvCell } from "@/shared/links";
import { inkOn } from "@/server/services/links/bio";
import { checkDestination } from "@/server/services/links/core";

/** R87: Links in Tools (short links, stats, bio page, go links, link domain). */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
let member: Client;
let outsider: Client;
const BASE = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "k1", DOC_ENGINE_KEY: "e".repeat(40), TOOLS_TOKEN_KEY: "t".repeat(40), TOOLS_FEATURES: "links", LINK_CLICK_FLUSH_MS: "0", TRUST_PROXY: "true", APP_URL: "http://localhost" };
const CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const visit = (path: string, init: RequestInit & { ua?: string; ip?: string } = {}) => ctx.app.request(path, {
  ...init, redirect: "manual",
  headers: { host: "localhost", "user-agent": init.ua ?? CHROME, "x-forwarded-for": init.ip ?? "203.0.113.9", "cf-ipcountry": "AU", referer: "https://www.instagram.com/p/1", ...(init.headers as Record<string, string> ?? {}) },
});

beforeAll(async () => {
  ctx = await makeTestApp(BASE);
  owner = new Client(ctx.app);
  await owner.signup("olive@harbour.test", "Olive Owner", "Harbour Coffee");
  const inv = await owner.post("/api/team/invites", { email: "max@harbour.test", role: "member" });
  member = new Client(ctx.app);
  await member.signup("max@harbour.test", "Max Member", "");
  expect((await member.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  outsider = new Client(ctx.app);
  await outsider.signup("eve@else.test", "Eve Else", "Else Co");
});

describe("shared helpers", () => {
  it("spots bots and link previews, and reads device, browser and system", () => {
    for (const ua of ["facebookexternalhit/1.1", "Twitterbot/1.0", "Slackbot-LinkExpanding 1.0", "WhatsApp/2.23.20.0 A", "TelegramBot (like TwitterBot)", "Mozilla/5.0 (compatible; Discordbot/2.0)", "curl/8.4.0", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36", "", "LinkedInBot/1.0"]) expect(isBotAgent(ua)).toBe(true);
    expect(isBotAgent(CHROME)).toBe(false);
    expect(deviceOf(CHROME)).toBe("Phone");
    expect(deviceOf("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("Tablet");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0")).toBe("Desktop");
    expect(browserOf(CHROME)).toBe("Safari");
    expect(browserOf("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0")).toBe("Edge");
    expect(osOf(CHROME)).toBe("iOS");
    expect(referrerOf("https://www.instagram.com/p/1")).toBe("instagram.com");
    expect(referrerOf("https://l.facebook.com/x")).toBe("facebook.com");
    expect(referrerOf("https://t.co/abc")).toBe("x.com");
    expect(referrerOf(null)).toBe("Direct");
    expect(referrerOf("https://localhost/app", "localhost")).toBe("Direct");
  });
  it("builds and reads UTM fields, keeps the rest of the address", () => {
    const u = withUtm("https://shop.example/a?x=1#top", { source: "newsletter", medium: "email", campaign: "spring sale", term: "", content: "" });
    expect(u).toBe("https://shop.example/a?x=1&utm_source=newsletter&utm_medium=email&utm_campaign=spring+sale#top");
    expect(readUtm(u).campaign).toBe("spring sale");
    expect(withUtm(u, { source: "" })).not.toContain("utm_source");
  });
  it("guards CSV cells and picks readable text on a colour", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(inkOn("#ffff00")).toBe("#111111");
    expect(inkOn("#0066cc")).toBe("#ffffff");
  });
  it("only takes public web addresses", () => {
    expect(checkDestination("example.com/a", "http://localhost")).toBe("https://example.com/a");
    for (const bad of ["javascript:alert(1)", "http://127.0.0.1/", "http://10.1.2.3/x", "http://169.254.169.254/latest", "ftp://example.com", "https://user:pw@example.com", "http://localhost/l/abc", "https://intranet/"]) {
      expect(() => checkDestination(bad, "http://localhost")).toThrow();
    }
  });
});

describe("short links", () => {
  let id = "";
  it("makes a link with an auto back half and sends visitors on with a 302", async () => {
    const r = await owner.post("/api/links", { url: "https://harbour.example/menu", title: "Menu", tags: ["Print", "print", "menu"] });
    expect(r.status).toBe(201);
    id = r.body.link.id;
    expect(r.body.link.code).toMatch(/^[a-z2-9]{7}$/);
    expect(r.body.link.shortUrl).toBe(`http://localhost/l/${r.body.link.code}`);
    expect(r.body.link.tags).toEqual(["print", "menu"]);
    const res = await visit(`/l/${r.body.link.code}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://harbour.example/menu");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("counts people, not bots, and stores no address", async () => {
    const l = (await owner.get(`/api/links/${id}`)).body.link;
    await visit(`/l/${l.code}`, { ip: "198.51.100.7" });
    await visit(`/l/${l.code}`, { ua: "facebookexternalhit/1.1" });
    await visit(`/l/${l.code}`, { headers: { "sec-purpose": "prefetch" } });
    await flushClicks(ctx.deps);
    const after = (await owner.get(`/api/links/${id}`)).body.link;
    expect(after.clicks).toBe(2);
    const raw = (ctx.db as unknown as { $client: { prepare: (q: string) => { all: () => Record<string, unknown>[] } } }).$client;
    const rows = raw.prepare("select * from link_clicks").all();
    expect(rows.length).toBe(2);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
    expect(JSON.stringify(rows)).not.toContain("198.51.100.7");
    expect(rows[0].country).toBe("AU");
    expect(rows[0].referrer).toBe("instagram.com");
    expect(String(rows[0].visitor)).toMatch(/^[0-9a-f]{16}$/);
    const st = await owner.get(`/api/links/${id}/stats?days=7`);
    expect(st.status).toBe(200);
    expect(st.body.days).toHaveLength(7);
    expect(st.body.total).toBe(2);
    expect(st.body.visitors).toBe(2);
    expect(st.body.countries[0]).toEqual({ key: "AU", n: 2 });
    expect(st.body.devices[0].key).toBe("Phone");
    expect(st.body.botClicks).toBe(2);
    const csv = await ctx.app.request(`/api/links/${id}/clicks.csv`, { headers: { cookie: owner.cookie, host: "localhost" } });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\n")[0]).toBe("time_utc,country,referrer,device,browser,os");
    expect(text).toContain("AU,instagram.com,Phone,Safari,iOS");
  });

  it("refuses a taken custom back half and unsafe addresses", async () => {
    const a = await owner.post("/api/links", { url: "https://harbour.example/", code: "Coffee" });
    expect(a.status).toBe(201);
    expect(a.body.link.code).toBe("coffee");
    expect((await owner.get("/api/links/check?code=coffee")).body.free).toBe(false);
    expect((await owner.get("/api/links/check?code=free-one")).body.free).toBe(true);
    const b = await outsider.post("/api/links", { url: "https://else.example/", code: "coffee" });
    expect(b.status).toBe(409);
    expect((await owner.post("/api/links", { url: "http://192.168.1.1/admin" })).status).toBe(400);
    expect((await owner.post("/api/links", { url: "https://x.example", code: "bad code!" })).status).toBe(400);
  });

  it("edits the destination later, turns off, expires and limits clicks", async () => {
    const l = (await owner.post("/api/links", { url: "https://harbour.example/old", code: "edit-me" })).body.link;
    expect((await owner.patch(`/api/links/${l.id}`, { url: "https://harbour.example/new" })).status).toBe(200);
    expect((await visit("/l/edit-me")).headers.get("location")).toBe("https://harbour.example/new");
    await owner.patch(`/api/links/${l.id}`, { enabled: false });
    const off = await visit("/l/edit-me");
    expect(off.status).toBe(410);
    expect(await off.text()).toContain("This link is turned off");
    const lim = (await owner.post("/api/links", { url: "https://harbour.example/once", code: "once", maxClicks: 1 })).body.link;
    expect((await visit("/l/once", { ua: "Twitterbot/1.0" })).status).toBe(302); // a preview does not use the click
    expect((await visit("/l/once")).status).toBe(302);
    const used = await visit("/l/once");
    expect(used.status).toBe(410);
    expect(await used.text()).toContain("used up");
    expect(lim.maxClicks).toBe(1);
    expect((await owner.post("/api/links", { url: "https://x.example", expiresAt: "2001-01-01T00:00:00Z" })).status).toBe(400);
    expect((await visit("/l/nothing-here")).status).toBe(404);
  });

  it("asks for the password before sending on", async () => {
    await owner.post("/api/links", { url: "https://harbour.example/secret", code: "locked", password: "beans123" });
    const page = await visit("/l/locked");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("This link has a password");
    const ft = html.match(/name="ft" value="([^"]+)"/)![1];
    const wrong = await visit("/l/locked", { method: "POST", body: new URLSearchParams({ ft, password: "nope" }), headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" } });
    expect(wrong.status).toBe(401);
    const right = await visit("/l/locked", { method: "POST", body: new URLSearchParams({ ft, password: "beans123" }), headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" } });
    expect(right.status).toBe(302);
    expect(right.headers.get("location")).toBe("https://harbour.example/secret");
    const cross = await visit("/l/locked", { method: "POST", body: new URLSearchParams({ ft, password: "beans123" }), headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" } });
    expect(cross.status).toBe(401);
  });

  it("imports from CSV rows and reports bad rows by line", async () => {
    const r = await owner.post("/api/links/bulk", { rows: [{ url: "https://a.example", code: "bulk-a", tags: "x;y" }, { url: "not a url at all" }, { url: "https://b.example" }] });
    expect(r.status).toBe(201);
    expect(r.body.created).toHaveLength(2);
    expect(r.body.failed).toEqual([{ line: 3, message: expect.any(String) }]);
    expect(r.body.created[0].tags).toEqual(["x", "y"]);
  });

  it("keeps workspaces apart and lets only the maker or an admin edit", async () => {
    expect((await outsider.get(`/api/links/${id}`)).status).toBe(404);
    expect((await outsider.patch(`/api/links/${id}`, { url: "https://evil.example" })).status).toBe(404);
    const list = await outsider.get("/api/links");
    expect(list.body.links.find((x: { id: string }) => x.id === id)).toBeUndefined();
  });

  it("deletes a link with its clicks", async () => {
    expect((await owner.del(`/api/links/${id}`)).status).toBe(200);
    expect((await owner.get(`/api/links/${id}`)).status).toBe(404);
  });
});

describe("bio page", () => {
  it("drafts, publishes and counts link clicks; members cannot edit the workspace page", async () => {
    const draft = await owner.get("/api/links/bio?scope=workspace");
    expect(draft.body.page.id).toBeNull();
    expect(draft.body.page.slug).toBe("harbour-coffee");
    const save = await owner.put("/api/links/bio?scope=workspace", {
      slug: "harbour", title: "Harbour Coffee", bio: "Small batch roasters", avatar: "none", theme: "brand", published: false,
      items: [{ title: "Order online", url: "https://harbour.example/order", icon: "shop" }, { title: "Email us", url: "hello@harbour.example", icon: "mail" }],
      socials: [{ kind: "instagram", url: "https://instagram.com/harbour" }, { kind: "email", url: "hello@harbour.example" }],
    });
    expect(save.status).toBe(200);
    expect(save.body.page.items[1].url).toBe("mailto:hello@harbour.example");
    expect((await visit("/bio/harbour")).status).toBe(404); // not published yet
    await owner.put("/api/links/bio?scope=workspace", { ...save.body.page, avatar: "none", published: true, items: save.body.page.items, socials: save.body.page.socials });
    const page = await visit("/bio/harbour");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Harbour Coffee");
    expect(html).toContain("Order online");
    expect(html).not.toContain("<script");
    const itemId = save.body.page.items[0].id as string;
    const go = await visit(`/bio/harbour/go/${itemId}`);
    expect(go.status).toBe(302);
    expect(go.headers.get("location")).toBe("https://harbour.example/order");
    await flushClicks(ctx.deps);
    const again = await owner.get("/api/links/bio?scope=workspace");
    expect(again.body.page.items[0].clicks).toBe(1);
    expect(again.body.page.views).toBe(1);
    expect((await member.put("/api/links/bio?scope=workspace", { ...save.body.page, avatar: "none" })).status).toBe(403);
    const reserved = await owner.put("/api/links/bio?scope=me", { slug: "admin", title: "Me", avatar: "none", theme: "dark", published: true, items: [], socials: [] });
    expect(reserved.status).toBe(409);
    const taken = await outsider.put("/api/links/bio?scope=me", { slug: "harbour", title: "Me", avatar: "none", theme: "dark", published: true, items: [], socials: [] });
    expect(taken.status).toBe(409);
    const bad = await owner.put("/api/links/bio?scope=me", { slug: "olive", title: "Olive", avatar: "none", theme: "light", published: true, items: [{ title: "x", url: "javascript:alert(1)" }], socials: [] });
    expect(bad.status).toBe(400);
  });
});

describe("go links", () => {
  it("opens a doc or a web address for members only", async () => {
    const doc = (await owner.post("/api/docs", { title: "Onboarding", text: "hello" })).body.doc;
    const g = await owner.post("/api/links/go", { name: "go/Onboarding", targetKind: "doc", targetId: doc.id });
    expect(g.status).toBe(201);
    expect(g.body.link.name).toBe("onboarding");
    expect(g.body.link.href).toBe(`/app/docs/${doc.id}`);
    expect((await owner.post("/api/links/go", { name: "onboarding", targetKind: "url", url: "https://x.example" })).status).toBe(409);
    expect((await owner.post("/api/links/go", { name: "wiki", targetKind: "url", url: "https://wiki.example" })).status).toBe(201);
    const open = await owner.get("/api/links/go/open/onboarding");
    expect(open.body.href).toBe(`/app/docs/${doc.id}`);
    const miss = await owner.get("/api/links/go/open/onboard");
    expect(miss.body.href).toBeNull();
    expect(miss.body.suggestions).toContain("onboarding");
    expect((await outsider.get("/api/links/go/open/onboarding")).body.href).toBeNull();
    expect((await outsider.post("/api/links/go", { name: "steal", targetKind: "doc", targetId: doc.id })).status).toBe(404);
    const list = await owner.get("/api/links/go");
    expect(list.body.links.map((l: { name: string }) => l.name)).toEqual(["onboarding", "wiki"]);
    expect(list.body.links[0].clicks).toBe(1);
  });
});

describe("link domain and the flag", () => {
  it("offers only verified domains and needs an admin", async () => {
    const h = await owner.get("/api/links/host");
    expect(h.body.status).toBe("none");
    expect(h.body.base).toBe("http://localhost/l");
    expect((await member.put("/api/links/host", { domainId: "x", sub: "go" })).status).toBe(403);
    expect((await owner.put("/api/links/host", { domainId: "nope", sub: "go" })).status).toBe(404);
  });
  it("is a plain 404 everywhere while the feature is off", async () => {
    const off = await makeTestApp({ ...BASE, TOOLS_FEATURES: "share" });
    const c = new Client(off.app);
    await c.signup("off@x.test", "Off", "Off Co");
    expect((await c.get("/api/links")).status).toBe(404);
    expect((await off.app.request("/l/anything", { headers: { host: "localhost" } })).status).toBe(404);
    expect((await off.app.request("/bio/anything", { headers: { host: "localhost" } })).status).toBe(404);
  });
});
