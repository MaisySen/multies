import { Link } from "react-router";
import { ArrowRight, AtSign, Check, Globe, Inbox, Send, Users } from "lucide-react";
import { useDashboard, useMe } from "@/web/lib/queries";
import { Card, Meter, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { ButtonLink } from "@/web/components/ui/button";
import { DomainStatusBadge, describeAudit } from "@/web/components/app-bits";
import { formatBytes, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import type { Dashboard } from "@/web/lib/types";

export function DashboardPage() {
  const me = useMe();
  const { data, isPending, error } = useDashboard();
  const first = me.data?.user.name.split(" ")[0];
  return (
    <>
      <PageHeader title={`Good ${greeting()}${first ? `, ${first}` : ""}`} description="Here's how mail is flowing across your workspace." actions={<ButtonLink to="/app/mail" variant="secondary" size="sm"><Inbox className="h-4 w-4" />Open mail</ButtonLink>} />
      {error && <Card className="p-6 text-sm text-bad">Couldn't load the overview: {error.message}</Card>}
      {isPending ? <DashboardSkeleton /> : data && (
        <div className="space-y-6">
          {data.usage.domains === 0 || data.usage.mailboxes === 0 ? <GettingStarted data={data} /> : null}
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <Stat icon={<Globe />} label="Domains" value={`${data.domains.filter((d) => d.status === "verified").length}/${data.usage.domains}`} sub="verified" used={data.usage.domains} max={data.plan.limits.domains} />
            <Stat icon={<Users />} label="Mailboxes" value={String(data.usage.mailboxes)} sub={`of ${data.plan.limits.mailboxes}`} used={data.usage.mailboxes} max={data.plan.limits.mailboxes} />
            <Stat icon={<AtSign />} label="Aliases" value={String(data.usage.aliases)} sub={`of ${data.plan.limits.aliases.toLocaleString()}`} used={data.usage.aliases} max={data.plan.limits.aliases} />
            <Stat icon={<Send />} label="Sent today" value={String(data.sentToday)} sub={`of ${data.plan.limits.dailySends.toLocaleString()}`} used={data.sentToday} max={data.plan.limits.dailySends} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <div className="flex items-center justify-between">
                <div><h2 className="text-sm font-semibold">Mail flow</h2><p className="text-xs text-subtle">Last 14 days</p></div>
                <div className="flex gap-4 text-xs text-muted">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-brand" />Inbound</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-ok/80" />Outbound</span>
                </div>
              </div>
              <FlowChart series={data.series} />
            </Card>
            <Card className="flex flex-col p-5">
              <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Domain health</h2><Link to="/app/domains" className="text-xs text-muted hover:text-fg">View all</Link></div>
              {data.domains.length === 0 ? (
                <p className="mt-6 text-sm text-muted">No domains yet.</p>
              ) : (
                <ul className="mt-4 space-y-1">
                  {data.domains.slice(0, 6).map((d) => (
                    <li key={d.id}>
                      <Link to={`/app/domains/${d.id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-white/[0.04]">
                        <span className="truncate text-sm">{d.name}</span><DomainStatusBadge status={d.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-auto pt-4 text-xs text-subtle">Storage used: {formatBytes(data.storageBytes)}</div>
            </Card>
          </div>
          <Card className="p-5">
            <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Recent activity</h2><Link to="/app/activity" className="text-xs text-muted hover:text-fg">Audit log</Link></div>
            <ul className="mt-3 divide-y divide-line">
              {data.recent.map((e) => {
                const { verb, object } = describeAudit(e);
                return (
                  <li key={e.id} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                    <span className="min-w-0 truncate"><span className="text-muted">{e.actorEmail ?? "System"}</span> {verb}{object && <span className="font-medium"> {object}</span>}</span>
                    <time className="shrink-0 text-xs text-subtle" dateTime={e.createdAt}>{timeAgo(e.createdAt)}</time>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

function Stat({ icon, label, value, sub, used, max }: { icon: React.ReactNode; label: string; value: string; sub: string; used: number; max: number }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-2 text-[13px] text-muted [&_svg]:h-4 [&_svg]:w-4">{icon}{label}</div>
      <div className="mt-3 flex items-baseline gap-1.5"><span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span><span className="text-xs text-subtle">{sub}</span></div>
      <Meter value={used} max={max} className="mt-4" />
    </Card>
  );
}

function FlowChart({ series }: { series: Dashboard["series"] }) {
  const max = Math.max(1, ...series.map((s) => Math.max(s.inbound, s.outbound)));
  const total = series.reduce((n, s) => n + s.inbound + s.outbound, 0);
  return (
    <div className="mt-6">
      <div className="flex h-44 items-end gap-1.5 sm:gap-2.5" role="img" aria-label={`${total} deliveries over the last 14 days`}>
        {series.map((s) => (
          <div key={s.day} className="group relative flex h-full flex-1 items-end justify-center gap-0.5">
            <div className="w-full max-w-3 rounded-t bg-brand transition-opacity group-hover:opacity-80" style={{ height: `${(s.inbound / max) * 100}%`, minHeight: s.inbound ? 3 : 0 }} />
            <div className="w-full max-w-3 rounded-t bg-ok/80 transition-opacity group-hover:opacity-80" style={{ height: `${(s.outbound / max) * 100}%`, minHeight: s.outbound ? 3 : 0 }} />
            <div className="pointer-events-none absolute bottom-full mb-2 hidden whitespace-nowrap rounded-md border border-line-strong bg-elevated px-2 py-1 text-[11px] shadow-pop group-hover:block">
              {new Date(s.day + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {s.inbound} in · {s.outbound} out
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-subtle">
        <span>{new Date(series[0].day + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
        <span>Today</span>
      </div>
      {total === 0 && <p className="mt-3 text-center text-xs text-subtle">No mail yet. Deliveries will appear here as they happen.</p>}
    </div>
  );
}

function GettingStarted({ data }: { data: Dashboard }) {
  const steps = [
    { done: data.usage.domains > 0, title: "Add your domain", body: "We'll generate its DKIM key and DNS records.", to: "/app/domains" },
    { done: data.domains.some((d) => d.status === "verified"), title: "Verify DNS", body: "Publish the records; we check them live.", to: data.domains[0] ? `/app/domains/${data.domains[0].id}` : "/app/domains" },
    { done: data.usage.mailboxes > 0, title: "Create a mailbox", body: "An inbox for you or your team.", to: "/app/mailboxes" },
    { done: false, title: "Connect inbound mail", body: "Route your MX through Cloudflare to MyMail.", to: "/app/settings/mail#inbound" },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-sm font-semibold">Get set up</h2>
        <p className="text-xs text-muted">{steps.filter((s) => s.done).length} of {steps.length} done</p>
      </div>
      <ol className="grid divide-line md:grid-cols-4 md:divide-x">
        {steps.map((s, i) => (
          <li key={s.title}>
            <Link to={s.to} className={cn("flex h-full gap-3 p-5 transition-colors hover:bg-white/[0.03]", i === next && "bg-white/[0.02]")}>
              <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold", s.done ? "border-ok/30 bg-ok-soft text-ok" : i === next ? "border-brand bg-brand text-brand-fg" : "border-line-strong text-subtle")}>
                {s.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span>
                <span className={cn("block text-sm font-medium", s.done && "text-muted line-through decoration-subtle")}>{s.title}</span>
                <span className="mt-0.5 block text-xs text-subtle">{s.body}</span>
                {i === next && <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-hover">Start <ArrowRight className="h-3 w-3" /></span>}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px] rounded-xl" />)}</div>
      <div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-72 rounded-xl lg:col-span-2" /><Skeleton className="h-72 rounded-xl" /></div>
    </div>
  );
}
