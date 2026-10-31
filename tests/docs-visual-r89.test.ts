import { describe, expect, it } from "vitest";
import { addChild, addSibling, diffBlocks, docToTree, find, indent, move, moveTo, neighbours, outdent, remove, rename, treeToDoc, visible, type PMNode } from "@/web/lib/mindmap-tree";
import { clock, isNotesCallout, slideKey, splitSlides } from "@/web/lib/slides";
import { diagramKind, readDiagramError, templateCode, DIAGRAM_TEMPLATES } from "@/web/lib/diagram";
import { boardText, changedSince, mergeElements, readScene, sceneKey, wins, type BoardElement } from "@/web/lib/whiteboard-merge";

const t = (text: string): PMNode[] => [{ type: "text", text }];
const h = (level: number, text: string): PMNode => ({ type: "heading", attrs: { level }, content: t(text) });
const p = (text: string): PMNode => (text ? { type: "paragraph", content: t(text) } : { type: "paragraph" });
const li = (text: string, ...kids: PMNode[]): PMNode => ({ type: "listItem", content: [p(text), ...kids] });
const ul = (...items: PMNode[]): PMNode => ({ type: "bulletList", content: items });
const doc = (...content: PMNode[]): PMNode => ({ type: "doc", content });

const sample = doc(
  p("Intro line"),
  h(1, "Goals"),
  ul(li("Grow", ul(li("Sales"), li("Reach"))), li("Hire")),
  p("Body text under goals"),
  h(2, "Q1"),
  { type: "orderedList", attrs: { start: 1, type: null }, content: [li("Plan"), li("Ship")] },
  h(1, "Risks"),
  { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p("Budget")] }] },
  { type: "table", content: [] },
);

describe("R89 mind map: doc to tree and back", () => {
  it("reads headings and bullets into a tree under the title", () => {
    const tree = docToTree(sample, "Plan");
    expect(tree.text).toBe("Plan");
    const top = visible(tree).map((n) => n.text);
    expect(top).toEqual(["Goals", "Risks"]);
    const goals = visible(tree)[0];
    expect(visible(goals).map((n) => n.text)).toEqual(["Grow", "Hire", "Q1"]);
    expect(visible(visible(goals)[0]).map((n) => n.text)).toEqual(["Sales", "Reach"]);
    expect(visible(visible(goals)[2]).map((n) => n.listType)).toEqual(["orderedList", "orderedList"]);
    expect(visible(visible(tree)[1])[0]).toMatchObject({ text: "Budget", listType: "taskList", itemAttrs: { checked: true } });
  });

  it("round trips every block, including paragraphs, tables and to-dos", () => {
    expect(treeToDoc(docToTree(sample, "Plan"))).toEqual(sample);
  });

  it("round trips an empty doc and a doc with only text", () => {
    expect(treeToDoc(docToTree(doc(), "x"))).toEqual(doc());
    expect(treeToDoc(docToTree(doc(p("a"), p("")), "x"))).toEqual(doc(p("a"), p("")));
  });
});

describe("R89 mind map edits update the doc", () => {
  const tree = () => docToTree(sample, "Plan");
  const ids = (text: string) => {
    const walk = (n: ReturnType<typeof tree>): string | null => (n.text === text ? n.id : n.children.map(walk).find(Boolean) ?? null);
    return walk(tree())!;
  };

  it("Tab adds a child: a bullet under a level 2 heading, a level 2 heading under a level 1 heading with subheadings", () => {
    const r = addChild(tree(), ids("Q1"))!;
    const out = treeToDoc(r.root);
    expect(out.content![5]).toMatchObject({ type: "orderedList" });
    expect((out.content![5].content as PMNode[]).length).toBe(3);
    const r2 = addChild(tree(), ids("Goals"))!;
    const out2 = treeToDoc(r2.root);
    expect(out2.content!.filter((b) => b.type === "heading").map((b) => b.attrs?.level)).toEqual([1, 2, 2, 1]);
    expect(find(r2.root, r2.focus)!.node.kind).toBe("heading");
  });

  it("a child of a bullet is a nested bullet", () => {
    const r = addChild(tree(), ids("Hire"))!;
    const list = treeToDoc(r.root).content![2];
    expect((list.content![1].content as PMNode[])[1]).toMatchObject({ type: "bulletList" });
  });

  it("Enter adds a sibling right after", () => {
    const r = addSibling(tree(), ids("Sales"))!;
    const renamed = rename(r.root, r.focus, "Margin")!;
    const goalsList = treeToDoc(renamed.root).content![2];
    const nested = (goalsList.content![0].content as PMNode[])[1];
    expect((nested.content as PMNode[]).map((x) => (x.content as PMNode[])[0].content?.[0].text)).toEqual(["Sales", "Margin", "Reach"]);
  });

  it("rename changes only that text", () => {
    const r = rename(tree(), ids("Risks"), "  Open   risks ")!;
    const out = treeToDoc(r.root);
    expect(out.content![6]).toEqual(h(1, "Open risks"));
    expect(diffBlocks(sample.content!, out.content!)).toEqual({ from: 6, to: 7, insert: [h(1, "Open risks")] });
  });

  it("delete removes the node and its children and focuses the previous sibling", () => {
    const r = remove(tree(), ids("Grow"))!;
    const out = treeToDoc(r.root);
    expect(out.content![2]).toEqual(ul(li("Hire")));
    expect(find(r.root, r.focus)!.node.text).toBe("Goals");
  });

  it("move swaps with a sibling of the same kind and stops at the edge", () => {
    const r = move(tree(), ids("Hire"), -1)!;
    expect(treeToDoc(r.root).content![2]).toEqual(ul(li("Hire"), li("Grow", ul(li("Sales"), li("Reach")))));
    expect(move(tree(), ids("Grow"), -1)).toBeNull();
    const r2 = move(tree(), ids("Risks"), -1)!;
    expect(treeToDoc(r2.root).content!.filter((b) => b.type === "heading").map((b) => b.content?.[0].text)).toEqual(["Risks", "Goals", "Q1"]);
  });

  it("drag a heading onto a bullet makes it a bullet with its children", () => {
    const r = moveTo(tree(), ids("Q1"), ids("Hire"))!;
    const out = treeToDoc(r.root);
    expect(out.content!.some((b) => b.type === "heading" && b.content?.[0].text === "Q1")).toBe(false);
    const hire = (out.content![2].content as PMNode[])[1];
    expect(JSON.stringify(hire)).toContain("Q1");
    expect(JSON.stringify(hire)).toContain("Ship");
  });

  it("cannot drop a node into its own subtree", () => {
    expect(moveTo(tree(), ids("Goals"), ids("Sales"))).toBeNull();
  });

  it("indent and outdent move a bullet a level in and out", () => {
    const r = indent(tree(), ids("Hire"))!;
    const grow = find(r.root, find(r.root, r.focus)!.parent!.id)!.node;
    expect(grow.text).toBe("Grow");
    const back = outdent(r.root, r.focus)!;
    expect(treeToDoc(back.root)).toEqual(sample);
    expect(outdent(tree(), ids("Grow"))).toBeNull();
  });

  it("outdent a heading lifts its level", () => {
    const r = outdent(tree(), ids("Q1"))!;
    expect(find(r.root, r.focus)!.node.level).toBe(1);
  });

  it("arrow key neighbours skip hidden blocks and respect collapse", () => {
    const n = neighbours(tree(), ids("Goals"));
    expect(n.firstChild).toBe(ids("Grow"));
    expect(n.next).toBe(ids("Risks"));
    expect(neighbours(tree(), ids("Goals"), new Set([ids("Goals")])).firstChild).toBeNull();
  });

  it("diffBlocks returns null when nothing changed", () => {
    expect(diffBlocks(sample.content!, treeToDoc(docToTree(sample, "Plan")).content!)).toBeNull();
  });
});

describe("R89 present: slides and notes", () => {
  const notes = (text: string): PMNode => ({ type: "callout", attrs: { variant: "info" }, content: [p(text)] });

  it("splits at H1 and H2, keeps H3 inside, takes the title slide from the doc title", () => {
    const s = splitSlides(doc(p("A short line"), h(1, "One"), p("a"), h(3, "Deep"), p("b"), h(2, "Two"), p("c")), "Deck");
    expect(s.map((x) => x.title)).toEqual(["Deck", "One", "Two"]);
    expect(s[0]).toMatchObject({ kind: "title", subtitle: "A short line" });
    expect(s[1].blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "paragraph"]);
  });

  it("a Notes callout under a heading becomes speaker notes and leaves the slide", () => {
    const s = splitSlides(doc(h(2, "Pitch"), p("Point"), notes("Notes: mention the pilot"), notes("Remember: tip")), "D");
    expect(s[1].notes).toBe("mention the pilot");
    expect(s[1].blocks.map((b) => b.type)).toEqual(["paragraph", "callout"]);
    expect(isNotesCallout(notes("Speaker notes"))).toBe(true);
    expect(isNotesCallout(notes("Notebook prices"))).toBe(false);
  });

  it("a doc with no headings gives a title slide and one content slide", () => {
    const s = splitSlides(doc(p("x".repeat(250)), p("y")), "Memo");
    expect(s.length).toBe(2);
    expect(s[1].blocks.length).toBe(2);
    expect(splitSlides(doc(), "").map((x) => x.title)).toEqual(["Untitled"]);
  });

  it("keys move between slides and stop at both ends", () => {
    expect(slideKey("ArrowRight", 0, 3)).toBe(1);
    expect(slideKey(" ", 2, 3)).toBe(2);
    expect(slideKey(" ", 2, 3, true)).toBe(1);
    expect(slideKey("ArrowLeft", 0, 3)).toBe(0);
    expect(slideKey("End", 0, 3)).toBe(2);
    expect(slideKey("x", 0, 3)).toBeNull();
    expect(clock(65_000)).toBe("01:05");
    expect(clock(3_725_000)).toBe("1:02:05");
  });
});

describe("R89 diagram errors", () => {
  it("reads the failing line from a parser error with a location", () => {
    const e = readDiagramError({ message: "Parse error on line 3:\n...B -->\n-----^\nExpecting 'X', got 'EOF'", hash: { loc: { first_line: 3 } } }, "flowchart LR\nA --> B\nB -->");
    expect(e.line).toBe(3);
    expect(e.message).toContain("Line 3");
    expect(e.detail).not.toContain("-----^");
  });

  it("reads a line from the message alone, and clamps it to the source", () => {
    expect(readDiagramError(new Error("Parsing failed: unexpected token at line 9 column 2"), "a\nb").line).toBe(2);
    expect(readDiagramError({ hash: { line: 0 }, message: "x" }, "a\nb").line).toBe(1);
  });

  it("explains a missing diagram type and an empty source, and never throws", () => {
    expect(readDiagramError(new Error("No diagram type detected matching given configuration for text: hello"), "hello").message).toContain("first line");
    expect(readDiagramError(null, "").message).toContain("pick a template");
    expect(readDiagramError("weird", "x").line).toBeNull();
  });

  it("templates name their kind", () => {
    for (const tpl of DIAGRAM_TEMPLATES) expect(diagramKind(tpl.code)).not.toBe("Diagram");
    expect(templateCode("nope")).toBe(DIAGRAM_TEMPLATES[0].code);
  });
});

describe("R89 whiteboard merge", () => {
  const el = (id: string, version: number, versionNonce = 1, extra: Partial<BoardElement> = {}): BoardElement => ({ id, version, versionNonce, index: `a${id}`, ...extra });

  it("two people drawing different shapes keep both", () => {
    const merged = mergeElements([el("1", 1)], [el("2", 1)]);
    expect(merged.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("the same shape: higher version wins, a tie goes to the lower nonce, on both sides alike", () => {
    expect(wins(el("1", 2), el("1", 3))).toBe(true);
    expect(wins(el("1", 3, 5), el("1", 3, 2))).toBe(true);
    const a = mergeElements([el("1", 3, 5)], [el("1", 3, 2)]);
    const b = mergeElements([el("1", 3, 2)], [el("1", 3, 5)]);
    expect(a).toEqual(b);
  });

  it("deletes travel as a newer version", () => {
    const merged = mergeElements([el("1", 1)], [el("1", 2, 1, { isDeleted: true })]);
    expect(merged[0].isDeleted).toBe(true);
  });

  it("only changed elements are sent, and the scene key moves with any change", () => {
    const sent = new Map([["1", 1]]);
    expect(changedSince(sent, [el("1", 1), el("2", 1)]).map((e) => e.id)).toEqual(["2"]);
    expect(sceneKey([el("1", 1)])).not.toBe(sceneKey([el("1", 2)]));
  });

  it("reads saved scenes safely and pulls out board text", () => {
    expect(readScene("not json")).toEqual([]);
    expect(readScene(JSON.stringify([el("1", 1), { nope: 1 }])).length).toBe(1);
    expect(boardText([el("1", 1, 1, { type: "text", text: " Hi " }), el("2", 1, 1, { type: "text", text: "Gone", isDeleted: true })])).toBe("Hi");
  });
});
