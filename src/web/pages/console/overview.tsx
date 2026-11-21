/**
 * OPS1: the console's Overview. What needs attention now comes first, then the trends (loaded on demand, so the charts
 * stay out of the console's first chunk), then the platform numbers, the write budget,
 * integrations, abuse signals, the job queue and the newest workspaces with their controls (moved from /app/admin).
 */
import { Suspense } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { consoleApi, consoleKeys } from "@/web/lib/console-api";
import { sendSentryTest, sentryEnabled } from "@/web/lib/sentry";
import { Badge, Card, EmptyState, PageHeader, Skeleton, StatTile, tableStyles as T } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconBuilding, IconChevronRight, IconGlobe, IconInbox, IconSend, IconShieldCheck, IconTeam, IconWarning } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { LOCALE } from "@/shared/locale";
import { Section } from "../app/settings";
import { AbuseQueue, INTEGRATION_LABEL, JobQueue, TenantControls } from "../app/admin";
import { WriteBudgetMeter } from "../app/admin-write-budget";
import { ModerationLink } from "../app/admin-moderation-r35";
import { lazyPage } from "@/web/components/lazy-page";
import { PermissionGate } from "./guard";

const OverviewTrends = lazyPage(() => import("./overview-trends"), "OverviewTrends");

function Attention() {
  const q = useQuery({ queryKey: consoleKeys.overview, queryFn: consoleApi.overview });
  if (q.isPending) return <Skeleton className="h-24 rounded-xl" />;
  if (q.error) return null; // the page's own error card covers it
  const items = q.data.attention;
  if (!items.length) {
    return (
      <Card className="flex items-center gap-3 px-4 py-3 text-sm" data-testid="console-attention-clear">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-ok-soft text-ok"><IconShieldCheck className="h-4 w-4" aria-hidden /></span>
        <span><span className="font-medium">Nothing needs attention</span><span className="block text-xs text-muted">No open reports, abuse signals, dead jobs or failed payments.</span></span>
      </Card>
    );
  }
  return (
    <section aria-labelledby="attention-h">
      <h2 id="attention-h" className="mb-2 text-[15px] font-semibold">Needs attention</h2>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface" data-testid="console-attention">
        {items.map((i) => (
          <li key={i.id}>
            <Link to={i.to} className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-hover">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", i.tone === "bad" ? "bg-bad" : "bg-warn")} aria-hidden />
              <span className="flex-1">{i.label}</span>
              <Badge tone={i.tone}>{i.count.toLocaleString(LOCALE)}</Badge>
              <IconChevronRight className="h-4 w-4 text-subtle" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ConsoleOverviewPage() {
  const q = useQuery({ queryKey: consoleKeys.overview, queryFn: consoleApi.overview });
  const apiTest = useMutation({
    mutationFn: () => api.post<{ configured: boolean; eventId: string | null }>("/admin/sentry-test"),
    onSuccess: (r) => (r.configured ? toast.success("API test event sent", { description: `Sentry event ${r.eventId}` }) : toast("Sentry isn't configured for the API")),
  });
  const webTest = useMutation({
    mutationFn: sendSentryTest,
    onSuccess: (id) => (id ? toast.success("Web test event sent", { description: `Sentry event ${id}` }) : toast("Sentry isn't configured for the web app")),
  });
  const header = <PageHeader eyebrow="Operator console" title="Overview" description="What needs attention now, then the numbers for this deployment." />;
  if (q.isPending) return (
    <div className="space-y-6" aria-busy="true">
      {header}
      <Skeleton className="h-24 rounded-xl" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)}</div>
      <Skeleton className="h-48 rounded-xl" />
    </div>
  );
  if (q.error) return (
    <div className="space-y-6">
      {header}
      <Card className="p-0"><EmptyState icon={<IconWarning />} title="Couldn't load the overview" body={errorMessage(q.error)} action={<Button variant="secondary" onClick={() => void q.refetch()}>Try again</Button>} /></Card>
    </div>
  );
  const { totals, tenants, integrations } = q.data;
  const fmt = new Intl.NumberFormat(LOCALE);
  const tiles = [
    { label: "Users", value: totals.users, icon: <IconTeam />, tone: "brand" as const },
    { label: "Customer workspaces", value: totals.workspaces, icon: <IconBuilding />, tone: "neutral" as const },
    { label: "Domains", value: totals.domains, icon: <IconGlobe />, tone: "neutral" as const },
    { label: "Mailboxes", value: totals.mailboxes, icon: <IconInbox />, tone: "neutral" as const },
    { label: "Deliveries, 24h", value: totals.deliveries24h, icon: <IconSend />, tone: "ok" as const },
  ];
  const integrationList = Object.entries(integrations);
  const on = integrationList.filter(([, v]) => v && v !== "log").length;
  return (
    <div className="space-y-6">
      {header}
      <Attention />
      <PermissionGate permission="moderation.read"><ModerationLink /></PermissionGate>
      <PermissionGate permission="metrics.read">
        <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}><OverviewTrends /></Suspense>
      </PermissionGate>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => <StatTile key={t.label} label={t.label} value={fmt.format(t.value)} icon={t.icon} tone={t.tone} />)}
      </div>
      <PermissionGate permission="system.read"><WriteBudgetMeter /></PermissionGate>
      <Section title="Integrations" description={<>What this deployment has keys for. <span className="tabular-nums">{on} of {integrationList.length}</span> on.</>}>
        <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
          {integrationList.map(([k, v]) => {
            const live = !!v && v !== "log";
            return (
              <li key={k} className="flex items-center justify-between gap-3 bg-surface px-4 py-2.5 text-sm">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className={live ? "h-2 w-2 shrink-0 rounded-full bg-ok" : "h-2 w-2 shrink-0 rounded-full bg-line-strong"} aria-hidden />
                  <span className="truncate">{INTEGRATION_LABEL[k] ?? k}</span>
                </span>
                <span className={live ? "shrink-0 text-xs font-medium text-ok" : "shrink-0 text-xs text-subtle"}>{typeof v === "string" ? v : v ? "On" : "Off"}</span>
              </li>
            );
          })}
        </ul>
        <PermissionGate permission="system.manage">
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" loading={apiTest.isPending} onClick={() => apiTest.mutate()}>Send API test error</Button>
            <Button variant="secondary" size="sm" loading={webTest.isPending} disabled={!sentryEnabled()} onClick={() => webTest.mutate()}>Send web test error</Button>
          </div>
        </PermissionGate>
      </Section>
      <PermissionGate permission="moderation.read"><AbuseQueue /></PermissionGate>
      <PermissionGate permission="jobs.read"><JobQueue /></PermissionGate>
      <Section title="Newest workspaces" description="Up to 100, newest first. Suspending stops sending and API access; receiving continues.">
        {!tenants.length ? <EmptyState className="py-10" icon={<IconBuilding />} title="No workspaces yet" body="Workspaces show here as people sign up." /> : (
        <div className={T.wrap} tabIndex={0} role="region" aria-label="Workspaces">
          <table className={T.table}>
            <thead className={T.head}><tr><th className={T.th}>Name</th><th className={T.th}>Plan</th><th className={`${T.th} text-right`}>People</th><th className={`${T.th} text-right`}>AI agents</th><th className={`${T.th} text-right`}>Domains</th><th className={T.th}>Created</th><th className={T.th}><span className="sr-only">Controls</span></th></tr></thead>
            <tbody className={T.body}>
              {tenants.map((t) => (
                <tr key={t.id} className={T.row}>
                  <td className={T.td}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{t.name}</span>
                      {t.isDemo && <Badge>demo</Badge>}{t.suspendedAt && <Badge tone="bad" dot>suspended</Badge>}{t.pastDueSince && <Badge tone="warn" dot>past due</Badge>}
                    </span>
                    {t.suspendedReason && t.suspendedAt && <span className="mt-0.5 block max-w-xs truncate text-xs text-subtle" title={t.suspendedReason}>{t.suspendedReason}</span>}
                  </td>
                  <td className={T.td}><Badge tone={t.plan === "free" ? "neutral" : "brand"} className="capitalize">{t.plan}</Badge></td>
                  <td className={`${T.td} text-right tabular-nums`}>{t.members}</td><td className={`${T.td} text-right tabular-nums`}>{t.agents}</td>
                  <td className={`${T.td} text-right tabular-nums`}>{t.domains}</td>
                  <td className={`${T.td} whitespace-nowrap text-muted`}>{new Date(t.createdAt).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" })}</td>
                  <td className={`${T.td} text-right`}><PermissionGate permission="workspaces.limits"><TenantControls t={t} /></PermissionGate></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </Section>
    </div>
  );
}
