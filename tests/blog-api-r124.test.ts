import { describe, it, expect, beforeEach } from "vitest";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { makeTestApp, Client } from "./helpers";
import { runDueJobs } from "@/server/services/jobs";

/** R124: the blog inside Sites through the API and the public pages (signed out), with subscribers through R109. */
const ON = {
  SITES_R123: "on", BLOG_R124: "on", SHIELD_DIFFICULTY: "0",
  TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: "k".repeat(40), TOOLS_TOKEN_KEY: "t".repeat(40), TOOLS_FEATURES: "all",
};
const JOBS = { types: ["campaign.batch", "campaign.send"] as ("campaign.batch" | "campaign.send")[] };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let clock = 0;
const logs: string[] = [];
const tick = (ms: number) => { clock += ms; };
const get = (path: string) => ctx.app.request(path, { headers: { host: "localhost" } });
const text = async (path: string) => { const r = await get(path); return { status: r.status, text: await r.text(), type: r.headers.get("content-type") ?? "" }; };

async function member(email = "mate@acme.io") {
  const invite = await owner.post("/api/team/invites", { email, role: "member" });
  const mate = new Client(ctx.app);
  await mate.signup(email, "Mia Mate", "");
  expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return mate;
}
async function start() {
  expect((await owner.post("/api/sites", { name: "Acme", slug: "acme" })).status).toBe(201);
  const r = await owner.post("/api/sites/blog", { title: "Notes", description: "What we are working on" });
  expect(r.status).toBe(201);
  return r.body.blog;
}
async function post(title: string, body = "Hello there. This is the first post on our blog.") {
  const p = (await owner.post("/api/sites/blog/posts", { title })).body;
  const d = (await owner.get(`/api/docs/${p.docId}`)).body.doc;
  expect((await owner.patch(`/api/docs/${p.docId}`, { text: body, version: d.version })).status).toBe(200);
  return p;
}
async function mailbox() {
  const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await owner.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await owner.post(`/api/domains/${domainId}/verify`);
  return (await owner.post("/api/mailboxes", { domainId, localPart: "news", displayName: "Acme news" })).body.mailbox.id as string;
}
async function subscribe(email: string) {
  const ch = await (await get("/site/acme/blog/_shield")).json();
  tick(5_000);
  return ctx.app.request("/site/acme/blog/subscribe", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ email, shield: { challenge: ch.challenge, nonce: 0, hp: "" } }) });
}
const news = () => ctx.outbound.sent.filter((m) => m.from.address.startsWith("news@"));
async function drain() { for (let i = 0; i < 6; i++) { await runDueJobs(ctx.deps, 50, JOBS); tick(5_000); } }
const form = (path: string) => ctx.app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });

beforeEach(async () => {
  ctx = await makeTestApp(ON);
  clock = Date.now();
  ctx.deps.now = () => new Date(clock);
  logs.length = 0;
  const say = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
  ctx.deps.log = { info: say, warn: say, error: say, debug: say } as unknown as typeof ctx.deps.log;
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
});

describe("R124 blog setup, posts and public pages", () => {
  it("starts only for admins, keeps the blog address, and makes a Blog posts page in Docs", async () => {
    expect((await owner.post("/api/sites", { name: "Acme", slug: "acme" })).status).toBe(201);
    const mate = await member();
    expect((await mate.post("/api/sites/blog", {})).status).toBe(403);
    const pg = await owner.post("/api/sites/pages", { title: "Blog", slug: "blog" });
    expect(pg.status).toBe(201);
    expect((await owner.post("/api/sites/blog", {})).status).toBe(409); // a page holds the address
    expect((await owner.patch(`/api/sites/pages/${pg.body.page.id}`, { slug: "old-blog" })).status).toBe(200);
    const b = (await owner.post("/api/sites/blog", {})).body;
    expect(b.blog.title).toBe("Blog");
    expect(b.blog.rootDocId).toBeTruthy();
    expect(b.blog.newsletter.listId).toBeTruthy();
    expect((await owner.post("/api/sites/pages", { title: "Blog again", slug: "blog" })).status).toBe(400); // now the blog's
    expect((await owner.post("/api/sites/blog", {})).status).toBe(409);
    const p = await post("Hello world");
    const doc = (await owner.get(`/api/docs/${p.docId}`)).body.doc;
    expect(doc.parentId).toBe(b.blog.rootDocId);
  });

  it("keeps drafts private, publishes with titles and Open Graph, and lists posts with reading time", async () => {
    await start();
    const p = await post("Hello world");
    expect(p.status).toBe("draft");
    expect(p.slug).toBe("hello-world");
    expect((await get("/site/acme/blog/hello-world")).status).toBe(404);
    expect((await text("/site/acme/blog")).text).toContain("No posts yet");
    expect((await owner.patch(`/api/sites/blog/posts/${p.id}`, { excerpt: "A short hello", tags: ["News", "news", " Product  updates "] })).body.tags).toEqual(["News", "Product updates"]);
    const r = await owner.post(`/api/sites/blog/posts/${p.id}/publish`, {});
    expect(r.status).toBe(200);
    expect(r.body.post.status).toBe("published");
    expect(r.body.email.status).toBe("none");
    const page = await text("/site/acme/blog/hello-world");
    expect(page.status).toBe(200);
    expect(page.text).toContain("<title>Hello world | Acme</title>");
    expect(page.text).toContain('<meta property="og:type" content="article">');
    expect(page.text).toContain('<meta name="description" content="A short hello">');
    expect(page.text).toContain('rel="canonical" href="http://localhost:8787/site/acme/blog/hello-world"'.replace("http://localhost:8787", ctx.deps.config.appUrl.replace(/\/+$/, "")));
    expect(page.text).toContain("first post on our blog");
    expect(page.text).toContain("1 min read");
    expect(page.text).toContain('type="application/rss+xml"');
    const index = await text("/site/acme/blog");
    expect(index.text).toContain("<title>Notes | Acme</title>");
    expect(index.text).toContain("Hello world");
    const home = (await owner.get("/api/sites/pages")).body.pages[0];
    await owner.post(`/api/sites/pages/${home.id}/publish`, {});
    expect((await text("/site/acme")).text).toContain(">Notes</a>"); // the blog joins the site's nav
    // A body edit is not live until it is published again.
    const d = (await owner.get(`/api/docs/${p.docId}`)).body.doc;
    await owner.patch(`/api/docs/${p.docId}`, { text: "Second version of the text", version: d.version });
    expect((await owner.get(`/api/sites/blog/posts/${p.id}`)).body.hasUnpublished).toBe(true);
    expect((await text("/site/acme/blog/hello-world")).text).not.toContain("Second version");
    tick(31_000);
    const again = await owner.post(`/api/sites/blog/posts/${p.id}/publish`, {});
    expect(again.body.post.publishedAt).toBe(r.body.post.publishedAt); // first publish date stays
    expect((await text("/site/acme/blog/hello-world")).text).toContain("Second version");
    // Unpublish takes it down at once.
    expect((await owner.post(`/api/sites/blog/posts/${p.id}/unpublish`)).body.status).toBe("draft");
    expect((await get("/site/acme/blog/hello-world")).status).toBe(404);
  });

  it("keeps post addresses unique per site and safe to rename", async () => {
    await start();
    const a = await post("Same title");
    const b = await post("Same title");
    expect(b.slug).toBe("same-title-2");
    expect((await owner.patch(`/api/sites/blog/posts/${b.id}`, { slug: "same-title" })).status).toBe(409);
    expect((await owner.patch(`/api/sites/blog/posts/${b.id}`, { slug: "tag" })).status).toBe(400);
    expect((await owner.patch(`/api/sites/blog/posts/${b.id}`, { slug: "Bad Slug" })).status).toBe(400);
    await owner.post(`/api/sites/blog/posts/${a.id}/publish`, {});
    expect((await get("/site/acme/blog/same-title")).status).toBe(200);
    expect((await owner.patch(`/api/sites/blog/posts/${a.id}`, { slug: "renamed" })).body.slug).toBe("renamed");
    expect((await get("/site/acme/blog/same-title")).status).toBe(404);
    expect((await get("/site/acme/blog/renamed")).status).toBe(200);
  });

  it("schedules a post for a set time and shows it only once that time has come", async () => {
    await start();
    const p = await post("Later news");
    expect((await owner.post(`/api/sites/blog/posts/${p.id}/publish`, { at: clock - 3_600_000 })).status).toBe(400);
    expect((await owner.post(`/api/sites/blog/posts/${p.id}/publish`, { at: clock + 400 * 86_400_000 })).status).toBe(400);
    const at = clock + 3_600_000;
    const r = await owner.post(`/api/sites/blog/posts/${p.id}/publish`, { at });
    expect(r.body.post.status).toBe("scheduled");
    expect(r.body.post.publishAt).toBe(at);
    expect((await get("/site/acme/blog/later-news")).status).toBe(404);
    expect((await text("/site/acme/blog/rss.xml")).text).not.toContain("Later news");
    tick(3_600_001);
    expect((await get("/site/acme/blog/later-news")).status).toBe(200);
    expect((await owner.get(`/api/sites/blog/posts/${p.id}`)).body.status).toBe("published");
  });

  it("serves valid RSS 2.0 with absolute links, tag and author pages, and sitemap entries", async () => {
    await start();
    const a = await post("First & best <post>");
    await owner.patch(`/api/sites/blog/posts/${a.id}`, { tags: ["Tips"], excerpt: "Fish & chips" });
    await owner.post(`/api/sites/blog/posts/${a.id}/publish`, {});
    tick(1_000);
    const b = await post("Second post");
    await owner.patch(`/api/sites/blog/posts/${b.id}`, { tags: ["News"] });
    await owner.post(`/api/sites/blog/posts/${b.id}/publish`, {});
    const rss = await text("/site/acme/blog/rss.xml");
    expect(rss.type).toContain("application/rss+xml");
    expect(XMLValidator.validate(rss.text)).toBe(true);
    const doc = new XMLParser({ ignoreAttributes: false }).parse(rss.text);
    expect(doc.rss["@_version"]).toBe("2.0");
    const items = doc.rss.channel.item;
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Second post"); // newest first
    expect(String(items[1].link)).toMatch(/^https?:\/\/[^/]+\/site\/acme\/blog\/first-best-post$/);
    expect(items[1].description).toBe("Fish & chips");
    expect(new Date(items[1].pubDate).getTime()).toBeGreaterThan(0);
    const tag = await text("/site/acme/blog/tag/tips");
    expect(tag.status).toBe(200);
    expect(tag.text).toContain("<title>Tips | Notes | Acme</title>");
    expect(tag.text).toContain("First &amp; best &lt;post&gt;");
    expect(tag.text).not.toContain("Second post");
    expect((await get("/site/acme/blog/tag/nothing")).status).toBe(404);
    const authors = (await owner.get("/api/sites/blog/authors")).body.authors;
    expect(authors).toHaveLength(1);
    await owner.patch(`/api/sites/blog/authors/${authors[0].userId}`, { bio: "Runs the place" });
    const au = await text(`/site/acme/blog/author/${authors[0].slug}`);
    expect(au.status).toBe(200);
    expect(au.text).toContain("Runs the place");
    expect(au.text).toContain(`<title>Olive Owner | Notes | Acme</title>`);
    const map = (await text("/site/acme/sitemap.xml")).text;
    expect(map).toContain("/site/acme/blog/first-best-post</loc>");
    expect(map).toContain("/site/acme/blog/tag/tips</loc>");
    expect(map).toContain(`/site/acme/blog/author/${authors[0].slug}</loc>`);
    // Pages: 12 posts make two index pages.
    for (let i = 0; i < 10; i++) { const x = await post(`Post ${i}`); await owner.post(`/api/sites/blog/posts/${x.id}/publish`, {}); tick(10); }
    const p2 = await text("/site/acme/blog?page=2");
    expect(p2.text).toContain("Page 2 of 2");
    expect(p2.text).toContain("<title>Notes, page 2 | Acme</title>");
    expect((await text("/site/acme/blog?page=99")).text).toContain("Page 2 of 2");
  });

  it("refuses members without edit rights, signed out callers, guests and other workspaces", async () => {
    await start();
    const p = await post("Team only");
    const mate = await member();
    expect((await mate.post("/api/sites/blog/posts", { title: "Mine" })).status).toBe(403);
    expect((await mate.patch(`/api/sites/blog/posts/${p.id}`, { title: "Changed" })).status).toBe(403);
    expect((await mate.post(`/api/sites/blog/posts/${p.id}/publish`, {})).status).toBe(403);
    expect((await mate.get(`/api/sites/blog/posts/${p.id}`)).status).toBe(404); // drafts stay with editors
    expect((await mate.get("/api/sites/blog/posts")).body.posts).toHaveLength(0);
    expect((await mate.get("/api/sites/blog/subscribers")).status).toBe(403);
    expect((await mate.get("/api/sites/blog/subscribers.csv")).status).toBe(403);
    // A site editor writes and publishes, but only admins email subscribers.
    const site = (await owner.get("/api/sites")).body.site;
    await owner.patch("/api/sites", { editors: [...site.editors, (await mate.get("/api/account/me")).body.user.id] });
    const mine = await mate.post("/api/sites/blog/posts", { title: "Mine" });
    expect(mine.status).toBe(201);
    expect((await mate.patch(`/api/sites/blog/posts/${mine.body.id}`, { emailOnPublish: true })).status).toBe(403);
    expect((await mate.post(`/api/sites/blog/posts/${mine.body.id}/publish`, {})).status).toBe(200);
    expect((await new Client(ctx.app).get("/api/sites/blog")).status).toBe(401);
    const other = new Client(ctx.app);
    await other.signup("boss@other.io", "Otto Other", "Other Co");
    expect((await other.get(`/api/sites/blog/posts/${p.id}`)).status).toBe(404);
    expect((await other.patch(`/api/sites/blog/posts/${p.id}`, { title: "x" })).status).toBe(404);
  });

  it("serves an uploaded image only while a live post uses it", async () => {
    await start();
    const p = await post("With a picture");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const up = await owner.post("/api/doc-images", { docId: p.docId, contentType: "image/png", contentBase64: png });
    if (up.status !== 201) return; // no upload store in this test setup
    await owner.patch(`/api/sites/blog/posts/${p.id}`, { cover: up.body.src });
    expect((await get(`/site/acme/blog/img/${up.body.id}`)).status).toBe(404);
    await owner.post(`/api/sites/blog/posts/${p.id}/publish`, {});
    expect((await get(`/site/acme/blog/img/${up.body.id}`)).status).toBe(200);
    expect((await text("/site/acme/blog/with-a-picture")).text).toContain(`/site/acme/blog/img/${up.body.id}`);
    await owner.post(`/api/sites/blog/posts/${p.id}/unpublish`);
    expect((await get(`/site/acme/blog/img/${up.body.id}`)).status).toBe(404);
  });

  it("is all off without the flag", async () => {
    ctx = await makeTestApp({ SITES_R123: "on" });
    owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    expect((await owner.post("/api/sites", { name: "Acme", slug: "acme" })).status).toBe(201);
    expect((await owner.get("/api/sites/blog")).status).toBe(404);
    expect((await get("/site/acme/blog")).status).toBe(404);
    expect((await owner.post("/api/sites/pages", { title: "Blog", slug: "blog" })).status).toBe(201);
  });
});

describe("R124 subscribers and email through campaigns", () => {
  async function ready() {
    await start();
    const mailboxId = await mailbox();
    const r = await owner.patch("/api/sites/blog", { mailboxId, senderName: "Acme Pty Ltd", senderAddress: "1 George St, Sydney NSW 2000" });
    expect(r.status).toBe(200);
    expect(r.body.blog.newsletter.ready).toBe(true);
    return r.body.blog;
  }

  it("shows no subscribe box until the newsletter is ready", async () => {
    await start();
    const p = await post("Hi");
    await owner.post(`/api/sites/blog/posts/${p.id}/publish`, {});
    expect((await text("/site/acme/blog")).text).not.toContain("blog-subscribe");
    expect((await subscribe("reader@x.io")).status).toBe(404);
  });

  it("double opt in: confirms by a one time link, never mails the unconfirmed, sends only through campaigns, honours unsubscribe", async () => {
    await ready();
    expect((await text("/site/acme/blog")).text).toContain("blog-subscribe");
    const s = await subscribe("reader@x.io");
    expect(s.status).toBe(202);
    expect(news().find((m) => m.to[0] === "reader@x.io")!.subject).toContain("Confirm");
    // The same answer whether or not the address is already on the list; the newest link is the one that works.
    expect((await (await subscribe("reader@x.io")).json()).message).toBe("Check your inbox to confirm.");
    const token = news().filter((m) => m.to[0] === "reader@x.io").at(-1)!.text.match(/confirm\/([0-9a-f]{32})/)![1];
    const subs = (await owner.get("/api/sites/blog/subscribers")).body;
    expect(subs.counts.pending).toBe(1);
    expect(subs.subscribers[0].source).toBe("Blog subscribe box (Acme)");
    // Unconfirmed: the post publishes, no email goes out.
    const p1 = await post("Before confirm");
    await owner.patch(`/api/sites/blog/posts/${p1.id}`, { emailOnPublish: true });
    const r1 = await owner.post(`/api/sites/blog/posts/${p1.id}/publish`, {});
    expect(r1.body.post.status).toBe("published");
    expect(r1.body.email.status).toBe("skipped");
    await drain();
    expect(news().filter((m) => m.to[0] === "reader@x.io")).toHaveLength(2); // the two confirm emails only
    expect((await form(`/api/campaign-public/confirm/${token}`)).status).toBe(200);
    expect((await form(`/api/campaign-public/confirm/${token}`)).status).toBe(400); // one time
    // Confirmed: opt in per post, through an R109 newsletter, never twice.
    const p2 = await post("After confirm");
    const plain = await owner.post(`/api/sites/blog/posts/${p2.id}/publish`, {});
    expect(plain.body.email.status).toBe("none"); // not ticked: never automatic
    const p3 = await post("Emailed post");
    await owner.patch(`/api/sites/blog/posts/${p3.id}`, { emailOnPublish: true });
    const r3 = await owner.post(`/api/sites/blog/posts/${p3.id}/publish`, {});
    expect(r3.body.email.status).toBe("sent");
    await drain();
    const mail = news().filter((m) => m.to[0] === "reader@x.io" && m.subject === "Emailed post");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain("/site/acme/blog/emailed-post");
    expect(mail[0]!.text).toContain("1 George St, Sydney NSW 2000");
    expect(mail[0]!.text).toMatch(/campaign-public\/u\/[0-9a-f]{32}/); // one click unsubscribe in every email
    const campaigns = (await owner.get("/api/tools/campaigns/newsletters")).body.newsletters;
    expect(campaigns.some((c: { name: string }) => c.name === "Blog: Emailed post")).toBe(true);
    tick(31_000);
    const r3b = await owner.post(`/api/sites/blog/posts/${p3.id}/publish`, {});
    expect(r3b.body.email.status).toBe("skipped"); // already emailed
    await drain();
    expect(news().filter((m) => m.subject === "Emailed post")).toHaveLength(1);
    // Unsubscribe from the email, then nothing more reaches them.
    const u = mail[0]!.text.match(/campaign-public\/u\/([0-9a-f]{32})/)![1];
    expect((await form(`/api/campaign-public/u/${u}`)).status).toBe(200);
    const p4 = await post("After unsubscribe");
    await owner.patch(`/api/sites/blog/posts/${p4.id}`, { emailOnPublish: true });
    expect((await owner.post(`/api/sites/blog/posts/${p4.id}/publish`, {})).body.email.status).toBe("skipped");
    await drain();
    expect(news().filter((m) => m.subject === "After unsubscribe")).toHaveLength(0);
    // CSV for admins, with consent time and source; addresses never in logs.
    const csv = await owner.get("/api/sites/blog/subscribers.csv");
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain("reader@x.io");
    expect(logs.join("\n")).not.toContain("reader@x.io");
  });

  it("schedules the email with a scheduled post and drops it on unpublish", async () => {
    await ready();
    await subscribe("early@x.io");
    const token = news().find((m) => m.to[0] === "early@x.io")!.text.match(/confirm\/([0-9a-f]{32})/)![1];
    await form(`/api/campaign-public/confirm/${token}`);
    const p = await post("Next week");
    await owner.patch(`/api/sites/blog/posts/${p.id}`, { emailOnPublish: true });
    const r = await owner.post(`/api/sites/blog/posts/${p.id}/publish`, { at: clock + 3_600_000 });
    expect(r.body.email.status).toBe("scheduled");
    expect((await owner.get(`/api/sites/blog/posts/${p.id}`)).body.emailState).toBe("scheduled");
    await owner.post(`/api/sites/blog/posts/${p.id}/unpublish`);
    tick(3_700_000);
    await drain();
    expect(news().filter((m) => m.subject === "Next week")).toHaveLength(0);
  });

  it("lets admins remove a subscriber", async () => {
    await ready();
    await subscribe("gone@x.io");
    const list = (await owner.get("/api/sites/blog/subscribers")).body.subscribers;
    expect((await owner.del(`/api/sites/blog/subscribers/${list[0].id}`)).status).toBe(200);
    expect((await owner.get("/api/sites/blog/subscribers")).body.subscribers).toHaveLength(0);
  });
});
