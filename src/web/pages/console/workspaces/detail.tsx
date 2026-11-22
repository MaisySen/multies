/**
 * OPS1: one workspace in the operator console, /console/workspaces/:id/:tab?. The header shows the name, plan, state,
 * owner, id and the main actions (Suspend or Restore, and a More menu for limits); the tabs below hold everything else.
 * The header and back link stay when a read fails: the error shows inside the tab area. The old Trends address
 * (/console/workspaces/:id/trends) opens the Usage tab, which now holds the trend charts.
 */
import { Navigate, useLocation, useParams } from "react-router";
import { api } from "@/web/lib/api";
import { Badge, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { IconMore } from "@/web/components/ui/icon";
import { DetailTabs, useDetailTab, type DetailTab } from "../components/detail-tabs";
import { useOperatorAction } from "../components/reason-dialog";
import { BackLink, LoadError, PersonLink } from "../components/format";
import { PermissionGate } from "../guard";
import { NotesPanel } from "../notes-panel";
import { WorkspaceBillingTab } from "./tab-billing";
import { WorkspaceFlagsTab } from "./tab-flags";
import { WorkspaceOverviewTab } from "./tab-overview";
import { WorkspaceMembersTab } from "./tab-members";
import { WorkspaceUsageTab } from "./tab-usage";
import { WorkspaceMailTab } from "./tab-mail";
import { WorkspaceAgentsTab } from "./tab-agents";
import { WorkspaceDeveloperTab } from "./tab-developer";
import { WorkspaceAuditTab } from "./tab-audit";
import { CopyIdButton, DetailHeader, MetaDot } from "./detail-header";
import { StateBadges, apiPath, useLimitActions, useWorkspace, workspacePlanLabel, wsPath, type WorkspaceOverview } from "./tab-shared";

const TABS: DetailTab[] = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "billing", label: "Billing", permission: "billing.read" },
  { id: "usage", label: "Usage" },
  { id: "mail", label: "Mail" },
  { id: "agents", label: "Agents", permission: "agents.read" },
  { id: "developer", label: "Developer", permission: "developer.read" },
  { id: "flags", label: "Flags", permission: "flags.read" },
  // The id and address stay "audit" so older links keep working.
  { id: "audit", label: "Activity" },
  { id: "notes", label: "Notes" },
];

/** Tab addresses that moved: the old one opens the new one. */
const MOVED_TABS: Record<string, string> = { trends: "usage" };

function Actions({ w }: { w: WorkspaceOverview }) {
  const o = w.org;
  const limits = useLimitActions();
  const suspend = useOperatorAction<void>({
    title: `Suspend ${o.name}?`,
    description: "Sending mail and access through API keys and connected apps stop straight away. People can still sign in. The workspace sees your reason.",
    confirmLabel: "Suspend workspace", tone: "danger",
    run: (_v, reason) => api.post(apiPath(o.id, "/suspend"), { reason }),
    success: "Workspace suspended",
  });
  const restore = useOperatorAction<void>({
    title: `Restore ${o.name}?`,
    description: "The suspension is lifted and its open abuse signals are marked resolved. Everything works again straight away.",
    confirmLabel: "Restore workspace",
    run: (_v, reason) => api.post(apiPath(o.id, "/unsuspend"), { reason }),
    success: "Workspace restored",
  });
  const sendingOff = o.sendCapDaily === 0;
  return (
    <>
      <PermissionGate permission="workspaces.suspend">
        {o.suspendedAt
          ? <Button variant="secondary" onClick={() => restore.open()} data-testid="console-workspaces-restore">Restore</Button>
          : <Button variant="danger" onClick={() => suspend.open()} data-testid="console-workspaces-suspend">Suspend</Button>}
      </PermissionGate>
      <PermissionGate permission="workspaces.limits">
        <Menu label="More actions" sheet trigger={<Button variant="secondary" data-testid="console-workspaces-more"><IconMore className="h-4 w-4" aria-hidden />More</Button>}>
          <MenuItem onSelect={() => limits.openSendCap({ id: o.id, name: o.name, current: o.sendCapDaily })}>Change daily send cap</MenuItem>
          {/* A suspended workspace sends nothing whatever the switch says, so the switch waits for Restore. */}
          {!o.suspendedAt && <MenuItem onSelect={() => limits.openSending({ id: o.id, name: o.name, enabled: sendingOff })}>{sendingOff ? "Turn sending on" : "Turn sending off"}</MenuItem>}
          <MenuItem onSelect={() => limits.openMeetingCap({ id: o.id, name: o.name, current: o.meetingMinutesCap })}>Change call minutes cap</MenuItem>
        </Menu>
      </PermissionGate>
      {suspend.dialog}
      {restore.dialog}
      {limits.dialogs}
    </>
  );
}

function Header({ w }: { w: WorkspaceOverview }) {
  const o = w.org;
  return (
    <DetailHeader
      back={{ to: "/console/workspaces", label: "All workspaces" }}
      title={o.name}
      meta={
        <>
          <Badge tone="brand" className="whitespace-nowrap">{workspacePlanLabel(o)}</Badge>
          <StateBadges w={o} showActive />
          <MetaDot />
          <span className="inline-flex min-w-0 items-center gap-1" data-testid="console-workspaces-owner">
            Owner {w.owner ? <PersonLink id={w.owner.userId} name={w.owner.name || null} email={w.owner.name ? null : w.owner.email} className="font-medium text-fg" /> : <span className="text-subtle">None</span>}
          </span>
          <MetaDot />
          <span className="inline-flex items-center gap-0.5 font-mono text-xs" data-testid="console-workspaces-id">
            {o.id}<CopyIdButton value={o.id} label="Copy workspace id" testId="console-workspaces-copy-id" />
          </span>
        </>
      }
      note={o.suspendedAt && o.suspendedReason ? <p className="text-[13px] text-bad">Suspended: {o.suspendedReason}</p> : undefined}
      actions={<Actions w={w} />}
    />
  );
}

export function ConsoleWorkspaceDetailPage() {
  const { id = "", tab: asked } = useParams();
  const location = useLocation();
  const q = useWorkspace(id);
  const tab = useDetailTab(TABS);
  if (asked && MOVED_TABS[asked]) return <Navigate replace to={{ pathname: `${wsPath(id)}/${MOVED_TABS[asked]}`, search: location.search }} />;
  if (q.isPending) {
    return (
      <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading the workspace">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (!q.data) {
    // No workspace to name: keep the way back, and say what went wrong (404 reads "wasn't found").
    return (
      <div className="space-y-4" data-testid="console-workspaces-detail">
        <BackLink to="/console/workspaces">All workspaces</BackLink>
        <LoadError error={q.error} retry={() => void q.refetch()} what="the workspace" />
      </div>
    );
  }
  const w = q.data;
  return (
    <div data-testid="console-workspaces-detail">
      <Header w={w} />
      <DetailTabs tabs={TABS} base={wsPath(w.org.id)} />
      {/* A refresh that failed after the first load: the page stays, the error shows here with Try again. */}
      {q.error && <LoadError error={q.error} retry={() => void q.refetch()} what="the latest workspace details" className="mb-4" />}
      {tab === "overview" && <WorkspaceOverviewTab w={w} />}
      {tab === "members" && <WorkspaceMembersTab orgId={w.org.id} />}
      {tab === "billing" && <WorkspaceBillingTab orgId={w.org.id} />}
      {tab === "usage" && <WorkspaceUsageTab w={w} />}
      {tab === "mail" && <WorkspaceMailTab orgId={w.org.id} />}
      {tab === "agents" && <WorkspaceAgentsTab orgId={w.org.id} />}
      {tab === "developer" && <WorkspaceDeveloperTab orgId={w.org.id} />}
      {tab === "flags" && <WorkspaceFlagsTab orgId={w.org.id} />}
      {tab === "audit" && <WorkspaceAuditTab orgId={w.org.id} />}
      {tab === "notes" && <NotesPanel targetType="workspace" targetId={w.org.id} />}
    </div>
  );
}
