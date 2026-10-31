import { describe, expect, it } from "vitest";
import { addStepAfter, connect, readingOrder, removeStep, tidy } from "@/web/pages/app/automations/graph-edit";
import { validateGraph, type FlowGraph } from "@/shared/flows";

/** R90: editing a flow on the canvas or the phone list keeps it joined and loop free. */
const base: FlowGraph = { nodes: [{ id: "t", kind: "trigger", config: { trigger: "manual" }, x: 0, y: 0 }], edges: [] };

describe("graph edits", () => {
  it("adds steps after a step, and in between when the branch is taken", () => {
    const a = addStepAfter(base, "t", "next", "action");
    const b = addStepAfter(a.graph, "t", "next", "wait");
    expect(b.graph.edges.map((e) => `${e.from}>${e.to}:${e.branch}`).sort()).toEqual([`${b.id}>${a.id}:next`, `t>${b.id}:next`].sort());
    expect(validateGraph(b.graph)).toEqual([]);
    expect(b.graph.nodes.find((n) => n.id === a.id)!.y).toBe(300);
  });
  it("a condition in between keeps the old step on its yes path", () => {
    const a = addStepAfter(base, "t", "next", "action");
    const c = addStepAfter(a.graph, "t", "next", "condition");
    expect(c.graph.edges.some((e) => e.from === c.id && e.to === a.id && e.branch === "yes")).toBe(true);
  });
  it("refuses loops and joins into the trigger", () => {
    const a = addStepAfter(base, "t", "next", "action");
    const b = addStepAfter(a.graph, a.id, "next", "action");
    expect(connect(b.graph, b.id, a.id, "next")).toBeNull();
    expect(connect(b.graph, b.id, "t", "next")).toBeNull();
    expect(connect(b.graph, a.id, a.id, "error")).toBeNull();
    const ok = connect(b.graph, a.id, b.id, "error")!;
    expect(ok.edges.filter((e) => e.from === a.id).map((e) => e.branch).sort()).toEqual(["error", "next"]);
  });
  it("removing a middle step bridges the flow; the trigger cannot be removed", () => {
    const a = addStepAfter(base, "t", "next", "action");
    const b = addStepAfter(a.graph, a.id, "next", "action");
    const r = removeStep(b.graph, a.id);
    expect(r.edges).toEqual([expect.objectContaining({ from: "t", to: b.id, branch: "next" })]);
    expect(removeStep(r, "t")).toBe(r);
  });
  it("reading order follows yes before no and indents branches; tidy lays out by level", () => {
    const c = addStepAfter(base, "t", "next", "condition");
    const y = addStepAfter(c.graph, c.id, "yes", "action");
    const n = addStepAfter(y.graph, c.id, "no", "stop");
    const order = readingOrder(n.graph);
    expect(order.map((o) => o.node.id)).toEqual(["t", c.id, y.id, n.id]);
    expect(order.map((o) => o.depth)).toEqual([0, 0, 1, 1]);
    const t = tidy(n.graph);
    expect(t.nodes.find((x) => x.id === y.id)!.y).toBe(300);
    expect(t.nodes.find((x) => x.id === y.id)!.x).toBeLessThan(t.nodes.find((x) => x.id === n.id)!.x);
  });
});
