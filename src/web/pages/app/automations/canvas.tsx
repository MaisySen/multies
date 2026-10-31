/**
 * R90: the flow canvas (desktop). Loaded only when a flow opens on a wide screen. Steps are cards; each card
 * has a handle per way it can lead on (Then, Yes and No, If it fails). Drag a handle to another step to join
 * them; drag cards to arrange. Keyboard: Tab moves between steps, Enter opens one, Delete removes it.
 */
import { useCallback, useMemo } from "react";
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  type Connection, type Edge, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { cn } from "@/web/lib/cn";
import { IconApprovals, IconBranch, IconCircleStop, IconHourglass, IconWorkflow, IconZap } from "@/web/components/ui/icon";
import { KIND_LABEL, describeNode, type Branch, type FlowGraph, type FlowNode } from "@/shared/flows";
import { BRANCH_LABEL, branchesOf, connect } from "./graph-edit";

type StepData = { node: FlowNode; problem: boolean; selected: boolean };

const ICON = { trigger: IconZap, condition: IconBranch, wait: IconHourglass, approval: IconApprovals, action: IconWorkflow, stop: IconCircleStop };

function StepCard({ data }: NodeProps<Node<StepData>>) {
  const { node, problem, selected } = data;
  const Icon = ICON[node.kind];
  const branches = branchesOf(node.kind);
  return (
    <div className={cn("w-[220px] rounded-xl border bg-surface px-3 py-2.5 text-left shadow-sm transition-colors duration-150",
      selected ? "border-brand ring-2 ring-brand/30" : problem ? "border-warn" : "border-line-strong hover:border-brand/60")}>
      {node.kind !== "trigger" && <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !border-2 !border-surface !bg-line-strong" />}
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle"><Icon className="h-3.5 w-3.5" aria-hidden />{KIND_LABEL[node.kind]}{problem && <span className="ml-auto rounded bg-warn-soft px-1 text-[10px] normal-case text-fg">Needs a look</span>}</div>
      <div className="mt-1 truncate text-[13px] font-medium text-fg" title={node.label || describeNode(node)}>{node.label || describeNode(node)}</div>
      {node.label && <div className="truncate text-[12px] text-muted">{describeNode(node)}</div>}
      {branches.length > 1 && (
        <div className="mt-2 flex justify-between text-[10px] text-subtle" aria-hidden>
          {branches.map((b) => <span key={b}>{BRANCH_LABEL[b]}</span>)}
        </div>
      )}
      {branches.map((b, i) => (
        <Handle key={b} id={b} type="source" position={Position.Bottom} title={BRANCH_LABEL[b]}
          style={{ left: branches.length === 1 ? "50%" : `${(i + 1) * (100 / (branches.length + 1))}%` }}
          className={cn("!h-3 !w-3 !border-2 !border-surface", b === "error" ? "!bg-bad" : b === "no" ? "!bg-muted" : "!bg-brand")} />
      ))}
    </div>
  );
}

const nodeTypes = { step: StepCard };

export interface CanvasProps {
  graph: FlowGraph; selected: string | null; problems: Set<string>; readOnly: boolean;
  onSelect: (id: string | null) => void; onChange: (g: FlowGraph) => void; onDelete: (id: string) => void; onRefused: (why: string) => void;
}

function Inner({ graph, selected, problems, readOnly, onSelect, onChange, onDelete, onRefused }: CanvasProps) {
  const nodes: Node<StepData>[] = useMemo(() => graph.nodes.map((n) => ({
    id: n.id, type: "step", position: { x: n.x, y: n.y }, data: { node: n, problem: problems.has(n.id), selected: selected === n.id },
    selected: selected === n.id, deletable: !readOnly && n.kind !== "trigger", draggable: !readOnly, ariaLabel: `${KIND_LABEL[n.kind]}: ${n.label || describeNode(n)}`,
  })), [graph.nodes, problems, selected, readOnly]);
  const edges: Edge[] = useMemo(() => graph.edges.map((e) => ({
    id: e.id, source: e.from, target: e.to, sourceHandle: e.branch, label: e.branch === "next" ? undefined : BRANCH_LABEL[e.branch],
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: e.branch === "error" ? "var(--color-bad)" : "var(--color-line-strong)" },
    style: { stroke: e.branch === "error" ? "var(--color-bad)" : "var(--color-line-strong)", strokeWidth: 1.5, strokeDasharray: e.branch === "error" ? "5 4" : undefined },
    labelStyle: { fill: "var(--color-muted)", fontSize: 11 }, labelBgStyle: { fill: "var(--color-surface)" }, deletable: !readOnly,
  })), [graph.edges, readOnly]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    let next = graph;
    let moved = false;
    for (const ch of changes) {
      if (ch.type === "position" && ch.position && !readOnly) { next = { ...next, nodes: next.nodes.map((n) => (n.id === ch.id ? { ...n, x: Math.round(ch.position!.x), y: Math.round(ch.position!.y) } : n)) }; moved = true; }
      if (ch.type === "select" && ch.selected) onSelect(ch.id);
      if (ch.type === "remove" && !readOnly) onDelete(ch.id);
    }
    if (moved) onChange(next);
  }, [graph, readOnly, onSelect, onChange, onDelete]);

  const onConnect = useCallback((c: Connection) => {
    if (readOnly || !c.source || !c.target) return;
    const g = connect(graph, c.source, c.target, (c.sourceHandle ?? "next") as Branch);
    if (!g) { onRefused("That join would make a loop or point back at the trigger."); return; }
    onChange(g);
  }, [graph, readOnly, onChange, onRefused]);

  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onConnect={onConnect}
      onEdgesDelete={(del) => onChange({ ...graph, edges: graph.edges.filter((e) => !del.some((d) => d.id === e.id)) })}
      onPaneClick={() => onSelect(null)} nodesConnectable={!readOnly} fitView fitViewOptions={{ padding: 0.25, maxZoom: 1 }} minZoom={0.3} maxZoom={1.5}
      deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]} proOptions={{ hideAttribution: true }} className="flow-canvas" aria-label="Flow canvas">
      <Background gap={24} size={1} color="var(--color-line)" />
      <Controls showInteractive={false} className="!shadow-none [&_button]:!border-line [&_button]:!bg-surface [&_button]:!text-fg [&_button:hover]:!bg-hover [&_svg]:!fill-current" />
    </ReactFlow>
  );
}

export function FlowCanvas(props: CanvasProps) {
  return <ReactFlowProvider><Inner {...props} /></ReactFlowProvider>;
}
