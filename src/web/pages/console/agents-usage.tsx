/**
 * OPS1: Agents and AI, the "AI usage" tab. The account's AI units and calls for the last 7 or 30 days, then the
 * workspaces that used the most, heaviest first (sort by units or calls). Read only.
 */
import { useQuery } from "@tanstack/react-query";
import { IconSparkle } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { consoleKeys, listQuery } from "@/web/lib/console-api";
import { DataTable } from "./components/data-table";
import { useUrlParams, type FilterDef } from "./components/filter-bar";
import { formatDay, formatNumber, KpiTile } from "./components/kpi";
import { WorkspaceLink, type AiUsagePage, type AiUsageRow } from "./agents-shared";

const FILTERS: FilterDef[] = [
  { key: "days", label: "Window", initial: "7", options: [{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }] },
];

export function AiUsageTab() {
  const url = useUrlParams(FILTERS, { sort: "units:desc" });
  const days = url.values.days === "30" ? "30" : "7";
  // The account total and the window come with every page; one row is enough to read them.
  const totals = useQuery({
    queryKey: consoleKeys.list("/agents/ai-usage/totals", { days }),
    queryFn: () => api.get<AiUsagePage>(`/console/agents/ai-usage${listQuery({ days, limit: "1" })}`),
  });
  const account = totals.data?.account;
  const window = totals.data?.window;
  const hint = window ? `${formatDay(window.from, "medium")} to ${formatDay(window.to, "medium")}` : undefined;
  const share = (r: AiUsageRow) => (account && account.units > 0 ? `${Math.round((r.units / account.units) * 1000) / 10}%` : "");
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <KpiTile label="AI units, all workspaces" value={account?.units ?? null} hint={hint} loading={totals.isPending} testId="console-agents-usage-units" />
        <KpiTile label="AI calls, all workspaces" value={account?.calls ?? null} hint={hint} loading={totals.isPending} testId="console-agents-usage-calls" />
      </div>
      {totals.error && <p className="text-sm text-bad" role="alert">Couldn't load the account totals. The list below still works.</p>}
      <DataTable<AiUsageRow>
        label="AI usage by workspace" path="/agents/ai-usage"
        filters={FILTERS}
        defaultSort="units:desc"
        rowKey={(r) => r.orgId}
        empty={{ icon: <IconSparkle />, title: "No AI use in this window", body: "Workspaces that used AI features or agents in the window show here, heaviest first." }}
        columns={[
          { key: "workspace", header: "Workspace", cell: (r) => <WorkspaceLink id={r.orgId} name={r.workspaceName} /> },
          { key: "units", header: "Units", sort: "units", align: "right", cell: (r) => <span className="tabular-nums">{formatNumber(r.units)}</span> },
          { key: "calls", header: "Calls", sort: "calls", align: "right", cell: (r) => <span className="tabular-nums">{formatNumber(r.calls)}</span> },
          { key: "share", header: "Share of units", align: "right", cell: (r) => <span className="tabular-nums text-muted">{share(r)}</span> },
          { key: "days", header: "Days used", align: "right", cell: (r) => <span className="tabular-nums">{r.days}</span> },
        ]}
      />
    </div>
  );
}
