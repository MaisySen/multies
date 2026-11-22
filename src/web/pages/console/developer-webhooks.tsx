/** OPS1: the Developer platform's webhook tabs: failed deliveries (with Redeliver) and endpoints (with Enable and Disable). */
import { Button } from "@/web/components/ui/button";
import { IconWebhook } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { useOperatorAction } from "./components/reason-dialog";
import { Day, Empty, EMPTY, Labelled, RelTime, StatusBadge, eventTypeLabel } from "./components/format";
import { usePermission } from "./guard";
import { developerApi, fieldNames, hostOf, Workspace, useWorkspaceScope, type DevWebhookDelivery, type DevWebhookEndpoint } from "./developer-shared";

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

const DELIVERY_LABEL: Record<DevWebhookDelivery["status"], string> = { failed: "Failed", pending: "Retrying", delivered: "Delivered" };
/** The status badge with the number of attempts under it. */
const statusBadge = (d: DevWebhookDelivery) => (
  <span className="flex flex-col items-start gap-0.5">
    <StatusBadge state={d.status} label={DELIVERY_LABEL[d.status]} tone={d.status === "pending" ? "warn" : undefined} />
    <span className="whitespace-nowrap text-xs tabular-nums text-subtle">{d.attempts} {d.attempts === 1 ? "attempt" : "attempts"}</span>
  </span>
);

export function WebhookFailuresTab() {
  const canManage = usePermission("developer.manage");
  const scope = useWorkspaceScope();
  const redeliver = useOperatorAction<DevWebhookDelivery>({
    title: (d) => `Send the "${eventTypeLabel(d.eventType)}" event again?`,
    description: (d) => `It goes to ${hostOf(d.endpointUrl)} now, as the workspace's own replay does. If that endpoint is switched off, this switches it back on and resets its failure count, so new events start going to it again.`,
    confirmLabel: "Redeliver",
    run: (d, reason) => developerApi.redeliver(d.id, reason),
    success: "Sent again",
  });
  return (
    <>
      <DataTable<DevWebhookDelivery>
        label="Webhook deliveries" path="/developer/webhook-deliveries" filters={DELIVERY_FILTERS} defaultSort="createdAt:desc" params={scope.params}
        rowKey={(d) => d.id} minWidth={640}
        empty={{ icon: <IconWebhook />, title: "No webhook deliveries match", body: "Deliveries that ran out of retries in this window show here. Try a wider window or another status." }}
        columns={[
          { key: "when", header: "When", sort: "createdAt", cell: (d) => <RelTime at={d.createdAt} className="text-muted" /> },
          { key: "event", header: "Event", cell: (d) => <Labelled raw={d.eventType} label={eventTypeLabel(d.eventType)} className="whitespace-nowrap font-medium" /> },
          { key: "fields", header: "Fields", secondary: true, cell: (d) => {
            const f = fieldNames(d);
            return f === EMPTY ? <Empty /> : <span className="line-clamp-2 block min-w-[7rem] max-w-[10rem] text-xs text-muted" title={f}>{f}</span>;
          } },
          { key: "endpoint", header: "Endpoint", cell: (d) => <span className="block max-w-[11rem] [overflow-wrap:anywhere]">{hostOf(d.endpointUrl)}</span> },
          { key: "workspace", header: "Workspace", cell: (d) => <Workspace id={d.orgId} name={d.orgName} ownerEmail={d.ownerEmail} /> },
          { key: "status", header: "Status", cell: statusBadge },
          { key: "error", header: "Last error", secondary: true, cell: (d) => (d.lastError || d.responseStatus
            ? <span className="line-clamp-2 block min-w-[8rem] max-w-[14rem] text-xs text-muted" title={d.lastError ?? undefined}>{d.responseStatus ? `HTTP ${d.responseStatus}` : ""}{d.responseStatus && d.lastError ? ": " : ""}{d.lastError ?? ""}</span>
            : <Empty />) },
          { key: "actions", header: "", align: "right", cell: (d) => (canManage && d.status === "failed"
            ? <Button size="sm" variant="secondary" onClick={() => redeliver.open(d)} data-testid="console-developer-redeliver">Redeliver</Button>
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
    <span className="flex flex-col items-start gap-0.5">
      <StatusBadge state="disabled" label="Off" tone="bad" />
      {e.disabledReason && <span className="line-clamp-2 max-w-xs text-xs text-muted">{e.disabledReason}</span>}
    </span>
  );
  if (e.consecutiveDead > 0) return <span title={`${e.consecutiveDead} failed in a row. It is switched off at 5.`}><StatusBadge state="failing" label="Failing" tone="warn" /></span>;
  return <StatusBadge state="on" label="On" />;
}

function eventsCell(e: DevWebhookEndpoint) {
  if (e.events.includes("*")) return <span className="text-muted">{eventTypeLabel("*")}</span>;
  if (e.events.length === 1) return <Labelled raw={e.events[0]} label={eventTypeLabel(e.events[0])} className="text-muted" />;
  return <span className="text-muted" title={e.events.map(eventTypeLabel).join(", ")}>{e.events.length} events</span>;
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
        search={{ placeholder: "Search endpoints" }} minWidth={680}
        rowKey={(e) => e.id}
        empty={{ icon: <IconWebhook />, title: "No webhook endpoints match", body: "Endpoints workspaces add in their developer settings show here." }}
        columns={[
          { key: "endpoint", header: "Endpoint", cell: (e) => (
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{hostOf(e.url)}</span>
              <span className="text-xs text-muted">{[FORMAT_LABEL[e.format] ?? e.format, e.description].filter(Boolean).join(", ")}</span>
            </span>
          ) },
          { key: "workspace", header: "Workspace", cell: (e) => <Workspace id={e.orgId} name={e.orgName} ownerEmail={e.ownerEmail} /> },
          { key: "events", header: "Events", secondary: true, cell: eventsCell },
          { key: "state", header: "State", cell: endpointState },
          { key: "failures", header: "Failures, 7 days", align: "right", cell: (e) => (e.recentFailures > 0
            ? <StatusBadge state="failures" label={String(e.recentFailures)} tone="warn" dot={false} className="tabular-nums" />
            : <span className="tabular-nums text-subtle">0</span>) },
          { key: "created", header: "Added", sort: "createdAt", secondary: true, cell: (e) => <Day at={e.createdAt} className="text-muted" /> },
          { key: "actions", header: "", align: "right", cell: (e) => (!canManage ? null : e.enabled
            ? <Button size="sm" variant="danger" onClick={() => disable.open(e)} data-testid="console-developer-disable">Disable</Button>
            : <Button size="sm" variant="secondary" onClick={() => enable.open(e)} data-testid="console-developer-enable">Enable</Button>) },
        ]}
      />
      {disable.dialog}{enable.dialog}
    </>
  );
}
