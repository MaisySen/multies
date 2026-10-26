import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { sendSentryTest, sentryEnabled } from "@/web/lib/sentry";
import { Badge, Card, EmptyState, PageHeader, Skeleton, StatTile, tableStyles as T } from "@/web/components/ui/misc";
import { PromptDialog } from "@/web/components/ui/confirm";
import { Dialog } from "@/web/components/ui/dialog"; // R34
import { Building2, Globe, Inbox, Send, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/web/components/ui/button";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { Section } from "./settings";
import { LOCALE } from "@/shared/locale";
import { WriteBudgetMeter } from "./admin-write-budget"; // R32

interface Overview {
  totals: { users: number; workspaces: number; domains: number; mailboxes: number; deliveries24h: number };
  tenants: { id: string; name: string; plan: string; isDemo: boolean; createdAt: string; members: number; agents: number; domains: number; suspendedAt: string | null; suspendedReason: string | null; sendCapDaily: number | null; pastDueSince: string | null; meetingMinutesCap?: number | null; meetingMinutes?: number }[];
  integrations: Record<string, boolean | string>;
}

const INTEGRATION_LABEL: Record<string, string> = {
  sentryApi: "Sentry (API)", sentryWeb: "Sentry (web)", outbound: "Outbound mail", billing: "Stripe billing",
  billingTestMode: "Stripe test mode", auth0: "Auth0 sign-in", google: "Google sign-in", github: "GitHub sign-in",
};

/** Operator console: platform totals, tenants and integration health. */
export function AdminPage() {
  const q = useQuery({ queryKey: ["admin"], queryFn: () => api.get<Overview>("/admin/overview") });
  const apiTest = useMutation({
    mutationFn: () => api.post<{ configured: boolean; eventId: string | null }>("/admin/sentry-test"),
    onSuccess: (r) => (r.configured ? toast.success("API test event sent", { description: `Sentry event ${r.eventId}` }) : toast("Sentry isn't configured for the API")),
  });
  const webTest = useMutation({
    mutationFn: sendSentryTest,
    onSuccess: (id) => (id ? toast.success("Web test event sent", { description: `Sentry event ${id}` }) : toast("Sentry isn't configured for the web app")),
  });
  if (q.isPending) return (
    <div className="space-y-6" aria-busy>
      <Skeleton className="h-9 w-64" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)}</div>
      <Skeleton className="h-48 rounded-xl" />
    </div>
  );
  if (q.error) return <Card className="p-6 text-sm text-muted">{q.error.message}</Card>;
  const { totals, tenants, integrations } = q.data;
  const fmt = new Intl.NumberFormat(LOCALE);
  const tiles = [
    { label: "Users", value: totals.users, icon: <Users />, tone: "brand" as const },
    { label: "Customer workspaces", value: totals.workspaces, icon: <Building2 />, tone: "neutral" as const },
    { label: "Domains", value: totals.domains, icon: <Globe />, tone: "neutral" as const },
    { label: "Mailboxes", value: totals.mailboxes, icon: <Inbox />, tone: "neutral" as const },
    { label: "Deliveries, 24h", value: totals.deliveries24h, icon: <Send />, tone: "ok" as const },
  ];
  const integrationList = Object.entries(integrations);
  const on = integrationList.filter(([, v]) => v && v !== "log").length;
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Platform" title="Operator console" description="Every workspace on this deployment. Only platform admins see this page." />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => <StatTile key={t.label} label={t.label} value={fmt.format(t.value)} icon={t.icon} tone={t.tone} />)}
      </div>
      <WriteBudgetMeter />
      <Section title="Integrations" description={<>What this deployment has keys for. <span className="tabular-nums">{on} of {integrationList.length}</span> on.</>}>
        <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
          {integrationList.map(([k, v]) => {
            const live = !!v && v !== "log";
            return (
              <li key={k} className="flex items-center justify-between gap-3 bg-surface px-4 py-2.5 text-sm">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className={live ? "h-2 w-2 shrink-0 rounded-full bg-ok shadow-[0_0_0_3px_rgb(52_199_89/0.15)]" : "h-2 w-2 shrink-0 rounded-full bg-line-strong"} aria-hidden />
                  <span className="truncate">{INTEGRATION_LABEL[k] ?? k}</span>
                </span>
                <span className={live ? "shrink-0 text-xs font-medium text-ok" : "shrink-0 text-xs text-subtle"}>{typeof v === "string" ? v : v ? "On" : "Off"}</span>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" loading={apiTest.isPending} onClick={() => apiTest.mutate()}>Send API test error</Button>
          <Button variant="secondary" size="sm" loading={webTest.isPending} disabled={!sentryEnabled()} onClick={() => webTest.mutate()}>Send web test error</Button>
        </div>
      </Section>
      <AbuseQueue />
      <JobQueue />
      <Section title="Workspaces" description="Newest first, up to 100. Suspending stops sending and API access; receiving continues.">
        {!tenants.length ? <EmptyState className="py-10" icon={<Building2 />} title="No workspaces yet" body="Workspaces show here as people sign up." /> : (
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
                  <td className={`${T.td} text-right`}><TenantControls t={t} /></td>
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

type Tenant = Overview["tenants"][number];

function TenantControls({ t }: { t: Tenant }) {
  const qc = useQueryClient();
  const done = (msg: string) => () => { qc.invalidateQueries({ queryKey: ["admin"] }); toast.success(msg); };
  const suspend = useMutation({ mutationFn: (reason: string) => api.post(`/admin/workspaces/${t.id}/suspend`, { reason }), onSuccess: done("Workspace suspended"), onError: showError });
  const unsuspend = useMutation({ mutationFn: () => api.post(`/admin/workspaces/${t.id}/unsuspend`), onSuccess: done("Workspace restored"), onError: showError });
  const cap = useMutation({ mutationFn: (v: number | null) => api.put(`/admin/workspaces/${t.id}/send-cap`, { cap: v }), onSuccess: done("Send cap saved"), onError: showError });
  // R34 (MB-169): the kill switch, and (MB-166) mail a sending limit queued until tomorrow, with Send anyway.
  const sendingOff = t.sendCapDaily === 0;
  const sending = useMutation({ mutationFn: (enabled: boolean) => api.put(`/admin/workspaces/${t.id}/sending`, { enabled }), onSuccess: done(sendingOff ? "Sending turned on" : "Sending turned off"), onError: showError });
  const [showQueued, setShowQueued] = useState(false);
  const queued = useQuery({ queryKey: ["admin", "queued-sends", t.id], queryFn: () => api.get<{ queued: { id: string; subject: string; reason: string; recipients: number; dueAt: string; forced: boolean }[] }>(`/admin/workspaces/${t.id}/queued-sends`), enabled: showQueued });
  const sendAnyway = useMutation({ mutationFn: (id: string) => api.post(`/admin/workspaces/${t.id}/queued-sends/${id}/send`), onSuccess: () => { toast.success("It goes on the next pass"); void queued.refetch(); }, onError: showError });
  const minutes = useMutation({ mutationFn: (v: number | null) => api.put(`/admin/workspaces/${t.id}/meeting-cap`, { cap: v }), onSuccess: done("Call minutes cap saved"), onError: showError });
  const [ask, setAsk] = useState<"suspend" | "cap" | "minutes" | null>(null);
  // R34 (MB-171): free workspaces get 1,000 call participant-minutes a month unless the operator sets a cap.
  const minuteCap = t.meetingMinutesCap ?? (t.plan === "starter" ? 1000 : null);
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {t.suspendedAt
        ? <Button size="sm" variant="secondary" loading={unsuspend.isPending} onClick={() => unsuspend.mutate()} title={t.suspendedReason ?? ""}>Restore</Button>
        : <Button size="sm" variant="ghost" loading={suspend.isPending} onClick={() => setAsk("suspend")}>Suspend</Button>}
      <Button size="sm" variant={sendingOff ? "danger" : "ghost"} loading={sending.isPending} data-testid="admin-sending-toggle" aria-pressed={sendingOff} onClick={() => sending.mutate(sendingOff)}>{sendingOff ? "Sending off" : "Sending on"}</Button>
      {!sendingOff && <Button size="sm" variant="ghost" loading={cap.isPending} onClick={() => setAsk("cap")}>{t.sendCapDaily !== null ? `Cap ${t.sendCapDaily}` : "Set cap"}</Button>}
      <Button size="sm" variant="ghost" onClick={() => setShowQueued(true)}>Queued</Button>
      <Dialog open={showQueued} onClose={() => setShowQueued(false)} title={`Queued until tomorrow: ${t.name}`} description="Mail a sending limit held. It goes at midnight UTC, or now with Send anyway.">
        <ul className="divide-y divide-line px-6 pb-5">
          {queued.data?.queued.length === 0 && <li className="py-3 text-sm text-muted">Nothing queued.</li>}
          {queued.data?.queued.map((q) => (
            <li key={q.id} className="flex items-start justify-between gap-3 py-3">
              <span className="min-w-0 text-sm"><span className="block truncate font-medium">{q.subject || "(no subject)"}</span><span className="block text-xs text-subtle">{q.recipients} recipient{q.recipients === 1 ? "" : "s"}. {q.reason}</span></span>
              <Button size="sm" variant="secondary" disabled={q.forced} loading={sendAnyway.isPending && sendAnyway.variables === q.id} onClick={() => sendAnyway.mutate(q.id)}>{q.forced ? "Sending" : "Send anyway"}</Button>
            </li>
          ))}
        </ul>
      </Dialog>
      <Button size="sm" variant="ghost" loading={minutes.isPending} onClick={() => setAsk("minutes")} title="Call participant-minutes this month" data-testid="tenant-call-minutes">
        {`Calls ${(t.meetingMinutes ?? 0).toLocaleString(LOCALE)}${minuteCap !== null ? ` of ${minuteCap.toLocaleString(LOCALE)}` : ""} min`}
      </Button>
      <PromptDialog
        open={ask === "minutes"} onClose={() => setAsk(null)} busy={minutes.isPending}
        title="Call minutes a month" description={`Participant-minutes ${t.name} can use on calls each month (two people for 30 minutes is 60). Used this month: ${(t.meetingMinutes ?? 0).toLocaleString(LOCALE)}.`}
        label="Minutes a month" hint="Leave empty for the plan's rule: 1,000 on Free, no cap on paid plans. 0 stops new calls." inputMode="numeric" placeholder="Plan rule"
        initial={t.meetingMinutesCap?.toString() ?? ""} confirmLabel="Save cap"
        validate={(v) => (v.trim() === "" || /^\d+$/.test(v.trim()) ? null : "Enter a whole number, or leave it empty.")}
        onSubmit={(v) => { minutes.mutate(v.trim() === "" ? null : Number(v.trim()), { onSettled: () => setAsk(null) }); }}
      />
      <PromptDialog
        open={ask === "suspend"} onClose={() => setAsk(null)} busy={suspend.isPending}
        title={`Suspend ${t.name}?`} description="Sending and API access stop straight away. Mail still arrives. You can restore it any time."
        label="Reason" hint="The workspace sees this, so write it for them." placeholder="Unusual sending volume, under review" multiline
        confirmLabel="Suspend workspace" tone="danger"
        validate={(v) => (v.trim().length < 3 ? "Give a short reason." : null)}
        onSubmit={(v) => { suspend.mutate(v.trim(), { onSettled: () => setAsk(null) }); }}
      />
      <PromptDialog
        open={ask === "cap"} onClose={() => setAsk(null)} busy={cap.isPending}
        title="Daily send cap" description={`How many recipients ${t.name} can send to each day.`}
        label="Recipients a day" hint="Leave empty to use the plan limit." inputMode="numeric" placeholder="Plan limit"
        initial={t.sendCapDaily?.toString() ?? ""} confirmLabel="Save cap"
        validate={(v) => (v.trim() === "" || /^\d+$/.test(v.trim()) ? null : "Enter a whole number, or leave it empty.")}
        onSubmit={(v) => { cap.mutate(v.trim() === "" ? null : Number(v.trim()), { onSettled: () => setAsk(null) }); }}
      />
    </div>
  );
}

interface AbuseEvent { id: string; orgId: string; workspace: string; kind: string; score: number; detail: string | null; createdAt: string }

function AbuseQueue() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "abuse"], queryFn: () => api.get<{ events: AbuseEvent[] }>("/admin/abuse") });
  const resolve = useMutation({ mutationFn: (ids: string[]) => api.post("/admin/abuse/resolve", { ids }), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "abuse"] }), onError: showError });
  const events = q.data?.events ?? [];
  return (
    <Section title="Abuse signals" description="Held messages and automatic suspensions waiting for review.">
      {q.isPending ? <Skeleton className="h-16" /> : !events.length ? (
        <div className="flex items-center gap-3 rounded-xl border border-line px-4 py-3 text-sm"><span className="grid h-8 w-8 place-items-center rounded-full bg-ok-soft text-ok"><ShieldCheck className="h-4 w-4" /></span><span><span className="font-medium">All clear</span><span className="block text-xs text-muted">Nothing is waiting for review.</span></span></div>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-xl border border-line text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span><span className="font-medium">{e.workspace}</span> <span className="text-muted">{e.kind.replace(/_/g, " ")}, score {e.score}</span>{e.detail && <span className="block text-xs text-subtle">{e.detail}</span>}</span>
                <span className="flex items-center gap-2 text-xs text-subtle">{timeAgo(e.createdAt)}<Button size="sm" variant="ghost" onClick={() => resolve.mutate([e.id])}>Dismiss</Button></span>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="secondary" className="mt-3" loading={resolve.isPending} onClick={() => resolve.mutate(events.map((e) => e.id))}>Dismiss all</Button>
        </>
      )}
    </Section>
  );
}

interface QueueStats { pending: number; running: number; dead: number; oldestPendingAgeMs: number }

/** "45 s", "12 min", "3 h" for a queue age. */
function formatAge(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

interface DeadJob { id: string; type: string; orgId: string | null; attempts: number; lastError: string | null; updatedAt: string }

function JobQueue() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["admin", "jobs"], queryFn: () => api.get<{ stats: QueueStats; dead: DeadJob[] }>("/admin/jobs") });
  const stats: Partial<QueueStats> = q.data?.stats ?? {};
  const replay = async (ids: string[]) => {
    setBusy(true);
    try { const r = await api.post<{ replayed: number }>("/admin/jobs/replay", { ids }); toast.success(`Queued ${r.replayed} again`); qc.invalidateQueries({ queryKey: ["admin", "jobs"] }); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const dead = q.data?.dead ?? [];
  return (
    <Section title="Job queue" description="Retries for outbound and account mail. Dead jobs ran out of retries and wait here for a replay.">
      {q.isPending ? <Skeleton className="h-16" /> : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries({
              Pending: stats.pending, Running: stats.running, Dead: stats.dead,
              "Oldest pending": stats.oldestPendingAgeMs ? formatAge(stats.oldestPendingAgeMs) : "none",
            }).map(([k, v]) => (
              <div key={k} className={k === "Dead" && Number(v) > 0 ? "rounded-xl border border-bad/25 bg-bad-soft/50 p-3" : "rounded-xl border border-line p-3"}><dt className="text-xs text-muted">{k}</dt><dd className={k === "Dead" && Number(v) > 0 ? "mt-1 text-lg font-semibold tabular-nums text-bad" : "mt-1 text-lg font-semibold tabular-nums"}>{v ?? 0}</dd></div>
            ))}
          </dl>
          {dead.length > 0 && (
            <>
              <ul className="mt-3 divide-y divide-line rounded-xl border border-line text-sm">
                {dead.map((j) => (
                  <li key={j.id} className="px-3 py-2"><span className="font-mono text-xs">{j.type}</span> <span className="text-xs text-subtle">{j.attempts} tries, {timeAgo(j.updatedAt)}</span>{j.lastError && <span className="block text-xs text-bad">{j.lastError}</span>}</li>
                ))}
              </ul>
              <Button size="sm" variant="secondary" className="mt-3" loading={busy} onClick={() => replay(dead.map((j) => j.id))}>Replay all dead jobs</Button>
            </>
          )}
        </>
      )}
    </Section>
  );
}
