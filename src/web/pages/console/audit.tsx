/**
 * OPS1: the platform audit log. Every operator change with who, their role, the reason and what changed.
 * Filters: Area (action prefix), When (a rolling window) or a From and To day range, the workspace (picker), and the
 * operator and the target (from a row's details: "Only this operator", "Only this target"). All of them live in the
 * address bar, so the workspace and person pages link to a filtered log. Owners can download the filtered log as CSV.
 * Actions and changed fields read in plain words (components/format), targets by name (the server resolves them in
 * batches), and a note needs no reason, so it shows no "No reason" badge.
 */
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Badge, PageHeader } from "@/web/components/ui/misc";
import { Button, buttonClass } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { IconActivity, IconClose, IconDownload } from "@/web/components/ui/icon";
import { Input } from "@/web/components/ui/input";
import { consoleApi, type PlatformAuditEntry } from "@/web/lib/console-api";
import { operatorRoleLabel } from "@/shared/operator-permissions";
import { DataTable } from "./components/data-table";
import { AUDIT_ACTIONS_WITHOUT_REASON, Empty, PersonLink, RelTime, auditActionLabel, formatDateTime, humanize, personHref, workspaceHref } from "./components/format";
import { useUrlParams, type FilterDef } from "./components/filter-bar";
import { KvList } from "./components/kv-list";
import { JsonDiff } from "./components/json-diff";
import { PermissionGate } from "./guard";
import { WorkspacePicker, useWorkspaceParam } from "./components/workspace-picker";

const AREAS: FilterDef = {
  key: "action", label: "Area", initial: "",
  // One option per action prefix the console and the older admin pages write (grep operatorAction( and platformAudit(
  // in src/server). The server matches the start of the action, so "agent_" covers agent runs and triggers.
  options: [
    { value: "", label: "Everything" },
    { value: "workspace.", label: "Workspaces" },
    { value: "user.", label: "Users" },
    { value: "note.", label: "Notes" },
    { value: "impersonation", label: "Viewing as someone" },
    { value: "support.", label: "Support access" },
    { value: "billing.", label: "Billing" },
    { value: "mail.", label: "Mail" },
    { value: "message.", label: "Held sends sent early" },
    { value: "agent_", label: "Agents" },
    { value: "developer.", label: "Developer platform" },
    { value: "jobs.", label: "Jobs" },
    { value: "report.", label: "Reports" },
    { value: "abuse.", label: "Abuse signals" },
    { value: "flags.", label: "Feature flags" },
    { value: "announcement.", label: "Announcements" },
    { value: "app_config.", label: "Mobile app" },
    { value: "metrics.", label: "Trends" },
    { value: "system.", label: "System" },
    { value: "operator.", label: "Operators" },
    { value: "audit.", label: "Audit exports" },
  ],
};
const WINDOWS: FilterDef = {
  key: "window", label: "When", initial: "",
  options: [{ value: "", label: "Any time" }, { value: "1", label: "Last 24 hours" }, { value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }],
};
const FILTERS = [AREAS, WINDOWS];

/** Where a target opens in the console, when it has a page. */
function targetHref(type: string | null, id: string): string | null {
  if (type === "workspace") return workspaceHref(id);
  if (type === "user") return personHref(id);
  if (type === "flag") return `/console/flags?flag=${encodeURIComponent(id)}`;
  return null;
}

/**
 * The target by name (a workspace's name, a person's email, a flag's label), linked to its console page, with the
 * raw id in the title. Without a name it reads as its kind ("Note", "Job") with the id in the title.
 */
function Target({ row }: { row: Pick<PlatformAuditEntry, "targetType" | "targetId" | "targetLabel"> }) {
  const { targetType: type, targetId: id } = row;
  if (!id) return <Empty />;
  const to = targetHref(type, id);
  const label = row.targetLabel || (type === "workspace" ? "Deleted workspace" : type === "user" ? "Deleted user" : humanize(type ?? "item"));
  const title = `${type ?? "item"} ${id}`;
  return to
    ? <Link to={to} title={id} className="block max-w-[14rem] truncate hover:underline">{label}</Link>
    : <span title={title} className="block max-w-[14rem] truncate">{label}</span>;
}

/** Re-exported for older imports: the plain label of an action. */
export const actionLabel = auditActionLabel;

const needsNoReason = (action: string) => AUDIT_ACTIONS_WITHOUT_REASON.has(action);

function Detail({ row, onClose, onOnly }: { row: PlatformAuditEntry | null; onClose: () => void; onOnly: (changes: Record<string, string>) => void }) {
  const actor = row?.actorUserId || row?.actorEmail || "";
  return (
    <Dialog open={!!row} onClose={onClose} title={row ? auditActionLabel(row.action) : ""} description={row ? formatDateTime(row.createdAt) : undefined}>
      {row && (
        <div className="space-y-4 px-1 pb-2 text-left" data-testid="console-audit-detail">
          {/* Narrow the log to this row's operator or target (both kept in the address bar, so the view can be shared). */}
          <div className="flex flex-wrap gap-2">
            {actor && <Button size="sm" variant="secondary" onClick={() => onOnly({ actor })} data-testid="console-audit-only-actor">Only this operator</Button>}
            {row.targetId && !/invit/.test(row.targetType ?? "") && <Button size="sm" variant="secondary" onClick={() => onOnly({ targetType: row.targetType ?? "", targetId: row.targetId! })} data-testid="console-audit-only-target">Only this target</Button>}
          </div>
          <KvList items={[
            { label: "Operator", value: row.actorUserId || row.actorEmail ? <PersonLink id={row.actorUserId} email={row.actorEmail} /> : "System" },
            { label: "Role", value: row.actorRole ? operatorRoleLabel(row.actorRole) : null },
            ...(needsNoReason(row.action) && !row.reason ? [] : [{ label: "Reason", value: row.reason }]),
            { label: "Target", value: row.targetId ? <Target row={row} /> : null, hint: row.targetId ? <span className="font-mono">{row.targetId}</span> : undefined },
            { label: "Workspace", value: row.orgId ? <Link to={workspaceHref(row.orgId)} className="hover:underline">{row.orgName || "Deleted workspace"}</Link> : null, hint: row.orgId ? <span className="font-mono">{row.orgId}</span> : undefined },
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

/** A YYYY-MM-DD from the address bar, or "" when it is not one. */
const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
/** The start of that day (or of the day after it) in the viewer's time zone, as the server's ISO date. */
function dayStart(v: string, plusDays = 0): string | undefined {
  if (!v) return undefined;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(y!, m! - 1, d! + plusDays);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

/**
 * The filters beyond Area and When, all in the address bar so a link can open a filtered log
 * (/console/audit?orgId=..., ?actor=..., ?targetType=user&targetId=..., ?from=2026-11-17&to=2026-11-17):
 * the workspace (picker), the date range (From and To days; they win over When), and the operator and the target
 * (set from a row's details, shown as chips with an x).
 */
function useAuditLinkFilters() {
  const [params, setParams] = useSearchParams();
  const [orgId, setOrgId] = useWorkspaceParam();
  const v = {
    orgId, actor: params.get("actor") ?? "", targetType: params.get("targetType") ?? "", targetId: params.get("targetId") ?? "",
    from: day(params.get("from")), to: day(params.get("to")),
  };
  const set = (changes: Record<string, string>) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, val] of Object.entries(changes)) if (val) next.set(k, val); else next.delete(k);
    // A day range replaces the rolling window.
    if (changes.from || changes.to) next.delete("window");
    return next;
  }, { replace: true });
  const clearAll = () => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const k of ["q", "action", "window", "orgId", "actor", "targetType", "targetId", "from", "to"]) next.delete(k);
    return next;
  }, { replace: true });
  return { v, set, setOrgId, clearAll, any: !!(v.orgId || v.actor || v.targetId || v.from || v.to) };
}

/** Removable chips for the operator and target filters, which have no control of their own. */
function LinkChips({ v, set }: Pick<ReturnType<typeof useAuditLinkFilters>, "v" | "set">) {
  const chip = (label: string, title: string, clear: Record<string, string>, testId: string) => (
    <button type="button" onClick={() => set(clear)} title={title} data-testid={testId}
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-fill px-2.5 py-1 text-xs text-fg hover:bg-hover">
      <span className="truncate">{label}</span><IconClose className="h-3 w-3 shrink-0 text-muted" aria-label="Remove filter" />
    </button>
  );
  if (!v.actor && !v.targetId) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="console-audit-link-filters">
      {v.actor && chip(`Operator: ${v.actor}`, "Show every operator", { actor: "" }, "console-audit-actor-chip")}
      {v.targetId && chip(`Target: ${humanize(v.targetType || "item")} ${v.targetId}`, "Show every target", { targetType: "", targetId: "" }, "console-audit-target-chip")}
    </div>
  );
}

export function ConsoleAuditPage() {
  const [open, setOpen] = useState<PlatformAuditEntry | null>(null);
  const url = useUrlParams(FILTERS, { sort: "createdAt:desc" });
  const link = useAuditLinkFilters();
  const days = Number(url.values.window || 0);
  // The window is turned into a from date for the server; rounded to the hour so the list's query key stays put.
  const windowFrom = days ? new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - days * 86_400_000).toISOString() : undefined;
  const ranged = !!(link.v.from || link.v.to);
  const from = ranged ? dayStart(link.v.from) : windowFrom;
  const to = ranged ? dayStart(link.v.to, 1) : undefined; // To is the whole day: up to the next midnight
  const server: Record<string, string> = Object.fromEntries(Object.entries({
    orgId: link.v.orgId, actor: link.v.actor, targetType: link.v.targetType, targetId: link.v.targetId, from, to,
  }).filter((e): e is [string, string] => !!e[1]));
  const exportParams = { q: url.values.q, action: url.values.action, ...server };
  const filtered = link.any || !!url.values.q || !!url.values.action || !!url.values.window;
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Access" title="Audit log" description="Every change an operator made, newest first, with the reason they gave." />
      <LinkChips v={link.v} set={link.set} />
      <DataTable<PlatformAuditEntry>
        label="Audit log" path="/audit"
        filters={FILTERS} search={{ placeholder: "Search audit log" }}
        params={Object.keys(server).length ? server : undefined}
        rowKey={(r) => r.id}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <WorkspacePicker value={link.v.orgId} onChange={link.setOrgId} testIdPrefix="console-audit-workspace" />
            <label className="flex items-center gap-1.5 text-xs text-muted">
              From
              <Input type="date" value={link.v.from} max={link.v.to || undefined} onChange={(e) => link.set({ from: e.target.value })} className="w-36" data-testid="console-audit-from" aria-label="From day" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              To
              <Input type="date" value={link.v.to} min={link.v.from || undefined} onChange={(e) => link.set({ to: e.target.value })} className="w-36" data-testid="console-audit-to" aria-label="To day" />
            </label>
            <PermissionGate permission="audit.export">
              <a href={consoleApi.auditExportUrl(exportParams)} className={buttonClass("secondary", "sm")} download data-testid="audit-export">
                <IconDownload className="h-4 w-4" aria-hidden />Download CSV
              </a>
            </PermissionGate>
          </div>
        )}
        empty={filtered
          ? { icon: <IconActivity />, title: "Nothing matches these filters", body: "Try a wider date range or remove a filter.",
            action: <Button variant="secondary" onClick={link.clearAll} data-testid="console-audit-clear">Clear all filters</Button> }
          : { icon: <IconActivity />, title: "No operator activity yet", body: "Changes made in the console show here with who made them and why." }}
        columns={[
          { key: "when", header: "When", cell: (r) => <RelTime at={r.createdAt} className="text-muted" /> },
          { key: "action", header: "Action", cell: (r) => <span className="font-medium" title={r.action}>{auditActionLabel(r.action)}</span> },
          { key: "actor", header: "Operator", secondary: true, cell: (r) => (
            <span className="flex min-w-0 flex-col">
              {r.actorUserId || r.actorEmail ? <PersonLink id={r.actorUserId} email={r.actorEmail} className="whitespace-nowrap" /> : <span>System</span>}
              {r.actorRole && <span className="text-xs text-subtle">{operatorRoleLabel(r.actorRole)}</span>}
            </span>
          ) },
          { key: "target", header: "Target", cell: (r) => <Target row={r} /> },
          { key: "reason", header: "Reason", secondary: true, cell: (r) => (r.reason
            ? <span className="line-clamp-2 max-w-xs">{r.reason}</span>
            : needsNoReason(r.action) ? null : <Badge className="whitespace-nowrap">No reason</Badge>) },
          { key: "open", header: "", align: "right", cell: (r) => <Button size="sm" variant="ghost" onClick={() => setOpen(r)} data-testid="console-audit-details">Details</Button> },
        ]}
      />
      <Detail row={open} onClose={() => setOpen(null)} onOnly={(changes) => { link.set(changes); setOpen(null); }} />
    </div>
  );
}
