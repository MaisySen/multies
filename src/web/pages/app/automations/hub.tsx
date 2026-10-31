import { Suspense } from "react";
import { lazyPage } from "@/web/components/lazy-page";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconChevronRight, IconPlus, IconWorkflow, IconZap } from "@/web/components/ui/icon";
import { Badge, Card, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { useMe } from "@/web/lib/queries";
import { FLOW_TEMPLATES, TRIGGER_LABEL, emptyGraph, type FlowTemplate } from "@/shared/flows";
import { flowKeys, RUN_STATUS, useFlows, type FlowDto, type RunStatus } from "./api";
import { RunsList } from "./runs";

const RulesPageLazy = lazyPage(() => import("../work/automations"), "AutomationsPage");
const RulesPage = () => <RulesPageLazy embedded />;

type Tab = "flows" | "rules" | "runs";
const TABS: { key: Tab; label: string }[] = [{ key: "flows", label: "Flows" }, { key: "rules", label: "Rules" }, { key: "runs", label: "Runs" }];

/** R90: one home for automations (layout plan, under Agents): flows, the simple rules, and every run. */
export function AutomationsHubPage() {
  const [params, setParams] = useSearchParams();
  const flows = useFlows();
  const off = flows.error instanceof ApiError && flows.error.status === 404;
  const tab: Tab = off ? "rules" : ((params.get("tab") as Tab) || "flows");
  const nav = useNavigate();
  const isAdmin = useIsAdmin();
  const create = useCreateFlow();
  if (off) return <Suspense fallback={<Skeleton className="h-64" />}><RulesPage /></Suspense>;
  return (
    <div>
      <PageHeader title="Automations" description="Flows, rules and their runs, in one place. They make tasks, notify your team and post in channels."
        actions={isAdmin && tab === "flows" ? <Button onClick={() => void create("New flow", emptyGraph("manual")).then((id) => id && nav(`/app/automations/flows/${id}`))}><IconPlus className="h-4 w-4" />New flow</Button> : undefined} />
      <div role="tablist" aria-label="Automations" className="mb-5 inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-surface p-0.5 text-[13px]">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setParams(t.key === "flows" ? {} : { tab: t.key }, { replace: true })}
            className={`shrink-0 rounded-md px-3 py-1.5 font-medium transition-colors duration-150 max-sm:min-h-11 ${tab === t.key ? "bg-brand text-brand-fg" : "text-muted hover:text-fg"}`}>{t.label}</button>
        ))}
      </div>
      {tab === "flows" && <FlowsTab isAdmin={isAdmin} />}
      {tab === "rules" && <Suspense fallback={<Skeleton className="h-64" />}><RulesPage /></Suspense>}
      {tab === "runs" && <RunsList />}
    </div>
  );
}

export function useIsAdmin() {
  const me = useMe();
  const role = (me.data as { organization?: { role?: string } } | undefined)?.organization?.role;
  return role === "owner" || role === "admin";
}

export function useCreateFlow() {
  const qc = useQueryClient();
  return async (name: string, graph: FlowTemplate["graph"]) => {
    try {
      const r = await api.post<{ flow: FlowDto }>("/flows", { name, graph });
      await qc.invalidateQueries({ queryKey: flowKeys.all });
      return r.flow.id;
    } catch (e) { showError(e as Error); return null; }
  };
}

function FlowsTab({ isAdmin }: { isAdmin: boolean }) {
  const q = useFlows();
  const qc = useQueryClient();
  const nav = useNavigate();
  const create = useCreateFlow();
  const toggle = async (f: FlowDto) => {
    try {
      await api.patch(`/flows/${f.id}`, { enabled: !f.enabled });
      toast.success(f.enabled ? `${f.name} is off` : `${f.name} is on`);
      await qc.invalidateQueries({ queryKey: flowKeys.all });
    } catch (e) { showError(e as Error); }
  };
  const pickTemplate = async (t: FlowTemplate) => { const id = await create(t.name, t.graph); if (id) nav(`/app/automations/flows/${id}`); };
  if (q.isPending) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-40" /></div>;
  if (q.isError) return <Card className="p-6"><EmptyState icon={<IconWorkflow />} title="Flows did not load" body="Check your connection and try again." action={<Button variant="outline" onClick={() => void q.refetch()}>Try again</Button>} /></Card>;
  const list = q.data.flows;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <section aria-label="Your flows" className="min-w-0">
        {!list.length ? (
          <Card className="p-2"><EmptyState icon={<IconWorkflow />} title="No flows yet" body={isAdmin ? "A flow is a trigger and the steps that follow, with conditions, waits and approvals. Start from a template below." : "Admins make flows. You can see them here once they do."} /></Card>
        ) : (
          <Card className="divide-y divide-line">
            {list.map((f) => (
              <div key={f.id} className="flex items-center gap-3 p-4 transition-colors duration-150 hover:bg-hover/50">
                {isAdmin && <Switch checked={f.enabled} onChange={() => void toggle(f)} label={`Turn ${f.name} ${f.enabled ? "off" : "on"}`} />}
                <Link to={`/app/automations/flows/${f.id}`} className="min-w-0 flex-1 rounded focus-visible:outline-2 focus-visible:outline-brand">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium" title={f.name}>{f.name}</span>
                    {!f.enabled && <Badge tone="neutral">Off</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-[13px] text-muted">{TRIGGER_LABEL[f.trigger] ?? "Pick a trigger"}, then {Math.max(0, f.graph.nodes.length - 1)} {f.graph.nodes.length - 1 === 1 ? "step" : "steps"}</p>
                  <p className="mt-1 text-[12px] text-subtle">
                    Ran {f.runCount} {f.runCount === 1 ? "time" : "times"}{f.lastRunAt && `, last ${timeAgo(f.lastRunAt)}`}
                    {f.lastStatus && f.lastStatus in RUN_STATUS && <> · <span className={f.lastStatus === "failed" ? "text-bad" : ""}>{RUN_STATUS[f.lastStatus as RunStatus].label}</span></>}
                    {f.watch?.lastError && <span className="text-bad"> · {f.watch.lastError}</span>}
                  </p>
                </Link>
                <IconChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
              </div>
            ))}
          </Card>
        )}
        {isAdmin && (
          <div className="mt-6">
            <h2 className="mb-3 text-[13px] font-semibold text-fg">Start from a template</h2>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {FLOW_TEMPLATES.map((t) => (
                <li key={t.key}>
                  <button onClick={() => void pickTemplate(t)} className="flex h-full w-full flex-col rounded-lg border border-line bg-surface p-4 text-left transition-colors duration-150 hover:border-line-strong hover:bg-hover/40 focus-visible:outline-2 focus-visible:outline-brand">
                    <span className="flex items-center gap-1.5 text-[14px] font-medium"><IconZap className="h-3.5 w-3.5 text-brand-hover" aria-hidden />{t.name}</span>
                    <span className="mt-1 text-[13px] text-muted">{t.description}</span>
                    <span className="mt-2 text-[12px] text-subtle">{TRIGGER_LABEL[t.trigger]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <aside aria-label="Usage" className="space-y-4">
        <Card className="p-4">
          <div className="flex items-center justify-between text-[13px]"><span className="font-medium">Runs this month</span><span className="tabular-nums text-muted">{q.data.usage.used.toLocaleString()} of {q.data.usage.limit.toLocaleString()}</span></div>
          <p className="mt-2 text-[12px] text-subtle">Flows and rules share the plan's monthly runs.</p>
        </Card>
        <Card className="p-4 text-[13px]">
          <p className="font-medium">Other automations</p>
          <ul className="mt-2 space-y-2 text-muted">
            <li><Link className="text-fg underline underline-offset-2 hover:text-brand-hover" to="/app/tools/workflows">Tool workflows</Link>: turn files into PDFs, compress and more.</li>
            <li><Link className="text-fg underline underline-offset-2 hover:text-brand-hover" to="/app/agents">Agent triggers</Link>: on each agent's page.</li>
            <li><Link className="text-fg underline underline-offset-2 hover:text-brand-hover" to="/app/settings/apps/webhooks">Webhooks</Link>: send events to other systems.</li>
          </ul>
        </Card>
      </aside>
    </div>
  );
}
