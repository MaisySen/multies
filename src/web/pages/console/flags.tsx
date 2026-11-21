/**
 * OPS1: Feature flags. Every on/off switch from the registry (src/shared/feature-flags.ts), grouped, with its value
 * for everyone and where that comes from (default, changed for everyone, locked for everyone), how many workspaces
 * have their own setting, and a "Set at deploy" note for flags read when the server starts. A row opens the flag's
 * detail (flags-detail.tsx) in a dialog named in the address (?flag=<key>).
 */
import { Link, useLocation, useSearchParams } from "react-router";
import { PageHeader } from "@/web/components/ui/misc";
import { IconFlag } from "@/web/components/ui/icon";
import { num } from "@/web/lib/format";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { GROUP_FILTER, type ConsoleFlag } from "./flags-api";
import { FlagDetailDialog } from "./flags-detail";
import { DeployNote, FlagState, PropagationNote, platformSource } from "./flags-parts";

const STATE_FILTER: FilterDef = {
  key: "state", label: "Show", initial: "",
  options: [
    { value: "", label: "All flags" },
    { value: "changed", label: "Changed for everyone" },
    { value: "workspaces", label: "With workspace settings" },
    { value: "deploy", label: "Set at deploy" },
  ],
};
const FILTERS: FilterDef[] = [GROUP_FILTER, STATE_FILTER];

export function ConsoleFlagsPage() {
  const loc = useLocation();
  const [params, setParams] = useSearchParams();
  const open = params.get("flag");
  const hrefFor = (key: string) => {
    const next = new URLSearchParams(loc.search);
    next.set("flag", key);
    return `/console/flags?${next.toString()}`;
  };
  const close = () => setParams((prev) => { const next = new URLSearchParams(prev); next.delete("flag"); return next; }, { replace: true });

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Product" title="Feature flags"
        description="Each switch starts from the deploy settings. Change it for everyone here, or for one workspace from that workspace's Flags tab." />
      <PropagationNote />
      <DataTable<ConsoleFlag>
        label="Feature flags" path="/flags" pageSize={200}
        search={{ placeholder: "Search flags" }} filters={FILTERS} defaultSort="group:asc"
        rowKey={(f) => f.key} rowHref={(f) => hrefFor(f.key)}
        empty={{ icon: <IconFlag />, title: "No flags match", body: "Try another search or group." }}
        columns={[
          { key: "flag", header: "Flag", sort: "label", className: "min-w-[16rem]", cell: (f) => (
            <span className="flex flex-col">
              <Link to={hrefFor(f.key)} className="font-medium hover:underline" data-testid={`console-flags-row-${f.key}`}>{f.label}</Link>
              <span className="line-clamp-1 text-xs text-muted" title={f.description}>{f.description}</span>
            </span>
          ) },
          { key: "group", header: "Group", sort: "group", cell: (f) => <span className="whitespace-nowrap text-muted">{f.group}</span> },
          { key: "state", header: "For everyone", cell: (f) => (
            <span className="flex flex-col items-start gap-1">
              <FlagState on={f.effective} source={f.runtime ? platformSource(f.globalOverride) : "default"} testId={`console-flags-state-${f.key}`} />
              {!f.runtime && <DeployNote reason={f.bootReason} />}
            </span>
          ) },
          { key: "workspaces", header: "Workspaces with own setting", sort: "workspaces", align: "right", cell: (f) => (
            f.scope === "global"
              ? <span className="text-xs text-subtle" title="This flag has one setting for the whole platform.">Platform only</span>
              : <span className="tabular-nums">{num(f.workspaceOverrideCount)}</span>
          ) },
        ]}
      />
      <FlagDetailDialog flagKey={open} onClose={close} />
    </div>
  );
}
