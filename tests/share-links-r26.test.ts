import { describe, it, expect, beforeAll } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { createShareLink, initials, listShareLinks, publicShare, renderDocHtml, revokeShareLink, setShareLinksAllowed } from "@/server/services/suite/share-links";

/** R26 (MB-87): read only share links for docs and project boards. */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
let me: { user: { id: string; email: string; name: string }; organization: { id: string } };
let docId = "";
let projectId = "";
let otherDocId = "";

const tokenOf = (url: string) => url.split("/s/")[1];
const page = async (token: string, ip = "10.0.0.1") => {
  const res = await ctx.app.request(`/s/${token}`, { headers: { host: "localhost", "cf-connecting-ip": ip } });
  return { status: res.status, headers: res.headers, html: await res.text() };
};

beforeAll(async () => {
  ctx = await makeTestApp({ TRUST_PROXY: "true" });
  owner = new Client(ctx.app);
  await owner.signup("olive@harbour.test", "Olive Owner", "Harbour Coffee");
  me = (await owner.get("/api/account/me")).body;
  const content = {
    type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Launch plan" }] },
      { type: "paragraph", content: [
        { type: "text", text: "Ask " }, { type: "mention", attrs: { id: "usr_secret_id", label: "Kiran Rao" } },
        { type: "text", text: " about the ", marks: [{ type: "bold" }] },
        { type: "text", text: "roastery", marks: [{ type: "comment", attrs: { commentId: "cmt_hidden_thread" } }] },
        { type: "text", text: " and see " }, { type: "text", text: "the brief", marks: [{ type: "link", attrs: { href: "/app/docs/doc_internal_target" } }] },
        { type: "text", text: " or " }, { type: "text", text: "our site", marks: [{ type: "link", attrs: { href: "https://harbour.example/" } }] },
        { type: "text", text: " <script>alert(1)</script>" },
      ] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Pick beans" }] }] }] },
    ],
  };
  docId = (await owner.post("/api/docs", { title: "Client brief", content })).body.doc.id;
  projectId = (await owner.post("/api/projects", { name: "Website", key: "WEB" })).body.project.id;
  const field = await owner.post("/api/fields", { projectId, name: "Budget note", type: "text" });
  const fieldId = (field.body.field ?? field.body).id as string;
  const t = (await owner.post("/api/tasks", { projectId, title: "Design the home page", notes: "SECRET NOTES margin is 40%", assignee: `member:${me.user.id}`, labels: ["design"], due: "2026-11-03", fields: { [fieldId]: "PRIVATE FIELD VALUE" } })).body.task;
  await owner.post(`/api/tasks/${t.id}/comments`, { body: "INTERNAL COMMENT do not share" });
  await owner.post("/api/tasks", { projectId, title: "Write the about page", status: "doing" });
  const other = new Client(ctx.app);
  await other.signup("eve@else.test", "Eve Else", "Else Co");
  otherDocId = (await other.post("/api/docs", { title: "Eve's doc", text: "private" })).body.doc.id;
});

describe("share links (R26, MB-87)", () => {
  it("creates a doc link, stores only the token hash, renders it read only, then revokes it", async () => {
    const r = await owner.post("/api/share-links", { kind: "doc", targetId: docId });
    expect(r.status).toBe(201);
    const url = r.body.link.url as string;
    expect(url).toMatch(/^http:\/\/localhost[^/]*\/s\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(url);
    // Only the SHA-256 is stored: the token itself appears nowhere in the table.
    const raw = (ctx.db as unknown as { $client: { prepare: (q: string) => { all: () => Record<string, unknown>[] } } }).$client;
    const rows = raw.prepare("select * from share_links").all();
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    const { createHash } = await import("node:crypto");
    expect(rows[0].token_hash).toBe(createHash("sha256").update(token).digest("hex"));

    const p = await page(token);
    expect(p.status).toBe(200);
    expect(p.headers.get("cache-control")).toBe("private, max-age=0");
    expect(p.headers.get("x-robots-tag")).toContain("noindex");
    expect(p.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(p.html).toContain("Client brief");
    expect(p.html).toContain("Launch plan");
    expect(p.html).toContain("@Kiran Rao");
    expect(p.html).toContain("Shared by Harbour Coffee");
    expect(p.html).toContain('href="https://harbour.example/"');
    expect(p.html).toContain("the brief");
    for (const leak of ["usr_secret_id", "cmt_hidden_thread", "doc_internal_target", "/app/docs", "<script>alert", docId, me.organization.id]) expect(p.html).not.toContain(leak);

    // The list shows it (without the url) and the revoke stops it at once.
    const list = await owner.get(`/api/share-links?kind=doc&targetId=${docId}`);
    expect(list.body.links.map((l: { id: string }) => l.id)).toEqual([r.body.link.id]);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect((await owner.del(`/api/share-links/${r.body.link.id}`)).status).toBe(200);
    const gone = await page(token);
    expect(gone.status).toBe(404);
    expect(gone.html).toContain("This link is no longer active");
    expect((await owner.get(`/api/share-links?kind=doc&targetId=${docId}`)).body.links).toEqual([]);
    expect((await page("x".repeat(43))).status).toBe(404);
  });

  it("expires links and hides the workspace name when asked", async () => {
    const r = await owner.post("/api/share-links", { kind: "doc", targetId: docId, expiresInDays: 7, showWorkspaceName: false });
    const token = tokenOf(r.body.link.url);
    const p = await page(token);
    expect(p.status).toBe(200);
    expect(p.html).not.toContain("Harbour Coffee");
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + 8 * 86_400_000);
    try {
      expect((await page(token)).status).toBe(404);
      expect((await owner.get(`/api/share-links?kind=doc&targetId=${docId}`)).body.links).toEqual([]);
    } finally { ctx.deps.now = real; }
    expect((await owner.post("/api/share-links", { kind: "doc", targetId: docId, expiresInDays: 3 })).status).toBe(422);
  });

  it("a board link shows columns, titles, initials, due and labels, and never notes, comments or custom fields", async () => {
    const r = await owner.post("/api/share-links", { kind: "project_board", targetId: projectId });
    expect(r.status).toBe(201);
    const token = tokenOf(r.body.link.url);
    const payload = await publicShare(ctx.deps, token);
    expect(payload?.kind).toBe("project_board");
    const json = JSON.stringify(payload);
    for (const leak of ["SECRET NOTES", "INTERNAL COMMENT", "PRIVATE FIELD VALUE", "Budget note", me.user.id, me.user.email, projectId]) expect(json).not.toContain(leak);
    if (payload?.kind !== "project_board") throw new Error("board");
    const cards = payload.columns.flatMap((c) => c.cards);
    expect(cards.find((c) => c.title === "Design the home page")).toEqual({ title: "Design the home page", assignee: "OO", due: "2026-11-03", labels: ["design"] });
    expect(payload.columns.find((c) => c.cards.some((x) => x.title === "Write the about page"))).toBeTruthy();
    const p = await page(token);
    expect(p.status).toBe(200);
    for (const leak of ["SECRET NOTES", "INTERNAL COMMENT", "PRIVATE FIELD VALUE", "Budget note", me.user.email]) expect(p.html).not.toContain(leak);
    expect(p.html).toContain("Design the home page");
    expect(p.html).toContain("3 Nov");
  });

  it("refuses another workspace's ids, guests, read only keys and agent keys", async () => {
    expect((await owner.post("/api/share-links", { kind: "doc", targetId: otherDocId })).status).toBe(404);
    expect((await owner.post("/api/share-links", { kind: "project_board", targetId: docId })).status).toBe(404);
    const eve = new Client(ctx.app);
    await eve.login("eve@else.test");
    const mine = await owner.post("/api/share-links", { kind: "doc", targetId: docId });
    expect((await eve.del(`/api/share-links/${mine.body.link.id}`)).status).toBe(404);
    expect((await eve.get(`/api/share-links?kind=doc&targetId=${docId}`)).status).toBe(404);
    expect((await eve.get("/api/share-links")).body.links).toEqual([]);
    // Signed out and guests: no session, so 401.
    expect((await new Client(ctx.app).post("/api/share-links", { kind: "doc", targetId: docId })).status).toBe(401);
    const inv = await owner.post("/api/guests", { projectId, email: "client@harbour.example", name: "Mia" });
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const gtoken = sent.map((m) => m.text).reverse().find((x) => x.includes("/g/"))?.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1] ?? (inv.body.inviteUrl as string).split("/g/")[1];
    const guest = new Client(ctx.app);
    expect((await guest.post("/api/guest/accept", { token: gtoken })).status).toBe(200);
    expect((await guest.post("/api/share-links", { kind: "doc", targetId: docId })).status).toBe(401);
    expect((await guest.get("/api/share-links")).status).toBe(401);
    // The service refuses a guest, an agent and a read only key outright.
    const base = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "member" as const };
    await expect(createShareLink(ctx.deps, { ...base, guest: true }, { kind: "doc", targetId: docId })).rejects.toMatchObject({ status: 403 });
    await expect(createShareLink(ctx.deps, { ...base, agentId: "agt_x" }, { kind: "doc", targetId: docId })).rejects.toMatchObject({ status: 403 });
    await expect(createShareLink(ctx.deps, { ...base, scope: "read" }, { kind: "doc", targetId: docId })).rejects.toMatchObject({ status: 403 });
    await expect(revokeShareLink(ctx.deps, { ...base, scope: "read" }, mine.body.link.id)).rejects.toMatchObject({ status: 403 });
    // A member who can see the doc can make a link; only admins change the setting.
    expect((await createShareLink(ctx.deps, base, { kind: "doc", targetId: docId })).link.kind).toBe("doc");
    await expect(setShareLinksAllowed(ctx.deps, base, false)).rejects.toMatchObject({ status: 403 });
    // REST: a read only key lists but can't make or revoke; a full key can.
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret as string;
    const full = (await owner.post("/api/developer/keys", { name: "Full" })).body.secret as string;
    const v1 = async (key: string, method: string, path: string, b?: unknown) => {
      const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json" }, body: b !== undefined ? JSON.stringify(b) : undefined });
      return { status: res.status, body: await res.json() };
    };
    expect((await v1(ro, "GET", `/share-links?kind=doc&targetId=${docId}`)).status).toBe(200);
    expect((await v1(ro, "POST", "/share-links", { kind: "doc", targetId: docId })).status).toBe(403);
    expect((await v1(ro, "DELETE", `/share-links/${mine.body.link.id}`)).status).toBe(403);
    const made = await v1(full, "POST", "/share-links", { kind: "project_board", targetId: projectId, expiresInDays: 30 });
    expect(made.status).toBe(201);
    expect(made.body.link.url).toContain("/s/");
    expect((await v1(full, "POST", "/share-links", { kind: "doc", targetId: otherDocId })).status).toBe(404);
    expect((await v1(full, "DELETE", `/share-links/${made.body.link.id}`)).status).toBe(200);
    expect((await page(tokenOf(made.body.link.url))).status).toBe(404);
  });

  it("an admin can turn every link off and back on", async () => {
    const r = await owner.post("/api/share-links", { kind: "doc", targetId: docId });
    const token = tokenOf(r.body.link.url);
    expect((await owner.get("/api/share-links/settings")).body).toEqual({ allowShareLinks: true });
    expect((await owner.put("/api/share-links/settings", { allowShareLinks: false })).body).toEqual({ allowShareLinks: false });
    expect((await page(token)).status).toBe(404);
    const refused = await owner.post("/api/share-links", { kind: "doc", targetId: docId });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("share_links_off");
    expect((await owner.get(`/api/share-links?kind=doc&targetId=${docId}`)).body.allowShareLinks).toBe(false);
    await owner.put("/api/share-links/settings", { allowShareLinks: true });
    expect((await page(token)).status).toBe(200);
  });

  it("rate limits the public page per IP, in memory", async () => {
    const r = await owner.post("/api/share-links", { kind: "doc", targetId: docId });
    const token = tokenOf(r.body.link.url);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await page(token, "10.9.9.9")).status;
    expect(last).toBe(429);
    expect((await page(token, "10.9.9.10")).status).toBe(200);
  });

  it("the doc renderer escapes everything and drops unknown marks", () => {
    expect(renderDocHtml({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<b>x</b>", marks: [{ type: "highlight" }, { type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] }, "https://multies.si")).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>");
    expect(renderDocHtml({ type: "paragraph", content: [{ type: "text", text: "a", marks: [{ type: "link", attrs: { href: "https://multies.si/app/tasks?task=tsk_1" } }] }] }, "https://multies.si")).toBe("<p>a</p>");
    expect(initials("Olive Owner")).toBe("OO");
    expect(initials("Kiran")).toBe("K");
  });

  it("lists through the service with a target, and refuses another workspace's target", async () => {
    const base = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
    expect((await listShareLinks(ctx.deps, base, { kind: "doc", targetId: docId })).links.length).toBeGreaterThan(0);
    await expect(listShareLinks(ctx.deps, base, { kind: "doc", targetId: otherDocId })).rejects.toMatchObject({ status: 404 });
  });
});
