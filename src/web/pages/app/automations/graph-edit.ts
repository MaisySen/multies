/**
 * R90: pure edits of a flow graph for the editor (canvas and phone list share them), unit tested.
 */
import type { Branch, FlowEdge, FlowGraph, FlowNode, NodeKind } from "@/shared/flows";

let seq = 0;
export function newNodeId(g: FlowGraph, kind: NodeKind): string {
  const base = kind === "condition" ? "c" : kind === "action" ? "a" : kind === "wait" ? "w" : kind === "approval" ? "p" : kind === "stop" ? "s" : "t";
  for (;;) { seq++; const id = `${base}${g.nodes.length + seq}`; if (!g.nodes.some((n) => n.id === id)) return id; }
}

export function defaultConfig(kind: NodeKind): Record<string, unknown> {
  switch (kind) {
    case "condition": return { match: "all", rules: [{ field: "trigger.title", op: "contains", value: "" }] };
    case "wait": return { amount: 1, unit: "hours" };
    case "approval": return { note: "" };
    case "action": return { action: "notify", to: "admins" };
    default: return {};
  }
}

/** Branches a step can lead on by. */
export function branchesOf(kind: NodeKind): Branch[] {
  if (kind === "condition") return ["yes", "no"];
  if (kind === "action") return ["next", "error"];
  if (kind === "stop") return [];
  return ["next"];
}

export const BRANCH_LABEL: Record<Branch, string> = { next: "Then", yes: "Yes", no: "No", error: "If it fails" };

/**
 * Adds a step after `from` on `branch`. When that branch already led somewhere, the new step goes in
 * between (the old next step follows the new one), so adding never drops work.
 */
export function addStepAfter(g: FlowGraph, from: string, branch: Branch, kind: NodeKind): { graph: FlowGraph; id: string } {
  const src = g.nodes.find((n) => n.id === from);
  const id = newNodeId(g, kind);
  const old = g.edges.find((e) => e.from === from && e.branch === branch);
  const offset = branch === "no" ? 220 : branch === "error" ? 240 : branch === "yes" ? -220 : 0;
  const node: FlowNode = { id, kind, config: defaultConfig(kind), x: (src?.x ?? 0) + offset, y: (src?.y ?? 0) + 150 };
  const edges = g.edges.filter((e) => e !== old);
  edges.push(edge(from, id, branch));
  if (old && kind !== "stop") edges.push(edge(id, old.to, kind === "condition" ? "yes" : "next"));
  const nodes = [...g.nodes, node];
  if (old) shiftBelow(nodes, edges, old.to, 150);
  return { graph: { nodes, edges }, id };
}

function shiftBelow(nodes: FlowNode[], edges: FlowEdge[], start: string, dy: number) {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = nodes.find((x) => x.id === id);
    if (n) { const i = nodes.indexOf(n); nodes[i] = { ...n, y: n.y + dy }; }
    for (const e of edges) if (e.from === id) stack.push(e.to);
  }
}

export function edge(from: string, to: string, branch: Branch): FlowEdge { return { id: `${from}-${to}-${branch}`, from, to, branch }; }

/** Connects two steps on a branch, replacing what that branch led to before. Refuses loops and the trigger as a target. */
export function connect(g: FlowGraph, from: string, to: string, branch: Branch): FlowGraph | null {
  const target = g.nodes.find((n) => n.id === to);
  if (!target || target.kind === "trigger" || from === to) return null;
  const edges = [...g.edges.filter((e) => !(e.from === from && e.branch === branch)), edge(from, to, branch)];
  const next = { nodes: g.nodes, edges };
  // A path from `to` back to `from` would make a loop.
  const stack = [to]; const seen = new Set<string>();
  while (stack.length) { const id = stack.pop()!; if (id === from) return null; if (seen.has(id)) continue; seen.add(id); for (const e of edges) if (e.from === id) stack.push(e.to); }
  return next;
}

/** Removes a step. A step with one way in and one way on is bridged, so the flow stays joined. The trigger stays. */
export function removeStep(g: FlowGraph, id: string): FlowGraph {
  const n = g.nodes.find((x) => x.id === id);
  if (!n || n.kind === "trigger") return g;
  const ins = g.edges.filter((e) => e.to === id);
  const outs = g.edges.filter((e) => e.from === id && (e.branch === "next" || e.branch === "yes"));
  const edges = g.edges.filter((e) => e.from !== id && e.to !== id);
  if (ins.length === 1 && outs.length === 1) edges.push(edge(ins[0].from, outs[0].to, ins[0].branch));
  return { nodes: g.nodes.filter((x) => x.id !== id), edges };
}

export function updateNode(g: FlowGraph, id: string, patch: Partial<FlowNode>): FlowGraph {
  return { ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch, config: patch.config ?? n.config } : n)) };
}

/** Steps in reading order for the phone list: depth first from the trigger, yes before no, next before the failure path. */
export function readingOrder(g: FlowGraph): { node: FlowNode; depth: number; via: Branch | null; parent: string | null }[] {
  const order: { node: FlowNode; depth: number; via: Branch | null; parent: string | null }[] = [];
  const t = g.nodes.find((n) => n.kind === "trigger");
  if (!t) return order;
  const rank: Record<Branch, number> = { next: 0, yes: 0, no: 1, error: 2 };
  const seen = new Set<string>();
  const walk = (n: FlowNode, depth: number, via: Branch | null, parent: string | null) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    order.push({ node: n, depth, via, parent });
    const outs = g.edges.filter((e) => e.from === n.id).sort((a, b) => rank[a.branch] - rank[b.branch]);
    for (const e of outs) {
      const child = g.nodes.find((x) => x.id === e.to);
      if (child) walk(child, e.branch === "next" ? depth : depth + 1, e.branch, n.id);
    }
  };
  walk(t, 0, null, null);
  for (const n of g.nodes) if (!seen.has(n.id)) order.push({ node: n, depth: 0, via: null, parent: null });
  return order;
}

/** Lays the steps out top to bottom: each level 150 px lower, branches side by side. */
export function tidy(g: FlowGraph): FlowGraph {
  const t = g.nodes.find((n) => n.kind === "trigger");
  if (!t) return g;
  const pos = new Map<string, { x: number; y: number }>();
  let col = 0;
  const place = (id: string, depth: number): number => {
    if (pos.has(id)) return pos.get(id)!.x;
    const outs = g.edges.filter((e) => e.from === id).sort((a, b) => (a.branch === "no" || a.branch === "error" ? 1 : 0) - (b.branch === "no" || b.branch === "error" ? 1 : 0));
    pos.set(id, { x: 0, y: depth * 150 });
    const xs = outs.map((e) => place(e.to, depth + 1));
    const x = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : (col++) * 260;
    pos.set(id, { x, y: depth * 150 });
    return x;
  };
  place(t.id, 0);
  for (const n of g.nodes) if (!pos.has(n.id)) pos.set(n.id, { x: (col++) * 260, y: 0 });
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, ...pos.get(n.id)! })) };
}
