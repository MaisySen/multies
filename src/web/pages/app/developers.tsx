import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAgent, IconBook, IconCheck, IconKey, IconPlus, IconSend, IconTrash, IconWebhook } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { CopyButton, Skeleton, Switch } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input } from "@/web/components/ui/input";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { Section } from "./settings";

interface ApiKey { id: string; name: string; prefix: string; scope: string; showOnlyUsableTools?: boolean; scopeChips?: string[]; agentId?: string | null; lastUsedAt: string | null; createdAt: string }
interface Endpoint { id: string; url: string; description: string | null; events: string[]; enabled: boolean; disabledReason?: string | null; createdAt: string }
interface Delivery { id: string; eventType: string; status: "pending" | "delivered" | "failed"; attempts: number; responseStatus: number | null; lastError: string | null; createdAt: string }

export function DeveloperSettings() {
  const me = useMe();
  if (me.data?.organization?.role === "member") {
    return (
      <div className="space-y-6">
        <ConnectedApps />
        <p className="text-sm text-muted">API keys and webhooks are managed by workspace admins.</p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-elevated px-4 py-3 text-sm">
        <span className="text-muted">REST API for domains, mailboxes, aliases and mail, with an OpenAPI spec.</span>
        <a href="/api/v1/reference" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline"><IconBook className="h-4 w-4" />API reference</a>
      </div>
      <ConnectedApps />
      <ApiKeys />
      <Webhooks />
    </div>
  );
}

interface ScopeArea { area: string; label: string; read: string; write: string; readLabel: string; writeLabel: string; note: string }
type Preset = "full" | "read" | "custom";

/** R36: the stored value for a picked preset or list ("full" and "read" stay presets, so old keys are unchanged). */
const scopeValue = (preset: Preset, picked: string[]) => (preset === "custom" ? picked : preset);
const presetOf = (scope: string): { preset: Preset; picked: string[] } => (scope === "full" || scope === "read" ? { preset: scope, picked: [] } : { preset: "custom", picked: scope.split(/\s+/).filter(Boolean) });

function ScopeChips({ chips }: { chips: string[] }) {
  return <>{chips.map((c) => <span key={c} data-testid="scope-chip" className={cn("rounded-full border px-2 py-0.5 text-[11px]", c === "Full access" ? "border-brand/40 bg-brand-soft text-brand-hover" : "border-line text-muted")}>{c}</span>)}</>;
}

/** R36: presets plus a checkbox per area and level. Picking write also picks read. */
function ScopePicker({ preset, picked, onChange }: { preset: Preset; picked: string[]; onChange: (preset: Preset, picked: string[]) => void }) {
  const areas = useQuery({ queryKey: ["api-scopes"], queryFn: async () => (await api.get<{ areas: ScopeArea[] }>("/developer/scopes")).areas, staleTime: Infinity });
  const set = new Set(picked);
  const toggle = (a: ScopeArea, level: "read" | "write", on: boolean) => {
    const next = new Set(set);
    if (level === "write") { if (on) { next.add(a.write); next.add(a.read); } else next.delete(a.write); }
    else if (on) next.add(a.read); else { next.delete(a.read); next.delete(a.write); }
    onChange("custom", [...next]);
  };
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-[13px] font-medium">Access</legend>
      <div role="radiogroup" aria-label="Access preset" className="grid grid-cols-3 gap-1 rounded-lg bg-fill p-0.5 text-sm">
        {([["full", "Full access"], ["read", "Read only"], ["custom", "Choose areas"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={preset === id} onClick={() => onChange(id, id === "custom" && !picked.length ? ["tasks:read"] : picked)}
            className={cn("min-h-9 rounded-md px-2 py-1.5 transition-colors", preset === id ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>{label}</button>
        ))}
      </div>
      <p className="mt-2 text-xs text-subtle">{preset === "full" ? "Everything a workspace admin can do through the API and MCP." : preset === "read" ? "Reads every area. Any change or send is refused." : "Only the areas you tick. Calls outside them get insufficient_scope."}</p>
      {preset === "custom" ? (
        <div className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line">
          {(areas.data ?? []).map((a) => (
            <div key={a.area} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
              <div className="min-w-0 basis-full sm:basis-0 sm:flex-1"><p className="text-sm font-medium">{a.label}</p><p className="truncate text-xs text-subtle">{a.note}</p></div>
              <label className="flex min-h-9 items-center gap-1.5 text-[13px]"><input type="checkbox" className="h-4 w-4 accent-brand" checked={set.has(a.read)} onChange={(e) => toggle(a, "read", e.target.checked)} aria-label={`${a.label}: read`} />Read</label>
              <label className="flex min-h-9 items-center gap-1.5 text-[13px]"><input type="checkbox" className="h-4 w-4 accent-brand" checked={set.has(a.write)} onChange={(e) => toggle(a, "write", e.target.checked)} aria-label={`${a.label}: ${a.writeLabel.toLowerCase()}`} />{a.writeLabel}</label>
            </div>
          ))}
          {areas.isPending ? <Skeleton className="h-40" /> : null}
        </div>
      ) : null}
    </fieldset>
  );
}

/**
 * R37: "Show only the tools this key can use". Shows how many MCP tools an agent with these scopes sees,
 * from the same catalog the docs page reads (/api/mcp-tools?scope=...).
 */
function ToolListToggle({ preset, picked, on, onChange }: { preset: Preset; picked: string[]; on: boolean; onChange: (v: boolean) => void }) {
  const scope = preset === "custom" ? picked.join(" ") : preset;
  const view = useQuery({
    queryKey: ["mcp-tools-view", scope],
    enabled: preset !== "full" && !!scope,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await fetch(`/api/mcp-tools?scope=${encodeURIComponent(scope)}`);
      if (!r.ok) throw new Error(String(r.status));
      const b = (await r.json()) as { total: number; tools: unknown[] };
      return { usable: b.tools.length, total: b.total };
    },
  });
  if (preset === "full") return <p className="rounded-lg bg-hover/60 px-3 py-2.5 text-xs text-subtle" data-testid="tool-list-note">Full access keys see every MCP tool.</p>;
  const count = view.data ? `${view.data.usable} of ${view.data.total} tools` : "Only the tools it can use";
  return (
    <div className="flex items-start gap-3 rounded-lg border border-line px-3 py-2.5" data-testid="tool-list-toggle">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Show only the tools this key can use</p>
        <p className="mt-0.5 text-xs text-subtle">{on ? `Agents see ${count}. Shorter lists help an agent pick the right tool.` : "Agents see every tool. Ones outside the scopes answer insufficient_scope."} A connection can still ask with <code className="whitespace-nowrap font-mono">?tools=all</code> or <code className="whitespace-nowrap font-mono">?tools=scoped</code>.</p>
      </div>
      <Switch checked={on} onChange={onChange} label="Show only the tools this key can use" />
    </div>
  );
}

function ApiKeys() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: async () => (await api.get<{ apiKeys: ApiKey[] }>("/developer/keys")).apiKeys });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<Preset>("full");
  const [picked, setPicked] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [editPreset, setEditPreset] = useState<Preset>("full");
  const [editPicked, setEditPicked] = useState<string[]>([]);
  const [hideTools, setHideTools] = useState(true); // R37: on by default for new scoped keys
  const [editHide, setEditHide] = useState(false);
  const create = useMutation({
    mutationFn: () => api.post<{ secret: string }>("/developer/keys", { name, scope: scopeValue(preset, picked), showOnlyUsableTools: preset !== "full" && hideTools }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["api-keys"] }); setOpen(false); setName(""); setPreset("full"); setPicked([]); setHideTools(true); setSecret(r.secret); },
  });
  const edit = useMutation({
    mutationFn: () => api.patch(`/developer/keys/${editing!.id}`, { scope: scopeValue(editPreset, editPicked), showOnlyUsableTools: editPreset !== "full" && editHide }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["api-keys"] }); setEditing(null); toast.success("Scopes saved. They apply to the next request."); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/developer/keys/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["api-keys"] }); toast.success("Key deleted. Requests using it now fail."); },
  });
  const startEdit = (k: ApiKey) => { const p = presetOf(k.scope); setEditPreset(p.preset); setEditPicked(p.picked); setEditHide(!!k.showOnlyUsableTools); setEditing(k); };
  const customEmpty = (p: Preset, list: string[]) => p === "custom" && list.length === 0;
  return (
    <Section title="API keys" description="Give each app or script its own key with only the access it needs, so you can change or delete one without breaking the rest.">
      <div>
        {keys.isPending ? <Skeleton className="h-12" /> : keys.data?.length ? keys.data.map((k) => (
          <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0" data-testid="api-key-row">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <IconKey className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
              <span className="truncate text-sm font-medium">{k.name}</span>
              <code className="font-mono text-[12px] text-subtle">{k.prefix}...</code>
              <ScopeChips chips={k.scopeChips ?? (k.scope === "read" ? ["Read only"] : ["Full access"])} />
              {k.showOnlyUsableTools ? <span data-testid="tool-list-chip" className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">Shows only its tools</span> : null}
            </div>
            <div className="flex items-center gap-2 text-xs text-subtle">
              <span>{k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}</span>
              {!k.agentId ? <button onClick={() => startEdit(k)} className="rounded px-2 py-1 font-medium text-brand-hover hover:bg-hover max-sm:min-h-11" aria-label={`Edit scopes of ${k.name}`}>Edit scopes</button> : null}
              <button onClick={() => del.mutate(k.id)} className="rounded p-1 hover:bg-hover hover:text-bad max-sm:min-h-11 max-sm:px-3" aria-label={`Delete key ${k.name}`}><IconTrash className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        )) : <p className="text-sm text-muted">No API keys yet.</p>}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><IconPlus className="h-4 w-4" />Create API key</Button>
          <a href="/developers/mcp" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"><IconBook className="h-4 w-4" />MCP tools and the scope each needs</a>
        </div>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="New API key"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={create.isPending} disabled={!name.trim() || customEmpty(preset, picked)} onClick={() => create.mutate()}>Create</Button></>}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !customEmpty(preset, picked)) create.mutate(); }}>
          <Field label="Name" hint="What will use it, for example: Billing service" error={create.error instanceof ApiError ? create.error.message : undefined}>
            {(p) => <Input {...p} autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <ScopePicker preset={preset} picked={picked} onChange={(pr, list) => { if (pr !== preset) setHideTools(pr === "custom"); setPreset(pr); setPicked(list); }} />
          <ToolListToggle preset={preset} picked={picked} on={hideTools} onChange={setHideTools} />
        </form>
      </Dialog>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing ? `Scopes for ${editing.name}` : "Scopes"} description="Apps using this key keep working; calls outside the new scopes get insufficient_scope."
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={edit.isPending} disabled={customEmpty(editPreset, editPicked)} onClick={() => edit.mutate()}>Save scopes</Button></>}>
        <ScopePicker preset={editPreset} picked={editPicked} onChange={(pr, list) => { setEditPreset(pr); setEditPicked(list); }} />
        <div className="mt-4"><ToolListToggle preset={editPreset} picked={editPicked} on={editHide} onChange={setEditHide} /></div>
        {edit.error instanceof ApiError ? <p className="mt-2 text-sm text-bad">{edit.error.message}</p> : null}
      </Dialog>
      <Dialog open={!!secret} onClose={() => setSecret(null)} title="Copy your API key" description="It is shown once. Store it in your app's secret settings."
        footer={<Button onClick={() => setSecret(null)}><IconCheck className="h-4 w-4" />Done</Button>}>
        {secret && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-line bg-bg/60 px-3 py-2"><code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{secret}</code><CopyButton value={secret} /></div>
            <pre tabIndex={0} aria-label="Example request" className="overflow-x-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[12px] text-muted">{`curl ${location.origin}/api/v1/mailboxes \\\n  -H "Authorization: Bearer ${secret.slice(0, 16)}..."`}</pre>
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
    <Section title="Webhooks" description="We POST events to your URL, signed with the Standard Webhooks spec. Failed deliveries retry for about nine hours, then wait in the log for you to replay them.">
      <div>
        {endpoints.isPending ? <Skeleton className="h-12" /> : endpoints.data?.length ? endpoints.data.map((e) => <EndpointRow key={e.id} e={e} />) : <p className="text-sm text-muted">No endpoints yet.</p>}
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => setOpen(true)}><IconPlus className="h-4 w-4" />Add endpoint</Button>
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
        footer={<Button onClick={() => setSecret(null)}><IconCheck className="h-4 w-4" />Done</Button>}>
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
  const replay = useMutation({
    mutationFn: () => api.post<{ replayed: number }>(`/developer/webhooks/${e.id}/replay`, {}),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["webhooks"] }); qc.invalidateQueries({ queryKey: ["deliveries", e.id] }); toast.success(r.replayed ? `Sending ${r.replayed} failed ${r.replayed === 1 ? "delivery" : "deliveries"} again` : "No failed deliveries to replay"); },
  });
  const failedCount = deliveries.data?.filter((d) => d.status === "failed").length ?? 0;
  return (
    <div className="border-b border-line last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3 py-2">
        <button className="flex min-w-0 items-center gap-2.5 text-left" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}>
          <IconWebhook className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
          <span className="truncate font-mono text-[12.5px]">{e.url}</span>
          {!e.enabled && <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">paused</span>}
        </button>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" loading={test.isPending} onClick={() => test.mutate()}><IconSend className="h-3.5 w-3.5" />Send test</Button>
          <Button size="sm" variant="ghost" onClick={() => toggle.mutate()}>{e.enabled ? "Pause" : "Resume"}</Button>
          <button onClick={() => del.mutate()} className="rounded p-1.5 text-subtle hover:bg-hover hover:text-bad" aria-label={`Delete endpoint ${e.url}`}><IconTrash className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {expanded && (
        <div className="space-y-3 pb-4 pl-6 text-sm">
          {e.disabledReason && <p className="rounded-md border border-bad/30 bg-bad/5 px-2.5 py-2 text-xs text-bad" role="alert">{e.disabledReason}</p>}
          <div className="text-xs text-muted">Events: <span className="font-mono">{e.events.join(", ")}</span></div>
          <div className="flex items-center gap-2 text-xs">
            {reveal.data ? <><code className="min-w-0 flex-1 break-all font-mono">{reveal.data.secret}</code><CopyButton value={reveal.data.secret} /></>
              : <button className="font-medium text-brand hover:underline" onClick={() => reveal.mutate()}>Show signing secret</button>}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted">Recent deliveries</span>
              {(failedCount > 0 || e.disabledReason) && (
                <Button size="sm" variant="ghost" loading={replay.isPending} onClick={() => replay.mutate()}>Replay failed</Button>
              )}
            </div>
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

interface Grant { id: string; client: string; scope: "full" | "read"; user: { id: string; name: string; email: string }; createdAt: string; lastUsedAt: string | null; mine: boolean }

/** AI apps and other MCP clients signed in with OAuth, round 20. */
function ConnectedApps() {
  const qc = useQueryClient();
  const grants = useQuery({ queryKey: ["oauth-grants"], queryFn: async () => (await api.get<{ grants: Grant[] }>("/oauth/grants")).grants });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/oauth/grants/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["oauth-grants"] }); toast.success("Disconnected"); },
    onError: (e) => toast.error(e.message),
  });
  const mcpUrl = `${window.location.origin}/api/v1/mcp`;
  return (
    <Section title="Connected AI apps" description="Add Multies to your chat app, code editor or any MCP client with this URL. The app asks you to sign in and pick a workspace; no key to copy.">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-elevated px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]" data-testid="mcp-url">{mcpUrl}</code>
        <CopyButton value={mcpUrl} />
      </div>
      <div className="mt-3" data-testid="connected-apps">
        {grants.isPending ? <Skeleton className="h-12" /> : grants.data?.length ? grants.data.map((g) => (
          <div key={g.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0">
            <div className="flex min-w-0 items-center gap-2.5">
              <IconAgent className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
              <span className="truncate text-sm font-medium">{g.client}</span>
              {!g.mine && <span className="truncate text-xs text-muted">{g.user.name || g.user.email}</span>}
              <ScopeChips chips={[g.scope === "read" ? "Read only" : "Full access"]} />
            </div>
            <div className="flex items-center gap-3 text-xs text-subtle">
              <span>{g.lastUsedAt ? `used ${timeAgo(g.lastUsedAt)}` : `connected ${timeAgo(g.createdAt)}`}</span>
              <Button size="sm" variant="ghost" aria-label={`Disconnect ${g.client}`} loading={revoke.isPending && revoke.variables === g.id} onClick={() => revoke.mutate(g.id)}>Disconnect</Button>
            </div>
          </div>
        )) : <p className="text-sm text-muted">No AI apps connected yet.</p>}
      </div>
    </Section>
  );
}
