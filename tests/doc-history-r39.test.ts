import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { diffCounts, diffLines, wordCount } from "@/shared/line-diff-r39";
import { KEEP_UNNAMED, SESSION_MS, versionCount } from "@/server/services/suite/doc-versions-r39";
import { toolScope } from "@/server/lib/api-scopes";

/** R39: page history for docs: kept per editing session, named versions, compare, restore that can be undone. */
describe("line diff (pure)", () => {
  it("finds added and removed lines and keeps the rest", () => {
    const ops = diffLines("Plan\nShip Monday\nPress kit", "Plan\nShip Wednesday\nPress kit\nBudget agreed");
    expect(ops).toEqual([
      { type: "same", text: "Plan" }, { type: "del", text: "Ship Monday" }, { type: "add", text: "Ship Wednesday" },
      { type: "same", text: "Press kit" }, { type: "add", text: "Budget agreed" },
    ]);
    expect(diffCounts(ops)).toEqual({ added: 2, removed: 1 });
    expect(diffLines("", "a\nb")).toEqual([{ type: "add", text: "a" }, { type: "add", text: "b" }]);
    expect(diffLines("same", "same")).toEqual([{ type: "same", text: "same" }]);
    expect(wordCount("two words\nand three more")).toBe(5);
  });

  it("stays bounded on a big page", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    const c = diffCounts(diffLines(a, b));
    expect(c).toEqual({ added: 3000, removed: 3000 });
  });

  it("maps the tools to the docs scopes", () => {
    expect(toolScope("list_doc_versions", true)).toBe("docs:read");
    expect(toolScope("read_doc_version", true)).toBe("docs:read");
    expect(toolScope("restore_doc_version", false)).toBe("docs:write");
    expect(toolScope("save_doc_version", false)).toBe("docs:write");
  });
});

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let key: string;
let clock = Date.parse("2026-11-02T09:00:00.000Z");
const tick = (ms: number) => { clock += ms; };
async function v1(method: string, path: string, body?: unknown, k = key) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${k}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const edit = async (id: string, text: string) => {
  const d = (await c.get(`/api/docs/${id}`)).body.doc;
  const r = await c.patch(`/api/docs/${id}`, { text, version: d.version });
  expect(r.status).toBe(200);
  return r.body.doc;
};

beforeEach(async () => {
  clock = Date.parse("2026-11-02T09:00:00.000Z");
  ctx = await makeTestApp();
  ctx.deps.now = () => new Date(clock);
  c = new Client(ctx.app);
  await c.signup("owner@history.test");
  key = (await c.post("/api/developer/keys", { name: "rw" })).body.secret;
});

describe("page history (API)", () => {
  it("keeps one version per editing session, not one per save", async () => {
    const doc = (await c.post("/api/docs", { title: "Launch plan", text: "Ship Monday" })).body.doc;
    await edit(doc.id, "Ship Tuesday");
    tick(60_000);
    await edit(doc.id, "Ship Wednesday");
    expect((await c.get(`/api/docs/${doc.id}/versions`)).body.versions).toEqual([]); // same person, same session
    tick(SESSION_MS);
    await edit(doc.id, "Ship Thursday"); // a new session saves the page as it stood
    const list = (await c.get(`/api/docs/${doc.id}/versions`)).body;
    expect(list.versions).toHaveLength(1);
    expect(list.versions[0]).toMatchObject({ reason: "edit", name: null, words: 2, title: "Launch plan" });
    expect(list.versions[0].author.type).toBe("member");
    expect(list.doc).toMatchObject({ id: doc.id, words: 2 });
    const one = (await c.get(`/api/docs/${doc.id}/versions/${list.versions[0].id}?diff=1`)).body;
    expect(one.version.text).toBe("Ship Wednesday");
    expect(one.sinceThen).toEqual({ added: 1, removed: 1, titleChanged: false });
    expect(one.diff).toEqual([{ type: "del", text: "Ship Wednesday" }, { type: "add", text: "Ship Thursday" }]);
  });

  it("an edit by someone else (an agent key) always leaves the person's page restorable", async () => {
    const doc = (await c.post("/api/docs", { title: "Brief", text: "Written by a person" })).body.doc;
    const agent = (await c.post("/api/team/agents", { name: "Writer" })).body; // an agent member with its own full key
    const r = await v1("PATCH", `/docs/${doc.id}`, { text: "Rewritten by an agent", ifVersion: doc.version }, agent.secret);
    expect(r.status).toBe(200);
    const list = (await v1("GET", `/docs/${doc.id}/versions`)).body;
    expect(list.versions).toHaveLength(1);
    expect(list.versions[0].author.name).not.toBe("Writer");
    expect(list.doc.editedBy.name).toBe("Writer"); // agent members are workspace members with their own name
    // The person brings it back; the agent's page is kept, so the restore can be undone.
    const back = await c.post(`/api/docs/${doc.id}/versions/${list.versions[0].id}/restore`, {});
    expect(back.status).toBe(200);
    expect(back.body.doc.text).toBe("Written by a person");
    expect(back.body.restoredFrom.id).toBe(list.versions[0].id);
    const after = (await c.get(`/api/docs/${doc.id}/versions`)).body.versions;
    expect(after[0]).toMatchObject({ reason: "restore", id: back.body.savedCurrentAs });
    const undo = await c.post(`/api/docs/${doc.id}/versions/${after[0].id}/restore`, {});
    expect(undo.body.doc.text).toBe("Rewritten by an agent");
  });

  it("saves, names and renames versions, refuses a stale restore, and hides other workspaces", async () => {
    const doc = (await c.post("/api/docs", { title: "Notes", text: "v1" })).body.doc;
    const saved = await c.post(`/api/docs/${doc.id}/versions`, { name: "  Before the big rewrite " });
    expect(saved.status).toBe(201);
    expect(saved.body.version).toMatchObject({ name: "Before the big rewrite", docVersion: doc.version });
    const auto = await c.post(`/api/docs/${doc.id}/versions`, {});
    expect(auto.body.version.name).toBe(`Version ${doc.version}`);
    const renamed = await c.patch(`/api/docs/${doc.id}/versions/${auto.body.version.id}`, { name: "Kept" });
    expect(renamed.body.version.name).toBe("Kept");
    expect((await c.patch(`/api/docs/${doc.id}/versions/${auto.body.version.id}`, { name: "x".repeat(81) })).status).toBe(422);
    await edit(doc.id, "v2");
    const stale = await c.post(`/api/docs/${doc.id}/versions/${saved.body.version.id}/restore`, { ifVersion: doc.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.currentVersion).toBe(doc.version + 1);
    expect((await c.get(`/api/docs/${doc.id}/versions/nope`)).status).toBe(404);
    const other = new Client(ctx.app);
    await other.signup("someone@else.test");
    expect((await other.get(`/api/docs/${doc.id}/versions`)).status).toBe(404);
    expect((await other.get(`/api/docs/${doc.id}/versions/${saved.body.version.id}`)).status).toBe(404);
  });

  it("keeps the newest unnamed versions and every named one", async () => {
    const doc = (await c.post("/api/docs", { title: "Busy page", text: "start" })).body.doc;
    await c.post(`/api/docs/${doc.id}/versions`, { name: "Pinned" });
    for (let i = 0; i < KEEP_UNNAMED + 3; i++) { tick(SESSION_MS + 1000); await edit(doc.id, `edit ${i}`); }
    const list = (await c.get(`/api/docs/${doc.id}/versions?limit=200`)).body.versions;
    expect(list.filter((v: { name: string | null }) => !v.name)).toHaveLength(KEEP_UNNAMED);
    expect(list.some((v: { name: string | null }) => v.name === "Pinned")).toBe(true);
    expect(await versionCount(ctx.deps, doc.id)).toBe(KEEP_UNNAMED + 1);
  });

  it("works over /api/v1: read only keys read history but can't save or restore", async () => {
    const doc = (await c.post("/api/docs", { title: "Spec", text: "one" })).body.doc;
    const saved = await v1("POST", `/docs/${doc.id}/versions`, { name: "First" });
    expect(saved.status).toBe(201);
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    expect((await v1("GET", `/docs/${doc.id}/versions`, undefined, ro)).body.versions).toHaveLength(1);
    expect((await v1("GET", `/docs/${doc.id}/versions/${saved.body.version.id}`, undefined, ro)).status).toBe(200);
    expect((await v1("POST", `/docs/${doc.id}/versions`, { name: "x" }, ro)).status).toBe(403);
    expect((await v1("POST", `/docs/${doc.id}/versions/${saved.body.version.id}/restore`, {}, ro)).status).toBe(403);
    expect((await v1("PATCH", `/docs/${doc.id}/versions/${saved.body.version.id}`, { name: "y" }, ro)).status).toBe(403);
    const spec = await (await ctx.app.request("/api/v1/openapi.json", { headers: { host: "localhost" } })).json();
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/docs/{id}/versions", "/docs/{id}/versions/{versionId}", "/docs/{id}/versions/{versionId}/restore"]));
  });
});

describe("page history (MCP)", () => {
  it("lists, reads with a diff, saves and restores", async () => {
    const doc = (await c.post("/api/docs", { title: "Agent page", text: "Line one\nLine two" })).body.doc;
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "t", version: "1" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
    const saved = data(await mcp.callTool({ name: "save_doc_version", arguments: { docId: doc.id, name: "Before agent" } }));
    expect(saved.version.name).toBe("Before agent");
    await edit(doc.id, "Line one\nLine 2\nLine three");
    const list = data(await mcp.callTool({ name: "list_doc_versions", arguments: { docId: doc.id } }));
    expect(list.versions[0]).toMatchObject({ id: saved.version.id, name: "Before agent" });
    const read = data(await mcp.callTool({ name: "read_doc_version", arguments: { docId: doc.id, versionId: saved.version.id, diff: true } }));
    expect(read.sinceThen).toEqual({ added: 2, removed: 1, titleChanged: false });
    expect(read.version.content).toBeUndefined();
    expect(read.diff.filter((o: { type: string }) => o.type === "add").map((o: { text: string }) => o.text)).toEqual(["Line 2", "Line three"]);
    const back = data(await mcp.callTool({ name: "restore_doc_version", arguments: { docId: doc.id, versionId: saved.version.id } }));
    expect(back.doc.text).toBe("Line one\nLine two");
    expect(back.savedCurrentAs).toBeTruthy();
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_doc_versions", "read_doc_version", "save_doc_version", "restore_doc_version"]));
  });
});
