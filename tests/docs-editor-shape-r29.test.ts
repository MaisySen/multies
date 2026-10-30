import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { Node } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { makeTestApp, Client } from "./helpers";
import { markdownToDoc } from "@/server/services/suite/markdown-doc";
import { docFromText } from "@/server/services/suite/docs";
import { editorShape, MARK_ATTR_DEFAULTS, NODE_ATTR_DEFAULTS, needsTrailingParagraph } from "@/server/services/suite/doc-editor-shape";
import { updateShowsUnsaved } from "@/web/pages/app/work/collab-logic";

/**
 * R29: the Docs page showed "Unsaved changes" right after opening a doc appended through the API.
 * Root cause: the editor (StarterKit's trailing node) adds an empty paragraph after a doc that ends
 * in a list or code block on its first transaction, even a click, so the page saw an edit and wrote
 * a version nobody typed (and in a live session the room's first render flashed the same label).
 * The server now writes the editor's own shape; these tests run the editor's real plugins headless.
 */
const editor = new Editor({ element: null, extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true })], content: { type: "doc", content: [{ type: "paragraph" }] } });
const schema = editor.schema;

/** What opening the doc in the editor does: load it, then any transaction (a click) runs the plugins. */
function openAndClick(json: unknown) {
  const state = EditorState.create({ doc: Node.fromJSON(schema, json), plugins: editor.extensionManager.plugins });
  const r = state.applyTransaction(state.tr.setMeta("probe", true));
  return { changed: r.transactions.some((t) => t.docChanged), json: r.state.doc.toJSON() as unknown, loaded: state.doc.toJSON() as unknown };
}

const MD = [
  "## Week 2", "", "Call the **Kathmandu** school. See [the runbook](https://multies.si/docs) and <https://haajir.xyz>.", "",
  "3. Import the roster", "4. Print parent codes", "", "- [x] Demo school set up", "- [ ] First real register", "", "> quoted", "", "---", "",
  "```sh", "npm run school:setup", "```",
].join("\n");

describe("editor shape (R29)", () => {
  it("matches the editor schema's own attribute defaults", () => {
    for (const [name, type] of Object.entries(schema.nodes)) {
      const defaults = Object.fromEntries(Object.entries(type.spec.attrs ?? {}).map(([k, v]) => [k, v.default]));
      expect(NODE_ATTR_DEFAULTS[name] ?? {}, name).toEqual(defaults);
    }
    for (const [name, type] of Object.entries(schema.marks)) {
      const defaults = Object.fromEntries(Object.entries(type.spec.attrs ?? {}).map(([k, v]) => [k, v.default]));
      expect(MARK_ATTR_DEFAULTS[name] ?? {}, name).toEqual(defaults);
    }
  });

  it("reproduces the bug: raw markdown output changes on the first click", () => {
    const raw = markdownToDoc(MD);
    expect(needsTrailingParagraph(raw)).toBe(true);
    const r = openAndClick(raw);
    expect(r.changed).toBe(true);
    expect(r.loaded).not.toEqual(raw);
  });

  it("markdown in the editor's shape loads exactly as written and a click changes nothing", () => {
    const shaped = editorShape(markdownToDoc(MD));
    const r = openAndClick(shaped);
    expect(r.loaded).toEqual(shaped);
    expect(JSON.stringify(r.loaded)).toBe(JSON.stringify(shaped)); // same key order too, so hashes of it match
    expect(r.changed).toBe(false);
    expect(shaped.content!.at(-1)).toEqual({ type: "paragraph" });
  });

  it("text docs ending in bullets get the same treatment", () => {
    const shaped = editorShape(docFromText("# Notes\n- one\n- two"));
    expect(openAndClick(docFromText("# Notes\n- one")).changed).toBe(true);
    expect(openAndClick(shaped)).toMatchObject({ changed: false, loaded: shaped });
  });

  it("is idempotent, fills an empty doc, drops unknown attrs on known types and keeps unknown nodes", () => {
    const once = editorShape(markdownToDoc(MD));
    expect(editorShape(once)).toEqual(once);
    expect(editorShape({ type: "doc", content: [] })).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(editorShape({ type: "doc" })).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    const odd = editorShape({ type: "doc", content: [{ type: "heading", attrs: { level: 3, colour: "red" }, content: [{ type: "text", text: "x", marks: [{ type: "bold", attrs: { a: 1 } }] }] }, { type: "mystery", attrs: { a: 1 } }] });
    expect(odd.content).toEqual([
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }] },
      { type: "mystery", attrs: { a: 1 } },
      { type: "paragraph" },
    ]);
  });
});

describe("save status (R29)", () => {
  it("only this person's typing shows Unsaved changes; a change from the room is saved quietly", () => {
    expect(updateShowsUnsaved({ live: false, fromRoom: false })).toBe(true);
    expect(updateShowsUnsaved({ live: true, fromRoom: false })).toBe(true);
    expect(updateShowsUnsaved({ live: true, fromRoom: true })).toBe(false);
    expect(updateShowsUnsaved({ live: false, fromRoom: true })).toBe(true);
  });
});

describe("API writes docs in the editor's shape (R29)", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let key: string;
  beforeEach(async () => {
    ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    key = (await c.post("/api/developer/keys", { name: "Docs" })).body.secret;
  });
  async function v1(method: string, path: string, body?: unknown) {
    const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as { doc: { id: string; version: number; content: unknown } } };
  }

  it("an appended doc opens and clicks without a change, twice in a row, and the version stays", async () => {
    const made = await v1("POST", "/docs", { title: "Pilot plan", text: "# Goals\n- Two schools" });
    expect(openAndClick(made.body.doc.content).changed).toBe(false);
    const a = await v1("POST", `/docs/${made.body.doc.id}/append`, { markdown: MD, ifVersion: made.body.doc.version });
    expect(a.status).toBe(200);
    expect(openAndClick(a.body.doc.content)).toMatchObject({ changed: false, loaded: a.body.doc.content });
    // A second append replaces the closing empty paragraph instead of leaving a blank line in the middle.
    const b = await v1("POST", `/docs/${made.body.doc.id}/append`, { markdown: "- [ ] Next", ifVersion: a.body.doc.version });
    const blocks = (b.body.doc.content as { content: { type: string; content?: unknown[] }[] }).content;
    expect(blocks.slice(0, -1).filter((n) => n.type === "paragraph" && !n.content?.length)).toEqual([]);
    expect(blocks.map((n) => n.type).slice(-2)).toEqual(["taskList", "paragraph"]);
    expect(openAndClick(b.body.doc.content).changed).toBe(false);
    const row = await v1("GET", `/docs/${made.body.doc.id}`);
    expect(row.body.doc.version).toBe(b.body.doc.version);
  });
});
