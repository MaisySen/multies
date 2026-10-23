import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, KeyRound, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { useConfig, useMe, useOrg, qk } from "@/web/lib/queries";
import { PLAN_ORDER, PLANS, type PlanId } from "@/shared/plans";
import { Badge, Card, CopyButton, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input } from "@/web/components/ui/input";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";

export function SettingsPage() {
  const loc = useLocation();
  useEffect(() => { if (loc.hash) setTimeout(() => document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: "smooth" }), 100); }, [loc.hash]);
  return (
    <>
      <PageHeader title="Settings" description="Workspace, plan, mail routing and your account." />
      <div className="space-y-6">
        <WorkspaceSection />
        <PlanSection />
        <InboundSection />
        <OutboundSection />
        <AccountSection />
      </div>
    </>
  );
}

function Section({ id, title, description, children }: { id?: string; title: string; description: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-6">
      <div className="grid gap-6 p-5 md:grid-cols-[260px_1fr] md:p-6">
        <div><h2 className="text-[15px] font-semibold">{title}</h2><div className="mt-1 text-sm text-muted">{description}</div></div>
        <div className="min-w-0">{children}</div>
      </div>
    </Card>
  );
}

function WorkspaceSection() {
  const org = useOrg();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  useEffect(() => { if (org.data) setName(org.data.organization.name); }, [org.data]);
  const m = useMutation({
    mutationFn: () => api.patch("/org", { name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.org }); qc.invalidateQueries({ queryKey: qk.me }); toast.success("Workspace renamed"); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Section title="Workspace" description="The name your team sees.">
      {org.isPending ? <Skeleton className="h-10 max-w-md" /> : (
        <form className="flex max-w-md items-end gap-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <Field label="Workspace name" className="flex-1">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />}</Field>
          <Button type="submit" variant="secondary" loading={m.isPending} disabled={!name.trim() || name === org.data?.organization.name}>Save</Button>
        </form>
      )}
    </Section>
  );
}

function PlanSection() {
  const org = useOrg();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (plan: PlanId) => api.post("/org/plan", { plan }),
    onSuccess: () => { qc.invalidateQueries(); toast.success("Plan updated"); },
    onError: (e) => toast.error(e.message),
  });
  const current = org.data?.organization.plan;
  return (
    <Section title="Plan" description={<>Limits are enforced on the server. Billing isn't connected yet, so switching plans is free while MyMail is in preview.</>}>
      <div className="grid gap-3 lg:grid-cols-3">
        {PLAN_ORDER.map((id) => {
          const p = PLANS[id];
          const isCurrent = id === current;
          return (
            <div key={id} className={cn("flex flex-col rounded-xl border p-4", isCurrent ? "border-brand/50 bg-brand-soft/40" : "border-line")}>
              <div className="flex items-center justify-between"><span className="font-semibold">{p.name}</span>{isCurrent && <Badge tone="brand">Current</Badge>}</div>
              <div className="mt-1 text-sm text-muted">${p.priceMonthly}/mo</div>
              <ul className="mt-3 flex-1 space-y-1 text-xs text-muted">
                <li>{p.limits.domains} domains · {p.limits.mailboxes} mailboxes</li>
                <li>{p.limits.aliases.toLocaleString()} aliases · {p.limits.storagePerMailboxMb / 1024} GB each</li>
                <li>{p.limits.dailySends.toLocaleString()} recipients / day</li>
              </ul>
              {!isCurrent && <Button size="sm" variant="secondary" className="mt-4" loading={m.isPending && m.variables === id} onClick={() => m.mutate(id)}>Switch to {p.name}</Button>}
            </div>
          );
        })}
      </div>
      {org.data && (
        <p className="mt-3 text-xs text-subtle">Using {org.data.usage.domains} domain{org.data.usage.domains === 1 ? "" : "s"}, {org.data.usage.mailboxes} mailbox{org.data.usage.mailboxes === 1 ? "" : "es"} and {org.data.usage.aliases} alias{org.data.usage.aliases === 1 ? "" : "es"}.</p>
      )}
    </Section>
  );
}

interface InboundKey { id: string; createdAt: string; lastUsedAt: string | null }

function InboundSection() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["inbound-keys"], queryFn: async () => (await api.get<{ keys: InboundKey[] }>("/inbound-keys")).keys });
  const [created, setCreated] = useState<{ id: string; secret: string; webhookUrl: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ key: { id: string; secret: string }; webhookUrl: string }>("/inbound-keys"),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["inbound-keys"] }); setCreated({ ...r.key, webhookUrl: r.webhookUrl }); },
    onError: (e) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/inbound-keys/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["inbound-keys"] }); toast.success("Key revoked"); },
    onError: (e) => toast.error(e.message),
  });
  const webhook = `${window.location.origin}/api/inbound/cloudflare`;
  return (
    <Section id="inbound" title="Inbound mail" description={<>Cloudflare Email Routing receives your mail and a small Email Worker delivers it here, signed with one of these keys.</>}>
      <ol className="space-y-4 text-sm">
        <Step n={1} title="Point your domain at Cloudflare Email Routing">Add the domain to Cloudflare and enable <b className="font-medium">Email → Email Routing</b>. Your domain page will show the MX and SPF checks turn green.</Step>
        <Step n={2} title="Create a signing key">
          <div className="mt-2 space-y-2">
            {keys.isPending ? <Skeleton className="h-12" /> : keys.data?.map((k) => (
              <div key={k.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg/40 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2.5"><KeyRound className="h-4 w-4 shrink-0 text-subtle" /><code className="truncate font-mono text-[12.5px]">{k.id}</code></div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-subtle">
                  <span>{k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}</span>
                  <button onClick={() => revoke.mutate(k.id)} className="rounded p-1 hover:bg-hover hover:text-bad" aria-label={`Revoke ${k.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => create.mutate()} loading={create.isPending}><Plus className="h-4 w-4" />Create key</Button>
          </div>
        </Step>
        <Step n={3} title="Deploy the Email Worker">
          From the repository's <code className="font-mono text-[12.5px]">email-worker/</code> folder, set the webhook URL and key, then route your catch-all to the worker.
          <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[12px] leading-relaxed text-fg/85">{`MYMAIL_WEBHOOK_URL = "${webhook}"
MYMAIL_KEY_ID      = "${keys.data?.[0]?.id ?? "ink_…"}"
npx wrangler deploy
npx wrangler secret put MYMAIL_KEY_SECRET`}</pre>
        </Step>
      </ol>
      <Dialog open={!!created} onClose={() => setCreated(null)} title="Your new signing key" description="Copy the secret now — for your security it won't be shown again."
        footer={<Button onClick={() => setCreated(null)}><Check className="h-4 w-4" />I've saved it</Button>}>
        {created && (
          <div className="space-y-3 text-sm">
            <Secret label="MYMAIL_KEY_ID" value={created.id} />
            <Secret label="MYMAIL_KEY_SECRET" value={created.secret} />
            <Secret label="MYMAIL_WEBHOOK_URL" value={webhook} />
          </div>
        )}
      </Dialog>
    </Section>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-bg/60 px-3 py-2"><code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{value}</code><CopyButton value={value} /></div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line-strong text-[11px] font-semibold text-muted">{n}</span>
      <div className="min-w-0 flex-1"><div className="font-medium">{title}</div><div className="mt-0.5 text-muted">{children}</div></div>
    </li>
  );
}

function OutboundSection() {
  const config = useConfig();
  const live = config.data?.outboundDriver && config.data.outboundDriver !== "log";
  return (
    <Section title="Outbound mail" description="How mail to addresses outside MyMail leaves the platform.">
      <div className={cn("flex gap-3 rounded-lg border p-4 text-sm", live ? "border-ok/20 bg-ok-soft/40" : "border-warn/20 bg-warn-soft/40")}>
        {live ? <Send className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />}
        <div>
          <div className="font-medium">{live ? `Sending through ${config.data?.outboundDriver}` : "No email provider connected"}</div>
          <p className="mt-0.5 text-muted">
            {live ? "External recipients receive your mail with your domain's SPF, DKIM and DMARC." : "Mail between MyMail addresses is delivered instantly. Mail to outside addresses is saved to Sent and logged as queued until the server has an email provider key (RESEND_API_KEY)."}
          </p>
        </div>
      </div>
    </Section>
  );
}

function AccountSection() {
  const me = useMe();
  return (
    <Section title="Account" description="You sign in with your email and password. Sessions are stored server-side and expire after 30 days of inactivity.">
      <dl className="grid max-w-md gap-3 text-sm">
        <div className="flex justify-between gap-4"><dt className="text-muted">Name</dt><dd>{me.data?.user.name}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted">Email</dt><dd className="truncate">{me.data?.user.email}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted">Role</dt><dd className="capitalize">{me.data?.organization?.role}</dd></div>
      </dl>
    </Section>
  );
}
