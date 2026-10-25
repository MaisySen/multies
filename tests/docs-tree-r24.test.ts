import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { createDoc, deleteDoc, updateDoc } from "@/server/services/suite/docs";
import { buildTree, extractDocLinks, getBacklinks, getDocTree, MAX_DEPTH, moveDoc, parseAppHref, snippetFor, syncDocLinks, type TreeRow } from "@/server/services/suite/doc-tree";
import { createTask } from "@/server/services/suite/tasks";
import type { SuiteActor } from "@/server/services/suite/common";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let actor: SuiteActor;
let projectId: string;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const body = (await c.get("/api/account/me")).body;
  actor = { orgId: body.organization.id, userId: body.user.id, email: body.user.email, name: body.user.name, role: "owner" };
  projectId = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
});

const text = (t: string, href?: string) => ({ type: "text", text: t, ...(href ? { marks: [{ type: "link", attrs: { href } }] } : {}) });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", content });
const mk = (title: string, extra: Record<string, unknown> = {}) => createDoc(ctx.deps, actor, { title, text: "", ...extra });

describe("docs links: reading links from Tiptap JSON", () => {
  it("finds doc, task and project links, mentions and page links, once each; outside links are ignored", () => {
    const body = doc(
      para(text("See "), text("the brief", "/app/docs/doc_A1"), text(" and "), text("again", "https://multies.si/app/docs/doc_A1")),
      para(text("task", "/app/tasks?view=list&task=tsk_1"), text("task path", "/app/tasks/tsk_2"), text("project", "/app/tasks?project=prj_9")),
      { type: "bulletList", content: [{ type: "listItem", content: [para({ type: "mention", attrs: { id: "doc_B2", type: "doc", label: "B" } }), para({ type: "pageLink", attrs: { id: "tsk_1", type: "task" } })] }] },
      para(text("outside", "https://example.com/app/docs/doc_X"), text("mail", "mailto:a@b.co"), text("js", "javascript:alert(1)"), text("proto", "//evil.com/app/docs/doc_Y"), text("bad id", "/app/docs/a%20b")),
      para({ type: "mention", attrs: { id: "usr_1", type: "member" } }),
    );
    expect(extractDocLinks(body)).toEqual([
      { type: "doc", id: "doc_A1" }, { type: "task", id: "tsk_1" }, { type: "task", id: "tsk_2" }, { type: "project", id: "prj_9" }, { type: "doc", id: "doc_B2" },
    ]);
    expect(extractDocLinks(null)).toEqual([]);
    expect(extractDocLinks({ type: "doc" })).toEqual([]);
    expect(parseAppHref("http://localhost:8940/app/docs/doc_1", ["localhost"])).toEqual({ type: "doc", id: "doc_1" });
    expect(parseAppHref("http://localhost:8940/app/docs/doc_1")).toBeNull();
  });

  it("gives the text around the link as the snippet", () => {
    const body = doc(para(text("Intro")), para(text("Plan is in "), text("Brief", "/app/docs/doc_1"), text(" for the launch.")));
    expect(snippetFor(body, { type: "doc", id: "doc_1" })).toBe("Plan is in Brief for the launch.");
    expect(snippetFor(body, { type: "doc", id: "doc_2" }, "fallback text")).toBe("fallback text");
    expect(snippetFor(doc(para(text("x".repeat(300), "/app/docs/doc_1"))), { type: "doc", id: "doc_1" }).length).toBe(160);
  });
});

describe("docs links: saving", () => {
  it("stores links to this workspace's records only, and writes nothing when the links did not change", async () => {
    const b = await mk("B");
    const t = await createTask(ctx.deps, actor, { title: "Ship", projectId });
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else", "Else");
    const theirDoc = (await other.post("/api/docs", { title: "Theirs", text: "" })).body.doc.id;
    const a = await mk("A", { content: doc(para(text("B", `/app/docs/${b.id}`), text("theirs", `/app/docs/${theirDoc}`), text("self", "/app/docs/SELF"), text("task", `/app/tasks?task=${t.id}`))) });
    const rows = () => (ctx.db as unknown as { $client: { prepare: (q: string) => { all: (...x: unknown[]) => unknown[] } } }).$client.prepare("select target_type t, target_id i from doc_links where source_doc_id = ? order by t, i").all(a.id);
    expect(rows()).toEqual([{ t: "doc", i: b.id }, { t: "task", i: t.id }].sort((x, y) => (x.t < y.t ? -1 : 1)));
    const same = doc(para(text("B again", `/app/docs/${b.id}`)), para(text("task", `/app/tasks/${t.id}`)));
    expect(await syncDocLinks(ctx.deps, actor.orgId, a.id, same)).toEqual({ added: 0, removed: 0 });
    // A self link is ignored.
    expect(await syncDocLinks(ctx.deps, actor.orgId, a.id, doc(para(text("me", `/app/docs/${a.id}`)), para(text("B", `/app/docs/${b.id}`))))).toEqual({ added: 0, removed: 1 });
    await updateDoc(ctx.deps, actor, a.id, { content: doc(para(text("nothing linked"))) });
    expect(rows()).toEqual([]);
    // A title only update leaves links alone.
    await updateDoc(ctx.deps, actor, a.id, { content: doc(para(text("B", `/app/docs/${b.id}`))) });
    await updateDoc(ctx.deps, actor, a.id, { title: "A2" });
    expect(rows()).toEqual([{ t: "doc", i: b.id }]);
  });
});

describe("docs tree", () => {
  it("nests rows, sorts by position, and puts pages whose parent is missing at the top", () => {
    const at = new Date("2026-10-01T00:00:00Z");
    const r = (id: string, parentId: string | null, position: number): TreeRow => ({ id, title: id, parentId, position, projectId: null, updatedAt: at });
    const tree = buildTree([r("a", null, 2), r("b", null, 1), r("c", "a", 1.5), r("d", "a", 1), r("e", "gone", 0), r("f", "g", 0), r("g", "f", 0)]);
    expect(tree.map((n) => n.id)).toEqual(["e", "f", "g", "b", "a"]);
    const ids = tree.map((n) => n.id);
    expect(ids).toContain("e");
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("a"));
    const a = tree.find((n) => n.id === "a")!;
    expect(a.children.map((n) => [n.id, n.depth])).toEqual([["d", 2], ["c", 2]]);
    // A loop in stored data (f under g under f) never hangs and both pages stay visible.
    const flat: string[] = [];
    const walk = (l: typeof tree) => { for (const n of l) { flat.push(n.id); walk(n.children); } };
    walk(tree);
    expect(flat.sort()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("creates sub pages at the end, moves with fractional positions writing one row, refuses loops and depth past the cap", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const c1 = await mk("C1", { parentId: a.id });
    const c2 = await mk("C2", { parentId: a.id });
    expect([c1.parentId, c2.parentId, c2.position > c1.position]).toEqual([a.id, a.id, true]);
    // B goes between C1 and C2.
    const m = await moveDoc(ctx.deps, actor, b.id, { parentId: a.id, afterId: c1.id });
    expect(m.renumbered).toBe(0);
    expect(m.doc.position).toBeGreaterThan(c1.position);
    expect(m.doc.position).toBeLessThan(c2.position);
    let t = await getDocTree(ctx.deps, { orgId: actor.orgId });
    expect(t.tree.find((n) => n.id === a.id)!.children.map((n) => n.title)).toEqual(["C1", "B", "C2"]);
    // beforeId, and to the top level.
    await moveDoc(ctx.deps, actor, c2.id, { beforeId: c1.id });
    t = await getDocTree(ctx.deps, { orgId: actor.orgId });
    expect(t.tree.find((n) => n.id === a.id)!.children.map((n) => n.title)).toEqual(["C2", "C1", "B"]);
    await moveDoc(ctx.deps, actor, b.id, { parentId: null });
    t = await getDocTree(ctx.deps, { orgId: actor.orgId });
    expect(t.tree.map((n) => n.title)).toEqual(["A", "B"]);
    // Loops.
    await expect(moveDoc(ctx.deps, actor, a.id, { parentId: c1.id })).rejects.toMatchObject({ status: 422, code: "cycle" });
    await expect(moveDoc(ctx.deps, actor, a.id, { parentId: a.id })).rejects.toMatchObject({ status: 422 });
    // Depth: a chain of MAX_DEPTH pages is fine, one more is refused, and moving a subtree checks its height.
    let parent = c1.id;
    for (let i = 3; i <= MAX_DEPTH; i++) parent = (await mk(`L${i}`, { parentId: parent })).id;
    await expect(mk("too deep", { parentId: parent })).rejects.toMatchObject({ status: 422, code: "too_deep" });
    await expect(moveDoc(ctx.deps, actor, a.id, { parentId: b.id })).rejects.toMatchObject({ status: 422, code: "too_deep" });
    await expect(moveDoc(ctx.deps, actor, b.id, { parentId: "doc_missing" })).rejects.toMatchObject({ status: 404 });
  });

  it("spaces siblings out again only when the gap is used up", async () => {
    const p = await mk("P");
    const x = await mk("X", { parentId: p.id });
    const y = await mk("Y", { parentId: p.id });
    const z = await mk("Z", { parentId: p.id });
    // Squeeze Z between X and Y until there is no room left.
    let renumbered = 0;
    for (let i = 0; i < 60 && !renumbered; i++) {
      renumbered = (await moveDoc(ctx.deps, actor, z.id, { afterId: x.id })).renumbered;
      if (!renumbered) renumbered = (await moveDoc(ctx.deps, actor, y.id, { afterId: x.id })).renumbered;
    }
    expect(renumbered).toBeGreaterThan(0);
    const kids = (await getDocTree(ctx.deps, { orgId: actor.orgId })).tree.find((n) => n.id === p.id)!.children;
    expect(kids.map((k) => k.position)).toEqual([1, 2, 3]);
  });

  it("moves a deleted page's children up to its parent", async () => {
    const a = await mk("A");
    const b = await mk("B", { parentId: a.id });
    await mk("C", { parentId: b.id });
    await mk("D", { parentId: b.id });
    await deleteDoc(ctx.deps, actor, b.id);
    const t = await getDocTree(ctx.deps, { orgId: actor.orgId });
    expect(t.tree.map((n) => n.title)).toEqual(["A"]);
    expect(t.tree[0].children.map((n) => n.title).sort()).toEqual(["C", "D"]);
    await deleteDoc(ctx.deps, actor, a.id);
    expect((await getDocTree(ctx.deps, { orgId: actor.orgId })).tree.map((n) => n.title).sort()).toEqual(["C", "D"]);
  });

  it("keeps trees and moves to one workspace, and read only keys can't move", async () => {
    const a = await mk("A");
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else", "Else");
    const theirs = (await other.post("/api/docs", { title: "Theirs", text: "" })).body.doc.id;
    expect((await other.get("/api/docs/tree")).body.tree.map((n: { title: string }) => n.title)).toEqual(["Theirs"]);
    expect((await other.patch(`/api/docs/${a.id}/move`, { parentId: null })).status).toBe(404);
    expect((await c.patch(`/api/docs/${a.id}/move`, { parentId: theirs })).status).toBe(404);
    expect((await other.post("/api/docs", { title: "Sneaky", parentId: a.id })).status).toBe(404);
    await expect(moveDoc(ctx.deps, { ...actor, scope: "read" }, a.id, { parentId: null })).rejects.toMatchObject({ status: 403 });
    expect((await c.patch(`/api/docs/${a.id}/move`, { beforeId: "x", afterId: "y" })).status).toBe(422);
  });
});

describe("backlinks", () => {
  it("lists docs linking to a doc and to a task, with snippets, within the viewer's reach", async () => {
    const t = await createTask(ctx.deps, actor, { title: "Ship", projectId });
    const b = await mk("B", { projectId });
    const inProject = await mk("Plan", { projectId, content: doc(para(text("Read "), text("B", `/app/docs/${b.id}`), text(" first.")), para(text("Ship it", `/app/tasks?task=${t.id}`))) });
    const outside = await mk("Internal", { content: doc(para(text("Also see B", `/app/docs/${b.id}`))) });
    const res = await c.get(`/api/docs/${b.id}/backlinks`);
    expect(res.status).toBe(200);
    expect(res.body.backlinks.map((x: { title: string }) => x.title).sort()).toEqual(["Internal", "Plan"]);
    expect(res.body.backlinks.find((x: { id: string }) => x.id === inProject.id).snippet).toBe("Read B first.");
    const ref = (await c.get(`/api/tasks/${t.id}`)).body.task.ref as string;
    expect((await c.get(`/api/tasks/${ref}/backlinks`)).body.backlinks.map((x: { title: string }) => x.title)).toEqual(["Plan"]);
    // A deleted source stops showing.
    await deleteDoc(ctx.deps, actor, outside.id);
    expect((await getBacklinks(ctx.deps, { orgId: actor.orgId }, { type: "doc", id: b.id })).backlinks.map((x) => x.title)).toEqual(["Plan"]);
    // Another workspace: 404 for the doc and the task.
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else", "Else");
    expect((await other.get(`/api/docs/${b.id}/backlinks`)).status).toBe(404);
    expect((await other.get(`/api/tasks/${t.id}/backlinks`)).status).toBe(404);
    // A guest of the project sees project docs only, and nothing outside the project.
    await mk("Outside link", { content: doc(para(text("B", `/app/docs/${b.id}`))) });
    const loose = await mk("Loose");
    const inv = await c.post("/api/guests", { projectId, email: "client@harbour.example", name: "Mia" });
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const token = sent.map((m) => m.text).reverse().find((x) => x.includes("/g/"))?.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1] ?? (inv.body.inviteUrl as string).split("/g/")[1];
    const guest = new Client(ctx.app);
    expect((await guest.post("/api/guest/accept", { token })).status).toBe(200);
    expect((await guest.get(`/api/docs/${b.id}/backlinks`)).status).toBe(401);
    expect((await guest.get(`/api/guest/r24/docs/${b.id}/backlinks`)).body.backlinks.map((x: { title: string }) => x.title)).toEqual(["Plan"]);
    expect((await guest.get(`/api/guest/r24/tasks/${t.id}/backlinks`)).body.backlinks.map((x: { title: string }) => x.title)).toEqual(["Plan"]);
    expect((await guest.get(`/api/guest/r24/docs/${loose.id}/backlinks`)).status).toBe(404);
    expect((await guest.get("/api/guest/r24/docs/tree")).body.tree.map((n: { title: string }) => n.title).sort()).toEqual(["B", "Plan"]);
    expect((await new Client(ctx.app).get("/api/guest/r24/docs/tree")).status).toBe(401);
  });
});

describe("docs tree and backlinks in the API and MCP", () => {
  it("serves the tree, moves with a full key only, and lists backlinks; MCP tools too", async () => {
    const a = await mk("A");
    const b = await mk("B", { content: doc(para(text("A", `/app/docs/${a.id}`))) });
    const full = (await c.post("/api/developer/keys", { name: "full" })).body.secret;
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const call = (path: string, key: string, init: RequestInit = {}) => ctx.app.request(`/api/v1${path}`, { ...init, headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json" } });
    const tree = await (await call("/docs/tree", ro)).json() as { tree: { title: string }[] };
    expect(tree.tree.map((n) => n.title)).toEqual(["A", "B"]);
    expect((await call(`/docs/${b.id}/move`, ro, { method: "PATCH", body: JSON.stringify({ parentId: a.id }) })).status).toBe(403);
    const moved = await call(`/docs/${b.id}/move`, full, { method: "PATCH", body: JSON.stringify({ parentId: a.id }) });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { doc: { parentId: string } }).doc.parentId).toBe(a.id);
    expect((await call(`/docs/${a.id}/move`, full, { method: "PATCH", body: JSON.stringify({ parentId: b.id }) })).status).toBe(422);
    const bl = await (await call(`/docs/${a.id}/backlinks`, ro)).json() as { backlinks: { title: string }[] };
    expect(bl.backlinks.map((x) => x.title)).toEqual(["B"]);
    const created = await call("/docs", full, { method: "POST", body: JSON.stringify({ title: "Child", parentId: b.id }) });
    expect(created.status).toBe(201);
    const t = await createTask(ctx.deps, actor, { title: "Ship", projectId });
    expect(((await (await call(`/tasks/${t.id}/backlinks`, ro)).json()) as { backlinks: unknown[] }).backlinks).toEqual([]);
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else", "Else");
    const evil = (await other.post("/api/developer/keys", { name: "k" })).body.secret;
    expect((await call(`/docs/${a.id}/backlinks`, evil)).status).toBe(404);
    expect((await call(`/docs/${a.id}/move`, evil, { method: "PATCH", body: JSON.stringify({ parentId: null }) })).status).toBe(404);

    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const connect = async (key: string) => {
      const m = new McpClient({ name: "test", version: "1.0.0" });
      await m.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
      return m;
    };
    const out = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0].text);
    const mro = await connect(ro);
    const flat = out(await mro.callTool({ name: "get_doc_tree", arguments: { flat: true } }));
    expect(flat.pages.map((p: { title: string; depth: number }) => [p.title, p.depth])).toEqual([["A", 1], ["B", 2], ["Child", 3]]);
    expect(out(await mro.callTool({ name: "get_backlinks", arguments: { type: "doc", id: a.id } })).backlinks[0].title).toBe("B");
    expect((await mro.callTool({ name: "move_doc", arguments: { docId: b.id, parentId: null } })).isError).toBe(true);
    await mro.close();
    const mrw = await connect(full);
    const r = await mrw.callTool({ name: "move_doc", arguments: { docId: b.id, parentId: null } });
    expect(r.isError).toBeFalsy();
    expect(out(r).doc.parentId).toBeNull();
    await mrw.close();
  });
});
