import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Building2, CheckSquare, Handshake, Mail, Plus, Users, Video } from "lucide-react";
import { startMeeting } from "./meeting-start";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { requireText, useDialogs } from "@/web/components/ui/confirm";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Textarea } from "@/web/components/ui/input";
import { Avatar, Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { initials, mailDate, shortDate, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import type { Contact, Task } from "./data";

interface Company { id: string; name: string; domain: string | null; contactCount: number; lastContactAt: string | null }
interface ThreadRow { threadId: string; subject: string; lastAt: string; firstAt: string; count: number; lastDirection: "inbound" | "outbound"; snippet: string; messageId: string }
interface Deal { id: string; title: string; stage: string; value: number; contactId: string | null; companyId: string | null; expectedClose: string | null }
type TimelineItem = { kind: "thread"; at: string; thread: ThreadRow } | { kind: "task"; at: string; task: Task } | { kind: "deal"; at: string; deal: Deal };
interface ContactDetail { contact: Contact; threads: ThreadRow[]; tasks: Task[]; deals: Deal[]; timeline: TimelineItem[] }

export const aud = (n: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(n);

export function ContactsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "companies" ? "companies" : "people";
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const people = useQuery({ queryKey: ["contacts", q], queryFn: () => api.get<{ contacts: Contact[]; total: number }>(`/contacts${q ? `?q=${encodeURIComponent(q)}` : ""}`), enabled: tab === "people" });
  const companies = useQuery({ queryKey: ["companies", q], queryFn: async () => (await api.get<{ companies: Company[] }>(`/companies${q ? `?q=${encodeURIComponent(q)}` : ""}`)).companies, enabled: tab === "companies" });
  return (
    <div>
      <PageHeader title="Contacts" description="Everyone you email with, added automatically, with their companies. Open someone to see every thread, task and deal with them."
        actions={<><Link to="/app/deals" className="inline-flex h-9 items-center gap-2 rounded-lg border border-line px-3.5 text-sm hover:bg-elevated"><Handshake className="h-4 w-4" />Deals</Link><Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add contact</Button></>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="tablist" className="flex rounded-lg bg-fill p-0.5">
          {(["people", "companies"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setParams(t === "people" ? {} : { tab: t })} className={cn("rounded-md px-3 py-1.5 text-[13px] capitalize", tab === t ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>{t}</button>
          ))}
        </div>
        <Input aria-label="Search contacts" placeholder={tab === "people" ? "Search by name or email" : "Search companies"} value={q} onChange={(e) => setQ(e.target.value)} className="h-9 max-w-xs" />
        {tab === "people" && people.data && <span className="text-[12.5px] text-subtle">{people.data.total} {people.data.total === 1 ? "person" : "people"}</span>}
      </div>
      {tab === "people" ? (
        people.isPending ? <Skeleton className="h-48" /> : !people.data?.contacts.length ? (
          <EmptyState icon={<Users />} title={q ? "Nobody matches" : "No contacts yet"} body="When mail arrives or you send to someone outside your team, they show up here with their company." />
        ) : (
          <Card className="divide-y divide-line overflow-hidden" data-testid="contact-list">
            {people.data.contacts.map((c) => (
              <Link key={c.id} to={`/app/contacts/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-hover">
                <Avatar label={initials(c.name || c.email)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium">{c.name || c.email}</div>
                  <div className="truncate text-[12.5px] text-muted">{c.email}{c.company && <> · {c.company.name}</>}</div>
                </div>
                <div className="hidden text-right text-[12px] text-subtle sm:block">
                  <div>{c.messageCount} {c.messageCount === 1 ? "email" : "emails"}</div>
                  <div>{c.lastContactAt ? `Last ${timeAgo(c.lastContactAt)}` : ""}</div>
                </div>
              </Link>
            ))}
          </Card>
        )
      ) : companies.isPending ? <Skeleton className="h-48" /> : !companies.data?.length ? (
        <EmptyState icon={<Building2 />} title="No companies yet" body="Companies come from your contacts' work email domains. Free mail like Gmail never makes a company." />
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {companies.data.map((c) => (
            <Link key={c.id} to={`/app/contacts?company=${c.id}`} onClick={(e) => { e.preventDefault(); setQ(c.domain ?? c.name); setParams({}); }} className="flex items-center gap-3 px-4 py-3 hover:bg-hover">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-elevated"><Building2 className="h-4 w-4 text-muted" /></span>
              <div className="min-w-0 flex-1"><div className="text-[14px] font-medium">{c.name}</div><div className="text-[12.5px] text-muted">{c.domain}</div></div>
              <div className="text-right text-[12px] text-subtle">{c.contactCount} {c.contactCount === 1 ? "person" : "people"}</div>
            </Link>
          ))}
        </Card>
      )}
      {adding && <AddContact onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddContact({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", name: "", phone: "", title: "" });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ contact: Contact }>("/contacts", Object.fromEntries(Object.entries(form).filter(([, v]) => v)));
      await qc.invalidateQueries({ queryKey: ["contacts"] });
      navigate(`/app/contacts/${r.contact.id}`);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Add a contact" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!form.email.includes("@")} onClick={submit}>Add contact</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Email">{(f) => <Input {...f} type="email" autoFocus value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
        <Field label="Name">{(f) => <Input {...f} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone">{(f) => <Input {...f} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+61 4..." />}</Field>
          <Field label="Job title">{(f) => <Input {...f} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}</Field>
        </div>
      </form>
    </Dialog>
  );
}

export function ContactPage() {
  const { prompt, dialogs } = useDialogs();
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["contact", id], queryFn: () => api.get<ContactDetail>(`/contacts/${id}`) });
  const [notes, setNotes] = useState<string | null>(null);
  if (q.isPending) return <div className="space-y-3"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;
  if (q.error) return <EmptyState icon={<Users />} title="Contact not found" body="It may have been removed." action={<Button onClick={() => navigate("/app/contacts")}>All contacts</Button>} />;
  const { contact: c, timeline, tasks, deals } = q.data;
  const saveNotes = async () => {
    if (notes === null || notes === c.notes) return;
    try { await api.patch(`/contacts/${c.id}`, { notes }); await qc.invalidateQueries({ queryKey: ["contact", id] }); } catch (e) { showError(e as Error); }
  };
  const makeDeal = async () => {
    const title = (await prompt({ title: "New deal", label: "Deal name", initial: c.company ? `${c.company.name} deal` : `${c.name || c.email} deal`, confirmLabel: "Create deal", validate: requireText("a deal name") }))?.trim();
    if (!title) return;
    try { await api.post("/deals", { title, contactId: c.id }); await qc.invalidateQueries({ queryKey: ["contact", id] }); } catch (e) { showError(e as Error); }
  };
  return (
    <div>
      {dialogs}
      <Link to="/app/contacts" className="mb-4 inline-flex items-center gap-1 text-[12.5px] text-subtle hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Contacts</Link>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Avatar label={initials(c.name || c.email)} className="h-12 w-12 text-sm" />
        <div className="min-w-0">
          <h1 className="large-title" data-testid="contact-name">{c.name || c.email}</h1>
          <p className="text-[13.5px] text-muted">{c.email}{c.title && <> · {c.title}</>}{c.company && <> · {c.company.name}</>}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <Link to={`/app/mail?compose=${encodeURIComponent(c.email)}`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-line px-3.5 text-sm hover:bg-elevated"><Mail className="h-4 w-4" />Email</Link>
          <Button variant="secondary" onClick={() => void startMeeting({ type: "contact", id: c.id }, navigate)}><Video className="h-4 w-4" />Meeting</Button>
          <Button variant="secondary" onClick={makeDeal}><Handshake className="h-4 w-4" />New deal</Button>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <section aria-label="Timeline">
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-subtle">Timeline</h2>
          {!timeline.length ? <p className="text-sm text-muted">Nothing yet.</p> : (
            <ol className="relative space-y-3 border-l border-line pl-5" data-testid="contact-timeline">
              {timeline.map((i) => (
                <li key={`${i.kind}:${i.kind === "thread" ? i.thread.threadId : i.kind === "task" ? i.task.id : i.deal.id}`} className="relative">
                  <span className="absolute -left-[27px] top-3 grid h-3.5 w-3.5 place-items-center rounded-full border border-line-strong bg-surface" aria-hidden />
                  {i.kind === "thread" ? (
                    <Link to={`/app/mail?m=${i.thread.messageId}`} className="block rounded-lg border border-line bg-surface p-3 hover:border-line-strong">
                      <div className="flex items-center gap-2 text-[12px] text-subtle"><Mail className="h-3.5 w-3.5" />{i.thread.count} {i.thread.count === 1 ? "email" : "emails"} · {i.thread.lastDirection === "inbound" ? "they wrote last" : "you wrote last"}<span className="ml-auto">{mailDate(i.thread.lastAt)}</span></div>
                      <div className="mt-1 text-[14px] font-medium">{i.thread.subject || "(no subject)"}</div>
                      <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{i.thread.snippet}</p>
                    </Link>
                  ) : i.kind === "task" ? (
                    <Link to={`/app/tasks?view=list&task=${i.task.id}`} className="block rounded-lg border border-line bg-surface p-3 hover:border-line-strong">
                      <div className="flex items-center gap-2 text-[12px] text-subtle"><CheckSquare className="h-3.5 w-3.5" />Task {i.task.ref}<span className="ml-auto">{shortDate(i.task.createdAt)}</span></div>
                      <div className="mt-1 flex items-center gap-2 text-[14px] font-medium">{i.task.title}<Badge>{i.task.statusName}</Badge></div>
                    </Link>
                  ) : (
                    <Link to="/app/deals" className="block rounded-lg border border-line bg-surface p-3 hover:border-line-strong">
                      <div className="flex items-center gap-2 text-[12px] text-subtle"><Handshake className="h-3.5 w-3.5" />Deal<span className="ml-auto">{aud(i.deal.value)}</span></div>
                      <div className="mt-1 text-[14px] font-medium">{i.deal.title} <span className="text-[12.5px] font-normal capitalize text-muted">{i.deal.stage}</span></div>
                    </Link>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
        <aside className="space-y-4">
          <Card className="p-4 text-[13px]">
            <dl className="grid grid-cols-[90px_1fr] gap-y-2">
              <dt className="text-subtle">Emails</dt><dd>{c.messageCount}</dd>
              <dt className="text-subtle">First</dt><dd>{c.firstContactAt ? shortDate(c.firstContactAt) : "Not yet"}</dd>
              <dt className="text-subtle">Last</dt><dd>{c.lastContactAt ? timeAgo(c.lastContactAt) : "Not yet"}</dd>
              <dt className="text-subtle">Open tasks</dt><dd>{tasks.filter((t) => t.status !== "done").length}</dd>
              <dt className="text-subtle">Deals</dt><dd>{deals.length ? aud(deals.reduce((n, d) => n + d.value, 0)) : "None"}</dd>
              <dt className="text-subtle">Added</dt><dd className="capitalize">{c.source === "mail" ? "From email" : c.source}</dd>
            </dl>
          </Card>
          <div>
            <label htmlFor="contact-notes" className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Notes</label>
            <Textarea id="contact-notes" className="mt-2 min-h-28 text-[13px]" value={notes ?? c.notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} placeholder="What matters about this person" />
          </div>
        </aside>
      </div>
    </div>
  );
}
