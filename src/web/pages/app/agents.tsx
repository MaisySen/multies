import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAgent, IconCheck, IconChevronRight, IconKey, IconPause, IconPlay, IconPlus, IconShieldCheck, IconTrash, IconTrendingUp } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { useDomains, useMailboxes, useMe, useOrg } from "@/web/lib/queries";
import { showError } from "@/web/lib/show-error";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { timeAgo } from "@/web/lib/format";
import { auditLabel } from "@/web/components/app-bits";

export interface AgentInfo {
  id: string; name: string; description: string | null; address: string; inboxId: string;
  approvalMode: "always" | "external" | "never"; sendCapDaily: number; allowedRecipients: string[] | null;
  status: "active" | "paused"; mailboxIds: string[]; sentToday: number; pendingApprovals: number; createdAt: string;
}
interface AgentKey { id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }
interface AuditRow { id: string; action: string; actorEmail: string | null; targetType: string | null; targetId: string | null; metadata: Record<string, unknown> | null; createdAt: string }

export const APPROVAL_LABEL: Record<AgentInfo["approvalMode"], string> = {
  always: "Approve every send",
  external: "Approve mail leaving Multies",
  never: "Sends without approval",
};

export const useAgents = () => useQuery({ queryKey: ["agents"], queryFn: async () => (await api.get<{ agents: AgentInfo[] }>("/agents")).agents });

const mcpUrl = () => `${window.location.origin}/api/v1/mcp`;

export function AgentsPage() {
  const agents = useAgents();
  const org = useOrg();
  const me = useMe();
  const canManage = me.data?.organization?.role !== "member";
  const [open, setOpen] = useState(false);
  const limit = org.data?.plan.limits.agentInboxes;
  return (
    <>
      <PageHeader title="Agents" description="Inboxes for your AI agents. They read and send through the API or MCP, inside the limits you set, and a person approves what they send unless you say otherwise."
        actions={canManage ? <Button size="sm" onClick={() => setOpen(true)}><IconPlus className="h-4 w-4" />New agent inbox</Button> : undefined} />
      {agents.isPending ? <Card className="p-5"><Skeleton className="h-10" /><Skeleton className="mt-3 h-10" /></Card>
        : agents.error ? <Card className="p-6 text-sm text-bad">{agents.error.message}</Card>
        : !agents.data.length ? (
          <Card><EmptyState icon={<IconAgent />} title="Give an agent its own inbox"
            body={<>Create one here, or with one API call. Your agent gets an address, a key that only works for that inbox, and mail as clean JSON. <Link className="text-brand-hover hover:underline" to="/agents">See the quickstart</Link>.</>}
            action={canManage ? <Button onClick={() => setOpen(true)}><IconPlus className="h-4 w-4" />New agent inbox</Button> : undefined} /></Card>
        ) : (
          <Card className="divide-y divide-line overflow-hidden">
            {agents.data.map((a) => (
              <Link key={a.id} to={`/app/agents/${a.id}`} className="group flex items-center gap-4 p-4 transition-colors hover:bg-hover sm:p-5">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-elevated text-muted"><IconAgent className="h-4 w-4" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{a.name}</span>
                    {a.status === "paused" ? <Badge tone="warn" dot>Paused</Badge> : <Badge tone="ok" dot>Active</Badge>}
                    {a.pendingApprovals > 0 && <Badge tone="brand">{a.pendingApprovals} to approve</Badge>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-subtle">{a.address}</div>
                </div>
                <div className="hidden text-right text-xs text-subtle sm:block">
                  <div>{APPROVAL_LABEL[a.approvalMode]}</div>
                  <div className="tabular-nums">{a.sentToday} of {a.sendCapDaily} sends today</div>
                </div>
                <IconChevronRight className="h-4 w-4 text-subtle transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </Card>
        )}
      {agents.data && limit !== undefined && <p className="mt-3 text-xs text-subtle">{agents.data.length} of {limit} agent inboxes on your plan. Each extra one is A$1 a month.</p>}
      <NewAgentDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function NewAgentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const domains = useDomains();
  const [name, setName] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [domainId, setDomainId] = useState("");
  const [mode, setMode] = useState<AgentInfo["approvalMode"]>("always");
  const [made, setMade] = useState<{ agent: AgentInfo; secret: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ agent: AgentInfo; apiKey: { secret: string } | null }>("/agents", {
      name: name.trim(), approvalMode: mode, ...(localPart.trim() ? { localPart: localPart.trim().toLowerCase() } : {}), ...(domainId ? { domainId } : {}),
    }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["agents"] }); qc.invalidateQueries({ queryKey: ["billing"] }); setMade({ agent: r.agent, secret: r.apiKey?.secret ?? "" }); setName(""); setLocalPart(""); },
    onError: (e) => { if (!(e instanceof ApiError) || e.code === "plan_limit") showError(e); },
  });
  const close = () => { onClose(); setMade(null); create.reset(); };
  const domain = domains.data?.find((d) => d.id === domainId) ?? domains.data?.find((d) => d.status === "verified") ?? domains.data?.[0];
  return (
    <>
      <Dialog open={open && !made} onClose={close} title="New agent inbox" description="The agent gets its own address and a key that only works for this inbox."
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Create inbox</Button></>}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
          <Field label="Agent name" hint="For example: Invoice bot" error={create.error instanceof ApiError && create.error.code !== "plan_limit" ? create.error.message : undefined}>
            {(p) => <Input {...p} autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address" hint={`Leave empty to use the name${domain ? ` @${domain.name}` : ""}`}>
              {(p) => <Input {...p} value={localPart} maxLength={64} placeholder="invoices" onChange={(e) => setLocalPart(e.target.value)} />}
            </Field>
            <Field label="Domain">
              {(p) => <Select {...p} value={domainId} onChange={(e) => setDomainId(e.target.value)}>
                <option value="">{domain ? domain.name : "Your first domain"}</option>
                {domains.data?.filter((d) => d.id !== domain?.id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>}
            </Field>
          </div>
          <Field label="Before it sends" hint="You can change this any time.">
            {(p) => <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as AgentInfo["approvalMode"])}>
              <option value="always">A person approves every message</option>
              <option value="external">A person approves mail to outside addresses</option>
              <option value="never">Send without approval</option>
            </Select>}
          </Field>
        </form>
      </Dialog>
      <Dialog open={!!made} onClose={close} title={made ? `${made.agent.address} is ready` : ""} description="Copy the agent key now. It is shown once and works only for this inbox."
        footer={<><Button variant="secondary" onClick={() => { const id = made?.agent.id; close(); if (id) navigate(`/app/agents/${id}`); }}>Open agent</Button><Button onClick={close}><IconCheck className="h-4 w-4" />Done</Button></>}>
        {made && <ConnectSnippets secret={made.secret} agentId={made.agent.id} />}
      </Dialog>
    </>
  );
}

function Snippet({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-subtle"><span>{label}</span><CopyButton value={value} /></div>
      <pre tabIndex={0} className="max-h-48 overflow-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[12px] leading-relaxed text-fg/90">{value}</pre>
    </div>
  );
}

export function ConnectSnippets({ secret, agentId }: { secret: string; agentId: string }) {
  const key = secret || "mm_live_YOUR_AGENT_KEY";
  const origin = window.location.origin;
  const mcp = JSON.stringify({ mcpServers: { mymail: { url: mcpUrl(), headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  return (
    <div className="space-y-3">
      {secret && <Snippet label="Agent key" value={secret} />}
      <Snippet label="MCP (code editors, terminal agents and other clients that take a URL and headers)" value={mcp} />
      <Snippet label="Read its threads" value={`curl ${origin}/api/v1/agents/${agentId}/threads \\\n  -H "Authorization: Bearer ${key}"`} />
    </div>
  );
}

interface TrackRecordInfo {
  mode: AgentInfo["approvalMode"];
  record: { window: number; decided: number; approvedAsIs: number; approvedEdited: number; rejected: number; expired: number; failed: number; pending: number; cleanStreak: number };
  suggestion: { mode: AgentInfo["approvalMode"]; direction: "loosen" | "tighten"; reason: string } | null;
}

/** Earned autonomy: how people decided this agent's recent requests, and the next approval mode worth trying. */
function TrackRecord({ agentId, mode, canManage, onApply, applying }: { agentId: string; mode: AgentInfo["approvalMode"]; canManage: boolean; onApply: (m: AgentInfo["approvalMode"]) => void; applying: boolean }) {
  const q = useQuery({ queryKey: ["agents", agentId, "track-record", mode], queryFn: () => api.get<TrackRecordInfo>(`/agents/${agentId}/track-record`) });
  const t = q.data;
  const r = t?.record;
  const total = r ? r.approvedAsIs + r.approvedEdited + r.rejected + r.expired : 0;
  const bar = r && total ? [
    { n: r.approvedAsIs, cls: "bg-ok", label: "Approved as written" },
    { n: r.approvedEdited, cls: "bg-brand", label: "Approved after edits" },
    { n: r.rejected, cls: "bg-bad", label: "Rejected" },
    { n: r.expired, cls: "bg-subtle/50", label: "Expired" },
  ] : [];
  return (
    <Card className="p-5" data-testid="track-record">
      <div className="flex items-center gap-2">
        <IconTrendingUp className="h-4 w-4 text-brand-hover" aria-hidden />
        <h2 className="text-sm font-semibold">Track record</h2>
      </div>
      <p className="mt-1 text-xs text-subtle">How people decided this agent's last {r?.window ?? 50} requests. Use it to decide how much it may do on its own.</p>
      {q.isPending ? <Skeleton className="mt-3 h-14" /> : !r || r.decided === 0 ? (
        <p className="mt-3 text-sm text-muted">{mode === "never" ? "This agent sends without approval, so there is nothing to score." : "No decisions yet. The record starts with the first approval."}</p>
      ) : (
        <>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-fill" role="img" aria-label={bar.map((b) => `${b.label}: ${b.n}`).join(", ")}>
            {bar.filter((b) => b.n > 0).map((b) => <span key={b.label} className={b.cls} style={{ width: `${(b.n / total) * 100}%` }} />)}
          </div>
          <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
            {bar.map((b) => (
              <div key={b.label} className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${b.cls}`} aria-hidden />
                <dt className="text-xs text-subtle">{b.label}</dt>
                <dd className="ml-auto tabular-nums">{b.n}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-subtle">{r.cleanStreak === 1 ? "1 approval in a row without a change." : `${r.cleanStreak} approvals in a row without a change.`}</p>
        </>
      )}
      {t?.suggestion && (
        <div className={`mt-4 rounded-lg border p-3 text-sm ${t.suggestion.direction === "tighten" ? "border-warn/25 bg-warn-soft/60" : "border-brand/25 bg-brand-soft/50"}`}>
          <p className="font-medium">{t.suggestion.direction === "tighten" ? "Suggested: tighten" : "Suggested: more independence"}</p>
          <p className="mt-0.5 text-muted">{t.suggestion.reason}</p>
          {canManage && (
            <Button size="sm" variant="secondary" className="mt-3" loading={applying} onClick={() => onApply(t.suggestion!.mode)}>
              Switch to "{APPROVAL_LABEL[t.suggestion.mode]}"
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function AgentDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const canManage = me.data?.organization?.role !== "member";
  const agent = useQuery({ queryKey: ["agents", id], queryFn: () => api.get<AgentInfo>(`/agents/${id}`) });
  const audit = useQuery({ queryKey: ["agents", id, "audit"], queryFn: async () => (await api.get<{ entries: AuditRow[] }>(`/agents/${id}/audit`)).entries });
  const update = useMutation({
    mutationFn: (patch: Partial<AgentInfo>) => api.patch<AgentInfo>(`/agents/${id}`, patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agents"] }); toast.success("Agent updated"); },
    onError: (e) => showError(e),
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useMutation({
    mutationFn: () => api.del(`/agents/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agents"] }); toast.success("Agent inbox deleted"); navigate("/app/agents"); },
    onError: (e) => showError(e),
  });
  if (agent.isPending) return <Card className="p-6"><Skeleton className="h-6 w-56" /><Skeleton className="mt-4 h-32" /></Card>;
  if (agent.error) return <Card className="p-6 text-sm text-bad">{agent.error.message}</Card>;
  const a = agent.data;
  return (
    <>
      <PageHeader title={a.name} description={<span className="font-mono">{a.address}</span>}
        actions={canManage ? <div className="flex gap-2">
          <Button size="sm" variant="secondary" loading={update.isPending && update.variables?.status !== undefined} onClick={() => update.mutate({ status: a.status === "active" ? "paused" : "active" })}>
            {a.status === "active" ? <><IconPause className="h-4 w-4" />Pause</> : <><IconPlay className="h-4 w-4" />Resume</>}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(true)}><IconTrash className="h-4 w-4" />Delete</Button>
        </div> : undefined} />
      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="min-w-0 space-y-6">
          <Guardrails a={a} disabled={!canManage} onSave={(p) => update.mutate(p)} saving={update.isPending} />
          {canManage && <Keys agentId={a.id} />}
        </div>
        <div className="min-w-0 space-y-6">
          <Card className="p-5">
            <h2 className="text-sm font-semibold">Today</h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-subtle">Sends used</dt><dd className="tabular-nums">{a.sentToday} of {a.sendCapDaily}</dd></div>
              <div><dt className="text-xs text-subtle">Waiting for approval</dt><dd className="tabular-nums">{a.pendingApprovals ? <Link className="text-brand-hover hover:underline" to="/app/approvals">{a.pendingApprovals}</Link> : 0}</dd></div>
            </dl>
          </Card>
          <TrackRecord agentId={a.id} mode={a.approvalMode} canManage={canManage} applying={update.isPending && update.variables?.approvalMode !== undefined} onApply={(m) => update.mutate({ approvalMode: m })} />
          <Card className="p-5">
            <h2 className="text-sm font-semibold">Connect</h2>
            <p className="mt-1 text-xs text-subtle">MCP server URL: <code className="font-mono">{mcpUrl()}</code></p>
            <div className="mt-3"><ConnectSnippets secret="" agentId={a.id} /></div>
          </Card>
          <Card className="p-5">
            <h2 className="text-sm font-semibold">Audit log</h2>
            <p className="mt-1 text-xs text-subtle">Everything this agent did, and every decision people made about it.</p>
            <ol className="mt-3 space-y-2.5 text-sm">
              {audit.isPending ? <Skeleton className="h-16" /> : !audit.data?.length ? <li className="text-muted">Nothing yet.</li> : audit.data.slice(0, 40).map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0"><span className="text-muted">{e.actorEmail?.startsWith("agent:") ? a.name : e.actorEmail ?? "Multies"}</span> {auditLabel(e.action)}
                    {typeof e.metadata?.subject === "string" && <span className="text-subtle"> "{e.metadata.subject}"</span>}</span>
                  <time className="shrink-0 text-xs text-subtle" dateTime={e.createdAt}>{timeAgo(e.createdAt)}</time>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${a.name}?`} description="This deletes its inbox and all of its mail, and its keys stop working. It can't be undone."
        footer={<><Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>Delete agent inbox</Button></>}>
        <p className="text-sm text-muted">Shared mailboxes it worked in are not touched.</p>
      </Dialog>
    </>
  );
}

function Guardrails({ a, disabled, onSave, saving }: { a: AgentInfo; disabled: boolean; onSave: (p: Partial<AgentInfo>) => void; saving: boolean }) {
  const mailboxes = useMailboxes();
  const [mode, setMode] = useState(a.approvalMode);
  const [cap, setCap] = useState(String(a.sendCapDaily));
  const [allow, setAllow] = useState((a.allowedRecipients ?? []).join("\n"));
  const [shared, setShared] = useState<string[]>(a.mailboxIds.filter((m) => m !== a.inboxId));
  const allowList = useMemo(() => allow.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean), [allow]);
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2"><IconShieldCheck className="h-4 w-4 text-brand-hover" aria-hidden /><h2 className="text-sm font-semibold">Guardrails</h2></div>
      <form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); onSave({ approvalMode: mode, sendCapDaily: Number(cap) || 0, allowedRecipients: allowList.length ? allowList : null, mailboxIds: shared }); }}>
        <Field label="Before it sends">
          {(p) => <Select {...p} disabled={disabled} value={mode} onChange={(e) => setMode(e.target.value as AgentInfo["approvalMode"])}>
            <option value="always">A person approves every message</option>
            <option value="external">A person approves mail to outside addresses</option>
            <option value="never">Send without approval</option>
          </Select>}
        </Field>
        <Field label="Messages a day" hint="Requests waiting for approval count too.">
          {(p) => <Input {...p} disabled={disabled} type="number" min={0} value={cap} onChange={(e) => setCap(e.target.value)} />}
        </Field>
        <Field label="Who it may send to" hint="One per line: an address, or @domain for a whole domain. Leave empty for anyone.">
          {(p) => <Textarea {...p} disabled={disabled} rows={3} value={allow} placeholder={"@acme.com.au\naccounts@supplier.com.au"} onChange={(e) => setAllow(e.target.value)} />}
        </Field>
        <fieldset>
          <legend className="text-sm font-medium">Shared mailboxes it can work</legend>
          <p className="text-xs text-subtle">It reads and replies in these beside your team. Its replies are labelled.</p>
          <div className="mt-2 space-y-1.5">
            {mailboxes.data?.length ? mailboxes.data.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={disabled} checked={shared.includes(m.id)} onChange={(e) => setShared(e.target.checked ? [...shared, m.id] : shared.filter((x) => x !== m.id))} />
                <span className="font-mono text-[13px]">{m.address}</span>
              </label>
            )) : <p className="text-sm text-muted">No other mailboxes yet.</p>}
          </div>
        </fieldset>
        {!disabled && <Button type="submit" size="sm" loading={saving}>Save guardrails</Button>}
      </form>
    </Card>
  );
}

function Keys({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["agents", agentId, "keys"], queryFn: async () => (await api.get<{ keys: AgentKey[] }>(`/agents/${agentId}/keys`)).keys });
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => api.post<{ secret: string }>(`/agents/${agentId}/keys`, {}), onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["agents", agentId, "keys"] }); setSecret(r.secret); }, onError: (e) => showError(e) });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/agents/${agentId}/keys/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["agents", agentId, "keys"] }); toast.success("Key revoked. Requests using it now fail."); } });
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2"><IconKey className="h-4 w-4 text-subtle" aria-hidden /><h2 className="text-sm font-semibold">Agent keys</h2></div>
      <p className="mt-1 text-xs text-subtle">They work only for this agent: its inbox, its shared mailboxes and its own send requests.</p>
      <div className="mt-3">
        {keys.isPending ? <Skeleton className="h-10" /> : keys.data?.length ? keys.data.map((k) => (
          <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-2 last:border-b-0">
            <span className="min-w-0 truncate text-sm">{k.name} <code className="font-mono text-[12px] text-subtle">{k.prefix}...</code></span>
            <span className="flex items-center gap-3 text-xs text-subtle">{k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}
              <button onClick={() => revoke.mutate(k.id)} className="rounded p-1 hover:bg-hover hover:text-bad" aria-label={`Revoke key ${k.name}`}><IconTrash className="h-3.5 w-3.5" /></button></span>
          </div>
        )) : <p className="text-sm text-muted">No keys. Create one to connect the agent.</p>}
        <Button size="sm" variant="secondary" className="mt-3" loading={create.isPending} onClick={() => create.mutate()}><IconPlus className="h-4 w-4" />Create key</Button>
      </div>
      <Dialog open={!!secret} onClose={() => setSecret(null)} title="Copy the agent key" description="It is shown once." footer={<Button onClick={() => setSecret(null)}><IconCheck className="h-4 w-4" />Done</Button>}>
        {secret && <ConnectSnippets secret={secret} agentId={agentId} />}
      </Dialog>
    </Card>
  );
}
