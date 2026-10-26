import { describe, it, expect, beforeEach } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Node } from "@tiptap/pm/model";
import * as Y from "yjs";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { docBlockSchemaExtensions, isSafeImageSrc, looksLikeImageUrl, imageSize } from "@/web/lib/docs-blocks-schema";
import { calloutVariant, nextCalloutVariant, CALLOUT_INPUT } from "@/web/lib/docs-callout";
import { filterSlash, SLASH_ITEMS } from "@/web/lib/slash-commands";
import { markdownToDoc } from "@/server/services/suite/markdown-doc";
import { renderDocHtml } from "@/server/services/suite/share-links";
import { plainTextOf, safeImageSrc } from "@/server/services/suite/docs";
import { editorShape, NODE_ATTR_DEFAULTS } from "@/server/services/suite/doc-editor-shape";
import { blockMarkdown } from "@/server/services/suite/doc-blocks-r32";
import { sniffImageType } from "@/server/services/suite/doc-images-r32";
import { makeTestApp, Client } from "./helpers";

/** R32: docs table, image and callout blocks. */
const extensions = [StarterKit, TaskList, TaskItem.configure({ nested: true }), ...docBlockSchemaExtensions()];
const newEditor = () => new Editor({ element: null, extensions, content: { type: "doc", content: [{ type: "paragraph" }] } });

const SAMPLE = {
  type: "doc",
  content: [
    { type: "callout", attrs: { variant: "warning" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Mind the gap" }] }] },
    { type: "image", attrs: { src: "https://multies.si/a.png", alt: "Chart", title: null, width: null, height: null, size: "wide" } },
    { type: "table", content: [
      { type: "tableRow", content: [
        { type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }] },
        { type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "Owner" }] }] },
      ] },
      { type: "tableRow", content: [
        { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "Launch" }] }] },
        { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "Ana" }] }] },
      ] },
    ] },
    { type: "paragraph" },
  ],
};

describe("doc blocks schema (R32)", () => {
  it("inserts a 3 by 3 table with a header row, and adds a row", () => {
    const e = newEditor();
    expect(e.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true })).toBe(true);
    const table: JSONContent = e.getJSON().content!.find((n) => n.type === "table")!;
    expect(table.content).toHaveLength(3);
    expect(table.content![0].content!.map((c) => c.type)).toEqual(["tableHeader", "tableHeader", "tableHeader"]);
    expect(table.content![1].content!.map((c) => c.type)).toEqual(["tableCell", "tableCell", "tableCell"]);
    expect(e.commands.addRowAfter()).toBe(true);
    expect(e.getJSON().content!.find((n) => n.type === "table")!.content).toHaveLength(4);
    e.destroy();
  });

  it("wraps a block in a callout and switches its variant", () => {
    const e = newEditor();
    e.commands.insertContent({ type: "text", text: "Heads up" }); // JSON content: a string needs a DOM
    expect(e.commands.setCallout("danger")).toBe(true);
    expect(e.getJSON().content![0]).toMatchObject({ type: "callout", attrs: { variant: "danger" } });
    e.commands.setCalloutVariant("success");
    expect(e.getJSON().content![0].attrs).toEqual({ variant: "success" });
    e.destroy();
  });

  it("loads the sample exactly, so the editor shape matches the server's", () => {
    const schema = newEditor().schema;
    const doc = Node.fromJSON(schema, SAMPLE);
    expect(doc.toJSON()).toEqual(SAMPLE);
    expect(editorShape(markdownToDoc("| a | b |\n| --- | --- |\n| 1 | 2 |")).content![0]).toEqual(Node.fromJSON(schema, editorShape(markdownToDoc("| a | b |\n| --- | --- |\n| 1 | 2 |"))).toJSON().content[0]);
    for (const [name, type] of Object.entries(schema.nodes)) {
      const defaults = Object.fromEntries(Object.entries(type.spec.attrs ?? {}).map(([k, v]) => [k, (v as { default: unknown }).default]));
      expect(NODE_ATTR_DEFAULTS[name] ?? {}, name).toEqual(defaults);
    }
  });

  it("round trips tables, images and callouts through the shared (Yjs) document", () => {
    const schema = newEditor().schema;
    const ydoc = new Y.Doc();
    const frag = ydoc.getXmlFragment("default");
    prosemirrorJSONToYXmlFragment(schema, SAMPLE, frag);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
    // The shared document stores no null attributes; loading it fills the schema defaults back in.
    expect(Node.fromJSON(schema, yXmlFragmentToProsemirrorJSON(copy.getXmlFragment("default"))).toJSON()).toEqual(SAMPLE);
  });

  it("knows variants, aliases and the ::: shortcut", () => {
    expect(calloutVariant("tip")).toBe("success");
    expect(calloutVariant("CAUTION")).toBe("warning");
    expect(calloutVariant("nope")).toBe("info");
    expect(nextCalloutVariant("danger")).toBe("info");
    expect(CALLOUT_INPUT.test(":::warning ")).toBe(true);
    expect(CALLOUT_INPUT.test(":::bogus ")).toBe(false);
  });

  it("accepts only safe image sources", () => {
    for (const ok of ["https://x.io/a.png", "/api/doc-images/dim_abc123", "data:image/png;base64,iVBORw0KGgo="]) { expect(isSafeImageSrc(ok), ok).toBe(true); expect(safeImageSrc(ok), ok).toBe(true); }
    for (const bad of ["http://x.io/a.png", "javascript:alert(1)", "java\tscript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "/api/doc-images/../files/x", "//evil.io/a.png", 42]) { expect(isSafeImageSrc(bad), String(bad)).toBe(false); expect(safeImageSrc(bad), String(bad)).toBe(false); }
    expect(looksLikeImageUrl("https://x.io/cat.JPG")).toBe(true);
    expect(looksLikeImageUrl("https://x.io/page")).toBe(false);
    expect(looksLikeImageUrl("see https://x.io/a.png")).toBe(false);
    expect(imageSize("full")).toBe("full");
    expect(imageSize("huge")).toBe("fit");
  });

  it("sniffs image bytes and refuses svg or html", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("slash menu entries (R32)", () => {
  it("adds table, image and callouts", () => {
    expect(SLASH_ITEMS.find((i) => i.id === "table")!.action).toEqual({ kind: "table" });
    expect(SLASH_ITEMS.find((i) => i.id === "image")!.action).toEqual({ kind: "image" });
    expect(SLASH_ITEMS.find((i) => i.id === "callout-warning")!.action).toEqual({ kind: "callout", variant: "warning" });
    expect(filterSlash("table")[0].id).toBe("table");
    expect(filterSlash("image")[0].id).toBe("image");
    expect(filterSlash("callout")[0].id).toBe("callout");
    expect(filterSlash("photo")[0].id).toBe("image");
    expect(filterSlash("warning").map((i) => i.id)).toContain("callout-warning");
  });
});

describe("markdown, export and plain text (R32)", () => {
  it("reads callouts, image lines and pipe tables", () => {
    const doc = markdownToDoc([":::warning", "Back up **first**", ":::", "", "> [!TIP] Use the shortcut", "", "![A chart](https://x.io/c.png)", "", "| Name | Owner |", "| --- | --- |", "| Launch | Ana \\| Bo |"].join("\n"));
    expect(doc.content!.map((n) => n.type)).toEqual(["callout", "callout", "image", "table"]);
    expect(doc.content![0].attrs).toEqual({ variant: "warning" });
    expect(doc.content![1].attrs).toEqual({ variant: "success" });
    expect(doc.content![2].attrs).toMatchObject({ src: "https://x.io/c.png", alt: "A chart" });
    const t = doc.content![3];
    expect(t.content![0].content![0].type).toBe("tableHeader");
    expect(plainTextOf(t as never)).toBe("Name\nOwner\nLaunch\nAna | Bo");
  });

  it("renders the read only HTML with escaped content and only safe images", () => {
    const html = renderDocHtml(SAMPLE, "https://multies.si");
    expect(html).toContain('<div class="callout" data-callout="warning" role="note"><p>Mind the gap</p></div>');
    expect(html).toContain('<img src="https://multies.si/a.png" alt="Chart" data-size="wide"');
    expect(html).toContain("<table><tr><th><p>Name</p></th><th><p>Owner</p></th></tr><tr><td><p>Launch</p></td>");
    const evil = renderDocHtml({ type: "doc", content: [{ type: "image", attrs: { src: "javascript:alert(1)", alt: "<b>x</b>" } }, { type: "callout", attrs: { variant: "\"><script>" }, content: [] }] }, "https://multies.si");
    expect(evil).not.toContain("javascript:");
    expect(evil).not.toContain("<script>");
    expect(evil).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("builds block markdown for the MCP tool", () => {
    expect(blockMarkdown({ type: "table", rows: [["A", "B"], ["1", "2|3"]] })).toBe("| A | B |\n| --- | --- |\n| 1 | 2\\|3 |");
    expect(blockMarkdown({ type: "callout", variant: "danger", text: "Stop" })).toBe(":::danger\nStop\n:::");
    expect(() => blockMarkdown({ type: "image", url: "http://x.io/a.png" })).toThrow();
  });
});

describe("docs API and MCP (R32)", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let c: Client;
  beforeEach(async () => { ctx = await makeTestApp(); c = new Client(ctx.app); await c.signup("owner@acme.io"); });

  it("saves blocks through the docs API and drops unsafe image sources", async () => {
    const d = (await c.post("/api/docs", { title: "Blocks", content: { ...SAMPLE, content: [...SAMPLE.content, { type: "image", attrs: { src: "javascript:alert(1)" } }] } })).body.doc;
    const got = (await c.get(`/api/docs/${d.id}`)).body.doc;
    expect(got.content.content.map((n: { type: string }) => n.type)).toEqual(["callout", "image", "table", "paragraph"]);
  });

  it("answers 503 for image uploads without file storage, and 401 without a session", async () => {
    const d = (await c.post("/api/docs", { title: "Img", text: "" })).body.doc;
    const r = await c.post("/api/doc-images", { docId: d.id, contentBase64: "iVBORw0KGgoAAAANSUhEUg==" });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("uploads_unavailable");
    const anon = await ctx.app.request("/api/doc-images/dim_abc123", { headers: { host: "localhost" } });
    expect(anon.status).toBe(401);
  });

  it("docs_add_block adds a table, a callout and an image over MCP", async () => {
    const key = (await c.post("/api/developer/keys", { name: "Docs" })).body.secret;
    const d = (await c.post("/api/docs", { title: "MCP", text: "Intro" })).body.doc;
    const mcp = new McpClient({ name: "t", version: "1" });
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    await mcp.callTool({ name: "docs_add_block", arguments: { id: d.id, type: "table", rows: [["A", "B"], ["1", "2"]] } });
    await mcp.callTool({ name: "docs_add_block", arguments: { id: d.id, type: "callout", variant: "success", text: "Done" } });
    const r = await mcp.callTool({ name: "docs_add_block", arguments: { id: d.id, type: "image", url: "https://x.io/a.png", alt: "A" } });
    expect(r.isError).toBeFalsy();
    const got = (await c.get(`/api/docs/${d.id}`)).body.doc;
    expect(got.content.content.map((n: { type: string }) => n.type)).toEqual(["paragraph", "table", "callout", "image", "paragraph"]);
    const bad = await mcp.callTool({ name: "docs_add_block", arguments: { id: d.id, type: "image", url: "javascript:alert(1)" } });
    expect(bad.isError).toBe(true);
    await mcp.close();
  });
});
