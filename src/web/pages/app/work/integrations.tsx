/** Integrations: connect no-cost apps to workspace events, and receive data through incoming webhooks. */
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconArrowDownToLine, IconBranch, IconChats, IconHash, IconPlug, IconPlus, IconSheet, IconTeam, IconTrash, IconWebhook, IconWorkflow, IconZap, type IconComponent } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { ConfirmButton } from "@/web/components/ui/confirm";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";

interface Connector { id: string; name: string; description: string; icon: string; format: string; events: string[]; urlHint: string; help: string }
interface Connection { id: string; url: string; description: string | null; events: string[]; enabled: boolean; disabledReason: string | null; format: string; connector: string | null }
interface HookCall { at: string; ok: boolean; status: number; result?: { type: string; id: string }; error?: string }
interface Hook { id: string; name: string; action: "task" | "chat" | "contact"; enabled: boolean; tokenHint: string; callCount: number; lastCalledAt: string | null; recent: HookCall[]; config: { projectId?: string; channelId?: string } }

const ICONS: Record<string, IconComponent> = { Hash: IconHash, MessagesSquare: IconChats, Users: IconTeam, Zap: IconZap, Workflow: IconWorkflow, GitBranch: IconBranch, Sheet: IconSheet, Webhook: IconWebhook };
const ACTIONS = { task: "Create a task", chat: "Post a chat message", contact: "Create a contact" } as const;
const FIELDS = { task: ["title", "notes", "due", "assignee"], chat: ["text"], contact: ["email", "name", "phone", "notes"] } as const;
const EVENT_LABEL: Record<string, string> = {
  "task.created": "New task", "task.updated": "Task updated", "task.commented": "New comment", "chat.mention": "Chat mention", "form.submitted": "Form submitted",
  "deal.created": "New deal", "deal.updated": "Deal updated", "contact.created": "New contact", "meeting.created": "Meeting scheduled",
  "booking.created": "New booking", "booking.cancelled": "Booking cancelled", "message.received": "New email",
  "triage.created": "New in Triage", "triage.accepted": "Accepted from Triage",
};
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };
const time = (s: string) => new Date(s).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function IntegrationsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["connectors"], queryFn: () => api.get<{ catalogue: Connector[]; connections: Connection[] }>("/connectors") });
  const hooks = useQuery({ queryKey: ["incoming-hooks"], queryFn: async () => (await api.get<{ hooks: Hook[] }>("/incoming-hooks")).hooks });
  const [connecting, setConnecting] = useState<Connector | null>(null);
  const [creatingHook, setCreatingHook] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["connectors"] }); qc.invalidateQueries({ queryKey: ["incoming-hooks"] }); };
  const byId = new Map((q.data?.catalogue ?? []).map((c) => [c.id, c]));

  const test = async (c: Connection) => {
    try {
      const r = await api.post<{ delivery: { status: string; responseStatus: number | null; lastError: string | null } }>(`/connectors/${c.id}/test`);
      if (r.delivery.status === "delivered") toast.success("Test sent. Check the other app.");
      else toast.error(r.delivery.lastError ?? "The test did not arrive.");
      refresh();
    } catch (e) { showError(e as Error); }
  };
  const toggle = async (c: Connection, enabled: boolean) => { try { await api.patch(`/connectors/${c.id}`, { enabled }); refresh(); } catch (e) { showError(e as Error); } };
  const remove = async (c: Connection) => {
    try { await api.del(`/connectors/${c.id}`); refresh(); } catch (e) { showError(e as Error); }
  };
  const toggleHook = async (h: Hook, enabled: boolean) => { try { await api.patch(`/incoming-hooks/${h.id}`, { enabled }); refresh(); } catch (e) { showError(e as Error); } };
  const removeHook = async (h: Hook) => {
    try { await api.del(`/incoming-hooks/${h.id}`); refresh(); } catch (e) { showError(e as Error); }
  };

  return (
    <div className="max-w-5xl space-y-8">
      <PageHeader title="Integrations" description="Send workspace events to the apps you already use, and turn posts from other tools into tasks, chat messages and contacts. No paid plans or app installs needed." />

      <section aria-labelledby="int-connected" className="space-y-3">
        <h2 id="int-connected" className="text-[15px] font-semibold">Connected</h2>
        {q.isLoading ? <Skeleton className="h-16" /> : !q.data?.connections.length ? (
          <Card><EmptyState icon={<IconPlug />} title="Nothing connected yet" body="Pick an app below, paste its webhook URL and choose which events to send." /></Card>
        ) : (
          <Card className="divide-y divide-line">
            {q.data.connections.map((c) => {
              const meta = c.connector ? byId.get(c.connector) : undefined;
              const Icon = ICONS[meta?.icon ?? "Webhook"] ?? IconWebhook;
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-fill text-muted" aria-hidden><Icon className="h-4 w-4" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{c.description ?? meta?.name}</span>{!c.enabled && <Badge tone="warn">Paused</Badge>}</div>
                    <div className="truncate text-[12.5px] text-muted">{hostOf(c.url)} · {c.events.length === 1 ? "1 event" : `${c.events.length} events`}{c.disabledReason ? ` · ${c.disabledReason}` : ""}</div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => test(c)}>Send test</Button>
                  <Switch checked={c.enabled} onChange={(v) => toggle(c, v)} label={`Send events to ${c.description ?? meta?.name}`} />
                  <ConfirmButton armedLabel="Disconnect?" aria-label={`Disconnect ${c.description ?? meta?.name}`} onConfirm={() => void remove(c)}><IconTrash className="h-4 w-4" /></ConfirmButton>
                </div>
              );
            })}
          </Card>
        )}
      </section>

      <section aria-labelledby="int-catalogue" className="space-y-3">
        <h2 id="int-catalogue" className="text-[15px] font-semibold">Send events to</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(q.data?.catalogue ?? []).map((c) => {
            const Icon = ICONS[c.icon] ?? IconWebhook;
            return (
              <Card key={c.id} className="flex flex-col p-4">
                <div className="flex items-center gap-3">
                  <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand/10 text-brand" aria-hidden><Icon className="h-4 w-4" /></div>
                  <h3 className="text-sm font-semibold">{c.name}</h3>
                </div>
                <p className="mt-2 flex-1 text-[13px] leading-relaxed text-muted">{c.description}</p>
                <Button className="mt-3 self-start" size="sm" variant="secondary" aria-label={`Connect ${c.name}`} onClick={() => setConnecting(c)}>Connect</Button>
              </Card>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="int-incoming" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="int-incoming" className="text-[15px] font-semibold">Incoming webhooks</h2>
            <p className="text-[13px] text-muted">A private URL that Zapier, Make, n8n, a website form or a script can post to.</p>
          </div>
          <Button size="sm" onClick={() => setCreatingHook(true)}><IconPlus className="h-4 w-4" aria-hidden />New incoming webhook</Button>
        </div>
        {hooks.isLoading ? <Skeleton className="h-16" /> : !hooks.data?.length ? (
          <Card><EmptyState icon={<IconArrowDownToLine />} title="No incoming webhooks" body="Create one to turn posts from other tools into tasks, chat messages or contacts." /></Card>
        ) : (
          <Card className="divide-y divide-line">
            {hooks.data.map((h) => <HookRow key={h.id} hook={h} onToggle={(v) => toggleHook(h, v)} onDelete={() => removeHook(h)} />)}
          </Card>
        )}
      </section>

      {connecting && <ConnectDialog connector={connecting} onClose={() => setConnecting(null)} onDone={refresh} />}
      {creatingHook && <HookDialog onClose={() => setCreatingHook(false)} onDone={refresh} />}
    </div>
  );
}

function HookRow({ hook: h, onToggle, onDelete }: { hook: Hook; onToggle: (v: boolean) => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const last = h.recent[0];
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{h.name}</span>{!h.enabled && <Badge tone="warn">Off</Badge>}</div>
          <div className="truncate text-[12.5px] text-muted">{ACTIONS[h.action]} · /api/hooks/in/{h.tokenHint}... · {h.callCount === 1 ? "1 call" : `${h.callCount} calls`}{last ? ` · last ${time(last.at)}` : ""}</div>
        </div>
        {last && <Badge tone={last.ok ? "ok" : "warn"}>{last.ok ? "Working" : `Last call failed (${last.status})`}</Badge>}
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide calls" : "Recent calls"}</Button>
        <Switch checked={h.enabled} onChange={onToggle} label={`Accept posts for ${h.name}`} />
        <ConfirmButton armedLabel="Delete?" aria-label={`Delete ${h.name}`} title="Anything still posting to its URL will get an error" onConfirm={onDelete}><IconTrash className="h-4 w-4" /></ConfirmButton>
      </div>
      {open && (
        <ul className="mt-3 space-y-1 rounded-lg bg-fill p-3 text-[12.5px]" aria-label={`Recent calls to ${h.name}`}>
          {!h.recent.length && <li className="text-muted">No calls yet.</li>}
          {h.recent.map((c, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-28 shrink-0 tabular-nums text-muted">{time(c.at)}</span>
              <span className={cn("w-10 shrink-0 tabular-nums", c.ok ? "text-ok" : "text-warn")}>{c.status}</span>
              <span className="min-w-0 truncate">{c.ok ? `Created ${c.result?.type === "chat_message" ? "a message" : `a ${c.result?.type}`}` : c.error}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectDialog({ connector: c, onClose, onDone }: { connector: Connector; onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState(c.name);
  const [events, setEvents] = useState<string[]>(c.events.slice(0, 3));
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!events.length) return toast.error("Choose at least one event.");
    setBusy(true);
    try {
      const r = await api.post<{ secret?: string }>("/connectors", { connector: c.id, url: url.trim(), events, name: name.trim() || c.name });
      onDone();
      if (r.secret) setSecret(r.secret); else { toast.success(`${c.name} connected.`); onClose(); }
    } catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  if (secret) {
    return (
      <Dialog open onClose={onClose} title={`${c.name} connected`} description="Your endpoint can check each request with this signing secret. It is shown once." footer={<Button onClick={onClose}>Done</Button>}>
        <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded-lg bg-fill px-3 py-2 text-[12.5px]">{secret}</code><CopyButton value={secret} /></div>
      </Dialog>
    );
  }
  return (
    <Dialog open onClose={onClose} title={`Connect ${c.name}`} description={c.help}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="connect-form" disabled={busy}>{busy ? "Connecting..." : "Connect"}</Button></>}>
      <form id="connect-form" onSubmit={submit} className="space-y-4">
        <Field label="Webhook URL">{(p) => <Input {...p} type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder={c.urlHint} autoComplete="off" />}</Field>
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}</Field>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Events to send</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {c.events.map((ev) => (
              <label key={ev} className="flex min-h-9 items-center gap-2 text-[13px]">
                <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand,#0071e3)]" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />
                {EVENT_LABEL[ev] ?? ev}
              </label>
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

function HookDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [action, setAction] = useState<Hook["action"]>("task");
  const [projectId, setProjectId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string } | null>(null);
  const projects = useQuery({ queryKey: ["projects"], enabled: action === "task", queryFn: async () => (await api.get<{ projects: { id: string; name: string }[] }>("/projects")).projects });
  const channels = useQuery({ queryKey: ["chat", "channels"], enabled: action === "chat", queryFn: async () => (await api.get<{ channels: { id: string; name: string; kind?: string }[] }>("/chat/channels")).channels });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const m = Object.fromEntries(Object.entries(mapping).filter(([k, v]) => v.trim() && (FIELDS[action] as readonly string[]).includes(k)).map(([k, v]) => [k, v.trim()]));
      const r = await api.post<{ url: string }>("/incoming-hooks", { name: name.trim(), action, config: { ...(action === "task" && projectId ? { projectId } : {}), ...(action === "chat" ? { channelId } : {}), ...(Object.keys(m).length ? { mapping: m } : {}) } });
      onDone();
      setCreated({ url: r.url });
    } catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  if (created) {
    const example = `curl -X POST ${created.url} -H "content-type: application/json" -d '{"title":"Call back Jo","due":"2026-11-02"}'`;
    return (
      <Dialog open onClose={onClose} title="Incoming webhook ready" description="Copy the URL now. For your security it is shown once; anyone with it can post." footer={<Button onClick={onClose}>Done</Button>}>
        <div className="space-y-3">
          <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded-lg bg-fill px-3 py-2 text-[12.5px]" data-testid="hook-url">{created.url}</code><CopyButton value={created.url} /></div>
          <p className="text-[13px] text-muted">Try it from a terminal:</p>
          <code className="block whitespace-pre-wrap break-all rounded-lg bg-fill px-3 py-2 text-[12px]">{example}</code>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog open onClose={onClose} title="New incoming webhook" description="Posts can be JSON or a form, up to 64 KB."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="hook-form" disabled={busy}>{busy ? "Creating..." : "Create"}</Button></>}>
      <form id="hook-form" onSubmit={submit} className="space-y-4">
        <Field label="Name">{(p) => <Input {...p} required value={name} onChange={(e) => setName(e.target.value)} placeholder="Website enquiries" maxLength={80} />}</Field>
        <Field label="When a post arrives">
          {(p) => <Select {...p} value={action} onChange={(e) => setAction(e.target.value as Hook["action"])}>
            {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>}
        </Field>
        {action === "task" && (
          <Field label="Project" hint="Leave empty for the default project.">
            {(p) => <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Default project</option>
              {(projects.data ?? []).map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
            </Select>}
          </Field>
        )}
        {action === "chat" && (
          <Field label="Channel">
            {(p) => <Select {...p} required value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">Choose a channel</option>
              {(channels.data ?? []).filter((c) => c.kind !== "dm").map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </Select>}
          </Field>
        )}
        <details className="rounded-lg bg-fill px-3 py-2 text-[13px]">
          <summary className="cursor-pointer font-medium">Field mapping (optional)</summary>
          <p className="mt-2 text-muted">By default the {FIELDS[action][0]} comes from fields like title, text or subject. Name another field here, for example data.subject.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {FIELDS[action].map((f) => (
              <Field key={f} label={f[0].toUpperCase() + f.slice(1)}>{(p) => <Input {...p} value={mapping[f] ?? ""} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value })} placeholder="Automatic" />}</Field>
            ))}
          </div>
        </details>
      </form>
    </Dialog>
  );
}
