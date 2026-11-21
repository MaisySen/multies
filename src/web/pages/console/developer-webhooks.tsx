/** OPS1: the Developer platform's webhook tabs: failed deliveries (with Redeliver) and endpoints (with Enable and Disable). */
import { Badge } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconWebhook } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { useOperatorAction } from "./components/reason-dialog";
import { usePermission } from "./guard";
import { developerApi, hostOf, Mono, When, WorkspaceLink, useWorkspaceScope, type DevWebhookDelivery, type DevWebhookEndpoint } from "./developer-shared";

const DELIVERY_FILTERS: FilterDef[] = [
  { key: "status", label: "Status", initial: "failed", options: [
    { value: "failed", label: "Failed" },
    { value: "pending", label: "Retrying" },
    { value: "delivered", label: "Delivered" },
    { value: "pending,delivered,failed", label: "Any" },
  ] },
  { key: "days", label: "When", initial: "7", options: [
    { value: "1", label: "Last 24 hours" },
    { value: "7", label: "Last 7 days" },
    { value: "30", label: "Last 30 days" },
    { value: "90", label: "Last 90 days" },
  ] },
];

const statusBadge = (d: DevWebhookDelivery) =>
  d.status === "failed" ? <Badge tone="bad" dot>Failed</Badge> : d.status === "pending" ? <Badge tone="warn" dot>Retrying</Badge> : <Badge tone="ok" dot>Delivered</Badge>;

export function WebhookFailuresTab() {
  const canManage = usePermission("developer.manage");
  const scope = useWorkspaceScope();
  const redeliver = useOperatorAction<DevWebhookDelivery>({
    title: (d) => `Send this ${d.eventType} event again?`,
    description: (d) => `It goes to ${hostOf(d.endpointUrl)} now, as the workspace's own replay does. If that endpoint is switched off, this switches it back on and resets its failure count, so new events start going to it again.`,
    confirmLabel: "Redeliver",
    run: (d, reason) => developerApi.redeliver(d.id, reason),
    success: "Sent again",
  });
  return (
    <>
      <DataTable<DevWebhookDelivery>
        label="Webhook deliveries" path="/developer/webhook-deliveries" filters={DELIVERY_FILTERS} defaultSort="createdAt:desc" params={scope.params}
        rowKey={(d) => d.id}
        empty={{ icon: <IconWebhook />, title: "No webhook deliveries match", body: "Deliveries that ran out of retries in this window show here. Try a wider window or another status." }}
        columns={[
          { key: "when", header: "When", sort: "createdAt", cell: (d) => <When at={d.createdAt} /> },
          { key: "event", header: "Event", cell: (d) => (
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{d.eventType}</span>
              <Mono className="text-subtle" >{d.payloadPreview}</Mono>
            </span>
          ) },
          { key: "endpoint", header: "Endpoint", cell: (d) => <span className="whitespace-nowrap">{hostOf(d.endpointUrl)}</span> },
          { key: "workspace", header: "Workspace", cell: (d) => <WorkspaceLink id={d.orgId} name={d.orgName} /> },
          { key: "status", header: "Status", cell: statusBadge },
          { key: "attempts", header: "Attempts", align: "right", cell: (d) => <span className="tabular-nums">{d.attempts}</span> },
          { key: "error", header: "Last error", cell: (d) => (d.lastError || d.responseStatus
            ? <span className="line-clamp-2 max-w-xs text-muted">{d.responseStatus ? `HTTP ${d.responseStatus}` : ""}{d.responseStatus && d.lastError ? ": " : ""}{d.lastError ?? ""}</span>
            : <span className="text-subtle">None</span>) },
          { key: "actions", header: "", align: "right", cell: (d) => (canManage && d.status === "failed"
            ? <Button size="sm" variant="ghost" onClick={() => redeliver.open(d)} data-testid="console-developer-redeliver">Redeliver</Button>
            : null) },
        ]}
      />
      {redeliver.dialog}
    </>
  );
}

const ENDPOINT_FILTERS: FilterDef[] = [
  { key: "enabled", label: "State", initial: "", options: [
    { value: "", label: "Any" },
    { value: "true", label: "On" },
    { value: "false", label: "Off" },
  ] },
];

const FORMAT_LABEL: Record<DevWebhookEndpoint["format"], string> = { json: "JSON", slack: "Slack", discord: "Discord", teams: "Teams" };

function endpointState(e: DevWebhookEndpoint) {
  if (!e.enabled) return (
    <span className="flex flex-col gap-0.5">
      <Badge tone="bad" dot>Off</Badge>
      {e.disabledReason && <span className="line-clamp-2 max-w-xs text-xs text-muted">{e.disabledReason}</span>}
    </span>
  );
  if (e.consecutiveDead > 0) return <span title={`${e.consecutiveDead} failed in a row. It is switched off at 5.`}><Badge tone="warn" dot>Failing</Badge></span>;
  return <Badge tone="ok" dot>On</Badge>;
}

export function WebhookEndpointsTab() {
  const canManage = usePermission("developer.manage");
  const scope = useWorkspaceScope();
  const disable = useOperatorAction<DevWebhookEndpoint>({
    title: (e) => `Switch off the endpoint at ${hostOf(e.url)}?`,
    description: (e) => `${e.orgName ?? "The workspace"} stops sending events to it until it is switched back on. Events in the meantime are not queued for it.`,
    confirmLabel: "Disable endpoint", tone: "danger",
    run: (e, reason) => developerApi.setEndpointEnabled(e.id, false, reason),
    success: "Endpoint switched off",
  });
  const enable = useOperatorAction<DevWebhookEndpoint>({
    title: (e) => `Switch on the endpoint at ${hostOf(e.url)}?`,
    description: "New events start going to it again. Past failed deliveries are not sent again; use Redeliver for those.",
    confirmLabel: "Enable endpoint",
    run: (e, reason) => developerApi.setEndpointEnabled(e.id, true, reason),
    success: "Endpoint switched on",
  });
  return (
    <>
      <DataTable<DevWebhookEndpoint>
        label="Webhook endpoints" path="/developer/webhooks" filters={ENDPOINT_FILTERS} defaultSort="createdAt:desc" params={scope.params}
        search={{ placeholder: "Search by address or description" }}
        rowKey={(e) => e.id}
        empty={{ icon: <IconWebhook />, title: "No webhook endpoints match", body: "Endpoints workspaces add in their developer settings show here." }}
        columns={[
          { key: "endpoint", header: "Endpoint", sort: "url", cell: (e) => (
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{hostOf(e.url)}</span>
              <span className="text-xs text-muted">{[FORMAT_LABEL[e.format] ?? e.format, e.description].filter(Boolean).join(" · ")}</span>
            </span>
          ) },
          { key: "workspace", header: "Workspace", cell: (e) => <WorkspaceLink id={e.orgId} name={e.orgName} /> },
          { key: "events", header: "Events", cell: (e) => <span className="text-muted">{e.events.includes("*") ? "All events" : e.events.length === 1 ? e.events[0] : `${e.events.length} events`}</span> },
          { key: "state", header: "State", cell: endpointState },
          { key: "failures", header: "Failures, 7 days", align: "right", cell: (e) => (e.recentFailures > 0 ? <Badge tone="warn">{e.recentFailures}</Badge> : <span className="tabular-nums text-subtle">0</span>) },
          { key: "created", header: "Added", sort: "createdAt", cell: (e) => <When at={e.createdAt} /> },
          { key: "actions", header: "", align: "right", cell: (e) => (!canManage ? null : e.enabled
            ? <Button size="sm" variant="ghost" onClick={() => disable.open(e)} data-testid="console-developer-disable">Disable</Button>
            : <Button size="sm" variant="ghost" onClick={() => enable.open(e)} data-testid="console-developer-enable">Enable</Button>) },
        ]}
      />
      {disable.dialog}{enable.dialog}
    </>
  );
}
