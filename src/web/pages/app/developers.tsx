import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, KeyRound, Plus, Send, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { CopyButton, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { Section } from "./settings";

interface ApiKey { id: string; name: string; prefix: string; scope: "full" | "read"; lastUsedAt: string | null; createdAt: string }
interface Endpoint { id: string; url: string; description: string | null; events: string[]; enabled: boolean; createdAt: string }
interface Delivery { id: string; eventType: string; status: "pending" | "delivered" | "failed"; attempts: number; responseStatus: number | null; lastError: string | null; createdAt: string }

export function DeveloperSettings() {
  const me = useMe();
  if (me.data?.organization?.role === "member") {
    return <p className="text-sm text-muted">API keys and webhooks are managed by workspace admins.</p>;
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-elevated px-4 py-3 text-sm">
        <span className="text-muted">REST API for domains, mailboxes, aliases and mail, with an OpenAPI spec.</span>
        <a href="/api/v1/docs" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline"><BookOpen className="h-4 w-4" />API reference</a>
      </div>
      <ApiKeys />
      <Webhooks />
    </div>
  );
}

function ApiKeys() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: async () => (await api.get<{ apiKeys: ApiKey[] }>("/developer/keys")).apiKeys });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"full" | "read">("full");
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ secret: string }>("/developer/keys", { name, scope }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["api-keys"] }); setOpen(false); setName(""); setSecret(r.secret); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/developer/keys/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["api-keys"] }); toast.success("Key deleted. Requests using it now fail."); },
  });
  return (
    <Section title="API keys" description="Keys act for the whole workspace. Give each app or script its own, so you can delete one without breaking the rest.">
      <div>
        {keys.isPending ? <Skeleton className="h-12" /> : keys.data?.length ? keys.data.map((k) => (
          <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0">
            <div className="flex min-w-0 items-center gap-2.5">
              <KeyRound className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
              <span className="truncate text-sm font-medium">{k.name}</span>
              <code className="font-mono text-[12px] text-subtle">{k.prefix}...</code>
              {k.scope === "read" && <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">read only</span>}
            </div>
            <div className="flex items-center gap-3 text-xs text-subtle">
              <span>{k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}</span>
              <button onClick={() => del.mutate(k.id)} className="rounded p-1 hover:bg-hover hover:text-bad" aria-label={`Delete key ${k.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        )) : <p className="text-sm text-muted">No API keys yet.</p>}
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Create API key</Button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="New API key"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Create</Button></>}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
          <Field label="Name" hint="What will use it, for example: Billing service" error={create.error instanceof ApiError ? create.error.message : undefined}>
            {(p) => <Input {...p} autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Access">
            {(p) => <Select {...p} value={scope} onChange={(e) => setScope(e.target.value as "full" | "read")}><option value="full">Full access</option><option value="read">Read only</option></Select>}
          </Field>
        </form>
      </Dialog>
      <Dialog open={!!secret} onClose={() => setSecret(null)} title="Copy your API key" description="It is shown once. Store it in your app's secret settings."
        footer={<Button onClick={() => setSecret(null)}><Check className="h-4 w-4" />Done</Button>}>
        {secret && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-line bg-bg/60 px-3 py-2"><code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{secret}</code><CopyButton value={secret} /></div>
            <pre className="overflow-x-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[12px] text-muted">{`curl ${location.origin}/api/v1/mailboxes \\\n  -H "Authorization: Bearer ${secret.slice(0, 16)}..."`}</pre>
          </div>
        )}
      </Dialog>
    </Section>
  );
}

function Webhooks() {
  const qc = useQueryClient();
  const endpoints = useQuery({ queryKey: ["webhooks"], queryFn: async () => (await api.get<{ endpoints: Endpoint[] }>("/developer/webhooks")).endpoints });
  const events = useQuery({ queryKey: ["webhook-events"], queryFn: async () => (await api.get<{ events: string[] }>("/developer/events")).events, staleTime: Infinity });
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<string[]>(["*"]);
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ secret: string }>("/developer/webhooks", { url, events: picked }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["webhooks"] }); setOpen(false); setUrl(""); setPicked(["*"]); setSecret(r.secret); },
  });
  const toggle = (ev: string) => setPicked((cur) => (ev === "*" ? ["*"] : cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur.filter((x) => x !== "*"), ev]));
  return (
    <Section title="Webhooks" description="We POST events to your URL, signed with the Standard Webhooks spec. Failed deliveries retry for about nine hours.">
      <div>
        {endpoints.isPending ? <Skeleton className="h-12" /> : endpoints.data?.length ? endpoints.data.map((e) => <EndpointRow key={e.id} e={e} />) : <p className="text-sm text-muted">No endpoints yet.</p>}
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Add endpoint</Button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="New webhook endpoint"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={create.isPending} disabled={!url.trim() || !picked.length} onClick={() => create.mutate()}>Add endpoint</Button></>}>
        <div className="space-y-4">
          <Field label="URL" hint="Must be https and reachable from the internet." error={create.error instanceof ApiError ? create.error.message : undefined}>
            {(p) => <Input {...p} autoFocus inputMode="url" placeholder="https://example.com/webhooks/mymail" value={url} onChange={(e) => setUrl(e.target.value)} />}
          </Field>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Events</legend>
            <div className="flex flex-wrap gap-2">
              {["*", ...(events.data ?? [])].map((ev) => (
                <button type="button" key={ev} onClick={() => toggle(ev)} aria-pressed={picked.includes(ev)}
                  className={cn("rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors", picked.includes(ev) ? "border-brand bg-brand/10 text-fg" : "border-line text-muted hover:text-fg")}>
                  {ev === "*" ? "all events" : ev}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </Dialog>
      <Dialog open={!!secret} onClose={() => setSecret(null)} title="Signing secret" description="Verify each request with this secret and any Standard Webhooks library. You can see it again from the endpoint."
        footer={<Button onClick={() => setSecret(null)}><Check className="h-4 w-4" />Done</Button>}>
        {secret && <div className="flex items-center gap-2 rounded-lg border border-line bg-bg/60 px-3 py-2"><code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{secret}</code><CopyButton value={secret} /></div>}
      </Dialog>
    </Section>
  );
}

function EndpointRow({ e }: { e: Endpoint }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const deliveries = useQuery({ queryKey: ["deliveries", e.id], enabled: expanded, queryFn: async () => (await api.get<{ deliveries: Delivery[] }>(`/developer/webhooks/${e.id}/deliveries`)).deliveries });
  const test = useMutation({
    mutationFn: () => api.post<{ delivery: Delivery }>(`/developer/webhooks/${e.id}/test`, {}),
    onSuccess: (r) => { setExpanded(true); qc.invalidateQueries({ queryKey: ["deliveries", e.id] }); if (r.delivery.status === "delivered") toast.success(`Test delivered (${r.delivery.responseStatus})`); else toast.error(r.delivery.lastError ?? "Test failed"); },
  });
  const reveal = useMutation({ mutationFn: () => api.get<{ secret: string }>(`/developer/webhooks/${e.id}/secret`) });
  const del = useMutation({ mutationFn: () => api.del(`/developer/webhooks/${e.id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks"] }) });
  const toggle = useMutation({ mutationFn: () => api.patch(`/developer/webhooks/${e.id}`, { enabled: !e.enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks"] }) });
  return (
    <div className="border-b border-line last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3 py-2">
        <button className="flex min-w-0 items-center gap-2.5 text-left" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}>
          <WebhookIcon className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
          <span className="truncate font-mono text-[12.5px]">{e.url}</span>
          {!e.enabled && <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">paused</span>}
        </button>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" loading={test.isPending} onClick={() => test.mutate()}><Send className="h-3.5 w-3.5" />Send test</Button>
          <Button size="sm" variant="ghost" onClick={() => toggle.mutate()}>{e.enabled ? "Pause" : "Resume"}</Button>
          <button onClick={() => del.mutate()} className="rounded p-1.5 text-subtle hover:bg-hover hover:text-bad" aria-label={`Delete endpoint ${e.url}`}><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {expanded && (
        <div className="space-y-3 pb-4 pl-6 text-sm">
          <div className="text-xs text-muted">Events: <span className="font-mono">{e.events.join(", ")}</span></div>
          <div className="flex items-center gap-2 text-xs">
            {reveal.data ? <><code className="min-w-0 flex-1 break-all font-mono">{reveal.data.secret}</code><CopyButton value={reveal.data.secret} /></>
              : <button className="font-medium text-brand hover:underline" onClick={() => reveal.mutate()}>Show signing secret</button>}
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted">Recent deliveries</div>
            {deliveries.isPending ? <Skeleton className="h-8" /> : deliveries.data?.length ? (
              <ul className="divide-y divide-line rounded-md border border-line">
                {deliveries.data.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
                    <span className="font-mono">{d.eventType}</span>
                    <span className={cn(d.status === "delivered" ? "text-ok" : d.status === "failed" ? "text-bad" : "text-warn")}>
                      {d.status}{d.responseStatus ? ` ${d.responseStatus}` : ""}{d.attempts > 1 ? `, ${d.attempts} tries` : ""}
                    </span>
                    <span className="text-subtle">{timeAgo(d.createdAt)}</span>
                    {d.lastError && d.status !== "delivered" && <span className="w-full text-subtle">{d.lastError}</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-muted">Nothing sent yet. Use "Send test" to try it.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
