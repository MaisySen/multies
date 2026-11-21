/**
 * OPS1: the console's Overview, from one read (GET /api/console/overview): what needs attention first (each row opens
 * the already filtered page, one calm "All clear" row when nothing does), the platform numbers, the trends (loaded on
 * demand, so the charts stay out of the console's first chunk) and the five newest workspaces.
 * Integrations, Sentry tests and the database meter live on System health; jobs, moderation and workspace controls on
 * their own pages.
 */
import { Suspense, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { consoleApi, consoleKeys, type AttentionItem, type ConsoleNewestWorkspace } from "@/web/lib/console-api";
import { Badge, Card, PageHeader, Skeleton, StatTile } from "@/web/components/ui/misc";
import { IconBuilding, IconChevronRight, IconGlobe, IconInbox, IconSend, IconShieldCheck, IconTeam } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { LOCALE } from "@/shared/locale";
import { lazyPage } from "@/web/components/lazy-page";
import { EmptyRow, LoadError, RelTime, WorkspaceLink, planLabel } from "./components/format";
import { PermissionGate } from "./guard";

const OverviewTrends = lazyPage(() => import("./overview-trends"), "OverviewTrends");

function SectionTitle({ id, children, action }: { id: string; children: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h2 id={id} className="text-[15px] font-semibold">{children}</h2>
      {action}
    </div>
  );
}

function Attention({ items }: { items: AttentionItem[] }) {
  return (
    <section aria-labelledby="attention-h">
      <SectionTitle id="attention-h">Needs attention</SectionTitle>
      {!items.length ? (
        <Card className="flex items-center gap-3 px-4 py-3 text-sm" data-testid="console-attention-clear">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ok-soft text-ok"><IconShieldCheck className="h-4 w-4" aria-hidden /></span>
          <span className="min-w-0"><span className="font-medium">All clear</span><span className="block text-xs text-muted">No reports, abuse signals, failed jobs, payment problems or database warnings.</span></span>
        </Card>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-testid="console-attention">
          {items.map((i) => (
            <li key={i.id}>
              <Link to={i.to} className="flex min-h-12 items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-hover" data-testid={`console-attention-${i.id}`}>
                <span className={cn("h-2 w-2 shrink-0 rounded-full", i.tone === "bad" ? "bg-bad" : "bg-warn")} aria-hidden />
                <span className="min-w-0 flex-1">{i.label}</span>
                <Badge tone={i.tone} className="tabular-nums">{i.value ?? i.count.toLocaleString(LOCALE)}</Badge>
                <IconChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Newest({ rows }: { rows: ConsoleNewestWorkspace[] }) {
  return (
    <section aria-labelledby="newest-h" data-testid="console-overview-newest">
      <SectionTitle id="newest-h" action={<Link to="/console/workspaces" className="text-[13px] font-medium text-brand-hover hover:underline">See all workspaces</Link>}>Newest workspaces</SectionTitle>
      {!rows.length ? <EmptyRow icon={<IconBuilding />}>No workspaces yet. They show here as people sign up.</EmptyRow> : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          {rows.map((w) => (
            <li key={w.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <WorkspaceLink id={w.id} name={w.name} hint={w.ownerEmail ?? "No owner"} className="min-w-0 flex-1" />
              <span className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
                <span className="flex items-center gap-1.5">
                  {w.suspendedAt && <Badge tone="bad" dot className="whitespace-nowrap">Suspended</Badge>}
                  {!w.suspendedAt && w.pastDueSince && <Badge tone="warn" dot className="whitespace-nowrap">Past due</Badge>}
                  <Badge tone={w.plan === "starter" ? "neutral" : "brand"}>{planLabel(w.plan)}</Badge>
                </span>
                <RelTime at={w.createdAt} className="w-20 text-right text-xs text-muted" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ConsoleOverviewPage() {
  const q = useQuery({ queryKey: consoleKeys.overview, queryFn: consoleApi.overview });
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
      <LoadError error={q.error} what="the overview" retry={() => void q.refetch()} />
    </div>
  );
  const { totals, attention, newest } = q.data;
  const fmt = new Intl.NumberFormat(LOCALE);
  const tiles = [
    { label: "Users", value: totals.users, icon: <IconTeam />, tone: "brand" as const },
    { label: "Customer workspaces", value: totals.workspaces, icon: <IconBuilding />, tone: "neutral" as const },
    { label: "Domains", value: totals.domains, icon: <IconGlobe />, tone: "neutral" as const },
    { label: "Mailboxes", value: totals.mailboxes, icon: <IconInbox />, tone: "neutral" as const },
    { label: "Deliveries, 24h", value: totals.deliveries24h, icon: <IconSend />, tone: "ok" as const },
  ];
  return (
    <div className="space-y-7" data-testid="console-overview">
      {header}
      <Attention items={attention} />
      <section aria-label="Platform numbers" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="console-overview-totals">
        {tiles.map((t) => <StatTile key={t.label} label={t.label} value={fmt.format(t.value)} icon={t.icon} tone={t.tone} />)}
      </section>
      <PermissionGate permission="metrics.read">
        <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}><OverviewTrends /></Suspense>
      </PermissionGate>
      <Newest rows={newest ?? []} />
    </div>
  );
}
