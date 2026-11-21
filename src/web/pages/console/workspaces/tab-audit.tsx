/**
 * OPS1: the Audit tab of a workspace: its own activity log (what its admins see, operator actions included) or the
 * platform audit rows about it (operator actions with the reason and what changed).
 */
import { useState } from "react";
import { Link } from "react-router";
import { Badge } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { IconActivity } from "@/web/components/ui/icon";
import { fullDate } from "@/web/lib/format";
import { operatorRoleLabel } from "@/shared/operator-permissions";
import { DataTable } from "../components/data-table";
import type { FilterDef } from "../components/filter-bar";
import { KvList } from "../components/kv-list";
import { JsonDiff } from "../components/json-diff";
import { When } from "./tab-shared";

interface AuditRow {
  id: string; source: "workspace" | "platform"; action: string; actorUserId: string | null; actorEmail: string | null; actorRole: string | null;
  targetType: string | null; targetId: string | null; reason: string | null; before: unknown; after: unknown;
  metadata: Record<string, unknown> | null; createdAt: string;
}

const FILTERS: FilterDef[] = [
  { key: "source", label: "Show", initial: "workspace", options: [{ value: "workspace", label: "Workspace activity" }, { value: "platform", label: "Operator actions" }] },
];

const actionLabel = (a: string) => { const s = a.replace(/[._]/g, " ").trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

function Detail({ row, onClose }: { row: AuditRow | null; onClose: () => void }) {
  return (
    <Dialog open={!!row} onClose={onClose} title={row ? actionLabel(row.action) : ""} description={row ? fullDate(row.createdAt) : undefined}>
      {row && (
        <div className="space-y-4 px-1 pb-2 text-left">
          <KvList items={[
            { label: "By", value: row.actorEmail },
            { label: "Operator role", value: row.actorRole ? operatorRoleLabel(row.actorRole) : null },
            { label: "Reason", value: row.reason },
            { label: "Target", value: row.targetId ? `${row.targetType ?? "item"} ${row.targetId}` : null, mono: true },
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
        label="Audit" path={`/workspaces/${encodeURIComponent(orgId)}/audit`}
        filters={FILTERS} search={{ placeholder: "Search by who did it" }}
        rowKey={(r) => `${r.source}-${r.id}`}
        empty={{ icon: <IconActivity />, title: "Nothing here yet", body: "Changes to this workspace show here with who made them." }}
        columns={[
          { key: "when", header: "When", cell: (r) => <When at={r.createdAt} /> },
          { key: "action", header: "Action", cell: (r) => <span className="font-medium">{actionLabel(r.action)}</span> },
          {
            key: "who", header: "By",
            cell: (r) => (
              <span className="flex flex-col">
                <span className="[overflow-wrap:anywhere]">{r.actorUserId
                  ? <Link to={`/console/users/${encodeURIComponent(r.actorUserId)}`} className="hover:underline">{r.actorEmail ?? r.actorUserId}</Link>
                  : r.actorEmail ?? "System"}</span>
                {r.actorRole ? <span className="text-xs text-subtle">{operatorRoleLabel(r.actorRole)}</span> : r.metadata?.by === "operator" ? <span className="text-xs text-subtle">Operator</span> : null}
              </span>
            ),
          },
          { key: "reason", header: "Reason", cell: (r) => (r.reason ? <span className="line-clamp-2 max-w-xs">{r.reason}</span> : r.source === "platform" ? <Badge>No reason</Badge> : <span className="text-subtle">None</span>) },
          { key: "open", header: "", align: "right", cell: (r) => <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>Details</Button> },
        ]}
      />
      <Detail row={open} onClose={() => setOpen(null)} />
    </div>
  );
}
