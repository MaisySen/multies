import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  IconApprovals, IconArrowLeft, IconBranch, IconChevronRight, IconCircleStop, IconHourglass, IconLayers, IconPlay, IconPlus, IconRefresh, IconTrash, IconWarning, IconWorkflow, IconZap,
} from "@/web/components/ui/icon";
import { Badge, Card, EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Input } from "@/web/components/ui/input";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { useMediaQuery } from "@/web/lib/use-compact";
import { cn } from "@/web/lib/cn";
import { KIND_LABEL, describeNode, triggerNode, validateGraph, type Branch, type FlowGraph, type FlowTrigger, type NodeKind } from "@/shared/flows";
import { flowKeys, useFlow, type FlowDto } from "./api";
import { StepForm } from "./inspector";
import { BRANCH_LABEL, addStepAfter, branchesOf, readingOrder, removeStep, tidy, updateNode } from "./graph-edit";
import { useIsAdmin } from "./hub";
import { RunsList } from "./runs";

const FlowCanvas = lazy(() => import("./canvas"));
const ADDABLE: { kind: NodeKind; label: string; body: string; Icon: typeof IconZap }[] = [
  { kind: "action", label: "Action", body: "Make a task, notify, post, send to a webhook or a digest.", Icon: IconWorkflow },
  { kind: "condition", label: "Condition", body: "Go one way when something is true, another when not.", Icon: IconBranch },
  { kind: "wait", label: "Wait", body: "Pause for minutes, hours or days.", Icon: IconHourglass },
  { kind: "approval", label: "Approval", body: "A person approves before the flow goes on.", Icon: IconApprovals },
  { kind: "stop", label: "Stop", body: "End the flow on this path.", Icon: IconCircleStop },
];

/** R90: one flow. Canvas with a side panel on wide screens; a step list with sheets on phones. */
export function FlowEditorPage() {
  const { id = "" } = useParams();
  const q = useFlow(id);
  if (q.isPending) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-10 w-72" /><Skeleton className="h-[520px]" /></div>;
  if (q.isError) return <Card className="p-6"><EmptyState icon={<IconWorkflow />} title="This flow did not load" body="It may have been deleted, or the connection dropped." action={<div className="flex gap-2"><Button variant="outline" onClick={() => void q.refetch()}>Try again</Button><Link className="self-center text-[13px] underline" to="/app/automations">All flows</Link></div>} /></Card>;
  return <Editor key={q.data.id + q.data.updatedAt.slice(0, 0)} flow={q.data} />;
}

function Editor({ flow }: { flow: FlowDto }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const isAdmin = useIsAdmin();
  const wide = useMediaQuery("(min-width: 768px)");
  const [graph, setGraph] = useState<FlowGraph>(flow.graph);
  const [name, setName] = useState(flow.name);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "run" | "check" | "toggle" | "delete">("");
  const [adding, setAdding] = useState<{ from: string; branch: Branch } | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<"build" | "runs">("build");
  const problems = useMemo(() => validateGraph(graph), [graph]);
  const problemIds = useMemo(() => new Set(problems.map((p) => p.nodeId).filter(Boolean) as string[]), [problems]);
  const trigger = (triggerNode(graph)?.config.trigger ?? "manual") as FlowTrigger;
  const readOnly = !isAdmin;
  const change = (g: FlowGraph) => { setGraph(g); setDirty(true); };
  const latest = useRef({ graph, name }); latest.current = { graph, name };

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: flowKeys.one(flow.id) }), qc.invalidateQueries({ queryKey: flowKeys.all })]); };
  const save = async (extra: { enabled?: boolean } = {}) => {
    setBusy(extra.enabled !== undefined ? "toggle" : "save");
    try {
      await api.patch(`/flows/${flow.id}`, { name: latest.current.name.trim() || flow.name, graph: latest.current.graph, ...extra });
      setDirty(false);
      toast.success(extra.enabled === true ? "Flow is on" : extra.enabled === false ? "Flow is off" : "Saved");
      await refresh();
      return true;
    } catch (e) { showError(e as Error); return false; } finally { setBusy(""); }
  };
  const runNow = async () => {
    if (dirty && !(await save())) return;
    setBusy("run");
    try {
      const r = await api.post<{ run: { id: string; status: string } }>(`/flows/${flow.id}/run`, {});
      toast.success(r.run.status === "failed" ? "The run failed. Opening its log." : "Ran it. Opening the log.");
      nav(`/app/automations/runs/${r.run.id}`);
    } catch (e) { showError(e as Error); } finally { setBusy(""); }
  };
  const checkNow = async () => {
    setBusy("check");
    try { const r = await api.post<{ started: number; note: string }>(`/flows/${flow.id}/check`, {}); toast.success(r.started ? `${r.note}. Started ${r.started} ${r.started === 1 ? "run" : "runs"}.` : r.note); await refresh(); }
    catch (e) { showError(e as Error); } finally { setBusy(""); }
  };
  const del = async () => {
    setBusy("delete");
    try { await api.del(`/flows/${flow.id}`); toast.success(`${flow.name} deleted`); await qc.invalidateQueries({ queryKey: flowKeys.all }); nav("/app/automations"); }
    catch (e) { showError(e as Error); setBusy(""); }
  };
  const deleteStep = (nodeId: string) => {
    const before = graph;
    const n = graph.nodes.find((x) => x.id === nodeId);
    if (!n || n.kind === "trigger") return;
    change(removeStep(graph, nodeId));
    setSelected(null); setSheet(null);
    toast(`${n.label || KIND_LABEL[n.kind]} removed`, { action: { label: "Undo", onClick: () => { setGraph(before); setDirty(true); } } });
  };
  const addAfter = (from: string, branch: Branch, kind: NodeKind) => {
    const r = addStepAfter(graph, from, branch, kind);
    change(r.graph);
    setAdding(null);
    if (wide) setSelected(r.id); else setSheet(r.id);
  };
  const freeBranch = (nodeId: string): Branch | null => {
    const n = graph.nodes.find((x) => x.id === nodeId);
    if (!n) return null;
    const bs = branchesOf(n.kind);
    return bs.find((b) => !graph.edges.some((e) => e.from === nodeId && e.branch === b)) ?? bs[0] ?? null;
  };
  const sel = graph.nodes.find((n) => n.id === selected) ?? null;
  const sheetNode = graph.nodes.find((n) => n.id === sheet) ?? null;
  const watching = trigger === "page_changed" || trigger === "feed_item";

  // Keyboard: A adds a step after the selected one, Ctrl S saves.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); return; }
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key.toLowerCase() === "a" && !e.ctrlKey && !e.metaKey && selected) { const b = freeBranch(selected); if (b) { e.preventDefault(); setAdding({ from: selected, branch: b }); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex min-h-0 flex-col">
      <Link to="/app/automations" className="mb-2 inline-flex w-fit items-center gap-1 text-[13px] text-muted hover:text-fg max-sm:min-h-11"><IconArrowLeft className="h-4 w-4" aria-hidden />Automations</Link>
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <Input aria-label="Flow name" value={name} maxLength={80} readOnly={readOnly} onChange={(e) => { setName(e.target.value); setDirty(true); }}
          className="h-9 min-w-0 flex-1 border-transparent bg-transparent px-1 text-[20px] font-semibold hover:border-line focus:border-line-strong sm:max-w-md" />
        <div className="flex flex-wrap items-center gap-2">
          {problems.length > 0 && <Badge tone="warn"><IconWarning className="h-3.5 w-3.5" aria-hidden />{problems.length} to fix</Badge>}
          {dirty && <span className="text-[12px] text-subtle" aria-live="polite">Not saved</span>}
          {isAdmin && <Switch checked={flow.enabled} disabled={busy === "toggle" || (!flow.enabled && problems.length > 0)} onChange={(v) => void save({ enabled: v })} label={flow.enabled ? "Turn the flow off" : "Turn the flow on"} />}
          <span className="text-[13px] text-muted">{flow.enabled ? "On" : "Off"}</span>
          {isAdmin && watching && flow.enabled && <Button variant="outline" size="sm" onClick={() => void checkNow()} disabled={!!busy}><IconRefresh className="h-4 w-4" />{busy === "check" ? "Checking" : "Check now"}</Button>}
          {isAdmin && <Button variant="outline" size="sm" onClick={() => void runNow()} disabled={!!busy || problems.length > 0} title={problems.length ? "Fix the steps marked first" : "Runs the flow once with sample values"}><IconPlay className="h-4 w-4" />{busy === "run" ? "Running" : "Run now"}</Button>}
          {isAdmin && <Button size="sm" onClick={() => void save()} disabled={!dirty || !!busy}>{busy === "save" ? "Saving" : "Save"}</Button>}
        </div>
      </header>
      {flow.watch?.lastError && <p className="mb-3 rounded-lg border border-bad/40 bg-bad-soft/40 px-3 py-2 text-[13px]">Last check: {flow.watch.lastError}</p>}
      {flow.watch && !flow.watch.lastError && flow.watch.lastCheckedAt && <p className="mb-3 text-[12px] text-subtle">Last checked {timeAgo(flow.watch.lastCheckedAt)}{flow.watch.nextCheckAt && `, next ${timeAgo(flow.watch.nextCheckAt)}`}.</p>}
      <div role="tablist" aria-label="Flow" className="mb-3 inline-flex w-fit rounded-lg border border-line bg-surface p-0.5 text-[13px]">
        {(["build", "runs"] as const).map((k) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn("rounded-md px-3 py-1.5 font-medium transition-colors duration-150 max-sm:min-h-11", tab === k ? "bg-brand text-brand-fg" : "text-muted hover:text-fg")}>{k === "build" ? "Steps" : "Runs"}</button>)}
      </div>
      {tab === "runs" ? <RunsList flowId={flow.id} /> : wide ? (
        <div className="grid min-h-[560px] gap-3 lg:grid-cols-[1fr_360px]">
          <div className="relative h-[calc(100dvh-260px)] min-h-[520px] overflow-hidden rounded-xl border border-line bg-bg">
            {isAdmin && (
              <div className="absolute left-3 top-3 z-10 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => { const from = selected ?? triggerNode(graph)?.id; const b = from ? freeBranch(from) : null; if (from && b) setAdding({ from, branch: b }); else toast("Pick a step that can lead on first."); }}><IconPlus className="h-4 w-4" />Add step</Button>
                <Button size="sm" variant="ghost" onClick={() => change(tidy(graph))}><IconLayers className="h-4 w-4" />Tidy up</Button>
              </div>
            )}
            <Suspense fallback={<Skeleton className="h-full w-full" />}>
              <FlowCanvas graph={graph} selected={selected} problems={problemIds} readOnly={readOnly} onSelect={setSelected} onChange={change} onDelete={deleteStep} onRefused={(w) => toast.error(w)} />
            </Suspense>
          </div>
          <aside aria-label="Step settings" className="min-w-0 rounded-xl border border-line bg-surface p-4 lg:max-h-[calc(100dvh-260px)] lg:overflow-y-auto">
            {sel ? (
              <>
                <h2 className="mb-3 text-[15px] font-semibold">{KIND_LABEL[sel.kind]}</h2>
                <StepForm node={sel} trigger={trigger} readOnly={readOnly} onChange={(p) => change(updateNode(graph, sel.id, p))} onDelete={() => deleteStep(sel.id)} />
                {!readOnly && freeBranch(sel.id) && <AddButtons node={sel.id} kind={sel.kind} graph={graph} onAdd={(b) => setAdding({ from: sel.id, branch: b })} />}
              </>
            ) : <Overview problems={problems} onPick={(nid) => setSelected(nid)} readOnly={readOnly} />}
            {isAdmin && !sel && <Button className="mt-6" variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}><IconTrash className="h-4 w-4" />Delete flow</Button>}
          </aside>
        </div>
      ) : (
        <PhoneSteps graph={graph} problems={problemIds} readOnly={readOnly} onOpen={setSheet} onAdd={(from, branch) => setAdding({ from, branch })} onDeleteFlow={() => setConfirmDelete(true)} />
      )}
      <Dialog open={!!adding} onClose={() => setAdding(null)} title="Add a step" description={adding ? `After ${describeNode(graph.nodes.find((n) => n.id === adding.from)!)}${adding.branch !== "next" ? `, on ${BRANCH_LABEL[adding.branch]}` : ""}` : undefined}>
        <ul className="grid gap-2">
          {ADDABLE.map((a) => (
            <li key={a.kind}><button onClick={() => adding && addAfter(adding.from, adding.branch, a.kind)} className="flex w-full items-start gap-3 rounded-lg border border-line p-3 text-left transition-colors duration-150 hover:border-line-strong hover:bg-hover/40 focus-visible:outline-2 focus-visible:outline-brand">
              <a.Icon className="mt-0.5 h-4 w-4 text-brand-hover" aria-hidden /><span><span className="block text-[14px] font-medium">{a.label}</span><span className="block text-[13px] text-muted">{a.body}</span></span>
            </button></li>
          ))}
        </ul>
      </Dialog>
      <Dialog open={!!sheetNode} onClose={() => setSheet(null)} title={sheetNode ? KIND_LABEL[sheetNode.kind] : ""} footer={<Button onClick={() => setSheet(null)}>Done</Button>}>
        {sheetNode && <StepForm node={sheetNode} trigger={trigger} readOnly={readOnly} onChange={(p) => change(updateNode(graph, sheetNode.id, p))} onDelete={() => deleteStep(sheetNode.id)} />}
      </Dialog>
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${flow.name}?`} description="The flow stops at once and waiting runs are stopped. Past runs stay in the log for 30 days."
        footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="danger" onClick={() => void del()} disabled={busy === "delete"}>Delete flow</Button></>} />
    </div>
  );
}

function AddButtons({ node, kind, graph, onAdd }: { node: string; kind: NodeKind; graph: FlowGraph; onAdd: (b: Branch) => void }) {
  return (
    <div className="mt-5 border-t border-line pt-4">
      <p className="mb-2 text-[12px] font-medium text-subtle">Add a step</p>
      <div className="flex flex-wrap gap-2">
        {branchesOf(kind).map((b) => (
          <Button key={b} size="sm" variant="outline" onClick={() => onAdd(b)}><IconPlus className="h-4 w-4" />{b === "next" ? "Next" : BRANCH_LABEL[b]}{graph.edges.some((e) => e.from === node && e.branch === b) ? " (in between)" : ""}</Button>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-subtle">Shortcut: A</p>
    </div>
  );
}

function Overview({ problems, onPick, readOnly }: { problems: ReturnType<typeof validateGraph>; onPick: (id: string) => void; readOnly: boolean }) {
  return (
    <div className="text-[13px]">
      <h2 className="mb-2 text-[15px] font-semibold">How it works</h2>
      <p className="text-muted">{readOnly ? "Only admins change flows. Pick a step to see its settings." : "Pick a step to change it. Drag from a dot under a step to another step to join them. Delete removes the picked step, with undo."}</p>
      {problems.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 font-medium">To fix before it can run</p>
          <ul className="space-y-1.5">
            {problems.slice(0, 8).map((p, i) => <li key={i}>{p.nodeId ? <button className="text-left text-fg underline-offset-2 hover:underline" onClick={() => onPick(p.nodeId!)}>{p.message}</button> : <span>{p.message}</span>}</li>)}
          </ul>
        </div>
      ) : <p className="mt-4 rounded-lg bg-ok-soft px-3 py-2 text-fg">Every step is ready.</p>}
    </div>
  );
}

/** Phones: the flow as a readable list; each step opens a sheet. */
function PhoneSteps({ graph, problems, readOnly, onOpen, onAdd, onDeleteFlow }: {
  graph: FlowGraph; problems: Set<string>; readOnly: boolean; onOpen: (id: string) => void; onAdd: (from: string, b: Branch) => void; onDeleteFlow: () => void;
}) {
  const rows = readingOrder(graph);
  return (
    <div>
      <ol aria-label="Steps" className="space-y-2">
        {rows.map(({ node, depth, via }, i) => (
          <li key={node.id} style={{ marginLeft: Math.min(depth, 3) * 16 }}>
            {via && via !== "next" && <p className="mb-1 text-[12px] font-medium text-subtle">{BRANCH_LABEL[via]}</p>}
            <button onClick={() => onOpen(node.id)} className={cn("flex min-h-14 w-full items-center gap-3 rounded-xl border bg-surface p-3 text-left", problems.has(node.id) ? "border-warn" : "border-line")}>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-fill text-[12px] font-semibold tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1"><span className="block text-[11px] font-semibold uppercase tracking-wide text-subtle">{KIND_LABEL[node.kind]}</span><span className="block truncate text-[14px] font-medium">{node.label || describeNode(node)}</span></span>
              {problems.has(node.id) && <IconWarning className="h-4 w-4 text-warn" aria-label="Needs a look" />}
              <IconChevronRight className="h-4 w-4 text-subtle" aria-hidden />
            </button>
            {!readOnly && branchesOf(node.kind).filter((b) => !graph.edges.some((e) => e.from === node.id && e.branch === b) && (b === "next" || node.kind === "condition")).map((b) => (
              <button key={b} onClick={() => onAdd(node.id, b)} className="mt-1 flex min-h-11 w-full items-center justify-center gap-1 rounded-lg border border-dashed border-line text-[13px] text-muted hover:text-fg"><IconPlus className="h-4 w-4" aria-hidden />Add step{b !== "next" ? ` on ${BRANCH_LABEL[b]}` : ""}</button>
            ))}
          </li>
        ))}
      </ol>
      {!readOnly && <Button className="mt-6" variant="ghost" size="sm" onClick={onDeleteFlow}><IconTrash className="h-4 w-4" />Delete flow</Button>}
    </div>
  );
}
