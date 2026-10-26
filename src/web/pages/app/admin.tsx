import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { sendSentryTest, sentryEnabled } from "@/web/lib/sentry";
import { Badge, Card, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { Section } from "./settings";
import { LOCALE } from "@/shared/locale";
import { WriteBudgetMeter } from "./admin-write-budget"; // R32

interface Overview {
  totals: { users: number; workspaces: number; domains: number; mailboxes: number; deliveries24h: number };
  tenants: { id: string; name: string; plan: string; isDemo: boolean; createdAt: string; members: number; agents: number; domains: number; suspendedAt: string | null; suspendedReason: string | null; sendCapDaily: number | null; pastDueSince: string | null }[];
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
  if (q.isPending) return <Skeleton className="h-64" />;
  if (q.error) return <Card className="p-6 text-sm text-muted">{q.error.message}</Card>;
  const { totals, tenants, integrations } = q.data;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Operator console</h1>
        <p className="mt-1 text-sm text-muted">Every workspace on this deployment. Visible to platform admins only.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Object.entries({ Users: totals.users, "Customer workspaces": totals.workspaces, Domains: totals.domains, Mailboxes: totals.mailboxes, "Deliveries, 24h": totals.deliveries24h }).map(([k, v]) => (
          <Card key={k} className="p-4"><div className="text-xs text-muted">{k}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{v}</div></Card>
        ))}
      </div>
      <WriteBudgetMeter />
      <Section title="Integrations" description="What this deployment has keys for.">
        <ul className="flex flex-wrap gap-2">
          {Object.entries(integrations).map(([k, v]) => (
            <li key={k}><Badge tone={v && v !== "log" ? "ok" : "neutral"} dot>{INTEGRATION_LABEL[k] ?? k}{typeof v === "string" ? `: ${v}` : v ? "" : ": off"}</Badge></li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" loading={apiTest.isPending} onClick={() => apiTest.mutate()}>Send API test error</Button>
          <Button variant="secondary" size="sm" loading={webTest.isPending} disabled={!sentryEnabled()} onClick={() => webTest.mutate()}>Send web test error</Button>
        </div>
      </Section>
      <AbuseQueue />
      <JobQueue />
      <Section title="Workspaces" description="Newest first, up to 100. Suspending stops sending and API access; receiving continues.">
        <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Workspaces">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Plan</th><th className="px-3 py-2 font-medium">People</th><th className="px-3 py-2 font-medium">AI agents</th><th className="px-3 py-2 font-medium">Domains</th><th className="px-3 py-2 font-medium">Created</th><th className="px-3 py-2 font-medium">Controls</th></tr></thead>
            <tbody className="divide-y divide-line">
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td className="px-3 py-2">{t.name}{t.isDemo && <Badge className="ml-2">demo</Badge>}{t.suspendedAt && <Badge tone="bad" className="ml-2">suspended</Badge>}{t.pastDueSince && <Badge tone="warn" className="ml-2">past due</Badge>}</td>
                  <td className="px-3 py-2 capitalize">{t.plan}</td>
                  <td className="px-3 py-2 tabular-nums">{t.members}</td><td className="px-3 py-2 tabular-nums">{t.agents}</td>
                  <td className="px-3 py-2 tabular-nums">{t.domains}</td>
                  <td className="px-3 py-2 text-muted">{new Date(t.createdAt).toLocaleDateString(LOCALE)}</td>
                  <td className="px-3 py-2"><TenantControls t={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {t.suspendedAt
        ? <Button size="sm" variant="secondary" loading={unsuspend.isPending} onClick={() => unsuspend.mutate()} title={t.suspendedReason ?? ""}>Restore</Button>
        : <Button size="sm" variant="ghost" loading={suspend.isPending} onClick={() => { const r = window.prompt(`Why suspend ${t.name}? The workspace sees this.`); if (r) suspend.mutate(r); }}>Suspend</Button>}
      <Button size="sm" variant="ghost" loading={cap.isPending} onClick={() => {
        const v = window.prompt("Daily send cap (recipients). Leave empty to use the plan limit.", t.sendCapDaily?.toString() ?? "");
        if (v === null) return;
        cap.mutate(v.trim() === "" ? null : Math.max(0, Number(v) || 0));
      }}>{t.sendCapDaily !== null ? `Cap ${t.sendCapDaily}` : "Set cap"}</Button>
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
      {q.isPending ? <Skeleton className="h-16" /> : !events.length ? <p className="text-sm text-muted">Nothing to review.</p> : (
        <>
          <ul className="divide-y divide-line rounded-lg border border-line text-sm">
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
              <div key={k} className="rounded-lg border border-line p-3"><dt className="text-xs text-muted">{k}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{v ?? 0}</dd></div>
            ))}
          </dl>
          {dead.length > 0 && (
            <>
              <ul className="mt-3 divide-y divide-line rounded-lg border border-line text-sm">
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
