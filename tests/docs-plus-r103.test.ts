import { describe, it, expect, beforeAll } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { checkClipUrl, fetchPublicPage, isPrivateIp, ClipError } from "@/server/services/docs-plus/url-guard";
import { extractReadable, parseHtml, textOf, decodeEntities } from "@/server/services/docs-plus/extract";
import { applyFixes, checkSpelling, linkKey, matchCase, mentionedIds, normalizeTags, SPELL_LANGUAGES, withScheme } from "@/shared/docs-plus";

/** R103 Docs plus: SSRF guard, extraction, spelling, link library, clipper and comment permissions. */

const ARTICLE = `<!doctype html><html lang="en"><head><title>Ignored title tag</title>
<meta property="og:title" content="How we roast coffee"><meta property="og:site_name" content="Harbour Journal">
<meta name="description" content="A short guide to roasting."><meta name="author" content="Mia Rao">
<script>window.evil = 1</script><style>.x{}</style></head><body>
<header class="site-header"><nav><a href="/">Home</a><a href="/shop">Shop</a></nav></header>
<div class="cookie-banner">We use cookies <button>OK</button></div>
<main><article class="post"><h1>How we roast coffee</h1>
<p>Roasting turns green beans into the brown coffee we know. It takes about twelve minutes and a lot of attention to sound and smell.</p>
<h2>First crack</h2><p>At around 196 degrees the beans <b>crack</b> and <em>expand</em>. See <a href="/guide">our guide</a> or <a href="javascript:alert(1)">this</a>.</p>
<ul><li>Light roast keeps more acidity and fruit notes in the cup.</li><li>Dark roast tastes of chocolate and smoke for most people.</li></ul>
<blockquote><p>Listen to the beans, they tell you when they are ready.</p></blockquote>
<pre>temp = 196
time = 12</pre>
<img src="https://cdn.example.org/x.png" onerror="alert(1)"><iframe src="https://evil.example.org"></iframe>
<p>Rest the beans for two days before brewing so the gas can escape and the flavour settles.</p></article>
<aside class="related"><p>Related posts that are long enough to count as a paragraph of text but should be dropped.</p></aside></main>
<footer><p>Copyright Harbour 2026 and a long footer paragraph that should never be part of the clip.</p></footer></body></html>`;

const dohAnswer = (ips: string[]) => new Response(JSON.stringify({ Status: 0, Answer: ips.map((data) => ({ type: data.includes(":") ? 28 : 1, data })) }), { headers: { "content-type": "application/dns-json" } });
const DNS: Record<string, string[]> = { "harbour.example.org": ["93.184.216.34"], "rebind.example.org": ["10.0.0.5"], "v6.example.org": ["fd00::1"], "plain.example.org": ["93.184.216.35"], "big.example.org": ["93.184.216.36"], "hop.example.org": ["93.184.216.37"] };
const calls: string[] = [];
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  calls.push(url);
  const u = new URL(url);
  if (u.hostname === "cloudflare-dns.com") {
    const name = u.searchParams.get("name")!;
    const type = u.searchParams.get("type");
    const ips = (DNS[name] ?? []).filter((ip) => (type === "AAAA") === ip.includes(":"));
    return dohAnswer(ips);
  }
  if (u.hostname === "harbour.example.org") return new Response(ARTICLE, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (u.hostname === "plain.example.org") return new Response("Hello world.\n\nThis is a plain text page with enough words to be saved as a clip, and more words here to pass the bar.", { headers: { "content-type": "text/plain" } });
  if (u.hostname === "big.example.org") return new Response("x".repeat(3_000_000), { headers: { "content-type": "text/html" } });
  if (u.hostname === "hop.example.org") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
}) as typeof fetch;

describe("SSRF guard", () => {
  it("blocks private, loopback, link local, metadata and odd forms", () => {
    for (const u of ["http://127.0.0.1/", "http://localhost/", "http://10.1.2.3/", "http://172.16.0.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/", "http://0.0.0.0/", "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
      "http://2130706433/", "http://0x7f.1/", "http://017700000001/", "http://intranet/", "http://db.internal/", "http://printer.local/", "http://224.0.0.1/",
      "http://[64:ff9b::a00:1]/", "http://[2002:c0a8:101::1]/"]) {
      expect(() => checkClipUrl(u), u).toThrow(ClipError);
    }
  });
  it("refuses other schemes, credentials and ports", () => {
    for (const u of ["file:///etc/passwd", "ftp://example.org/", "gopher://x.org/", "javascript:alert(1)", "http://user:pw@example.org/", "http://example.org:8080/", "data:text/html,hi"]) {
      expect(() => checkClipUrl(u), u).toThrow(ClipError);
    }
  });
  it("lets public addresses through", () => {
    expect(checkClipUrl("https://harbour.example.org/post").hostname).toBe("harbour.example.org");
    expect(checkClipUrl("http://93.184.216.34/").hostname).toBe("93.184.216.34");
    expect(checkClipUrl("https://[2606:4700::1111]/").hostname).toBe("[2606:4700::1111]");
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("2606:4700::1111")).toBe(false);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
    expect(isPrivateIp("not an ip")).toBe(true);
  });
  it("checks every DNS answer, every redirect hop, the size cap and the type", async () => {
    await expect(fetchPublicPage({ fetch: fakeFetch }, "https://rebind.example.org/")).rejects.toMatchObject({ code: "blocked_address" });
    await expect(fetchPublicPage({ fetch: fakeFetch }, "https://v6.example.org/")).rejects.toMatchObject({ code: "blocked_address" });
    await expect(fetchPublicPage({ fetch: fakeFetch }, "https://hop.example.org/")).rejects.toMatchObject({ code: "blocked_address" });
    await expect(fetchPublicPage({ fetch: fakeFetch }, "https://big.example.org/")).rejects.toMatchObject({ code: "too_large" });
    await expect(fetchPublicPage({ fetch: fakeFetch }, "https://nowhere.example.org/")).rejects.toMatchObject({ code: "dns_failed" });
    expect(calls.some((u) => u.includes("127.0.0.1"))).toBe(false);
    expect(calls.some((u) => u.includes("rebind.example.org/") && !u.includes("dns-query"))).toBe(false);
    const ok = await fetchPublicPage({ fetch: fakeFetch }, "https://harbour.example.org/post");
    expect(ok.contentType).toContain("text/html");
  });
  it("stops at the deadline", async () => {
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("dns-query")) return dohAnswer(url.includes("type=A&") || url.endsWith("type=A") ? ["93.184.216.34"] : []);
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
    }) as typeof fetch;
    await expect(fetchPublicPage({ fetch: slow }, "https://harbour.example.org/", { timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("extraction", () => {
  it("keeps the article, drops chrome, scripts and unsafe links", () => {
    const x = extractReadable(ARTICLE, "https://harbour.example.org/2026/roast");
    expect(x.title).toBe("How we roast coffee");
    expect(x.siteName).toBe("Harbour Journal");
    expect(x.description).toBe("A short guide to roasting.");
    expect(x.byline).toBe("Mia Rao");
    expect(x.lang).toBe("en");
    const json = JSON.stringify(x.content);
    expect(json).toContain("First crack");
    expect(json).toContain("https://harbour.example.org/guide");
    expect(json).not.toMatch(/javascript:|window\.evil|cookies|Shop|Copyright|Related posts|<script|onerror|iframe/);
    const types = (x.content.content ?? []).map((n) => n.type);
    expect(types).toEqual(expect.arrayContaining(["heading", "paragraph", "bulletList", "blockquote", "codeBlock"]));
    expect(types.filter((t) => t === "heading")).toHaveLength(1); // the h1 that repeats the title is dropped
    expect(json).toContain('"bold"');
    expect(x.words).toBeGreaterThan(50);
  });
  it("handles plain text, entities and broken markup", () => {
    expect(decodeEntities("Tom &amp; Jerry &#8217;s &#x41; &bogus;")).toBe("Tom & Jerry \u2019s A &bogus;");
    const root = parseHtml("<div><p>One<p>Two</div></span><li>x");
    expect(textOf(root)).toContain("OneTwo");
    const t = extractReadable("Line one.\n\nLine two.", "https://x.org/a.txt", "text/plain");
    expect(t.content.content).toHaveLength(2);
    const empty = extractReadable("<html><body><nav>menu</nav></body></html>", "https://x.org/");
    expect(empty.words).toBe(0);
  });
});

describe("spelling and links rules", () => {
  it("offers 20 languages and fixes common typos keeping case", () => {
    expect(SPELL_LANGUAGES).toHaveLength(20);
    expect(new Set(SPELL_LANGUAGES.map((l) => l.code)).size).toBe(20);
    const text = "Teh plan: we recieve the invoce tommorow. See `teh` and https://x.org/teh";
    const issues = checkSpelling(text);
    expect(issues.map((i) => i.suggestion)).toEqual(["The", "receive", "invoice", "tomorrow"]);
    expect(applyFixes(text, issues)).toBe("The plan: we receive the invoice tomorrow. See `teh` and https://x.org/teh");
    expect(checkSpelling(text, "en-AU", ["recieve"]).map((i) => i.word)).not.toContain("recieve");
    expect(checkSpelling(text, "de-DE")).toEqual([]);
    expect(matchCase("TEH", "the")).toBe("THE");
    expect(checkSpelling("The quick brown fox jumps over the lazy dog.")).toEqual([]);
  });
  it("normalises tags and link keys", () => {
    expect(normalizeTags(["#Design", " design ", "Research  notes", "", 5])).toEqual(["design", "research notes"]);
    expect(normalizeTags("a, b,a")).toEqual(["a", "b"]);
    expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(12);
    expect(linkKey("HTTPS://Example.org/Path/?utm_source=x&b=2&a=1#top")).toBe("https://example.org/Path?a=1&b=2");
    expect(linkKey("javascript:alert(1)")).toBeNull();
    expect(withScheme("example.org/x")).toBe("https://example.org/x");
    expect(mentionedIds("Thanks @Kiran Rao and @kiran", [{ id: "u1", name: "Kiran Rao" }, { id: "u2", name: "Kiran" }])).toEqual(["u1", "u2"]);
    expect(mentionedIds("mail a@kiranx", [{ id: "u2", name: "Kiran" }])).toEqual([]);
  });
});

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
let member: Client;
let admin: Client;
let ownerId = "";

async function addMember(role: "member" | "admin") {
  const invite = await owner.post("/api/team/invites", { email: `${role}@harbour.test`, role });
  const m = new Client(ctx.app);
  await m.signup(`${role}@harbour.test`, role === "admin" ? "Ada Admin" : "Kiran Rao", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return m;
}

describe("link library and clipper (API)", () => {
  beforeAll(async () => {
    ctx = await makeTestApp({ DOCS_PLUS_R103: "on", TRUST_PROXY: "true" }, { fetch: fakeFetch });
    owner = new Client(ctx.app);
    await owner.signup("olive@harbour.test", "Olive Owner", "Harbour Coffee");
    ownerId = (await owner.get("/api/account/me")).body.user.id;
    member = await addMember("member");
    admin = await addMember("admin");
  });

  it("is off without the flag", async () => {
    const off = await makeTestApp({}, { fetch: fakeFetch });
    const c = new Client(off.app);
    await c.signup("x@harbour.test", "X", "X");
    expect((await c.get("/api/docs-plus/links")).status).toBe(404);
    expect((await c.get("/api/config")).body.docsPlus ?? false).toBe(false);
  });

  it("saves, dedupes, tags, searches and removes links with the right people", async () => {
    expect((await member.get("/api/docs-plus/links")).body.links).toEqual([]);
    const a = await member.post("/api/docs-plus/links", { url: "harbour.example.org/post?utm_source=x", tags: ["Coffee", "#guides"] });
    expect(a.status).toBe(201);
    expect(a.body.link).toMatchObject({ url: "https://harbour.example.org/post", title: "How we roast coffee", site: "Harbour Journal", tags: ["coffee", "guides"], canRemove: true });
    const again = await owner.post("/api/docs-plus/links", { url: "https://harbour.example.org/post#x", tags: ["roasting"] });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ existing: true, link: { id: a.body.link.id, tags: ["coffee", "guides", "roasting"] } });
    const priv = await member.post("/api/docs-plus/links", { url: "http://intranet/wiki", tags: "team" });
    expect(priv.status).toBe(201);
    expect(priv.body.link.title).toBe("intranet"); // saved as a bookmark, never fetched
    expect(calls.some((u) => u.startsWith("http://intranet"))).toBe(false);
    expect((await member.post("/api/docs-plus/links", { url: "javascript:alert(1)" })).status).toBe(422);
    expect((await member.get("/api/docs-plus/links?tag=coffee")).body.links).toHaveLength(1);
    expect((await member.get("/api/docs-plus/links?q=roast")).body.links).toHaveLength(1);
    expect((await member.get("/api/docs-plus/links/tags")).body.tags[0]).toMatchObject({ tag: "coffee", count: 1 });
    const patched = await admin.patch(`/api/docs-plus/links/${a.body.link.id}`, { tags: ["coffee"], note: "Read before Monday" });
    expect(patched.body.link).toMatchObject({ tags: ["coffee"], note: "Read before Monday" });
    // Removing: the saver, an owner or an admin; another member cannot.
    const ownerLink = (await owner.post("/api/docs-plus/links", { url: "https://plain.example.org/" })).body.link;
    expect((await member.get("/api/docs-plus/links")).body.links.find((l: { id: string }) => l.id === ownerLink.id).canRemove).toBe(false);
    expect((await member.del(`/api/docs-plus/links/${ownerLink.id}`)).status).toBe(403);
    expect((await admin.del(`/api/docs-plus/links/${ownerLink.id}`)).status).toBe(200);
    expect((await member.del(`/api/docs-plus/links/${priv.body.link.id}`)).status).toBe(200);
    expect((await member.get("/api/docs-plus/links")).body.links).toHaveLength(1);
  });

  it("clips a public page into Web clips and refuses private ones", async () => {
    const r = await member.post("/api/docs-plus/clip", { url: "https://harbour.example.org/2026/roast", tags: ["coffee"] });
    expect(r.status).toBe(201);
    expect(r.body.doc.title).toBe("How we roast coffee");
    const doc = (await member.get(`/api/docs/${r.body.doc.id}`)).body.doc;
    expect(doc.text).toContain("Saved from Harbour Journal");
    expect(doc.text).toContain("First crack");
    expect(JSON.stringify(doc.content)).not.toContain("javascript:");
    const parent = (await member.get(`/api/docs/${r.body.doc.parentId}`)).body.doc;
    expect(parent.title).toBe("Web clips");
    expect(r.body.link).toMatchObject({ docId: r.body.doc.id, tags: ["coffee"] });
    // A second clip goes into the same collection; a chosen page works too.
    const second = await owner.post("/api/docs-plus/clip", { url: "https://plain.example.org/" });
    expect(second.body.doc.parentId).toBe(r.body.doc.parentId);
    const research = (await owner.post("/api/docs", { title: "Research", text: "" })).body.doc;
    const third = await owner.post("/api/docs-plus/clip", { url: "https://harbour.example.org/2026/roast?ref=2", parentId: research.id });
    expect(third.body.doc.parentId).toBe(research.id);
    expect((await member.get("/api/docs-plus/links?clipped=1")).body.links.length).toBeGreaterThanOrEqual(2);
    for (const bad of ["http://127.0.0.1/", "https://rebind.example.org/", "https://hop.example.org/", "http://169.254.169.254/"]) {
      const res = await member.post("/api/docs-plus/clip", { url: bad });
      expect(res.status, bad).toBe(422);
      expect(res.body.error.code).toBe("blocked_address");
    }
    expect((await member.post("/api/docs-plus/clip", { url: "https://big.example.org/" })).body.error.code).toBe("too_large");
    expect((await member.post("/api/docs-plus/clip", { url: "https://harbour.example.org/", parentId: "doc_nope" })).status).toBe(404);
  });
});

describe("comments on shared docs (member, admin, guest, visitor)", () => {
  let docId = "";
  let token = "";
  let linkId = "";
  let guest: Client;
  beforeAll(async () => {
    const p = (await owner.post("/api/projects", { name: "Client site", key: "CLI" })).body.project;
    docId = (await owner.post("/api/docs", { title: "Client brief", projectId: p.id, text: "The plan" })).body.doc.id;
    const inv = await owner.post("/api/guests", { projectId: p.id, email: "client@harbour.coffee", name: "Mia" });
    const gt = (inv.body.inviteUrl as string | undefined)?.split("/g/")[1] ?? JSON.stringify(ctx).match(/\/g\/([A-Za-z0-9_-]{20,})/)?.[1];
    guest = new Client(ctx.app);
    expect((await guest.post("/api/guest/accept", { token: gt })).status).toBe(200);
    const link = await owner.post("/api/share-links", { kind: "doc", targetId: docId });
    linkId = link.body.link.id;
    token = (link.body.link.url as string).split("/s/")[1];
    expect(link.body.link.comments).toBe("off");
  });

  it("team comments: members post, mention and edit their own; moderators hide; others cannot", async () => {
    const c1 = await member.post(`/api/docs-plus/docs/${docId}/comments`, { body: "Looks good @Olive Owner" });
    expect(c1.status).toBe(201);
    expect(c1.body.comment).toMatchObject({ thread: "team", status: "visible", mine: true, canEdit: true });
    const notes = (await owner.get("/api/notifications")).body;
    expect(JSON.stringify(notes)).toContain("mentioned you on Client brief");
    expect((await admin.patch(`/api/docs-plus/comments/${c1.body.comment.id}`, { body: "changed" })).status).toBe(403);
    expect((await member.patch(`/api/docs-plus/comments/${c1.body.comment.id}`, { body: "Looks great" })).body.comment.editedAt).toBeTruthy();
    expect((await member.patch(`/api/docs-plus/comments/${c1.body.comment.id}`, { status: "hidden" })).status).toBe(403);
    expect((await member.post(`/api/docs-plus/docs/${docId}/comments`, { body: "Public answer", thread: "public" })).status).toBe(403);
    expect((await member.post(`/api/docs-plus/docs/${docId}/comments`, { body: "   " })).status).toBe(422);
    expect((await member.post(`/api/docs-plus/docs/doc_missing/comments`, { body: "x" })).status).toBe(404);
    const list = (await member.get(`/api/docs-plus/docs/${docId}/comments`)).body;
    expect(list).toMatchObject({ canModerate: false, publicOn: false });
    expect(list.team).toHaveLength(1);
    expect((await admin.get(`/api/docs-plus/docs/${docId}/comments`)).body.canModerate).toBe(true);
    // The doc's maker moderates too.
    expect((await owner.get(`/api/docs-plus/docs/${docId}/comments`)).body.canModerate).toBe(true);
  });

  it("project guests read and add team comments on their project's docs only", async () => {
    const g = await guest.get(`/api/guest/r103/docs/${docId}/comments`);
    expect(g.status).toBe(200);
    expect(g.body.team.length).toBeGreaterThanOrEqual(1);
    const add = await guest.post(`/api/guest/r103/docs/${docId}/comments`, { body: "Can we change the colour?" });
    expect(add.status).toBe(201);
    expect(add.body.comment.author).toMatchObject({ type: "guest", name: "Mia" });
    const other = (await owner.post("/api/docs", { title: "Internal", text: "secret" })).body.doc.id;
    expect((await guest.get(`/api/guest/r103/docs/${other}/comments`)).status).toBe(404);
    expect((await guest.post(`/api/guest/r103/docs/${other}/comments`, { body: "x" })).status).toBe(404);
    expect((await new Client(ctx.app).get(`/api/guest/r103/docs/${docId}/comments`)).status).toBe(401);
  });

  it("share link visitors comment only when the link allows it; posts wait for review", async () => {
    const page = async () => (await ctx.app.request(`/s/${token}`, { headers: { host: "localhost", "x-forwarded-for": "10.9.9.9" } })).text();
    expect(await page()).not.toContain("data-r103=\"comment-form\"");
    const post = (body: Record<string, string>, ip = "10.9.9.9") => ctx.app.request(`/s/${token}/comments`, { method: "POST", headers: { host: "localhost", "x-forwarded-for": ip, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
    expect((await post({ name: "Eve", body: "spam" })).status).toBe(404);
    expect((await member.put(`/api/docs-plus/share/${linkId}`, { comments: true })).status).toBe(403);
    expect((await owner.put(`/api/docs-plus/share/${linkId}`, { comments: true })).body.comments).toBe("on");
    const html = await page();
    expect(html).toContain("data-r103=\"comment-form\"");
    expect(html).not.toContain("Looks great"); // team comments never show on the link
    expect(html).not.toContain("Can we change the colour");
    const ft = /name="ft" value="([^"]+)"/.exec(html)![1];
    expect((await post({ name: "Eve", body: "no token" })).status).toBe(400);
    const sent = await post({ ft, name: "Sam Visitor", email: "sam@visitor.test", body: "Lovely <b>plan</b>" });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toContain("sent=1");
    expect(await page()).not.toContain("Lovely"); // pending until approved
    const mod = (await owner.get(`/api/docs-plus/docs/${docId}/comments`)).body;
    expect(mod.pending).toBe(1);
    expect(mod.public[0]).toMatchObject({ status: "pending", author: { type: "visitor", name: "Sam Visitor", email: "sam@visitor.test" } });
    const plain = (await member.get(`/api/docs-plus/docs/${docId}/comments`)).body;
    expect(plain.public).toHaveLength(0); // a member who cannot moderate sees no pending posts
    expect((await member.patch(`/api/docs-plus/comments/${mod.public[0].id}`, { status: "visible" })).status).toBe(403);
    expect((await admin.patch(`/api/docs-plus/comments/${mod.public[0].id}`, { status: "visible" })).body.comment.status).toBe("visible");
    const after = await page();
    expect(after).toContain("Lovely &lt;b&gt;plan&lt;/b&gt;");
    expect(after).not.toContain("sam@visitor.test");
    expect((await owner.post(`/api/docs-plus/docs/${docId}/comments`, { body: "Thanks Sam", thread: "public" })).status).toBe(201);
    expect(await page()).toContain("Thanks Sam");
    // Honeypot and rate limit.
    expect((await post({ ft, name: "Bot", body: "buy", website: "x" })).status).toBe(303);
    expect((await owner.get(`/api/docs-plus/docs/${docId}/comments`)).body.pending).toBe(0);
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await post({ ft, name: "Flood", body: `n${i}` }, "10.7.7.7")).status;
    expect(last).toBe(429);
    // Turning comments off hides the form and refuses posts; a revoked link refuses too.
    await owner.put(`/api/docs-plus/share/${linkId}`, { comments: false });
    expect(await page()).not.toContain("comment-form");
    expect((await post({ ft, name: "Late", body: "x" }, "10.6.6.6")).status).toBe(404);
  });

  it("removal: authors and moderators only", async () => {
    const c = (await admin.post(`/api/docs-plus/docs/${docId}/comments`, { body: "Admin note" })).body.comment;
    expect((await member.del(`/api/docs-plus/comments/${c.id}`)).status).toBe(403);
    expect((await owner.del(`/api/docs-plus/comments/${c.id}`)).status).toBe(200);
    expect((await owner.get(`/api/docs-plus/docs/${docId}/comments`)).body.team.some((x: { id: string }) => x.id === c.id)).toBe(false);
    expect(ownerId).toBeTruthy();
  });
});
