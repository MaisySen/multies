import { Link } from "react-router";
import { displayFirstName } from "@/shared/display-name";
import { IconAgent, IconArrowRight, IconCheck, IconGlobe, IconInbox, IconMention, IconSend, IconTeam, IconUserRound } from "@/web/components/ui/icon";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { qk, useDashboard, useMe } from "@/web/lib/queries";
import { api } from "@/web/lib/api";
import { Card, Meter, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { ButtonLink } from "@/web/components/ui/button";
import { DomainStatusBadge, describeAudit } from "@/web/components/app-bits";
import { dayPart, formatBytes, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import type { Dashboard } from "@/web/lib/types";
import { LOCALE } from "@/shared/locale";
import { FreeAddressCard } from "@/web/components/free-address";
import { useProjects } from "./work/data"; // R40 (MB-214)
import { LoadError } from "@/web/components/load-error-t1g"; // T1G (T1-8)

export function DashboardPage() {
  const me = useMe();
  const { data, isPending, error, refetch } = useDashboard();
  const first = displayFirstName(me.data?.user.name, me.data?.user.email); // R41 (MB-224)
  return (
    <>
      <PageHeader title="Overview" description={`Good ${dayPart()}${first ? `, ${first}` : ""}. Here's how mail is flowing across your workspace.`} actions={<ButtonLink to="/app/mail" variant="secondary" size="sm"><IconInbox className="h-4 w-4" />Open mail</ButtonLink>} />
      {error && !data && <LoadError onRetry={() => refetch()} className="rounded-xl border border-line bg-surface" />}{/* T1G (T1-8) */}
      {isPending ? <DashboardSkeleton /> : data && (
        <div className="space-y-6">
          {data.usage.domains === 0 && <FreeAddressCard />}
          {!data.onboarding.dismissed && !Object.values(data.onboarding.steps).every(Boolean) ? <GettingStarted data={data} /> : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-5">
            <Stat icon={<IconGlobe />} label="Domains" value={`${data.domains.filter((d) => d.status === "verified").length}/${data.usage.domains}`} sub={`verified, plan allows ${data.plan.limits.domains}`} used={data.usage.domains} max={data.plan.limits.domains} />
            <Stat icon={<IconTeam />} label="Mailboxes" value={String(data.usage.mailboxes)} sub={`of ${data.plan.limits.mailboxes}`} used={data.usage.mailboxes} max={data.plan.limits.mailboxes} />
            <Stat icon={<IconUserRound />} label="People" value={String(data.team.members)} sub={`of ${data.plan.limits.seats} seats`} used={data.team.members} max={data.plan.limits.seats}
              note={<span className="inline-flex items-center gap-1"><IconAgent className="h-3.5 w-3.5" aria-hidden="true" />{data.team.agents === 1 ? "1 AI agent" : `${data.team.agents} AI agents`}, no seat used</span>} />
            <Stat icon={<IconMention />} label="Aliases" value={String(data.usage.aliases)} sub={`of ${data.plan.limits.aliases.toLocaleString(LOCALE)}`} used={data.usage.aliases} max={data.plan.limits.aliases} />
            <Stat icon={<IconSend />} label="Sent today" value={String(data.sentToday)} sub={`of ${data.plan.limits.dailySends.toLocaleString(LOCALE)}`} used={data.sentToday} max={data.plan.limits.dailySends} />
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
                      <Link to={`/app/domains/${d.id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-hover">
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
            <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Recent activity</h2>{me.data?.organization?.role !== "member" && <Link to="/app/activity?tab=audit" className="text-xs text-muted hover:text-fg">Audit log</Link>}</div>
            <ul className="mt-3 divide-y divide-line">
              {data.recent.map((e) => {
                const { verb, object, subject } = describeAudit(e);
                return (
                  <li key={e.id} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                    <span className="min-w-0 truncate"><span className="text-muted">{subject ?? e.actorEmail ?? "System"}</span> {verb}{object && <span className="font-medium"> {object}</span>}</span>
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

function Stat({ icon, label, value, sub, used, max, note }: { icon: React.ReactNode; label: string; value: string; sub: string; used: number; max: number; note?: React.ReactNode }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-2 text-[13px] text-muted [&_svg]:h-4 [&_svg]:w-4">{icon}{label}</div>
      <div className="mt-3 flex items-baseline gap-1.5"><span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span><span className="text-xs text-subtle">{sub}</span></div>
      <Meter value={used} max={max} className="mt-4" />
      {note ? <div className="mt-2 text-xs text-subtle" data-testid="stat-note">{note}</div> : null}
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
              {new Date(s.day + "T12:00:00Z").toLocaleDateString(LOCALE, { month: "short", day: "numeric", timeZone: "UTC" })} · {s.inbound} in · {s.outbound} out
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-subtle">
        <span>{new Date(series[0].day + "T12:00:00Z").toLocaleDateString(LOCALE, { month: "short", day: "numeric", timeZone: "UTC" })}</span>
        <span>Today</span>
      </div>
      {total === 0 && <p className="mt-3 text-center text-xs text-subtle">No mail yet. Deliveries will appear here as they happen.</p>}
    </div>
  );
}

function GettingStarted({ data }: { data: Dashboard }) {
  const qc = useQueryClient();
  const st = data.onboarding.steps;
  const firstDomain = data.domains[0];
  // R40 (MB-214): lead with the jobs people come for (a project, the team, an address); domain and DNS come later.
  // Every workspace starts with the "Tasks" project, so a second one means they made their own.
  const projects = useProjects();
  const steps = [
    { done: (projects.data?.length ?? 0) > 1, title: "Make a project", body: "Lists, a board and a timeline for your work.", to: "/app/tasks" },
    { done: st.teamInvited, title: "Invite your team", body: "Give people their own login and mailboxes.", to: "/app/settings/team" },
    { done: st.mailboxCreated, title: "Get an address", body: "A free address to send and receive from, or one on your own domain.", to: "/app/mailboxes" },
    { done: st.firstSend, title: "Send an email", body: "Write from your new address in Mail.", to: "/app/mail?compose=1" },
    { done: st.domainAdded, title: "Add your domain", body: "Later, when you want mail on your own name. We make the records for you.", to: "/app/domains" },
    { done: st.domainVerified, title: "Publish DNS records", body: "Each record turns green as it propagates.", to: firstDomain ? `/app/domains/${firstDomain.id}` : "/app/domains" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const next = steps.findIndex((s) => !s.done);
  const dismiss = useMutation({
    mutationFn: () => api.post("/dashboard/onboarding/dismiss", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.dashboard }),
  });
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">Get set up</h2>
          <p className="text-xs text-muted">{doneCount} of {steps.length} done</p>
        </div>
        <button onClick={() => dismiss.mutate()} className="min-h-10 rounded-md px-3 text-xs text-subtle hover:bg-hover hover:text-fg sm:min-h-0 sm:px-2 sm:py-1">Hide</button>
      </div>
      <div className="h-0.5 bg-line" aria-hidden><div className="h-full bg-brand transition-[width] duration-500" style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
      <ol className="grid sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="border-line [&:not(:last-child)]:border-b sm:[&:nth-child(odd)]:border-r lg:[&:nth-child(odd)]:border-r-0 lg:[&:not(:nth-child(3n))]:border-r lg:[&:nth-child(-n+3)]:border-b lg:[&:nth-child(n+4)]:border-b-0">
            <Link to={s.to} className={cn("flex h-full gap-3 p-4 transition-colors hover:bg-hover", i === next && "bg-fill/60")} aria-current={i === next ? "step" : undefined}>
              <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold", s.done ? "border-ok/30 bg-ok-soft text-ok" : i === next ? "border-brand bg-brand text-brand-fg" : "border-line-strong text-subtle")}>
                {s.done ? <IconCheck className="h-3.5 w-3.5" aria-label="Done" /> : i + 1}
              </span>
              <span>
                <span className={cn("block text-sm font-medium", s.done && "text-muted line-through decoration-subtle")}>{s.title}</span>
                <span className="mt-0.5 block text-xs text-subtle">{s.body}</span>
                {i === next && <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-hover">Start <IconArrowRight className="h-3 w-3" /></span>}
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
