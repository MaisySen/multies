/**
 * OPS1: one workspace in the operator console, /console/workspaces/:id/:tab?. The header shows the name, id, state
 * and the main actions (Suspend or Restore, and a More menu for limits); the tabs below hold everything else.
 */
import { Link, useParams } from "react-router";
import { api, ApiError } from "@/web/lib/api";
import { Badge, Card, CopyButton, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { IconArrowLeft, IconBuilding, IconMore } from "@/web/components/ui/icon";
import { DetailTabs, useDetailTab, type DetailTab } from "../components/detail-tabs";
import { useOperatorAction } from "../components/reason-dialog";
import { PermissionGate } from "../guard";
import { NotesPanel } from "../notes-panel";
import { WorkspaceBillingTab } from "./tab-billing";
import { WorkspaceFlagsTab } from "./tab-flags";
import { WorkspaceTrendsTab } from "./tab-trends";
import { WorkspaceOverviewTab } from "./tab-overview";
import { WorkspaceMembersTab } from "./tab-members";
import { WorkspaceUsageTab } from "./tab-usage";
import { WorkspaceMailTab } from "./tab-mail";
import { WorkspaceAgentsTab } from "./tab-agents";
import { WorkspaceDeveloperTab } from "./tab-developer";
import { WorkspaceAuditTab } from "./tab-audit";
import { ErrorBlock, PLAN_LABEL, StateBadges, apiPath, useLimitActions, useWorkspace, wsPath, type WorkspaceOverview } from "./tab-shared";

const TABS: DetailTab[] = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "billing", label: "Billing", permission: "billing.read" },
  { id: "usage", label: "Usage" },
  { id: "trends", label: "Trends", permission: "metrics.read" },
  { id: "mail", label: "Mail" },
  { id: "agents", label: "Agents", permission: "agents.read" },
  { id: "developer", label: "Developer", permission: "developer.read" },
  { id: "flags", label: "Flags", permission: "flags.read" },
  { id: "audit", label: "Audit" },
  { id: "notes", label: "Notes" },
];

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
    <div className="flex flex-wrap items-center gap-2">
      <PermissionGate permission="workspaces.suspend">
        {o.suspendedAt
          ? <Button variant="primary" onClick={() => restore.open()} data-testid="console-workspaces-restore">Restore</Button>
          : <Button variant="danger" onClick={() => suspend.open()} data-testid="console-workspaces-suspend">Suspend</Button>}
      </PermissionGate>
      <PermissionGate permission="workspaces.limits">
        <Menu label="More actions" trigger={<Button variant="secondary" data-testid="console-workspaces-more"><IconMore className="h-4 w-4" aria-hidden />More</Button>}>
          <MenuItem onSelect={() => limits.openSendCap({ id: o.id, name: o.name, current: o.sendCapDaily })}>Change daily send cap</MenuItem>
          <MenuItem onSelect={() => limits.openSending({ id: o.id, name: o.name, enabled: sendingOff })}>{sendingOff ? "Turn sending on" : "Turn sending off"}</MenuItem>
          <MenuItem onSelect={() => limits.openMeetingCap({ id: o.id, name: o.name, current: o.meetingMinutesCap })}>Change call minutes cap</MenuItem>
        </Menu>
      </PermissionGate>
      {suspend.dialog}
      {restore.dialog}
      {limits.dialogs}
    </div>
  );
}

function Header({ w }: { w: WorkspaceOverview }) {
  const o = w.org;
  return (
    <header className="mb-4 space-y-3">
      <Link to="/console/workspaces" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <IconArrowLeft className="h-3.5 w-3.5" aria-hidden />Workspaces
      </Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h1 className="large-title [overflow-wrap:anywhere]">{o.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            <span className="inline-flex items-center gap-1 font-mono text-xs" data-testid="console-workspaces-id">{o.id}<CopyButton value={o.id} label="Copy workspace id" /></span>
            <Badge tone="brand">{PLAN_LABEL[o.effectivePlan] ?? o.effectivePlan}</Badge>
            <StateBadges w={o} showActive />
          </div>
          {o.suspendedAt && o.suspendedReason && <p className="text-[13px] text-bad">Suspended: {o.suspendedReason}</p>}
        </div>
        <Actions w={w} />
      </div>
    </header>
  );
}

export function ConsoleWorkspaceDetailPage() {
  const { id = "" } = useParams();
  const q = useWorkspace(id);
  const tab = useDetailTab(TABS);
  if (q.isPending) {
    return (
      <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading the workspace">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <Card className="p-0">
          <EmptyState icon={<IconBuilding />} title="Workspace not found" body="It may have been deleted, or the link is wrong."
            action={<Link to="/console/workspaces" className="text-sm font-medium text-brand hover:underline">Back to workspaces</Link>} />
        </Card>
      );
    }
    return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  }
  const w = q.data;
  return (
    <div data-testid="console-workspaces-detail">
      <Header w={w} />
      <DetailTabs tabs={TABS} base={wsPath(w.org.id)} />
      {tab === "overview" && <WorkspaceOverviewTab w={w} />}
      {tab === "members" && <WorkspaceMembersTab orgId={w.org.id} />}
      {tab === "billing" && <WorkspaceBillingTab orgId={w.org.id} />}
      {tab === "usage" && <WorkspaceUsageTab orgId={w.org.id} />}
      {tab === "trends" && <WorkspaceTrendsTab orgId={w.org.id} />}
      {tab === "mail" && <WorkspaceMailTab orgId={w.org.id} />}
      {tab === "agents" && <WorkspaceAgentsTab orgId={w.org.id} />}
      {tab === "developer" && <WorkspaceDeveloperTab orgId={w.org.id} />}
      {tab === "flags" && <WorkspaceFlagsTab orgId={w.org.id} />}
      {tab === "audit" && <WorkspaceAuditTab orgId={w.org.id} />}
      {tab === "notes" && <NotesPanel targetType="workspace" targetId={w.org.id} />}
    </div>
  );
}
