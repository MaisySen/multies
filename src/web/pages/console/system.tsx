/**
 * OPS1: /console/system, System health. A calm status page from one read (GET /api/console/system/snapshot), refreshed
 * every 60 seconds: the overall line, release and database, database usage today, busiest workspaces, uptime,
 * integrations (with the two Sentry test buttons), provider health and the rate limits in force.
 */
import type { ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/web/lib/api";
import { fullDate } from "@/web/lib/format";
import { sendSentryTest, sentryEnabled } from "@/web/lib/sentry";
import { LOCALE } from "@/shared/locale";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconRefresh, IconShieldCheck, IconWarning } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { KvList } from "./components/kv-list";
import { useOperatorAction } from "./components/reason-dialog";
import { PermissionGate } from "./guard";
import { concerns, systemApi, systemKeys, type RateScope, type SystemSnapshot } from "./system-api";
import { BusiestWorkspaces, DatabaseUsage, ProviderHealth, UptimeHistory } from "./system-parts";

const REFRESH_MS = 60_000;

function Block({ title, description, children, id }: { title: string; description?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={`sys-${id}`} className="space-y-2">
      <div>
        <h2 id={`sys-${id}`} className="text-[15px] font-semibold">{title}</h2>
        {description && <p className="text-[13px] text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Overall({ s }: { s: SystemSnapshot }) {
  const list = concerns(s);
  if (!list.length) {
    return (
      <Card className="flex items-center gap-3 px-4 py-3 text-sm" data-testid="console-system-overall">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ok-soft text-ok"><IconShieldCheck className="h-4 w-4" aria-hidden /></span>
        <span className="font-medium">All systems normal</span>
      </Card>
    );
  }
  const bad = list.some((c) => c.tone === "bad");
  return (
    <Card className={cn("px-4 py-3 text-sm", bad ? "border-bad/30" : "border-warn/30")} data-testid="console-system-overall">
      <div className="flex items-center gap-3">
        <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full", bad ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn")}><IconWarning className="h-4 w-4" aria-hidden /></span>
        <span className="font-medium">{list.length === 1 ? "One thing needs attention" : `${list.length} things need attention`}</span>
      </div>
      <ul className="mt-2 space-y-1 pl-11">
        {list.map((c) => <li key={c.id} className="flex items-center gap-2"><span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", c.tone === "bad" ? "bg-bad" : "bg-warn")} aria-hidden />{c.text}</li>)}
      </ul>
    </Card>
  );
}

function ReleaseAndDatabase({ s }: { s: SystemSnapshot }) {
  const m = s.migrations;
  const migrations = !m.ok
    ? <Badge tone="warn" dot>Couldn't read the migration list</Badge>
    : !m.pending.length
      ? <Badge tone="ok" dot>None waiting</Badge>
      : (
        <span className="flex flex-col gap-1">
          <Badge tone="bad" dot>{m.pending.length === 1 ? "1 waiting" : `${m.pending.length} waiting`}</Badge>
          <span className="font-mono text-xs text-muted">{m.pending.slice(0, 10).join(", ")}{m.pending.length > 10 ? `, and ${m.pending.length - 10} more` : ""}</span>
        </span>
      );
  return (
    <KvList items={[
      { label: "Release", value: s.release, mono: true, copy: true },
      { label: "Mode", value: s.mode === "production" ? "Production" : s.mode.charAt(0).toUpperCase() + s.mode.slice(1) },
      { label: "Pending migrations", value: migrations, hint: m.ok && m.pending.length ? "Run the migrations before people hit the new code paths." : undefined },
    ]} />
  );
}

const INTEGRATIONS: { key: keyof SystemSnapshot["integrations"]; label: string }[] = [
  { key: "sentryApi", label: "Sentry (API)" }, { key: "sentryWeb", label: "Sentry (web)" }, { key: "outbound", label: "Outbound mail" },
  { key: "mailServer", label: "Mail server" }, { key: "billing", label: "Stripe billing" }, { key: "billingTestMode", label: "Stripe test mode" },
  { key: "auth0", label: "Auth0 sign-in" }, { key: "google", label: "Google sign-in" }, { key: "github", label: "GitHub sign-in" },
  { key: "writeBudgetMeter", label: "Database meter" },
];

function Integrations({ s }: { s: SystemSnapshot }) {
  const apiTest = useOperatorAction<void, { configured: boolean; eventId: string | null }>({
    title: "Send an API test error to Sentry?",
    description: "Sends one test error from the server so you can check that error tracking reaches Sentry.",
    confirmLabel: "Send test error",
    run: (_v, reason) => systemApi.sentryTest(reason),
    invalidate: [],
    onDone: (r) => (r.configured ? toast.success("API test event sent", { description: `Sentry event ${r.eventId ?? "sent"}` }) : toast("Sentry isn't configured for the API")),
  });
  const webTest = useMutation({
    mutationFn: sendSentryTest,
    onSuccess: (id) => (id ? toast.success("Web test event sent", { description: `Sentry event ${id}` }) : toast("Sentry isn't configured for the web app")),
  });
  return (
    <div className="space-y-3">
      <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2" data-testid="console-system-integrations">
        {INTEGRATIONS.map(({ key, label }) => {
          const v = s.integrations[key];
          const on = typeof v === "string" ? v !== "none" && v !== "log" : v;
          return (
            <li key={key} className="flex items-center justify-between gap-3 bg-surface px-4 py-2.5 text-sm">
              <span className="flex min-w-0 items-center gap-2.5">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", on ? "bg-ok" : "bg-line-strong")} aria-hidden />
                <span className="truncate">{label}</span>
              </span>
              <span className={cn("shrink-0 text-xs", on ? "font-medium text-ok" : "text-subtle")}>{typeof v === "string" ? v : v ? "Configured" : "Not configured"}</span>
            </li>
          );
        })}
      </ul>
      <PermissionGate permission="system.manage">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => apiTest.open()} data-testid="console-system-sentry-api">Send API test error</Button>
          <Button variant="secondary" size="sm" loading={webTest.isPending} disabled={!sentryEnabled()} onClick={() => webTest.mutate()} data-testid="console-system-sentry-web">Send web test error</Button>
        </div>
      </PermissionGate>
      {apiTest.dialog}
    </div>
  );
}

const SCOPE_LABEL: Record<RateScope, string> = {
  auth: "Sign in, sign up and password reset, per IP address", api: "REST API, per key", webhooks: "Webhooks and inbound mail, per source IP address",
  app: "Web app changes, per person", handoff: "Phone app to web sign in",
};

function RateLimits({ r }: { r: SystemSnapshot["rateLimits"] }) {
  const mins = (ms: number) => `${Math.round(ms / 60_000)} minutes`;
  return (
    <KvList items={[
      ...(Object.keys(r.perMinute) as RateScope[]).map((k) => ({
        label: SCOPE_LABEL[k] ?? k,
        value: <span className="tabular-nums">{r.perMinute[k].toLocaleString(LOCALE)} a minute</span>,
        hint: r.store[k] === "binding" ? "Counted by Cloudflare" : "Counted in the database",
      })),
      { label: "Password lockout", value: `${r.lockout.maxFailures} wrong passwords in ${mins(r.lockout.windowMs)} locks the account for ${mins(r.lockout.lockForMs)}` },
    ]} />
  );
}

export function ConsoleSystemPage() {
  const q = useQuery({ queryKey: systemKeys.snapshot, queryFn: systemApi.snapshot, refetchInterval: REFRESH_MS });
  const updated = q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null;
  const header = (
    <PageHeader eyebrow="Platform" title="System health" description="How this deployment is doing right now. Refreshes every minute."
      actions={
        <span className="flex items-center gap-2 text-xs text-subtle">
          {updated && <span data-testid="console-system-updated" title={fullDate(updated.toISOString())}>Updated {updated.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
          <Button variant="ghost" size="sm" loading={q.isFetching} onClick={() => void q.refetch()} data-testid="console-system-refresh"><IconRefresh className="h-4 w-4" aria-hidden />Refresh</Button>
        </span>
      } />
  );
  if (q.isPending) {
    return (
      <div className="space-y-6" aria-busy="true">
        {header}
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
        <div className="grid gap-3 lg:grid-cols-2"><Skeleton className="h-48 rounded-xl" /><Skeleton className="h-48 rounded-xl" /></div>
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }
  if (q.error) {
    return (
      <div className="space-y-6">
        {header}
        <Card className="p-0"><EmptyState icon={<IconWarning />} title="Couldn't load system health" body={errorMessage(q.error)} action={<Button variant="secondary" onClick={() => void q.refetch()}>Try again</Button>} /></Card>
      </div>
    );
  }
  const s = q.data;
  return (
    <div className="space-y-6" data-testid="console-system">
      {header}
      <Overall s={s} />
      <Block id="release" title="Release and database"><ReleaseAndDatabase s={s} /></Block>
      <Block id="usage" title="Database usage today" description="Rows written and read on the Cloudflare account against the daily budgets."><DatabaseUsage s={s} /></Block>
      <Block id="busiest" title="Busiest workspaces today" description={s.busiestWorkspaces.budget > 0 ? `By rows written. Each workspace may write ${s.busiestWorkspaces.budget.toLocaleString(LOCALE)} rows a day.` : "By rows written."}>
        <BusiestWorkspaces b={s.busiestWorkspaces} />
      </Block>
      <Block id="uptime" title="Uptime history" description="From the status check, one bar a day, oldest on the left."><UptimeHistory u={s.uptime} /></Block>
      <Block id="integrations" title="Integrations" description="What this deployment has keys for. Keys themselves are never shown."><Integrations s={s} /></Block>
      <Block id="providers" title="Provider health" description="When a provider keeps failing, calls to it pause for a short while so the app stays quick."><ProviderHealth c={s.circuitBreakers} /></Block>
      <Block id="limits" title="Rate limits" description="Read only. These are set in the server code."><RateLimits r={s.rateLimits} /></Block>
    </div>
  );
}
