import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { markdownToDoc } from "@/server/services/suite/markdown-doc";

/** R28 (found by Haajir, tsk_0mvomqyyoe2zq3y7483): append markdown to a doc, with a version check. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let key: string;

async function api(k: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${k}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, etag: res.headers.get("etag") };
}
const types = (n: { content?: { type: string }[] }) => (n.content ?? []).map((x) => x.type);

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  key = (await c.post("/api/developer/keys", { name: "Docs" })).body.secret;
});

describe("markdown to editor nodes", () => {
  it("turns headings, lists, quotes, code and inline marks into Tiptap nodes", () => {
    const doc = markdownToDoc([
      "## Week 3", "", "Plain *one* and **two** and ~~three~~, `x = 1`, [site](https://haajir.xyz) and https://multies.si.",
      "", "- a", "- b", "  - b1", "", "1. first", "2. second", "", "3) third starts at 3",
      "", "- [ ] todo", "- [x] done", "", "> quoted", "> still", "", "```ts", "const a = 1;", "```", "", "---", "line one  ", "line two",
    ].join("\n"));
    expect(types(doc)).toEqual(["heading", "paragraph", "bulletList", "orderedList", "orderedList", "taskList", "blockquote", "codeBlock", "horizontalRule", "paragraph"]);
    const [h, p, bl, ol, ol3, tl, bq, code, , last] = doc.content!;
    expect(h).toEqual({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Week 3" }] });
    const marks = (p.content ?? []).map((t) => [t.text, (t.marks ?? []).map((m) => m.type + (m.attrs?.href ? `:${m.attrs.href}` : "")).join(",")]);
    expect(marks).toEqual(expect.arrayContaining([["one", "italic"], ["two", "bold"], ["three", "strike"], ["x = 1", "code"], ["site", "link:https://haajir.xyz"], ["https://multies.si", "link:https://multies.si"]]));
    expect(p.content!.at(-1)).toEqual({ type: "text", text: "." });
    expect(bl.content).toHaveLength(2);
    expect(types(bl.content![1])).toEqual(["paragraph", "bulletList"]);
    expect(ol.attrs).toEqual({ start: 1 });
    expect(ol.content).toHaveLength(2);
    expect(ol3.attrs).toEqual({ start: 3 });
    expect(tl.content!.map((i) => i.attrs)).toEqual([{ checked: false }, { checked: true }]);
    expect(types(bq)).toEqual(["paragraph"]);
    expect(bq.content![0].content).toEqual([{ type: "text", text: "quoted still" }]);
    expect(code).toEqual({ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1;" }] });
    expect(types(last)).toEqual(["text", "hardBreak", "text"]);
  });

  it("leaves what it does not understand as plain text", () => {
    const doc = markdownToDoc("2 * 3 * 4 = 24, snake_case_name, an **unclosed bold, \\*escaped\\*, [no link](");
    expect(doc.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "2 * 3 * 4 = 24, snake_case_name, an **unclosed bold, *escaped*, [no link](" }] }]);
  });
});

describe("POST /api/v1/docs/{id}/append", () => {
  it("adds a markdown section and keeps the existing content and headings", async () => {
    const made = await api(key, "POST", "/docs", { title: "Plan", text: "# Goals\nShip the pilot\n## Risks\n- Late roster" });
    const id = made.body.doc.id;
    // R29: a doc written from text ends with the editor's empty paragraph, which an append replaces.
    expect(made.body.doc.content.content.at(-1)).toEqual({ type: "paragraph" });
    const before = made.body.doc.content.content.slice(0, -1);
    const r = await api(key, "POST", `/docs/${id}/append`, { markdown: "## Week 2\n\n1. Call **Kathmandu**\n2. Print codes\n\nSee [the runbook](https://multies.si/docs)." });
    expect(r.status).toBe(200);
    const content = r.body.doc.content.content;
    expect(content.slice(0, before.length)).toEqual(before);
    expect(types({ content: content.slice(before.length) })).toEqual(["heading", "orderedList", "paragraph"]);
    expect(r.body.doc.text).toContain("Goals\nShip the pilot\nRisks\nLate roster\nWeek 2\nCall Kathmandu\nPrint codes");
    expect(r.body.doc.version).toBe(made.body.doc.version + 1);
    expect(r.etag).toBe(`"${r.body.doc.version}"`);
    // Plain text still works, with the create rules.
    const t = await api(key, "POST", `/docs/${id}/append`, { text: "# Notes\n- one" });
    expect(t.status).toBe(200);
    expect(types({ content: t.body.doc.content.content.slice(-3) })).toEqual(["heading", "bulletList", "paragraph"]);
  });

  it("drops an unsafe link target but keeps the words", async () => {
    const id = (await api(key, "POST", "/docs", { title: "X" })).body.doc.id;
    const r = await api(key, "POST", `/docs/${id}/append`, { markdown: "[click](javascript:alert(1))" });
    expect(r.status).toBe(200);
    const node = r.body.doc.content.content.at(-1).content[0];
    expect(node.text).toBe("click");
    expect(node.marks ?? []).toEqual([]);
  });

  it("answers 409 with the current version when ifVersion or If-Match is stale, and writes nothing", async () => {
    const d = (await api(key, "POST", "/docs", { title: "V", text: "start" })).body.doc;
    const got = await api(key, "GET", `/docs/${d.id}`);
    expect(got.etag).toBe(`"${d.version}"`);
    expect((await api(key, "POST", `/docs/${d.id}/append`, { markdown: "one", ifVersion: d.version })).status).toBe(200);
    const stale = await api(key, "POST", `/docs/${d.id}/append`, { markdown: "two", ifVersion: d.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "version_conflict", details: { currentVersion: d.version + 1 } });
    const header = await api(key, "POST", `/docs/${d.id}/append`, { markdown: "two" }, { "if-match": `W/"${d.version}"` });
    expect(header.status).toBe(409);
    const patch = await api(key, "PATCH", `/docs/${d.id}`, { title: "New" }, { "if-match": `"${d.version}"` });
    expect(patch.status).toBe(409);
    expect(patch.body.error.details).toEqual({ currentVersion: d.version + 1 });
    const patch2 = await api(key, "PATCH", `/docs/${d.id}`, { title: "New", ifVersion: d.version });
    expect(patch2.status).toBe(409);
    const now = await api(key, "GET", `/docs/${d.id}`);
    expect(now.body.doc.title).toBe("V");
    expect(now.body.doc.text).toBe("start\none");
    // The current version goes through, from the header or the body.
    const ok = await api(key, "PATCH", `/docs/${d.id}`, { title: "New" }, { "if-match": `"${d.version + 1}"` });
    expect(ok.status).toBe(200);
    expect(ok.etag).toBe(`"${d.version + 2}"`);
    expect((await api(key, "POST", `/docs/${d.id}/append`, { markdown: "three" }, { "if-match": "*" })).status).toBe(200);
    expect((await api(key, "POST", `/docs/${d.id}/append`, { markdown: "x" }, { "if-match": "abc" })).status).toBe(400);
  });

  it("lets only one of two writers on the same version through", async () => {
    const d = (await api(key, "POST", "/docs", { title: "Race", text: "start" })).body.doc;
    const both = await Promise.all([
      api(key, "POST", `/docs/${d.id}/append`, { markdown: "from A", ifVersion: d.version }),
      api(key, "POST", `/docs/${d.id}/append`, { markdown: "from B", ifVersion: d.version }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const text = (await api(key, "GET", `/docs/${d.id}`)).body.doc.text as string;
    expect(text.split("\n")).toHaveLength(2);
  });

  it("needs a write key, the caller's own workspace and exactly one of markdown or text", async () => {
    const d = (await api(key, "POST", "/docs", { title: "P" })).body.doc;
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret as string;
    expect((await api(ro, "POST", `/docs/${d.id}/append`, { markdown: "no" })).status).toBe(403);
    const other = new Client(ctx.app);
    await other.signup("someone@else.io");
    const otherKey = (await other.post("/api/developer/keys", { name: "Other" })).body.secret as string;
    expect((await api(otherKey, "POST", `/docs/${d.id}/append`, { markdown: "no" })).status).toBe(404);
    expect((await api(key, "POST", `/docs/${d.id}/append`, { markdown: "a", text: "b" })).status).toBe(422);
    expect((await api(key, "POST", `/docs/${d.id}/append`, {})).status).toBe(422);
    expect((await api(key, "POST", `/docs/${d.id}/append`, { markdown: "x".repeat(200_001) })).status).toBe(422);
    expect((await api(key, "GET", `/docs/${d.id}`)).body.doc.version).toBe(d.version);
  });

  it("refuses an append that would take the doc over 1 MB", async () => {
    const big = { type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "x".repeat(990_000) }] }] };
    const d = (await api(key, "POST", "/docs", { title: "Big", content: big })).body.doc;
    const r = await api(key, "POST", `/docs/${d.id}/append`, { markdown: "y".repeat(20_000) });
    expect(r.status).toBe(413);
    expect((await api(key, "GET", `/docs/${d.id}`)).body.doc.version).toBe(d.version);
  });
});

describe("MCP docs_append", () => {
  it("appends markdown and honours ifVersion", async () => {
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const d = (await api(key, "POST", "/docs", { title: "M", text: "# Top" })).body.doc;
    const r = await mcp.callTool({ name: "docs_append", arguments: { id: d.id, markdown: "## Next\n- [x] done", ifVersion: d.version } });
    const out = JSON.parse((r as { content: { text: string }[] }).content[0].text);
    expect(out).toMatchObject({ id: d.id, version: d.version + 1 });
    const stale = await mcp.callTool({ name: "docs_append", arguments: { id: d.id, markdown: "again", ifVersion: d.version } });
    expect((stale as { isError?: boolean }).isError).toBe(true);
    expect((stale as { content: { text: string }[] }).content[0].text).toContain("version_conflict");
    const doc = (await api(key, "GET", `/docs/${d.id}`)).body.doc;
    expect(types(doc.content)).toEqual(["heading", "heading", "taskList", "paragraph"]);
    await mcp.close();
  });
});
