import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { docKindOf, boardTextOf, whiteboardDocContent } from "@/shared/docs-visual";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

const scene = JSON.stringify([
  { id: "t1", type: "text", text: "Launch idea", version: 2, versionNonce: 3 },
  { id: "t2", type: "text", text: "Removed", version: 2, versionNonce: 3, isDeleted: true },
  { id: "r1", type: "rectangle", version: 1, versionNonce: 1 },
]);

describe("R89 whiteboard docs on the server", () => {
  it("reads the doc kind from the content", () => {
    expect(docKindOf(whiteboardDocContent())).toBe("whiteboard");
    expect(docKindOf({ type: "doc", content: [{ type: "whiteboard", attrs: { page: false } }] })).toBe("doc");
    expect(docKindOf({ type: "doc", content: [{ type: "whiteboard", attrs: { page: true } }, { type: "paragraph", content: [{ type: "text", text: "x" }] }] })).toBe("doc");
    expect(docKindOf(null)).toBe("doc");
    expect(boardTextOf(scene)).toBe("Launch idea");
    expect(boardTextOf("{bad")).toBe("");
  });

  it("a whiteboard doc is listed with its kind, its words are searchable, and it turns back into a doc when its content does", async () => {
    const made = await c.post("/api/docs", { title: "Board", content: whiteboardDocContent(scene) });
    expect(made.status).toBe(201);
    const id = made.body.doc.id;
    expect(made.body.doc.kind).toBe("whiteboard");
    expect(made.body.doc.text).toContain("Launch idea");
    const found = await c.get("/api/docs?q=Launch");
    expect(found.body.docs.map((d: { id: string }) => d.id)).toContain(id);
    const tree = await c.get("/api/docs/tree");
    expect(JSON.stringify(tree.body)).toContain("\"kind\":\"whiteboard\"");
    const plain = await c.post("/api/docs", { title: "Plain", text: "hello" });
    expect(plain.body.doc.kind).toBe("doc");
    const back = await c.patch(`/api/docs/${id}`, { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "now text" }] }] }, version: made.body.doc.version });
    expect(back.body.doc.kind).toBe("doc");
  });

  it("a doc with a diagram keeps its source as text", async () => {
    const d = await c.post("/api/docs", { title: "Chart", content: { type: "doc", content: [{ type: "diagram", content: [{ type: "text", text: "flowchart LR\n  A --> B" }] }] } });
    expect(d.status).toBe(201);
    expect(d.body.doc.content.content[0].type).toBe("diagram");
    expect(d.body.doc.text).toContain("flowchart LR");
  });

  it("the starter retro board, user flow and org chart are in the templates and open as docs", async () => {
    const list = (await c.get("/api/templates")).body.templates as { id: string; name: string; kind: string }[];
    for (const id of ["starter-retro-board", "starter-user-flow", "starter-org-chart"]) expect(list.map((t) => t.id)).toContain(id);
    const retro = await c.post("/api/templates/starter-retro-board/use", {});
    expect(retro.body.doc.kind).toBe("whiteboard");
    expect(retro.body.doc.text).toContain("Went well");
    const org = await c.post("/api/templates/starter-org-chart/use", {});
    expect(org.body.doc.kind).toBe("doc");
    expect(org.body.doc.content.content.some((b: { type: string }) => b.type === "diagram")).toBe(true);
  });

  it("the flag is on by default in the public config", async () => {
    expect((await c.get("/api/config")).body.docsVisual).toBe(true);
  });
});
