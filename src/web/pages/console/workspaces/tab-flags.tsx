/**
 * OPS1: the Flags tab of a workspace's console page. Every flag with its value in this workspace and where that comes
 * from (default, changed for everyone, locked for everyone, this workspace). Ops admins and owners can turn a flag on
 * or off for this workspace or put it back to the default; flags with one setting for the whole platform, flags locked
 * for everyone and flags set at deploy say why they cannot be changed here.
 */
import { Link } from "react-router";
import { Button } from "@/web/components/ui/button";
import { IconFlag } from "@/web/components/ui/icon";
import { DataTable } from "../components/data-table";
import type { FilterDef } from "../components/filter-bar";
import { useOperatorAction } from "../components/reason-dialog";
import { usePermission } from "../guard";
import { GROUP_FILTER, flagsApi, type FlagBlocked, type WorkspaceFlagRow } from "../flags-api";
import { DeployNote, FlagState, PropagationNote } from "../flags-parts";

const STATE_FILTER: FilterDef = {
  key: "state", label: "Show", initial: "",
  options: [
    { value: "", label: "All flags" },
    { value: "own", label: "Own setting" },
    { value: "differs", label: "Differs from everyone" },
  ],
};
const FILTERS: FilterDef[] = [GROUP_FILTER, STATE_FILTER];

const BLOCKED_TEXT: Record<Exclude<FlagBlocked, null>, string> = {
  deploy: "Set at deploy, so it cannot be changed here.",
  global_only: "One setting for the whole platform. Change it on the Feature flags page.",
  locked: "Locked for everyone, so workspaces cannot differ. An owner can change that on the Feature flags page.",
};

function Actions({ row, onSet, onReset }: { row: WorkspaceFlagRow; onSet: (r: WorkspaceFlagRow, value: boolean) => void; onReset: (r: WorkspaceFlagRow) => void }) {
  const turnOn = !row.effective;
  const label = turnOn ? "Turn on for this workspace" : "Turn off for this workspace";
  if (row.blocked) {
    return (
      <span className="flex flex-col items-end gap-1">
        <Button size="sm" variant="secondary" disabled aria-describedby={`flag-blocked-${row.key}`}>{label}</Button>
        <span id={`flag-blocked-${row.key}`} className="max-w-[16rem] text-right text-xs text-subtle">{BLOCKED_TEXT[row.blocked]}</span>
        {row.blocked === "locked" && row.workspaceOverride && <Button size="sm" variant="ghost" onClick={() => onReset(row)}>Use the default</Button>}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap justify-end gap-1.5">
      <Button size="sm" variant="secondary" onClick={() => onSet(row, turnOn)} data-testid={`console-flags-ws-set-${row.key}`}>{label}</Button>
      {row.workspaceOverride && <Button size="sm" variant="ghost" onClick={() => onReset(row)} data-testid={`console-flags-ws-reset-${row.key}`}>Use the default</Button>}
    </span>
  );
}

export function WorkspaceFlagsTab({ orgId }: { orgId: string }) {
  const canChange = usePermission("flags.workspace");
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
        label="Flags for this workspace" path={`/flags/workspaces/${encodeURIComponent(orgId)}`} pageSize={200}
        search={{ placeholder: "Search flags" }} filters={FILTERS}
        rowKey={(r) => r.key}
        empty={{ icon: <IconFlag />, title: "No flags match", body: "Try another search or group." }}
        columns={[
          { key: "flag", header: "Flag", className: "min-w-[14rem]", cell: (r) => (
            <span className="flex flex-col">
              <Link to={`/console/flags?flag=${encodeURIComponent(r.key)}`} className="font-medium hover:underline">{r.label}</Link>
              <span className="line-clamp-1 text-xs text-muted" title={r.description}>{r.description}</span>
            </span>
          ) },
          { key: "value", header: "In this workspace", cell: (r) => (
            <span className="flex flex-col items-start gap-1">
              <FlagState on={r.effective} source={r.source} testId={`console-flags-ws-state-${r.key}`} />
              {!r.runtime && <DeployNote reason={r.bootReason} />}
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
