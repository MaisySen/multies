/**
 * OPS1: the Flags tab of a workspace's console page. It opens on the flags this workspace has its own setting for
 * ("Has own setting"), with "Show all flags" one click away. Each flag shows its value in this workspace and where that
 * comes from (default, changed for everyone, locked for everyone, this workspace). Ops admins and owners can turn a
 * flag on or off for this workspace or put it back to the default. Flags that cannot be changed for one workspace show a
 * small tag instead ("Platform only", "Locked", "Set at deploy") with the reason in its title; which ones is the
 * server's `blocked` field, never a list kept here.
 */
import { Link, useSearchParams } from "react-router";
import { Button } from "@/web/components/ui/button";
import { IconFlag } from "@/web/components/ui/icon";
import { DataTable } from "../components/data-table";
import type { FilterDef } from "../components/filter-bar";
import { useOperatorAction } from "../components/reason-dialog";
import { usePermission } from "../guard";
import { GROUP_FILTER, flagsApi, type WorkspaceFlagRow } from "../flags-api";
import { BlockedTag, DeployNote, FlagState, PropagationNote } from "../flags-parts";

const STATE_FILTER: FilterDef = {
  key: "state", label: "Show", initial: "own",
  options: [
    { value: "own", label: "Has own setting" },
    { value: "differs", label: "Differs from everyone" },
    { value: "all", label: "All flags" },
  ],
};
const FILTERS: FilterDef[] = [GROUP_FILTER, STATE_FILTER];

function Actions({ row, onSet, onReset }: { row: WorkspaceFlagRow; onSet: (r: WorkspaceFlagRow, value: boolean) => void; onReset: (r: WorkspaceFlagRow) => void }) {
  const turnOn = !row.effective;
  if (row.blocked) {
    return (
      <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
        <BlockedTag blocked={row.blocked} bootReason={row.bootReason} testId={`console-flags-ws-blocked-${row.key}`} />
        {row.blocked === "locked" && row.workspaceOverride && <Button size="sm" variant="ghost" onClick={() => onReset(row)} data-testid={`console-flags-ws-reset-${row.key}`}>Use the default</Button>}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap justify-end gap-1.5">
      <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => onSet(row, turnOn)} data-testid={`console-flags-ws-set-${row.key}`}>{turnOn ? "Turn on" : "Turn off"}</Button>
      {row.workspaceOverride && <Button size="sm" variant="ghost" className="whitespace-nowrap" onClick={() => onReset(row)} data-testid={`console-flags-ws-reset-${row.key}`}>Use the default</Button>}
    </span>
  );
}

export function WorkspaceFlagsTab({ orgId }: { orgId: string }) {
  const canChange = usePermission("flags.workspace");
  const [params, setParams] = useSearchParams();
  const state = params.get("state") ?? STATE_FILTER.initial;
  const plainDefault = state === "own" && !params.get("q") && !params.get("group");
  const showAll = () => setParams((prev) => { const next = new URLSearchParams(prev); next.set("state", "all"); return next; }, { replace: true });
  const showAllButton = <Button size="sm" variant="secondary" onClick={showAll} data-testid="console-flags-ws-show-all">Show all flags</Button>;
  const set = useOperatorAction<{ row: WorkspaceFlagRow; value: boolean }>({
    title: ({ row, value }) => `Turn ${value ? "on" : "off"} ${row.label} for this workspace?`,
    description: ({ row, value }) => `This workspace gets ${value ? "On" : "Off"} whatever the setting for everyone is (${row.platformValue ? "On" : "Off"} now), until you choose Use the default.`,
    confirmLabel: "Save for this workspace",
    run: ({ row, value }, reason) => flagsApi.setWorkspace(row.key, orgId, { value, reason }),
    success: ({ row, value }) => `${row.label} turned ${value ? "on" : "off"} for this workspace`,
  });
  const reset = useOperatorAction<WorkspaceFlagRow>({
    title: (row) => `Use the default for ${row.label}?`,
    description: (row) => `This workspace's own setting is removed and it follows the setting for everyone (${row.platformValue ? "On" : "Off"} now).`,
    confirmLabel: "Use the default",
    run: (row, reason) => flagsApi.clearWorkspace(row.key, orgId, reason),
    success: (row) => `${row.label} uses the default again`,
  });

  return (
    <div data-testid="console-workspace-flags">
      <PropagationNote />
      <DataTable<WorkspaceFlagRow>
        label="Flags for this workspace" path={`/flags/workspaces/${encodeURIComponent(orgId)}`} pageSize={200} minWidth={600}
        search={{ placeholder: "Search flags" }} filters={FILTERS}
        actions={state !== "all" ? showAllButton : undefined}
        rowKey={(r) => r.key}
        empty={plainDefault
          ? { icon: <IconFlag />, title: "No own settings", body: <>This workspace uses the default for every flag.<span className="mt-4 flex justify-center">{showAllButton}</span></> }
          : { icon: <IconFlag />, title: "No flags match", body: "Try another search, group or Show choice." }}
        columns={[
          { key: "flag", header: "Flag", className: "min-w-[11rem] sm:min-w-[14rem]", cell: (r) => (
            <span className="flex flex-col">
              <Link to={`/console/flags?flag=${encodeURIComponent(r.key)}`} title={r.key} className="font-medium hover:underline">{r.label}</Link>
              <span className="line-clamp-1 text-xs text-muted" title={r.description}>{r.description}</span>
            </span>
          ) },
          { key: "value", header: "In this workspace", cell: (r) => (
            <span className="flex flex-col items-start gap-1">
              <FlagState on={r.effective} source={r.source} testId={`console-flags-ws-state-${r.key}`} />
              {!canChange && !r.runtime && <DeployNote reason={r.bootReason} />}
              {r.workspaceOverride && !r.workspaceOverride.applies && <span className="text-xs text-subtle">Own setting ({r.workspaceOverride.value ? "On" : "Off"}) kept but has no effect</span>}
            </span>
          ) },
          ...(canChange ? [{ key: "actions", header: "", align: "right" as const, cell: (r: WorkspaceFlagRow) => (
            <Actions row={r} onSet={(row, value) => set.open({ row, value })} onReset={(row) => reset.open(row)} />
          ) }] : []),
        ]}
      />
      {set.dialog}{reset.dialog}
    </div>
  );
}
