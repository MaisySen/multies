import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { sendSentryTest, sentryEnabled } from "@/web/lib/sentry";
import { Badge, Card, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Section } from "./settings";
import { LOCALE } from "@/shared/locale";

interface Overview {
  totals: { users: number; workspaces: number; domains: number; mailboxes: number; deliveries24h: number };
  tenants: { id: string; name: string; plan: string; isDemo: boolean; createdAt: string; members: number; domains: number }[];
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
        {Object.entries({ Users: totals.users, Workspaces: totals.workspaces, Domains: totals.domains, Mailboxes: totals.mailboxes, "Deliveries, 24h": totals.deliveries24h }).map(([k, v]) => (
          <Card key={k} className="p-4"><div className="text-xs text-muted">{k}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{v}</div></Card>
        ))}
      </div>
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
      <Section title="Workspaces" description="Newest first, up to 100.">
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Plan</th><th className="px-3 py-2 font-medium">Members</th><th className="px-3 py-2 font-medium">Domains</th><th className="px-3 py-2 font-medium">Created</th></tr></thead>
            <tbody className="divide-y divide-line">
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td className="px-3 py-2">{t.name}{t.isDemo && <Badge className="ml-2">demo</Badge>}</td>
                  <td className="px-3 py-2 capitalize">{t.plan}</td>
                  <td className="px-3 py-2 tabular-nums">{t.members}</td>
                  <td className="px-3 py-2 tabular-nums">{t.domains}</td>
                  <td className="px-3 py-2 text-muted">{new Date(t.createdAt).toLocaleDateString(LOCALE)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
