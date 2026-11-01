/**
 * R109 (flag merge_plus_r109): Tools > Merge grows newsletters, lists with consent records, journeys and an
 * unsubscribe list. The PDF merge stays as the Documents tab (flag merge_mail). Spam Act rules are shown
 * where they apply: consent source on every add, sender details before a send, the daily limit always visible.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useConfig, useMailboxes } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmButton } from "@/web/components/ui/confirm";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Meter, Skeleton, Switch } from "@/web/components/ui/misc";
import { parseCsv } from "@/shared/tools-automation";
import { CAMPAIGN_STATUS_LABEL, MEMBER_STATUS_LABEL, isEmail, rate, type CampaignStatus, type MemberStatus } from "@/shared/campaigns-r109";
import { AutoPage } from "./shell";
import { DocumentsMerge } from "./merge";

export interface ListSummary {
  id: string; name: string; description: string; visibility: "workspace" | "private"; mine: boolean; doubleOptIn: boolean; allowInferred: boolean; signupOn: boolean;
  signupKey: string | null; mailboxId: string | null; senderName: string; senderAddress: string; tz: string; canEdit: boolean; canSend: boolean;
  subscribed: number; pending: number; unsubscribed: number; bounced: number; updatedAt: string;
}
export interface Info { cap: number; usedToday: number; stagingOnly: boolean; consentSources: string[]; isAdmin: boolean }
export const B = "/tools/campaigns";
export const useInfo = () => useQuery({ queryKey: ["r109-info"], queryFn: () => api.get<Info>(`${B}/info`) });
export const useLists = () => useQuery({ queryKey: ["r109-lists"], queryFn: () => api.get<{ lists: ListSummary[] }>(`${B}/lists`) });

export const TZS = ["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth", "Australia/Hobart", "Australia/Darwin", "Pacific/Auckland", "Asia/Kathmandu", "Asia/Singapore", "Asia/Kolkata", "Europe/London", "America/New_York", "America/Los_Angeles", "UTC"];

/** Today's limit, shared with mail merge; shown wherever a send starts. */
export function DailyLimit({ info }: { info?: Info }) {
  if (!info) return null;
  const left = Math.max(0, info.cap - info.usedToday);
  return (
    <div className="space-y-1" data-testid="r109-limit">
      <Meter value={info.usedToday} max={info.cap} label={`${info.usedToday} of ${info.cap} used today`} />
      <p className="text-[12.5px] text-muted">{left} of {info.cap} emails left today on your plan. Anything over waits for tomorrow and goes out on its own.</p>
      {info.stagingOnly && <p className="text-[12.5px] text-warn">Test site: emails only go to the QA mailbox.</p>}
    </div>
  );
}

/** Tools > Merge: the R109 page when merge_plus_r109 is on, else the PDF merge as before. */
export function MergeEntry() {
  const config = useConfig();
  const on = ((config.data?.toolFeatures as readonly string[] | undefined) ?? []).includes("merge_plus_r109");
  return on ? <MergeHub /> : <DocumentsMerge />;
}

const TABS = [
  { id: "newsletters", label: "Newsletters" },
  { id: "lists", label: "Lists" },
  { id: "journeys", label: "Journeys" },
  { id: "unsubscribes", label: "Unsubscribes" },
  { id: "documents", label: "Documents" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Tools > Merge with R109 on: one tab bar, the tab kept in the address so back and refresh keep it. */
export function MergeHub() {
  const config = useConfig();
  const features = (config.data?.toolFeatures as readonly string[] | undefined) ?? [];
  const docs = features.includes("merge_mail");
  const tabs = TABS.filter((t) => t.id !== "documents" || docs);
  const [sp, setSp] = useSearchParams();
  const tab = (tabs.find((t) => t.id === sp.get("tab"))?.id ?? "newsletters") as TabId;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (id: TabId) => setSp((p: URLSearchParams) => { const n = new URLSearchParams(p); n.set("tab", id); return n; }, { replace: true });
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + tabs.length) % tabs.length;
    refs.current[n]?.focus(); go(tabs[n].id);
  };
  return (
    <AutoPage entryKey="merge_mail" title="Mail merge" description="Newsletters, welcome emails and personal documents to the people who said yes, with one click unsubscribe in every email.">
      <div role="tablist" aria-label="Mail merge" className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1" data-testid="r109-tabs">
        {tabs.map((t, i) => (
          <button key={t.id} ref={(el) => { refs.current[i] = el; }} role="tab" id={`r109-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`r109-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
            onClick={() => go(t.id)} onKeyDown={(e) => onKey(e, i)}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${tab === t.id ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`r109-panel-${tab}`} aria-labelledby={`r109-tab-${tab}`} className="pt-4">
        {tab === "newsletters" && <NewslettersTab />}
        {tab === "lists" && <ListsTab />}
        {tab === "journeys" && <JourneysTab />}
        {tab === "unsubscribes" && <UnsubscribesTab />}
        {tab === "documents" && docs && <DocumentsMerge bare />}
      </div>
    </AutoPage>
  );
}

function when(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

const statusTone = (s: string) => (s === "sent" || s === "active" || s === "subscribed" ? "ok" : s === "sending" || s === "scheduled" ? "brand" : s === "paused" || s === "pending" ? "warn" : s === "draft" ? "neutral" : "bad");

function Row({ to, title, sub, right, testId }: { to: string; title: ReactNode; sub: ReactNode; right?: ReactNode; testId?: string }) {
  return (
    <li>
      <Link to={to} data-testid={testId} className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 outline-none transition hover:border-line-strong focus-visible:ring-2 focus-visible:ring-brand/50">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={typeof title === "string" ? title : undefined}>{title}</p>
          <p className="truncate text-[12.5px] text-muted">{sub}</p>
        </div>
        {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
      </Link>
    </li>
  );
}

// ------------------------------------------------------------------ newsletters

interface NewsletterRow { id: string; name: string; subject: string; status: CampaignStatus; listName: string; scheduledAt: string | null; sentAt: string | null; stats: { total: number; sent: number; opened: number; clicked: number }; updatedAt: string }

function NewDialog({ open, onClose, kind }: { open: boolean; onClose: () => void; kind: "newsletter" | "journey" }) {
  const lists = useLists();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [listId, setListId] = useState("");
  const [starter, setStarter] = useState<"welcome" | "blank">("welcome");
  useEffect(() => { if (!listId && lists.data?.lists[0]) setListId(lists.data.lists[0].id); }, [lists.data, listId]);
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>(kind === "newsletter" ? `${B}/newsletters` : `${B}/journeys`, kind === "newsletter" ? { name, listId } : { name, listId, starter }),
    onSuccess: (r) => { onClose(); nav(`/tools/merge/${kind === "newsletter" ? "newsletters" : "journeys"}/${r.id}`); },
    onError: (e) => showError(e),
  });
  const ok = name.trim() && listId;
  return (
    <Dialog open={open} onClose={onClose} title={kind === "newsletter" ? "New newsletter" : "New journey"}
      description={kind === "newsletter" ? "Write it once; each person gets their own copy with their name filled in." : "A series of emails that goes to each person after they join a list, at their own pace."}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} disabled={!ok || create.isPending} data-testid="r109-create">Create</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ok) create.mutate(); }}>
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={kind === "newsletter" ? "November news" : "Welcome series"} autoFocus />}</Field>
        <Field label="List" hint="Only people on this list who said yes get it.">{(p) => (
          <Select {...p} value={listId} onChange={(e) => setListId(e.target.value)}>
            {(lists.data?.lists ?? []).map((l) => <option key={l.id} value={l.id}>{l.name} ({l.subscribed} subscribed)</option>)}
          </Select>
        )}</Field>
        {kind === "journey" && (
          <Field label="Start from">{(p) => (
            <Select {...p} value={starter} onChange={(e) => setStarter(e.target.value as "welcome" | "blank")}>
              <option value="welcome">Welcome series (welcome now, reminder after 3 days if not opened)</option>
              <option value="blank">Blank</option>
            </Select>
          )}</Field>
        )}
      </form>
    </Dialog>
  );
}

function NoListsYet({ what }: { what: string }) {
  const [, setSp] = useSearchParams();
  return <EmptyState title="Start with a list" body={`${what} go to a list of people who said yes to your emails. Make a list, add people with their consent, then come back here.`}
    action={<Button onClick={() => setSp({ tab: "lists" })}>Go to lists</Button>} />;
}

function NewslettersTab() {
  const q = useQuery({ queryKey: ["r109-newsletters"], queryFn: () => api.get<{ newsletters: NewsletterRow[] }>(`${B}/newsletters`) });
  const lists = useLists();
  const info = useInfo();
  const [open, setOpen] = useState(false);
  if (q.isPending || lists.isPending) return <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
  if (q.isError) return <ErrorBox onRetry={() => q.refetch()} />;
  const rows = q.data.newsletters;
  return (
    <section className="space-y-4" aria-label="Newsletters">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 sm:max-w-sm"><DailyLimit info={info.data} /></div>
        {!!lists.data?.lists.length && <Button onClick={() => setOpen(true)} data-testid="r109-new-newsletter">New newsletter</Button>}
      </div>
      {!lists.data?.lists.length ? <NoListsYet what="Newsletters" /> : !rows.length
        ? <EmptyState title="No newsletters yet" body="Write one with headings, text, buttons and pictures, send yourself a test, then send it or pick a time." action={<Button onClick={() => setOpen(true)}>New newsletter</Button>} />
        : <ul className="space-y-2">{rows.map((n) => (
          <Row key={n.id} to={`/tools/merge/newsletters/${n.id}`} testId="r109-newsletter-row" title={n.name}
            sub={<>{n.listName} · {n.status === "sent" || n.status === "sending" ? `${n.stats.sent} sent, ${rate(n.stats.opened, n.stats.sent)} opened, ${rate(n.stats.clicked, n.stats.sent)} clicked` : n.status === "scheduled" ? `Goes out ${when(n.scheduledAt)}` : n.subject || "No subject yet"}</>}
            right={<Badge tone={statusTone(n.status)}>{CAMPAIGN_STATUS_LABEL[n.status]}</Badge>} />
        ))}</ul>}
      <NewDialog open={open} onClose={() => setOpen(false)} kind="newsletter" />
    </section>
  );
}

export function ErrorBox({ onRetry, text = "This didn't load." }: { onRetry: () => void; text?: string }) {
  return <Card role="alert" className="flex flex-wrap items-center gap-3 p-4"><p className="flex-1 text-sm">{text}</p><Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button></Card>;
}

// ------------------------------------------------------------------ lists

function NewListDialog({ open, onClose, isAdmin }: { open: boolean; onClose: () => void; isAdmin: boolean }) {
  const qc = useQueryClient(); const nav = useNavigate();
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"workspace" | "private">(isAdmin ? "workspace" : "private");
  const [doubleOptIn, setDoubleOptIn] = useState(true);
  const create = useMutation({
    mutationFn: () => api.post<ListSummary>(`${B}/lists`, { name, visibility, doubleOptIn }),
    onSuccess: (l) => { qc.invalidateQueries({ queryKey: ["r109-lists"] }); onClose(); nav(`/tools/merge/lists/${l.id}`); },
    onError: (e) => showError(e),
  });
  return (
    <Dialog open={open} onClose={onClose} title="New list" description="A list is a group of people who said yes to your emails, with when and how they said it."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending} data-testid="r109-create-list">Create list</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Monthly news" autoFocus />}</Field>
        <Field label="Who can use it" hint={isAdmin ? "Everyone in the workspace can see a shared list; only admins send to it." : "Only admins can share a list with the whole workspace."}>{(p) => (
          <Select {...p} value={visibility} onChange={(e) => setVisibility(e.target.value as "workspace" | "private")} disabled={!isAdmin}>
            <option value="workspace">Whole workspace</option><option value="private">Just me</option>
          </Select>
        )}</Field>
        <Switch checked={doubleOptIn} onChange={setDoubleOptIn} label="People who sign up confirm by email first" />
      </form>
    </Dialog>
  );
}

function ListsTab() {
  const lists = useLists();
  const info = useInfo();
  const [open, setOpen] = useState(false);
  if (lists.isPending) return <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
  if (lists.isError) return <ErrorBox onRetry={() => lists.refetch()} />;
  const rows = lists.data.lists;
  return (
    <section className="space-y-4" aria-label="Lists">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">Only people with recorded consent get your emails. Unsubscribes apply to every list at once.</p>
        <Button onClick={() => setOpen(true)} data-testid="r109-new-list">New list</Button>
      </div>
      {!rows.length ? <EmptyState title="No lists yet" body="Make a list, then add people who said yes: paste them, upload a CSV, pick from your contacts, or share a signup form." action={<Button onClick={() => setOpen(true)}>New list</Button>} />
        : <ul className="space-y-2">{rows.map((l) => (
          <Row key={l.id} to={`/tools/merge/lists/${l.id}`} testId="r109-list-row" title={l.name}
            sub={<>{l.subscribed} subscribed{l.pending ? ` · ${l.pending} waiting to confirm` : ""}{l.unsubscribed ? ` · ${l.unsubscribed} unsubscribed` : ""}</>}
            right={<><Badge>{l.visibility === "workspace" ? "Workspace" : "Private"}</Badge>{l.signupOn && <Badge tone="brand">Signup form on</Badge>}</>} />
        ))}</ul>}
      <NewListDialog open={open} onClose={() => setOpen(false)} isAdmin={!!info.data?.isAdmin} />
    </section>
  );
}

interface Member { id: string; email: string; name: string; status: MemberStatus; consentKind: "express" | "inferred"; consentSource: string; consentAt: string | null; canSend: boolean; why: string | null }

export function ListPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient(); const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: ["r109-list", id, search, status, offset], queryFn: () => api.get<{ list: ListSummary; members: Member[]; more: boolean }>(`${B}/lists/${id}?${new URLSearchParams({ q: search, status, offset: String(offset) })}`), placeholderData: (p) => p });
  const remove = useMutation({ mutationFn: (mid: string) => api.del(`${B}/lists/${id}/members/${mid}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["r109-list", id] }), onError: (e) => showError(e) });
  const archive = useMutation({ mutationFn: () => api.del(`${B}/lists/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["r109-lists"] }); nav("/tools/merge?tab=lists"); }, onError: (e) => showError(e) });
  const l = q.data?.list;
  return (
    <AutoPage entryKey="merge_mail" title={l?.name ?? "List"} description="People on this list, their consent, and how new people join." usage={false}
      actions={<Link to="/tools/merge?tab=lists" className="text-sm text-muted hover:text-fg">Back to lists</Link>}>
      {q.isPending ? <Skeleton className="h-64 w-full" /> : q.isError || !l ? <ErrorBox onRetry={() => q.refetch()} text="This list didn't load. It may have been archived." /> : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-4">
            {l.canEdit && <AddPeople list={l} />}
            <Card className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="mr-auto text-sm font-semibold">People</h2>
                <Input aria-label="Search people" placeholder="Search name or email" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} className="w-full sm:w-56" />
                <Select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} className="w-full sm:w-44">
                  <option value="">Everyone</option>{(Object.keys(MEMBER_STATUS_LABEL) as MemberStatus[]).map((s) => <option key={s} value={s}>{MEMBER_STATUS_LABEL[s]}</option>)}
                </Select>
              </div>
              {!q.data.members.length ? <p className="py-6 text-center text-sm text-muted">{search || status ? "Nobody matches." : "Nobody on this list yet."}</p> : (
                <ul className="divide-y divide-line" data-testid="r109-members">
                  {q.data.members.map((m) => (
                    <li key={m.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" title={m.email}>{m.name || m.email}</p>
                        <p className="truncate text-[12px] text-muted">{m.name ? `${m.email} · ` : ""}{m.consentKind === "inferred" ? "Inferred consent" : "Express consent"}: {m.consentSource}{m.consentAt ? `, ${new Date(m.consentAt).toLocaleDateString()}` : ""}</p>
                      </div>
                      <Badge tone={statusTone(m.status)}>{MEMBER_STATUS_LABEL[m.status]}</Badge>
                      {l.canEdit && <ConfirmButton onConfirm={() => remove.mutate(m.id)} armedLabel="Remove?" aria-label={`Remove ${m.email}`}>Remove</ConfirmButton>}
                    </li>
                  ))}
                </ul>
              )}
              {(offset > 0 || q.data.more) && (
                <div className="flex justify-between">
                  <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button>
                  <Button size="sm" variant="ghost" disabled={!q.data.more} onClick={() => setOffset(offset + 50)}>Next</Button>
                </div>
              )}
            </Card>
          </div>
          <div className="space-y-4">
            <ListSettings list={l} />
            {l.canEdit && <Card className="p-4"><ConfirmButton variant="ghost" onConfirm={() => archive.mutate()} armedLabel="Archive this list?">Archive list</ConfirmButton><p className="mt-1 text-[12px] text-muted">Stops its signup form and journeys. Unsubscribes stay.</p></Card>}
          </div>
        </div>
      )}
    </AutoPage>
  );
}

function ListSettings({ list }: { list: ListSummary }) {
  const qc = useQueryClient();
  const mailboxes = useMailboxes();
  const [f, setF] = useState(list);
  useEffect(() => setF(list), [list]);
  const save = useMutation({
    mutationFn: (patch: Partial<ListSummary>) => api.patch<ListSummary>(`${B}/lists/${list.id}`, patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["r109-list", list.id] }); qc.invalidateQueries({ queryKey: ["r109-lists"] }); },
    onError: (e) => showError(e),
  });
  const ro = !list.canEdit;
  const signupUrl = list.signupKey ? `${window.location.origin}/api/campaign-public/s/${list.signupKey}` : "";
  const dirty = f.senderName !== list.senderName || f.senderAddress !== list.senderAddress || f.mailboxId !== list.mailboxId || f.tz !== list.tz || f.name !== list.name;
  return (
    <Card className="space-y-3 p-4" data-testid="r109-list-settings">
      <h2 className="text-sm font-semibold">Settings</h2>
      <Field label="Name">{(p) => <Input {...p} value={f.name} disabled={ro} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} />}</Field>
      <Field label="Sender name" hint="Shown in every email, as the law asks.">{(p) => <Input {...p} value={f.senderName} disabled={ro} onChange={(e) => setF({ ...f, senderName: e.target.value })} maxLength={120} placeholder="Your business name" />}</Field>
      <Field label="Contact address" hint="A postal address or other way to reach you, shown in every email.">{(p) => <Textarea {...p} rows={2} value={f.senderAddress} disabled={ro} onChange={(e) => setF({ ...f, senderAddress: e.target.value })} maxLength={300} />}</Field>
      <Field label="Sends from">{(p) => (
        <Select {...p} value={f.mailboxId ?? ""} disabled={ro} onChange={(e) => setF({ ...f, mailboxId: e.target.value || null })}>
          <option value="">Pick a mailbox</option>{(mailboxes.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
        </Select>
      )}</Field>
      <Field label="Time zone" hint="Journey emails go out at the hour you pick, in this time zone.">{(p) => (
        <Select {...p} value={f.tz} disabled={ro} onChange={(e) => setF({ ...f, tz: e.target.value })}>{[...new Set([f.tz, ...TZS])].map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</Select>
      )}</Field>
      {!ro && <Button size="sm" onClick={() => save.mutate({ name: f.name, senderName: f.senderName, senderAddress: f.senderAddress, mailboxId: f.mailboxId, tz: f.tz })} disabled={!dirty || save.isPending}>Save settings</Button>}
      <div className="space-y-2 border-t border-line pt-3">
        <Switch checked={list.doubleOptIn} disabled={ro} onChange={(v) => save.mutate({ doubleOptIn: v })} label="Signups confirm by email first" />
        <Switch checked={list.allowInferred} disabled={ro} onChange={(v) => save.mutate({ allowInferred: v })} label="Allow inferred consent (existing customers)" />
        <Switch checked={list.signupOn} disabled={ro || !list.mailboxId} onChange={(v) => save.mutate({ signupOn: v })} label="Public signup form" />
        {!list.mailboxId && !ro && <p className="text-[12px] text-muted">Pick a mailbox first, so confirm emails can go out.</p>}
        {list.signupOn && signupUrl && (
          <div className="flex gap-2"><Input aria-label="Signup form link" readOnly value={signupUrl} onFocus={(e) => e.currentTarget.select()} /><Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(signupUrl)}>Copy</Button></div>
        )}
      </div>
    </Card>
  );
}

function parsePeople(text: string): { email: string; name?: string; fields?: Record<string, string> }[] {
  const rows = parseCsv(text.trim());
  if (!rows.length) return [];
  const head = rows[0].map((c) => c.trim().toLowerCase());
  const hasHeader = head.some((h) => h === "email" || h === "e-mail" || h === "email address");
  if (hasHeader) {
    const ei = head.findIndex((h) => h.startsWith("e"));
    const ni = head.findIndex((h) => h === "name" || h === "full name");
    return rows.slice(1).filter((r) => r[ei]).map((r) => ({ email: r[ei].trim(), name: ni >= 0 ? r[ni]?.trim() : undefined,
      fields: Object.fromEntries(rows[0].map((h, i) => [h.trim().replace(/\s+/g, "_"), r[i] ?? ""]).filter(([, ], i) => i !== ei && i !== ni && rows[0][i]?.trim())) }));
  }
  return rows.map((r) => { const e = r.find((c) => isEmail(c)) ?? r[0]; const n = r.find((c) => c !== e && c.trim()); return { email: (e ?? "").trim(), name: n?.trim() }; }).filter((p) => p.email);
}

function AddPeople({ list }: { list: ListSummary }) {
  const qc = useQueryClient();
  const info = useInfo();
  const [mode, setMode] = useState<"paste" | "contacts">("paste");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"express" | "inferred">("express");
  const [source, setSource] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const people = useMemo(() => parsePeople(text), [text]);
  const valid = people.filter((p) => isEmail(p.email)).length;
  const done = (r: { added: number; updated: number; skippedUnsubscribed: number; skippedBounced: number; skippedInvalid: number }) => {
    const bits = [`${r.added} added`];
    if (r.updated) bits.push(`${r.updated} already on the list`);
    if (r.skippedUnsubscribed) bits.push(`${r.skippedUnsubscribed} skipped because they unsubscribed`);
    if (r.skippedBounced) bits.push(`${r.skippedBounced} skipped because emails to them bounced`);
    if (r.skippedInvalid) bits.push(`${r.skippedInvalid} not valid email addresses`);
    setResult(bits.join(", ") + ".");
    setText("");
    qc.invalidateQueries({ queryKey: ["r109-list", list.id] }); qc.invalidateQueries({ queryKey: ["r109-lists"] });
  };
  const consent = { kind, source };
  const add = useMutation({ mutationFn: () => api.post<Parameters<typeof done>[0]>(`${B}/lists/${list.id}/members`, { people: people.slice(0, 2000), consent }), onSuccess: done, onError: (e) => showError(e) });
  const fromContacts = useMutation({ mutationFn: () => api.post<Parameters<typeof done>[0]>(`${B}/lists/${list.id}/members/contacts`, { contactIds: "all", consent }), onSuccess: done, onError: (e) => showError(e) });
  const fileRef = useRef<HTMLInputElement>(null);
  const ready = !!source.trim();
  return (
    <Card className="space-y-3 p-4" data-testid="r109-add-people">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-semibold">Add people</h2>
        <div className="flex gap-1" role="group" aria-label="How to add">
          <Button size="sm" variant={mode === "paste" ? "secondary" : "ghost"} aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>Paste or CSV</Button>
          <Button size="sm" variant={mode === "contacts" ? "secondary" : "ghost"} aria-pressed={mode === "contacts"} onClick={() => setMode("contacts")}>From contacts</Button>
        </div>
      </div>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">Consent</legend>
        <Field label="How they said yes">{(p) => (
          <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as "express" | "inferred")}>
            <option value="express">Express consent (they asked for emails)</option>
            <option value="inferred" disabled={!list.allowInferred}>Inferred consent (existing customers){list.allowInferred ? "" : ", off for this list"}</option>
          </Select>
        )}</Field>
        <Field label="Where" hint="Kept with each person as their consent record.">{(p) => (
          <Select {...p} value={source} onChange={(e) => setSource(e.target.value)} data-testid="r109-consent-source">
            <option value="">Pick one</option>{(info.data?.consentSources ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        )}</Field>
      </fieldset>
      {mode === "paste" ? (
        <>
          <Field label="People" hint="One per line: email, then name. Or a CSV with an email column; other columns become merge fields.">{(p) => (
            <Textarea {...p} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={"jo@example.com, Jo Lee\nsam@example.com, Sam Wu"} data-testid="r109-paste" />
          )}</Field>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Upload a CSV" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); e.target.value = ""; }} />
            <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>Upload CSV</Button>
            <span className="mr-auto text-[12.5px] text-muted">{people.length ? `${valid} of ${people.length} look like email addresses` : ""}</span>
            <Button size="sm" onClick={() => add.mutate()} disabled={!ready || !valid || add.isPending} data-testid="r109-add">Add {valid || ""} {valid === 1 ? "person" : "people"}</Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-[12.5px] text-muted">Adds up to 2,000 of your contacts with an email address. Only add contacts who said yes to your emails.</p>
          <Button size="sm" onClick={() => fromContacts.mutate()} disabled={!ready || fromContacts.isPending}>Add contacts</Button>
        </div>
      )}
      {!ready && <p className="text-[12px] text-muted">Pick where they gave consent to add people.</p>}
      {result && <p role="status" className="text-sm" data-testid="r109-add-result">{result}</p>}
    </Card>
  );
}

// ------------------------------------------------------------------ journeys and unsubscribes

interface JourneyRow { id: string; name: string; status: "draft" | "active" | "paused"; listName: string; steps: unknown[]; enrolled: number }

function JourneysTab() {
  const q = useQuery({ queryKey: ["r109-journeys"], queryFn: () => api.get<{ journeys: JourneyRow[] }>(`${B}/journeys`) });
  const lists = useLists();
  const [open, setOpen] = useState(false);
  if (q.isPending || lists.isPending) return <Skeleton className="h-32 w-full" />;
  if (q.isError) return <ErrorBox onRetry={() => q.refetch()} />;
  return (
    <section className="space-y-4" aria-label="Journeys">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">Emails that go to each person after they join a list, like a welcome and a reminder if they didn't open it.</p>
        {!!lists.data?.lists.length && <Button onClick={() => setOpen(true)} data-testid="r109-new-journey">New journey</Button>}
      </div>
      {!lists.data?.lists.length ? <NoListsYet what="Journeys" /> : !q.data.journeys.length
        ? <EmptyState title="No journeys yet" body="Start with the welcome series: a welcome when someone joins, and a reminder three days later only if they didn't open it." action={<Button onClick={() => setOpen(true)}>New journey</Button>} />
        : <ul className="space-y-2">{q.data.journeys.map((j) => (
          <Row key={j.id} to={`/tools/merge/journeys/${j.id}`} testId="r109-journey-row" title={j.name} sub={`${j.listName} · ${j.steps.length} ${j.steps.length === 1 ? "email" : "emails"} · ${j.enrolled} started`}
            right={<Badge tone={statusTone(j.status)}>{j.status === "active" ? "On" : j.status === "paused" ? "Paused" : "Draft"}</Badge>} />
        ))}</ul>}
      <NewDialog open={open} onClose={() => setOpen(false)} kind="journey" />
    </section>
  );
}

const REASON: Record<string, string> = { unsubscribed: "Unsubscribed", hard_bounce: "Bounced", complaint: "Marked as spam", manual: "Blocked by hand" };

function UnsubscribesTab() {
  const qc = useQueryClient();
  const info = useInfo();
  const [search, setSearch] = useState("");
  const [email, setEmail] = useState("");
  const q = useQuery({ queryKey: ["r109-supp", search], queryFn: () => api.get<{ items: { email: string; reason: string; at: string }[] }>(`${B}/suppressions?q=${encodeURIComponent(search)}`), placeholderData: (p) => p });
  const block = useMutation({ mutationFn: () => api.post(`${B}/suppressions`, { email }), onSuccess: () => { setEmail(""); qc.invalidateQueries({ queryKey: ["r109-supp"] }); }, onError: (e) => showError(e) });
  return (
    <section className="space-y-4" aria-label="Unsubscribes">
      <p className="text-sm text-muted">Nobody here gets bulk email from this workspace, on any list. People who unsubscribe are taken off at once and are never added back by an import.</p>
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search addresses" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full sm:w-64" />
        {info.data?.isAdmin && (
          <form className="flex w-full gap-2 sm:ml-auto sm:w-auto" onSubmit={(e) => { e.preventDefault(); if (isEmail(email)) block.mutate(); }}>
            <Input aria-label="Address to block" type="email" placeholder="Block an address" value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-0 flex-1 sm:w-56" />
            <Button type="submit" variant="secondary" disabled={!isEmail(email) || block.isPending}>Block</Button>
          </form>
        )}
      </div>
      {q.isPending ? <Skeleton className="h-24 w-full" /> : q.isError ? <ErrorBox onRetry={() => q.refetch()} /> : !q.data.items.length
        ? <p className="py-6 text-center text-sm text-muted">{search ? "No address matches." : "Nobody has unsubscribed yet."}</p>
        : <ul className="divide-y divide-line rounded-lg border border-line bg-surface" data-testid="r109-supp">{q.data.items.map((s) => (
          <li key={`${s.email}-${s.reason}`} className="flex min-w-0 items-center gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1 truncate text-sm" title={s.email}>{s.email}</span>
            <Badge tone={s.reason === "unsubscribed" ? "neutral" : "bad"}>{REASON[s.reason] ?? s.reason}</Badge>
            <span className="hidden text-[12px] text-muted sm:inline">{new Date(s.at).toLocaleDateString()}</span>
          </li>
        ))}</ul>}
    </section>
  );
}
