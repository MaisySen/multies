/**
 * OPS1: the platform audit log. Every operator change with who, their role, the reason and what changed.
 * Filters: action (prefix), actor, workspace id, date range. Owners can download the filtered log as CSV.
 */
import { useState } from "react";
import { Badge, PageHeader } from "@/web/components/ui/misc";
import { Button, buttonClass } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { IconActivity, IconDownload } from "@/web/components/ui/icon";
import { consoleApi, type PlatformAuditEntry } from "@/web/lib/console-api";
import { fullDate, timeAgo } from "@/web/lib/format";
import { operatorRoleLabel } from "@/shared/operator-permissions";
import { DataTable } from "./components/data-table";
import { useUrlParams, type FilterDef } from "./components/filter-bar";
import { KvList } from "./components/kv-list";
import { JsonDiff } from "./components/json-diff";
import { PermissionGate } from "./guard";

const AREAS: FilterDef = {
  key: "action", label: "Area", initial: "",
  options: [
    { value: "", label: "Everything" },
    { value: "workspace.", label: "Workspaces" },
    { value: "user.", label: "Users" },
    { value: "operator.", label: "Operators" },
    { value: "report.", label: "Moderation" },
    { value: "abuse.", label: "Abuse signals" },
    { value: "jobs.", label: "Jobs" },
    { value: "app_config.", label: "Mobile app" },
    { value: "message.", label: "Mail" },
    { value: "audit.", label: "Audit exports" },
  ],
};
const WINDOWS: FilterDef = {
  key: "window", label: "When", initial: "",
  options: [{ value: "", label: "Any time" }, { value: "1", label: "Last 24 hours" }, { value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }],
};
const FILTERS = [AREAS, WINDOWS];

/** "workspace.send_cap_changed" reads as "Workspace send cap changed". */
export const actionLabel = (a: string) => {
  const s = a.replace(/[._]/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function Detail({ row, onClose }: { row: PlatformAuditEntry | null; onClose: () => void }) {
  return (
    <Dialog open={!!row} onClose={onClose} title={row ? actionLabel(row.action) : ""} description={row ? fullDate(row.createdAt) : undefined}>
      {row && (
        <div className="space-y-4 px-1 pb-2 text-left">
          <KvList items={[
            { label: "Operator", value: row.actorEmail },
            { label: "Role", value: row.actorRole ? operatorRoleLabel(row.actorRole) : null },
            { label: "Reason", value: row.reason },
            { label: "Target", value: row.targetId ? `${row.targetType ?? "item"} ${row.targetId}` : null, mono: true },
            { label: "Workspace", value: row.orgId, mono: true, copy: true },
            { label: "From", value: row.ip, mono: true },
            { label: "Request", value: row.requestId, mono: true },
          ]} />
          <div>
            <h3 className="mb-1.5 text-[13px] font-semibold">What changed</h3>
            <JsonDiff before={row.before} after={row.after} />
          </div>
          {row.metadata && Object.keys(row.metadata).length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[13px] font-semibold">Details</h3>
              <JsonDiff before={undefined} after={row.metadata} />
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function ConsoleAuditPage() {
  const [open, setOpen] = useState<PlatformAuditEntry | null>(null);
  const url = useUrlParams(FILTERS, { sort: "createdAt:desc" });
  const days = Number(url.values.window || 0);
  // The window is turned into a from date for the server; rounded to the hour so the list's query key stays put.
  const from = days ? new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - days * 86_400_000).toISOString() : undefined;
  const exportParams = { q: url.values.q, action: url.values.action, from };
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Access" title="Audit log" description="Every change an operator made, newest first, with the reason they gave." />
      <DataTable<PlatformAuditEntry>
        label="Audit log" path="/audit"
        filters={FILTERS} search={{ placeholder: "Search action, operator, target or reason" }}
        params={from ? { from } : undefined}
        rowKey={(r) => r.id}
        actions={
          <PermissionGate permission="audit.export">
            <a href={consoleApi.auditExportUrl(exportParams)} className={buttonClass("secondary", "sm")} download data-testid="audit-export">
              <IconDownload className="h-4 w-4" aria-hidden />Download CSV
            </a>
          </PermissionGate>
        }
        empty={{ icon: <IconActivity />, title: "No operator activity yet", body: "Changes made in the console show here with who made them and why." }}
        columns={[
          { key: "when", header: "When", cell: (r) => <span className="whitespace-nowrap text-muted" title={fullDate(r.createdAt)}>{timeAgo(r.createdAt)}</span> },
          { key: "action", header: "Action", cell: (r) => <span className="font-medium">{actionLabel(r.action)}</span> },
          { key: "actor", header: "Operator", cell: (r) => <span className="flex flex-col"><span>{r.actorEmail ?? "System"}</span>{r.actorRole && <span className="text-xs text-subtle">{operatorRoleLabel(r.actorRole)}</span>}</span> },
          { key: "target", header: "Target", cell: (r) => (r.targetId ? <span className="font-mono text-xs">{r.targetId}</span> : <span className="text-subtle">None</span>) },
          { key: "reason", header: "Reason", cell: (r) => (r.reason ? <span className="line-clamp-2 max-w-xs">{r.reason}</span> : <Badge>No reason</Badge>) },
          { key: "open", header: "", align: "right", cell: (r) => <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>Details</Button> },
        ]}
      />
      <Detail row={open} onClose={() => setOpen(null)} />
    </div>
  );
}
