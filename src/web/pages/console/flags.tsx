/**
 * OPS1: Feature flags. Every on/off switch from the registry (src/shared/feature-flags.ts), grouped, with its value
 * for everyone and where that comes from (default, changed for everyone, locked for everyone), how many workspaces
 * have their own setting, and a "Set at deploy" tag for flags read when the server starts (from the API's `runtime`,
 * never a list kept here). A row opens the flag's detail (flags-detail.tsx) in a dialog named in the address
 * (?flag=<key>).
 *
 * The list opens on "Changed from default" when at least one flag differs from its default (for everyone or for a
 * workspace), otherwise on all flags. The chip shows which, and once the operator picks another it stays in the address.
 */
import { useMemo } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/web/components/ui/misc";
import { IconFlag } from "@/web/components/ui/icon";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { num } from "@/web/lib/format";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { GROUP_FILTER, flagKeys, flagsApi, type ConsoleFlag } from "./flags-api";
import { FlagDetailDialog } from "./flags-detail";
import { DeployNote, FlagState, FlagTag, PLATFORM_ONLY_WHY, PropagationNote, platformSource } from "./flags-parts";

const stateFilter = (initial: "modified" | "all"): FilterDef => ({
  key: "state", label: "Show", initial,
  options: [
    { value: "modified", label: "Changed from default" },
    { value: "changed", label: "Changed for everyone" },
    { value: "workspaces", label: "With workspace settings" },
    { value: "deploy", label: "Set at deploy" },
    { value: "all", label: "All flags" },
  ],
});

export function ConsoleFlagsPage() {
  const loc = useLocation();
  const [params, setParams] = useSearchParams();
  const open = params.get("flag");
  const chosen = params.get("state");
  // Only needed while the address names no filter: is anything changed from its default?
  const any = useQuery({ queryKey: flagKeys.anyChanged, queryFn: flagsApi.anyChanged, enabled: chosen === null });
  const initial = any.data ? "modified" : "all";
  const filters = useMemo<FilterDef[]>(() => [GROUP_FILTER, stateFilter(initial)], [initial]);
  const hrefFor = (key: string) => {
    const next = new URLSearchParams(loc.search);
    next.set("flag", key);
    return `/console/flags?${next.toString()}`;
  };
  const close = () => setParams((prev) => { const next = new URLSearchParams(prev); next.delete("flag"); return next; }, { replace: true });
  const deciding = chosen === null && any.isPending;

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Product" title="Feature flags"
        description="Each switch starts from the deploy settings. Change it for everyone here, or for one workspace from that workspace's Flags tab." />
      <PropagationNote />
      {deciding ? <SkeletonRows rows={6} label="Loading feature flags" /> : (
        <DataTable<ConsoleFlag>
          label="Feature flags" path="/flags" pageSize={200} minWidth={640}
          search={{ placeholder: "Search flags" }} filters={filters} defaultSort="group:asc"
          rowKey={(f) => f.key} rowHref={(f) => hrefFor(f.key)}
          empty={{ icon: <IconFlag />, title: "No flags match", body: "Try another search or group." }}
          columns={[
            { key: "flag", header: "Flag", sort: "label", className: "min-w-[11rem] sm:min-w-[16rem]", cell: (f) => (
              <span className="flex flex-col">
                <Link to={hrefFor(f.key)} className="font-medium hover:underline" title={f.key} data-testid={`console-flags-row-${f.key}`}>{f.label}</Link>
                <span className="line-clamp-1 text-xs text-muted" title={f.description}>{f.description}</span>
              </span>
            ) },
            { key: "group", header: "Group", sort: "group", secondary: true, cell: (f) => <span className="whitespace-nowrap text-muted">{f.group}</span> },
            { key: "state", header: "For everyone", cell: (f) => (
              <span className="flex flex-col items-start gap-1">
                <FlagState on={f.effective} source={f.runtime ? platformSource(f.globalOverride) : "default"} testId={`console-flags-state-${f.key}`} />
                {!f.runtime && <DeployNote reason={f.bootReason} />}
              </span>
            ) },
            { key: "workspaces", header: "Workspaces with own setting", sort: "workspaces", align: "right", cell: (f) => (
              f.scope === "global"
                ? <FlagTag why={PLATFORM_ONLY_WHY}>Platform only</FlagTag>
                : <span className="tabular-nums">{num(f.workspaceOverrideCount)}</span>
            ) },
          ]}
        />
      )}
      <FlagDetailDialog flagKey={open} onClose={close} />
    </div>
  );
}
