/**
 * R120: client portals in Contacts. The "Client portals" tab lists every portal; a portal page shares files, docs,
 * tasks and file requests with a client, keeps a messages thread and the list of people who can sign in.
 * Clients use the public space at /p/<key> (server pages, their own session). Hidden while the flag is off (404).
 */
import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconArchive, IconArrowLeft, IconBuilding, IconChat, IconCopy, IconDocs, IconDownload, IconExternalLink, IconFile, IconFileUp, IconPlus, IconSend, IconTasks, IconTeam, IconTrash, IconUpload } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { useDialogs } from "@/web/components/ui/confirm";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Textarea } from "@/web/components/ui/input";
import { Avatar, Badge, Card, CopyButton, EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { initials, shortDate, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { portalInviteThrottledNote, taskStateLabel, type PortalDetail, type PortalItem, type PortalSummary } from "@/shared/client-portal";
import { LoadError, LoadErrorInline } from "@/web/components/load-error-t1g";
import { AccessDialog, FileProjectSelect, ItemThreadDialog, MilestonesDialog, PickTd9, type Td9PickKind } from "./portal-td9"; // TD9
import { IconClipboardList, IconLock, IconProject, IconReceipt } from "@/web/components/ui/icon"; // TD9

const MB = 1024 * 1024;
const sizeText = (n: number) => (n < MB ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`);
const portalsKey = (q?: string) => ["portals", q ?? ""] as const;

/** Undefined while loading, null when the feature is off on this deployment (the API answers 404). */
export function usePortalsOn() {
  const q = useQuery({ queryKey: portalsKey(), queryFn: () => api.get<{ portals: PortalSummary[] }>("/portals"), retry: false, staleTime: 30_000 });
  if (q.error instanceof ApiError && q.error.status === 404) return { on: false as const, q };
  return { on: !q.isError as boolean, q };
}

/** Contacts > Client portals. */
export function PortalsTab({ query }: { query: string }) {
  const { q } = usePortalsOn();
  const [adding, setAdding] = useState(false);
  const needle = query.trim().toLowerCase();
  const list = (q.data?.portals ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.contact?.name ?? "").toLowerCase().includes(needle) || (p.company?.name ?? "").toLowerCase().includes(needle));
  if (q.isPending) return <Skeleton className="h-48" />;
  if (q.isError) return <LoadError onRetry={() => q.refetch()} />;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted">A private space for each client: files, docs, task updates, file requests and messages. Clients sign in with an email link, no account needed.</p>
        <Button onClick={() => setAdding(true)} data-testid="portal-new"><IconPlus className="h-4 w-4" />New portal</Button>
      </div>
      {!list.length ? (
        <EmptyState icon={<IconTeam />} title={needle ? "No portals match" : "No client portals yet"} body={needle ? "Try another name." : "Make one for a person or a company to share files and updates with them in one place."}
          action={needle ? undefined : <Button onClick={() => setAdding(true)}>Make your first portal</Button>} />
      ) : (
        <Card className="divide-y divide-line overflow-hidden" data-testid="portal-list">
          {list.map((p) => (
            <Link key={p.id} to={`/app/contacts/portals/${p.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-hover focus-visible:bg-hover">
              <Avatar label={initials(p.name)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><span className="truncate text-[14px] font-medium" title={p.name}>{p.name}</span>{p.unread && <Badge tone="brand" dot>New message</Badge>}{p.archived && <Badge>Archived</Badge>}</div>
                <div className="truncate text-[12.5px] text-muted">{p.company ? <><IconBuilding className="mr-1 inline h-3.5 w-3.5" />{p.company.name}</> : p.contact?.name ?? ""}</div>
              </div>
              <div className="hidden text-right text-[12px] text-subtle sm:block">
                <div>{p.people} {p.people === 1 ? "person" : "people"}</div>
                <div>Active {timeAgo(p.lastActivityAt)}</div>
              </div>
            </Link>
          ))}
        </Card>
      )}
      {adding && <NewPortal onClose={() => setAdding(false)} />}
    </div>
  );
}

function NewPortal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [kind, setKind] = useState<"person" | "company">("person");
  const [search, setSearch] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const people = useQuery({ queryKey: ["contacts", search], queryFn: () => api.get<{ contacts: { id: string; name: string | null; email: string }[] }>(`/contacts${search ? `?q=${encodeURIComponent(search)}` : ""}`), enabled: kind === "person" });
  const companies = useQuery({ queryKey: ["companies", search], queryFn: async () => (await api.get<{ companies: { id: string; name: string; domain: string | null }[] }>(`/companies${search ? `?q=${encodeURIComponent(search)}` : ""}`)).companies, enabled: kind === "company" });
  const options = kind === "person" ? (people.data?.contacts ?? []).slice(0, 8).map((c) => ({ id: c.id, label: c.name || c.email, sub: c.email })) : (companies.data ?? []).slice(0, 8).map((c) => ({ id: c.id, label: c.name, sub: c.domain ?? "" }));
  const create = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      const r = await api.post<{ portal: PortalSummary }>("/portals", kind === "person" ? { contactId: pick } : { companyId: pick });
      await qc.invalidateQueries({ queryKey: ["portals"] });
      navigate(`/app/contacts/portals/${r.portal.id}`);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="New client portal" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!pick} onClick={create} data-testid="portal-create">Make portal</Button></>}>
      <div className="space-y-3">
        <div role="radiogroup" aria-label="Portal for" className="flex rounded-lg bg-fill p-0.5">
          {(["person", "company"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setPick(null); }} className={cn("flex-1 rounded-md px-3 py-1.5 text-[13px]", kind === k ? "bg-elevated font-medium shadow-sm" : "text-muted hover:text-fg")}>{k === "person" ? "A person" : "A company"}</button>
          ))}
        </div>
        <Field label={kind === "person" ? "Find a contact" : "Find a company"}>{(f) => <Input {...f} autoFocus value={search} onChange={(e) => { setSearch(e.target.value); setPick(null); }} placeholder={kind === "person" ? "Name or email" : "Company name"} />}</Field>
        <div role="listbox" aria-label="Matches" className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {options.length ? options.map((o) => (
            <button key={o.id} type="button" role="option" aria-selected={pick === o.id} onClick={() => setPick(o.id)} className={cn("flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-hover", pick === o.id && "bg-accent/10")} data-testid="portal-pick">
              <Avatar label={initials(o.label)} /><span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-medium">{o.label}</span><span className="block truncate text-[12px] text-muted">{o.sub}</span></span>
            </button>
          )) : <p className="px-3 py-6 text-center text-[13px] text-muted">{(kind === "person" ? people.isPending : companies.isPending) ? "Loading" : "Nobody matches. Add the contact first."}</p>}
        </div>
        <p className="text-[12.5px] text-muted">{kind === "person" ? "That person can sign in." : "Everyone at that company in your contacts can sign in."} You can add or remove people later.</p>
      </div>
    </Dialog>
  );
}

/** The contact page's "Client portal" button: opens the person's portal, or makes one. */
export function ContactPortalButton({ contactId }: { contactId: string }) {
  const { on } = usePortalsOn();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!on) return null;
  const open = async () => {
    setBusy(true);
    try { const r = await api.post<{ portal: PortalSummary }>("/portals", { contactId }); navigate(`/app/contacts/portals/${r.portal.id}`); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return <Button variant="secondary" loading={busy} onClick={open} data-testid="contact-portal"><IconTeam className="h-4 w-4" />Client portal</Button>;
}

const TABS = [["shared", "Shared"], ["messages", "Messages"], ["people", "People"], ["settings", "Settings"]] as const;
type Tab = (typeof TABS)[number][0];

export function PortalPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t[0] === params.get("tab")) ? params.get("tab") : "shared") as Tab;
  const q = useQuery({ queryKey: ["portal", id], queryFn: () => api.get<PortalDetail>(`/portals/${id}`), retry: false });
  const qc = useQueryClient();
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["portal", id] }), qc.invalidateQueries({ queryKey: ["portals"] })]);
  if (q.isPending) return <div className="space-y-3"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-9 w-80" /><Skeleton className="h-64" /></div>;
  if (q.error) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    if (!missing) return <LoadError onRetry={() => q.refetch()} />; // F12 (MB-299)
    return <EmptyState icon={<IconTeam />} title="Portal not found" body="It may have been removed." action={<Link className="text-accent underline" to="/app/contacts?tab=portals">All portals</Link>} />;
  }
  const d = q.data;
  const p = d.portal;
  return (
    <div>
      <Link to="/app/contacts?tab=portals" className="mb-4 inline-flex items-center gap-1 text-[12.5px] text-subtle hover:text-fg"><IconArrowLeft className="h-3.5 w-3.5" />Client portals</Link>
      <div className="mb-4 flex flex-wrap items-start gap-4">
        <Avatar label={initials(p.name)} className="h-12 w-12 text-sm" />
        <div className="min-w-0 flex-1 basis-48">
          <h1 className="large-title break-words" data-testid="portal-name">{p.name}</h1>
          <p className="text-[13.5px] text-muted">
            {p.company ? <>For <Link className="hover:underline" to={`/app/contacts?tab=companies`}>{p.company.name}</Link></> : p.contact ? <>For <Link className="hover:underline" to={`/app/contacts/${p.contact.id}`}>{p.contact.name}</Link></> : null}
            {" · "}{d.people.length} {d.people.length === 1 ? "person can sign in" : "people can sign in"}{p.archived && " · Archived"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton value={p.url} label="Copy portal link" toastText="Portal link copied" />
          <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg border border-line px-3.5 text-sm hover:bg-elevated"><IconExternalLink className="h-4 w-4" />Open portal</a>
        </div>
      </div>
      {p.archived && <Card className="mb-4 p-3 text-[13px] text-muted">This portal is archived. Clients can't open it. Restore it in Settings.</Card>}
      <div role="tablist" aria-label="Portal" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setParams(k === "shared" ? {} : { tab: k })} className={cn("-mb-px min-h-11 whitespace-nowrap border-b-2 px-3 text-[13.5px] transition-colors duration-150", tab === k ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>
            {label}{k === "messages" && d.messages.length > 0 && <span className="ml-1.5 text-[12px] text-subtle">{d.messages.length}</span>}
          </button>
        ))}
      </div>
      {tab === "shared" && <SharedTab d={d} refresh={refresh} />}
      {tab === "messages" && <MessagesTab d={d} refresh={refresh} />}
      {tab === "people" && <PeopleTab d={d} refresh={refresh} />}
      {tab === "settings" && <SettingsTab d={d} refresh={refresh} />}
    </div>
  );
}

type TabProps = { d: PortalDetail; refresh: () => Promise<unknown> };

function SharedTab({ d, refresh }: TabProps) {
  const { confirm, dialogs } = useDialogs();
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | "doc" | "task" | "request" | Td9PickKind>(null);
  const [td9Open, setTd9Open] = useState<null | { mode: "thread" | "milestones"; item: PortalItem }>(null); // TD9
  const [folder, setFolder] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const can = d.canManage && !d.portal.archived;
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("upload");
    try {
      for (const f of Array.from(files)) {
        if (f.size > 25 * MB) throw new Error(`${f.name} is over 25 MB. Share big files with a file request instead.`);
        const res = await fetch(`/api/portals/${d.portal.id}/files`, { method: "POST", credentials: "include", body: await f.arrayBuffer(), headers: { "content-type": f.type || "application/octet-stream", "x-multies-upload": "1", "x-file-name": encodeURIComponent(f.name), "x-folder": encodeURIComponent(folder.trim()) } });
        if (!res.ok) { const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null; throw new Error(j?.error?.message ?? "That file did not upload. Try again."); }
      }
      await refresh();
    } catch (e) { showError(e as Error); } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; }
  };
  const remove = async (it: PortalItem) => {
    if (!(await confirm({ title: `Stop sharing ${it.title}?`, description: it.kind === "file" ? "The client can't download it any more and the copy here is deleted." : it.kind === "request" ? "The request closes and its link stops taking files. Files already sent stay in Tools." : "The client can't see it any more. Nothing else changes.", confirmLabel: "Stop sharing", tone: "danger" }))) return;
    try { await api.del(`/portals/${d.portal.id}/items/${it.id}`); await refresh(); } catch (e) { showError(e as Error); }
  };
  const groups: { kind: PortalItem["kind"]; title: string; icon: React.ReactNode; empty: string }[] = [
    { kind: "file", title: "Files", icon: <IconFile className="h-4 w-4" />, empty: "Share contracts, designs or reports. Files are kept for a year." },
    { kind: "request", title: "File requests", icon: <IconFileUp className="h-4 w-4" />, empty: "Ask the client for files. They upload from their portal, no account needed." },
    { kind: "doc", title: "Docs", icon: <IconDocs className="h-4 w-4" />, empty: "Share a doc to read. They always see its latest version." },
    { kind: "task", title: "Task updates", icon: <IconTasks className="h-4 w-4" />, empty: "Share tasks so the client sees their status and due date." },
    ...(d.td9 ? [ // TD9
      { kind: "project" as const, title: "Projects", icon: <IconProject className="h-4 w-4" />, empty: "Share a project so the client sees its progress and milestones live." },
      { kind: "invoice" as const, title: "Invoices", icon: <IconReceipt className="h-4 w-4" />, empty: "Share issued invoices and quotes." },
      { kind: "form" as const, title: "Forms", icon: <IconClipboardList className="h-4 w-4" />, empty: "Share a form for the client to fill in." },
    ] : []),
  ];
  const sharedProjects = d.items.filter((i) => i.kind === "project" && i.live); // TD9
  return (
    <div className="space-y-4">
      {dialogs}
      {can && (
        <div className="flex flex-wrap items-end gap-2">
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} data-testid="portal-file-input" />
          <div className="w-44"><Field label="Folder (optional)">{(f) => <Input {...f} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Contracts" maxLength={60} />}</Field></div>
          <Button loading={busy === "upload"} onClick={() => fileRef.current?.click()}><IconUpload className="h-4 w-4" />Share files</Button>
          {d.requestsOn && <Button variant="secondary" onClick={() => setAdding("request")}><IconFileUp className="h-4 w-4" />Ask for files</Button>}
          <Button variant="secondary" onClick={() => setAdding("doc")}><IconDocs className="h-4 w-4" />Share a doc</Button>
          <Button variant="secondary" onClick={() => setAdding("task")}><IconTasks className="h-4 w-4" />Share a task</Button>
          {d.td9 && <>
            <Button variant="secondary" onClick={() => setAdding("project")} data-testid="portal-share-project"><IconProject className="h-4 w-4" />Share a project</Button>
            <Button variant="secondary" onClick={() => setAdding("invoice")}><IconReceipt className="h-4 w-4" />Share an invoice</Button>
            <Button variant="secondary" onClick={() => setAdding("form")}><IconClipboardList className="h-4 w-4" />Share a form</Button>
          </>}
        </div>
      )}
      {groups.filter((g) => g.kind !== "request" || d.requestsOn || d.items.some((i) => i.kind === "request")).map((g) => {
        const items = d.items.filter((i) => i.kind === g.kind);
        return (
          <Card key={g.kind} className="overflow-hidden" data-testid={`portal-group-${g.kind}`}>
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13px] font-medium">{g.icon}{g.title}<span className="text-subtle">{items.length || ""}</span></div>
            {!items.length ? <p className="px-4 py-5 text-[13px] text-muted">{g.empty}</p> : (
              <ul className="divide-y divide-line">
                {items.map((it) => (
                  <li key={it.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className={cn("truncate text-[13.5px]", !it.live && "text-muted line-through")} title={it.title}>{it.title}</div>
                      <div className="truncate text-[12px] text-muted">
                        {it.kind === "file" && <>{it.folder ? `${it.folder} · ` : ""}{it.bytes ? sizeText(it.bytes) : ""}</>}
                        {it.kind === "task" && <>{taskStateLabel(it.state)}{it.due ? ` · Due ${shortDate(it.due)}` : ""}</>}
                        {it.kind === "request" && <>{it.open ? "Open" : "Closed"} · {it.received ?? 0} {it.received === 1 ? "file" : "files"} received</>}
                        {it.kind === "project" && <>{it.progress?.total ? `${Math.round((it.progress.done / it.progress.total) * 100)}% done · ${it.progress.done} of ${it.progress.total} tasks` : "No tasks yet"}</>}
                        {it.kind === "invoice" && <>{it.amount ?? ""}{it.status ? ` · ${it.status}` : ""}</>}
                        {!it.live && " · No longer available"}
                        {" · Shared "}{timeAgo(it.addedAt)}
                      </div>
                    </div>
                    {it.kind === "file" && it.live && <a href={`/api/portals/${d.portal.id}/files/${it.id}`} className="inline-flex h-9 w-9 items-center justify-center rounded-lg hover:bg-hover" aria-label={`Download ${it.title}`}><IconDownload className="h-4 w-4" /></a>}
                    {it.kind === "request" && <Link className="text-[12.5px] text-accent hover:underline" to={`/app/tools/share?tab=requests&request=${it.refId}`}>See files</Link>}
                    {it.kind === "doc" && <Link className="text-[12.5px] text-accent hover:underline" to={`/app/docs/${it.refId}`}>Open</Link>}
                    {it.kind === "task" && <Link className="text-[12.5px] text-accent hover:underline" to={`/app/tasks?task=${it.refId}`}>Open</Link>}
                    {d.td9 && it.kind === "file" && can && sharedProjects.length > 0 && <FileProjectSelect portalId={d.portal.id} item={it} projects={sharedProjects} refresh={refresh} />}
                    {d.td9 && it.kind === "project" && it.live && <Button size="sm" variant="secondary" onClick={() => setTd9Open({ mode: "milestones", item: it })} data-testid="portal-milestones-open">Milestones</Button>}
                    {d.td9 && (it.kind === "project" || it.kind === "task") && it.live && <Button size="sm" variant="secondary" onClick={() => setTd9Open({ mode: "thread", item: it })} data-testid="portal-thread-open">Comments</Button>}
                    {can && <button type="button" onClick={() => void remove(it)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg" aria-label={`Stop sharing ${it.title}`}><IconTrash className="h-4 w-4" /></button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
      {adding === "request" && <AskForFiles portalId={d.portal.id} onClose={() => setAdding(null)} refresh={refresh} />}
      {(adding === "doc" || adding === "task") && <PickShared kind={adding} portalId={d.portal.id} onClose={() => setAdding(null)} refresh={refresh} />}
      {(adding === "project" || adding === "invoice" || adding === "form") && <PickTd9 kind={adding} portalId={d.portal.id} onClose={() => setAdding(null)} refresh={refresh} />}
      {td9Open?.mode === "milestones" && <MilestonesDialog portalId={d.portal.id} item={td9Open.item} onClose={() => setTd9Open(null)} />}
      {td9Open?.mode === "thread" && <ItemThreadDialog portalId={d.portal.id} item={td9Open.item} people={d.people} onClose={() => setTd9Open(null)} />}
    </div>
  );
}

function AskForFiles({ portalId, onClose, refresh }: { portalId: string; onClose: () => void; refresh: () => Promise<unknown> }) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.post(`/portals/${portalId}/requests`, { title, message: message || null }); await refresh(); onClose(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Ask for files" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!title.trim()} onClick={save} data-testid="portal-request-save">Ask for files</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void save(); }}>
        <Field label="What do you need?">{(f) => <Input {...f} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Signed contract" maxLength={120} />}</Field>
        <Field label="A note (optional)">{(f) => <Textarea {...f} value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={1000} />}</Field>
        <p className="text-[12.5px] text-muted">Files up to 100 MB each, 500 MB in all, open for 90 days. You get a notice when files arrive.</p>
      </form>
    </Dialog>
  );
}

function PickShared({ kind, portalId, onClose, refresh }: { kind: "doc" | "task"; portalId: string; onClose: () => void; refresh: () => Promise<unknown> }) {
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["portal-pick", kind, search],
    queryFn: async () => {
      if (kind === "doc") { const r = await api.get<{ docs?: { id: string; title: string }[] } | { id: string; title: string }[]>(`/docs`); const list = Array.isArray(r) ? r : r.docs ?? []; return list.map((x) => ({ id: x.id, title: x.title || "Untitled" })); }
      const r = await api.get<{ tasks?: { id: string; title: string }[] } | { id: string; title: string }[]>(`/tasks?limit=100${search ? `&q=${encodeURIComponent(search)}` : ""}`);
      return (Array.isArray(r) ? r : r.tasks ?? []).map((x) => ({ id: x.id, title: x.title }));
    },
  });
  const list = (q.data ?? []).filter((x) => !search || x.title.toLowerCase().includes(search.toLowerCase())).slice(0, 30);
  const add = async (refId: string) => {
    setBusy(refId);
    try { await api.post(`/portals/${portalId}/items`, { kind, refId }); await refresh(); onClose(); } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  return (
    <Dialog open onClose={onClose} title={kind === "doc" ? "Share a doc" : "Share a task"} footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="space-y-3">
        <Field label={kind === "doc" ? "Find a doc" : "Find a task"}>{(f) => <Input {...f} autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by title" />}</Field>
        <div className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {q.isPending ? <Skeleton className="m-3 h-20" /> : q.isError ? <LoadErrorInline className="px-3 py-6" onRetry={() => q.refetch()} /> : list.length ? list.map((x) => (
            <button key={x.id} type="button" disabled={!!busy} onClick={() => void add(x.id)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13.5px] hover:bg-hover disabled:opacity-60" data-testid="portal-pick-item">
              {kind === "doc" ? <IconDocs className="h-4 w-4 text-muted" /> : <IconTasks className="h-4 w-4 text-muted" />}<span className="min-w-0 flex-1 truncate">{x.title}</span>{busy === x.id && <span className="text-[12px] text-muted">Sharing</span>}
            </button>
          )) : <p className="px-3 py-6 text-center text-[13px] text-muted">Nothing matches.</p>}
        </div>
      </div>
    </Dialog>
  );
}

function MessagesTab({ d, refresh }: TabProps) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try { await api.post(`/portals/${d.portal.id}/messages`, { body }); setBody(""); await refresh(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Card className="flex flex-col p-0">
      {!d.messages.length ? <EmptyState icon={<IconChat />} title="No messages yet" body="Messages here are shared with everyone who can sign in to this portal. They get an email when you write." className="border-0" /> : (
        <ol className="flex max-h-[60vh] flex-col gap-2.5 overflow-y-auto p-4" data-testid="portal-messages">
          {d.messages.map((m) => (
            <li key={m.id} className={cn("max-w-[85%] rounded-2xl border px-3.5 py-2", m.fromClient ? "self-start border-line bg-elevated" : "self-end border-accent/30 bg-accent/10")}>
              <div className="text-[11.5px] text-muted">{m.author} · {timeAgo(m.at)}</div>
              <div className="whitespace-pre-wrap break-words text-[13.5px]">{m.body}</div>
            </li>
          ))}
        </ol>
      )}
      {!d.portal.archived && (
        <form className="sticky bottom-0 flex items-end gap-2 border-t border-line bg-surface p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Textarea aria-label="Write to the client" value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={4000} placeholder="Write to the client" className="flex-1"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} data-testid="portal-reply" />
          <Button type="submit" loading={busy} disabled={!body.trim()} aria-label="Send message"><IconSend className="h-4 w-4" />Send</Button>
        </form>
      )}
    </Card>
  );
}

function PeopleTab({ d, refresh }: TabProps) {
  const { confirm, dialogs } = useDialogs();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ id: string; url: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [access, setAccess] = useState<PortalDetail["people"][number] | null>(null); // TD9
  const can = d.canManage && !d.portal.archived;
  const add = async () => {
    setBusy("add");
    try { await api.post(`/portals/${d.portal.id}/people`, { email }); setEmail(""); await refresh(); } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  const invite = async (pid: string, addr: string) => {
    setBusy(`i${pid}`);
    try { const r = await api.post<{ sent: boolean; throttled?: boolean }>(`/portals/${d.portal.id}/people/${pid}/invite`); setNote(r.throttled ? portalInviteThrottledNote(addr) : r.sent ? `Sign in link sent to ${addr}.` : `The email to ${addr} did not go out. Copy a link instead.`); } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  const link = async (pid: string) => {
    setBusy(`l${pid}`);
    try { const r = await api.post<{ url: string }>(`/portals/${d.portal.id}/people/${pid}/link`); setCopied({ id: pid, url: r.url }); } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  const remove = async (pid: string, addr: string) => {
    if (!(await confirm({ title: `Remove ${addr}?`, description: "They are signed out at once and can't open this portal again unless you add them back.", confirmLabel: "Remove", tone: "danger" }))) return;
    try { await api.del(`/portals/${d.portal.id}/people/${pid}`); await refresh(); } catch (e) { showError(e as Error); }
  };
  return (
    <div className="space-y-4">
      {dialogs}
      {access && <AccessDialog portalId={d.portal.id} person={access} onClose={() => setAccess(null)} />}
      {note && <p role="status" className="text-[13px] text-muted">{note}</p>}
      <Card className="divide-y divide-line overflow-hidden" data-testid="portal-people">
        {!d.people.length && <p className="px-4 py-5 text-[13px] text-muted">Nobody can sign in yet. Add the client's email below.</p>}
        {d.people.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Avatar label={initials(p.name || p.email)} />
            <div className="min-w-0 flex-1"><div className="truncate text-[13.5px] font-medium">{p.name || p.email}</div><div className="truncate text-[12px] text-muted">{p.email} · {p.lastSeenAt ? `Last here ${timeAgo(p.lastSeenAt)}` : "Not signed in yet"}</div></div>
            {d.td9 && <Button size="sm" variant="secondary" onClick={() => setAccess(p)} data-testid="portal-access-open"><IconLock className="h-4 w-4" />Access</Button>}
            {can && <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" loading={busy === `i${p.id}`} onClick={() => void invite(p.id, p.email)} data-testid="portal-invite">Email sign in link</Button>
              <Button size="sm" variant="secondary" loading={busy === `l${p.id}`} onClick={() => void link(p.id)} data-testid="portal-copy-link"><IconCopy className="h-4 w-4" />Get link</Button>
              <button type="button" onClick={() => void remove(p.id, p.email)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg" aria-label={`Remove ${p.email}`}><IconTrash className="h-4 w-4" /></button>
            </div>}
            {copied?.id === p.id && (
              <div className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-fill px-3 py-2 text-[12.5px]">
                <span className="min-w-0 flex-1 truncate" data-testid="portal-link-value">{copied.url}</span><CopyButton value={copied.url} label="Copy" toastText="Link copied" />
                <span className="w-full text-muted">Works once, for 15 minutes. Send it any way you like.</span>
              </div>
            )}
          </div>
        ))}
      </Card>
      {can && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <div className="min-w-60 flex-1"><Field label="Add someone by email">{(f) => <Input {...f} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sam@client.com" data-testid="portal-add-email" />}</Field></div>
          <Button type="submit" loading={busy === "add"} disabled={!email.includes("@")}><IconPlus className="h-4 w-4" />Add</Button>
        </form>
      )}
      {!d.canManage && <p className="text-[12.5px] text-muted">Only the person who made this portal or an admin can change who signs in.</p>}
    </div>
  );
}

function SettingsTab({ d, refresh }: TabProps) {
  const { confirm, dialogs } = useDialogs();
  const p = d.portal;
  const [name, setName] = useState(p.name);
  const [welcome, setWelcome] = useState(p.welcome ?? "");
  const [busy, setBusy] = useState(false);
  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try { await api.patch(`/portals/${p.id}`, patch); await refresh(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const archive = async () => {
    if (!p.archived && !(await confirm({ title: "Archive this portal?", description: "Clients are signed out and the portal link stops working. Shared files stay until you remove them. You can restore it later.", confirmLabel: "Archive", tone: "danger" }))) return;
    await save({ archived: !p.archived });
  };
  if (!d.canManage) return <Card className="p-4 text-[13px] text-muted">Only the person who made this portal or an admin can change its settings.</Card>;
  return (
    <div className="max-w-xl space-y-4">
      {dialogs}
      <Card className="space-y-3 p-4">
        <Field label="Name">{(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field>
        <Field label="Welcome note on the client's overview (optional)">{(f) => <Textarea {...f} value={welcome} onChange={(e) => setWelcome(e.target.value)} rows={3} maxLength={1000} placeholder="Hi Sam, everything for your project lives here." />}</Field>
        <div className="flex items-center justify-between gap-3">
          <div><div className="text-[13.5px] font-medium">Show our logo and colour</div><div className="text-[12.5px] text-muted">From Settings, Branding.</div></div>
          <Switch checked={p.showBrand} onChange={(v: boolean) => void save({ showBrand: v })} label="Show our logo and colour" />
        </div>
        <div className="flex justify-end"><Button loading={busy} disabled={!name.trim() || (name === p.name && welcome === (p.welcome ?? ""))} onClick={() => void save({ name, welcome: welcome || null })}>Save</Button></div>
      </Card>
      <Card className="flex items-center justify-between gap-3 p-4">
        <div><div className="text-[13.5px] font-medium">{p.archived ? "Restore portal" : "Archive portal"}</div><div className="text-[12.5px] text-muted">{p.archived ? "Clients can sign in again." : "Signs every client out and closes the link."}</div></div>
        <Button variant="secondary" onClick={() => void archive()} data-testid="portal-archive"><IconArchive className="h-4 w-4" />{p.archived ? "Restore" : "Archive"}</Button>
      </Card>
    </div>
  );
}
