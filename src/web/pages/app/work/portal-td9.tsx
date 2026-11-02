/**
 * TD9 (PORTAL_TD9): the team side of portal access per area, sharing projects, invoices and forms, milestones,
 * item threads and private comments to one person. Mounted by portals.tsx and the task panel only when the
 * workspace config says portalTd9; nothing here renders while the flag is off.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCheckCircle, IconClipboardList, IconLock, IconProject, IconReceipt, IconSend, IconTrash } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Skeleton } from "@/web/components/ui/misc";
import { shortDate, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { LoadErrorInline } from "@/web/components/load-error-t1g";
import type { PortalItem, PortalPerson } from "@/shared/client-portal";
import {
  AREA_LABEL, LEVEL_LABEL, PORTAL_AREAS, PORTAL_LEVELS, type PortalArea, type PortalLevel, type Td9AccessHistory, type Td9Comment, type Td9Milestone, type Td9Recipient,
} from "@/shared/portal-td9";

const AREA_HELP: Record<PortalArea, string> = {
  projects: "Project pages with progress and milestones", tasks: "Shared tasks and their status", files: "Shared files and file requests",
  docs: "Shared docs", invoices: "Issued invoices and quotes", forms: "Forms to fill in",
};

/** Per area None, View or Comment for one person, saved as you pick, with the change history. */
export function AccessDialog({ portalId, person, onClose }: { portalId: string; person: PortalPerson; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ["portal-access", portalId, person.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ levels: Record<PortalArea, PortalLevel>; history: Td9AccessHistory[]; canManage: boolean }>(`/portals/${portalId}/people/${person.id}/access`), retry: false });
  const [busy, setBusy] = useState<string | null>(null);
  const set = async (area: PortalArea, level: PortalLevel) => {
    setBusy(area);
    try { const r = await api.put<{ levels: Record<PortalArea, PortalLevel>; history: Td9AccessHistory[]; canManage: boolean }>(`/portals/${portalId}/people/${person.id}/access`, { area, level }); qc.setQueryData(key, r); }
    catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  const who = person.name || person.email;
  return (
    <Dialog open onClose={onClose} title={`What ${who} can see`} description="None hides an area. View shows it read only. Comment also lets them reply on tasks and projects." footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      {q.isPending ? <Skeleton className="h-64" /> : q.isError ? <LoadErrorInline className="py-6" onRetry={() => q.refetch()} /> : (
        <div className="space-y-4" data-testid="portal-access">
          <ul className="divide-y divide-line rounded-lg border border-line">
            {PORTAL_AREAS.map((a) => (
              <li key={a} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">{AREA_LABEL[a]}</div><div className="text-[12px] text-muted">{AREA_HELP[a]}</div></div>
                <div role="radiogroup" aria-label={`${AREA_LABEL[a]} access`} className="flex rounded-lg border border-line p-0.5">
                  {PORTAL_LEVELS.map((l) => (
                    <button key={l} type="button" role="radio" aria-checked={q.data.levels[a] === l} disabled={!q.data.canManage || busy === a}
                      onClick={() => q.data.levels[a] !== l && void set(a, l)} data-testid={`access-${a}-${l}`}
                      className={cn("min-h-9 rounded-md px-3 text-[13px] transition-colors duration-150 disabled:cursor-not-allowed", q.data.levels[a] === l ? "bg-accent text-white" : "text-muted hover:text-fg")}>
                      {LEVEL_LABEL[l]}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {!q.data.canManage && <p className="text-[12.5px] text-muted">Only an admin or the person who made this portal can change access.</p>}
          <div>
            <h3 className="mb-1.5 text-[12.5px] font-medium text-muted">Changes</h3>
            {q.data.history.length ? (
              <ul className="space-y-1 text-[12.5px] text-muted" data-testid="portal-access-history">
                {q.data.history.map((h, i) => <li key={i}>{h.by} set {AREA_LABEL[h.area]} from {LEVEL_LABEL[h.from]} to {LEVEL_LABEL[h.to]} · {timeAgo(h.at)}</li>)}
              </ul>
            ) : <p className="text-[12.5px] text-muted">No changes yet. New areas start at None.</p>}
          </div>
        </div>
      )}
    </Dialog>
  );
}

export type Td9PickKind = "project" | "invoice" | "form";
const PICK_LABEL: Record<Td9PickKind, string> = { project: "project", invoice: "invoice", form: "form" };

export function PickTd9({ kind, portalId, onClose, refresh }: { kind: Td9PickKind; portalId: string; onClose: () => void; refresh: () => Promise<unknown> }) {
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["portal-pick-td9", portalId, kind, search], queryFn: () => api.get<{ items: { id: string; title: string; sub: string }[] }>(`/portals/${portalId}/pick?kind=${kind}&q=${encodeURIComponent(search.trim())}`), retry: false });
  const add = async (refId: string) => {
    setBusy(refId);
    try { await api.post(`/portals/${portalId}/items`, { kind, refId }); await refresh(); onClose(); } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  const Icon = kind === "project" ? IconProject : kind === "invoice" ? IconReceipt : IconClipboardList;
  return (
    <Dialog open onClose={onClose} title={`Share a ${PICK_LABEL[kind]}`} description={kind === "invoice" ? "Only issued invoices and quotes can be shared." : kind === "project" ? "Clients see progress, milestones, and the tasks and files you share from it." : "Clients get a link to fill it in."} footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="space-y-3">
        <Field label={`Find a ${PICK_LABEL[kind]}`}>{(f) => <Input {...f} autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" />}</Field>
        <div className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {q.isPending ? <Skeleton className="m-3 h-20" /> : q.isError ? <LoadErrorInline className="px-3 py-6" onRetry={() => q.refetch()} /> : q.data.items.length ? q.data.items.map((x) => (
            <button key={x.id} type="button" disabled={!!busy} onClick={() => void add(x.id)} className="flex min-h-11 w-full items-center gap-2 px-3 py-2.5 text-left text-[13.5px] hover:bg-hover disabled:opacity-60" data-testid="portal-pick-td9-item">
              <Icon className="h-4 w-4 text-muted" /><span className="min-w-0 flex-1 truncate">{x.title}</span><span className="truncate text-[12px] text-muted">{busy === x.id ? "Sharing" : x.sub}</span>
            </button>
          )) : <p className="px-3 py-6 text-center text-[13px] text-muted">Nothing matches.</p>}
        </div>
      </div>
    </Dialog>
  );
}

export function MilestonesDialog({ portalId, item, onClose }: { portalId: string; item: PortalItem; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ["portal-milestones", portalId, item.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ milestones: Td9Milestone[]; canManage: boolean }>(`/portals/${portalId}/items/${item.id}/milestones`), retry: false });
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, f: () => Promise<{ milestones: Td9Milestone[]; canManage: boolean }>) => {
    setBusy(id);
    try { qc.setQueryData(key, await f()); } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  const add = () => run("add", async () => { const r = await api.post<{ milestones: Td9Milestone[]; canManage: boolean }>(`/portals/${portalId}/items/${item.id}/milestones`, { title, due: due || null }); setTitle(""); setDue(""); return r; });
  return (
    <Dialog open onClose={onClose} title={`Milestones for ${item.title}`} description="Clients see these on the project page." footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      {q.isPending ? <Skeleton className="h-40" /> : q.isError ? <LoadErrorInline className="py-6" onRetry={() => q.refetch()} /> : (
        <div className="space-y-3" data-testid="portal-milestones">
          {q.data.milestones.length ? (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {q.data.milestones.map((m) => (
                <li key={m.id} className="flex items-center gap-2 px-3 py-2">
                  <button type="button" role="checkbox" aria-checked={m.done} aria-label={`${m.title} done`} disabled={!q.data.canManage || busy === m.id}
                    onClick={() => void run(m.id, () => api.patch(`/portals/${portalId}/items/${item.id}/milestones/${m.id}`, { done: !m.done }))}
                    className={cn("inline-flex h-9 w-9 items-center justify-center rounded-lg hover:bg-hover", m.done ? "text-accent" : "text-muted")}><IconCheckCircle className="h-4 w-4" /></button>
                  <div className="min-w-0 flex-1"><div className={cn("truncate text-[13.5px]", m.done && "text-muted line-through")}>{m.title}</div><div className="text-[12px] text-muted">{m.due ? `Due ${shortDate(m.due)}` : "No due date"}</div></div>
                  {q.data.canManage && <button type="button" aria-label={`Delete ${m.title}`} onClick={() => void run(m.id, () => api.del(`/portals/${portalId}/items/${item.id}/milestones/${m.id}`))} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"><IconTrash className="h-4 w-4" /></button>}
                </li>
              ))}
            </ul>
          ) : <p className="text-[13px] text-muted">No milestones yet. Add the big steps the client cares about.</p>}
          {q.data.canManage && (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void add(); }}>
              <div className="min-w-48 flex-1"><Field label="Milestone">{(f) => <Input {...f} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="First draft" />}</Field></div>
              <div className="w-40"><Field label="Due (optional)">{(f) => <Input {...f} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field></div>
              <Button type="submit" loading={busy === "add"} disabled={!title.trim()}>Add</Button>
            </form>
          )}
        </div>
      )}
    </Dialog>
  );
}

function CommentList({ comments, onDelete }: { comments: Td9Comment[]; onDelete: (c: Td9Comment) => void }) {
  if (!comments.length) return <p className="py-3 text-[13px] text-muted">No comments yet.</p>;
  return (
    <ol className="space-y-2" data-testid="td9-comments">
      {comments.map((c) => (
        <li key={c.id} className={cn("rounded-lg border px-3 py-2", c.privateLabel ? "border-accent/40 bg-accent/5" : "border-line")}>
          <div className="flex items-center gap-2 text-[12px] text-muted"><span className="font-medium text-fg">{c.author.name}</span>{c.author.client && <span>Client</span>}<span>· {timeAgo(c.at)}</span>
            {c.canDelete && <button type="button" onClick={() => onDelete(c)} className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-hover hover:text-fg" aria-label="Delete comment"><IconTrash className="h-3.5 w-3.5" /></button>}
          </div>
          <p className="whitespace-pre-wrap break-words text-[13.5px]">{c.body}</p>
          {c.privateLabel && <p className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium text-accent" data-testid="td9-private-label"><IconLock className="h-3.5 w-3.5" />{c.privateLabel}</p>}
        </li>
      ))}
    </ol>
  );
}

function Composer({ recipients, allowEveryone, onSend, busy }: { recipients: Td9Recipient[]; allowEveryone: boolean; onSend: (body: string, to: Td9Recipient | null) => Promise<boolean>; busy: boolean }) {
  const [body, setBody] = useState("");
  const [to, setTo] = useState(allowEveryone ? "" : recipients[0] ? `${recipients[0].kind}:${recipients[0].id}` : "");
  const target = recipients.find((r) => `${r.kind}:${r.id}` === to) ?? null;
  const send = async () => { if (await onSend(body, target)) setBody(""); };
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (body.trim() && (allowEveryone || target)) void send(); }}>
      <Field label="Who sees it">{(f) => (
        <Select {...f} value={to} onChange={(e) => setTo(e.target.value)} data-testid="td9-to">
          {allowEveryone && <option value="">Everyone on this thread</option>}
          {!allowEveryone && !recipients.length && <option value="">Nobody to pick yet</option>}
          {recipients.map((r) => <option key={`${r.kind}:${r.id}`} value={`${r.kind}:${r.id}`}>Only {r.name} ({r.sub})</option>)}
        </Select>
      )}</Field>
      <Field label="Comment">{(f) => <Textarea {...f} value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={4000} data-testid="td9-body" />}</Field>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-muted">{target ? `Only you and ${target.name} will see this. Admins can too.` : allowEveryone ? "Your team and the clients on this portal can read it." : ""}</span>
        <Button type="submit" loading={busy} disabled={!body.trim() || (!allowEveryone && !target)} data-testid="td9-send"><IconSend className="h-4 w-4" />Post</Button>
      </div>
    </form>
  );
}

/** The thread on a shared task or project in one portal: everyone on it, or one person only. */
export function ItemThreadDialog({ portalId, item, people, onClose }: { portalId: string; item: PortalItem; people: PortalPerson[]; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ["portal-thread", portalId, item.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ comments: Td9Comment[] }>(`/portals/${portalId}/items/${item.id}/comments`), retry: false });
  const rec = useQuery({ queryKey: ["td9-recipients", item.kind, item.refId], queryFn: () => api.get<{ recipients: Td9Recipient[] }>(`/item-comments/${item.kind}/${item.refId}/recipients`), retry: false });
  const ids = new Set(people.map((p) => p.id));
  const recipients = (rec.data?.recipients ?? []).filter((r) => r.kind === "member" || ids.has(r.id));
  const [busy, setBusy] = useState(false);
  const send = async (body: string, to: Td9Recipient | null) => {
    setBusy(true);
    try { qc.setQueryData(key, await api.post<{ comments: Td9Comment[] }>(`/portals/${portalId}/items/${item.id}/comments`, { body, toUserId: to?.kind === "member" ? to.id : null, toPersonId: to?.kind === "client" ? to.id : null })); return true; }
    catch (e) { showError(e as Error); return false; } finally { setBusy(false); }
  };
  const del = async (c: Td9Comment) => { try { await api.del(`/item-comments/${c.id}`); await q.refetch(); } catch (e) { showError(e as Error); } };
  return (
    <Dialog open onClose={onClose} title={`Comments on ${item.title}`} footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        <div className="max-h-80 overflow-y-auto">{q.isPending ? <Skeleton className="h-24" /> : q.isError ? <LoadErrorInline className="py-6" onRetry={() => q.refetch()} /> : <CommentList comments={q.data.comments} onDelete={(c) => void del(c)} />}</div>
        <Composer recipients={recipients} allowEveryone onSend={send} busy={busy} />
      </div>
    </Dialog>
  );
}

/** Task panel and project pages: private comments to one teammate or one client who can see this item. */
export function PrivateComments({ kind, refId }: { kind: "task" | "project"; refId: string }) {
  const qc = useQueryClient();
  const key = ["td9-private", kind, refId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ comments: Td9Comment[] }>(`/item-comments/${kind}/${refId}`), retry: false });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  // Who can be picked loads only when the composer opens, so opening a task costs one small read.
  const rec = useQuery({ queryKey: ["td9-recipients", kind, refId], queryFn: () => api.get<{ recipients: Td9Recipient[] }>(`/item-comments/${kind}/${refId}/recipients`), retry: false, enabled: open });
  const send = async (body: string, to: Td9Recipient | null) => {
    if (!to) return false;
    setBusy(true);
    try { qc.setQueryData(key, await api.post<{ comments: Td9Comment[] }>(`/item-comments/${kind}/${refId}`, { body, toUserId: to.kind === "member" ? to.id : null, toPersonId: to.kind === "client" ? to.id : null })); return true; }
    catch (e) { showError(e as Error); return false; } finally { setBusy(false); }
  };
  const del = async (c: Td9Comment) => { try { await api.del(`/item-comments/${c.id}`); await q.refetch(); } catch (e) { showError(e as Error); } };
  if (q.isError && (q.error as { status?: number })?.status === 404) return null;
  return (
    <section className="mt-4" aria-labelledby={`td9-private-${refId}`} data-testid="td9-private-comments">
      <div className="mb-2 flex items-center gap-2">
        <h3 id={`td9-private-${refId}`} className="inline-flex items-center gap-1.5 text-[13px] font-medium"><IconLock className="h-3.5 w-3.5" />Private comments</h3>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Close" : "Write to one person"}</Button>
      </div>
      {q.isPending ? <Skeleton className="h-12" /> : q.isError ? <LoadErrorInline className="py-3" onRetry={() => q.refetch()} /> : q.data.comments.length ? <CommentList comments={q.data.comments} onDelete={(c) => void del(c)} /> : <p className="text-[12.5px] text-muted">Only you, the person you pick and admins see these.</p>}
      {open && <div className="mt-3">{rec.isPending ? <Skeleton className="h-24" /> : <Composer recipients={rec.data?.recipients ?? []} allowEveryone={false} onSend={send} busy={busy} />}</div>}
    </section>
  );
}

/** A shared file can sit under one shared project, so it shows on that project's page. */
export function FileProjectSelect({ portalId, item, projects, refresh }: { portalId: string; item: PortalItem; projects: PortalItem[]; refresh: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const current = projects.find((p) => p.refId === item.projectId)?.id ?? "";
  const change = async (v: string) => {
    setBusy(true);
    try { await api.patch(`/portals/${portalId}/items/${item.id}`, { projectItemId: v || null }); await refresh(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Select aria-label={`Project for ${item.title}`} value={current} disabled={busy} onChange={(e) => void change(e.target.value)} className="h-9 w-40 text-[12.5px]" data-testid="portal-file-project">
      <option value="">No project</option>
      {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
    </Select>
  );
}
