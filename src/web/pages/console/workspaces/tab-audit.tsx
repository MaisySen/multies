/**
 * OPS1: the Activity tab of a workspace (tab id and address "audit"): its own activity log (what its admins see,
 * operator actions included) or the platform audit rows about it (operator actions with the reason and what changed).
 * Actions read in plain words (auditActionLabel), targets by name (the server adds them), and operator actions without
 * a reason show the same "No reason" badge as the global audit log.
 */
import { useState } from "react";
import { Link } from "react-router";
import { Badge } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { IconActivity } from "@/web/components/ui/icon";
import { operatorRoleLabel } from "@/shared/operator-permissions";
import { DataTable } from "../components/data-table";
import type { FilterDef } from "../components/filter-bar";
import { KvList } from "../components/kv-list";
import { JsonDiff } from "../components/json-diff";
import { AUDIT_ACTIONS_WITHOUT_REASON, Empty, PersonLink, RelTime, auditActionLabel, formatDateTime, humanize, personHref, workspaceHref } from "../components/format";

interface AuditRow {
  id: string; source: "workspace" | "platform"; action: string; actorUserId?: string | null; actorEmail: string | null; actorRole: string | null;
  targetType: string | null; targetId: string | null; targetLabel?: string | null; reason: string | null; before: unknown; after: unknown;
  metadata: Record<string, unknown> | null; createdAt: string;
}

const FILTERS: FilterDef[] = [
  { key: "source", label: "Show", initial: "workspace", options: [{ value: "workspace", label: "Workspace activity" }, { value: "platform", label: "Operator actions" }] },
];

/** The target by name, linked where it has a console page; its kind when there is no name. The id is in the title. */
function Target({ row }: { row: AuditRow }) {
  const { targetType: type, targetId: id } = row;
  if (!id) return <Empty />;
  const href = type === "workspace" ? workspaceHref(id) : type === "user" ? personHref(id) : null;
  const label = row.targetLabel || (type === "workspace" ? "This workspace" : type === "user" ? "Deleted user" : humanize(type ?? "item"));
  return href
    ? <Link to={href} title={id} className="block max-w-[14rem] truncate hover:underline">{label}</Link>
    : <span title={`${type ?? "item"} ${id}`} className="block max-w-[14rem] truncate">{label}</span>;
}

/** The same rule as the global audit log: an operator action needs a reason unless it is its own record (a note). */
function Reason({ row }: { row: AuditRow }) {
  if (row.reason) return <span className="line-clamp-2 max-w-xs">{row.reason}</span>;
  if (row.source === "platform" && !AUDIT_ACTIONS_WITHOUT_REASON.has(row.action)) return <Badge className="whitespace-nowrap">No reason</Badge>;
  return null;
}

function Actor({ row }: { row: AuditRow }) {
  return (
    <span className="flex min-w-0 flex-col">
      {row.actorUserId || row.actorEmail ? <PersonLink id={row.actorUserId ?? null} email={row.actorEmail} /> : <span>System</span>}
      {row.actorRole ? <span className="text-xs text-subtle">{operatorRoleLabel(row.actorRole)}</span> : row.metadata?.by === "operator" ? <span className="text-xs text-subtle">Operator</span> : null}
    </span>
  );
}

function Detail({ row, onClose }: { row: AuditRow | null; onClose: () => void }) {
  // A reason row when there is one, or when an operator action should have had one (it then reads "None").
  const showReason = !!row && (!!row.reason || (row.source === "platform" && !AUDIT_ACTIONS_WITHOUT_REASON.has(row.action)));
  return (
    <Dialog open={!!row} onClose={onClose} title={row ? auditActionLabel(row.action) : ""} description={row ? formatDateTime(row.createdAt) : undefined}>
      {row && (
        <div className="space-y-4 px-1 pb-2 text-left" data-testid="console-workspaces-audit-detail">
          <KvList items={[
            { label: "By", value: <Actor row={row} /> },
            ...(showReason ? [{ label: "Reason", value: row.reason }] : []),
            { label: "Target", value: row.targetId ? <Target row={row} /> : null, hint: row.targetId ? <span className="font-mono">{row.targetId}</span> : undefined },
          ]} />
          {row.source === "platform" && (
            <div>
              <h3 className="mb-1.5 text-[13px] font-semibold">What changed</h3>
              <JsonDiff before={row.before} after={row.after} />
            </div>
          )}
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

export function WorkspaceAuditTab({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState<AuditRow | null>(null);
  return (
    <div data-testid="console-workspaces-audit">
      <DataTable<AuditRow>
        label="Activity" path={`/workspaces/${encodeURIComponent(orgId)}/audit`}
        filters={FILTERS} search={{ placeholder: "Search by who did it" }}
        rowKey={(r) => `${r.source}-${r.id}`}
        empty={{ icon: <IconActivity />, title: "Nothing here yet", body: "Changes to this workspace show here with who made them." }}
        columns={[
          { key: "when", header: "When", cell: (r) => <RelTime at={r.createdAt} className="text-muted" /> },
          { key: "action", header: "Action", cell: (r) => <span className="font-medium" title={r.action}>{auditActionLabel(r.action)}</span> },
          { key: "who", header: "By", secondary: true, cell: (r) => <Actor row={r} /> },
          { key: "target", header: "Target", secondary: true, cell: (r) => <Target row={r} /> },
          { key: "reason", header: "Reason", secondary: true, cell: (r) => <Reason row={r} /> },
          { key: "open", header: "", align: "right", cell: (r) => <Button size="sm" variant="ghost" onClick={() => setOpen(r)} data-testid="console-workspaces-audit-details">Details</Button> },
        ]}
      />
      <Detail row={open} onClose={() => setOpen(null)} />
    </div>
  );
}
