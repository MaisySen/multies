/**
 * R119: Shared inbox > Helpdesk settings (/app/inbox/helpdesk): which inboxes work as a helpdesk, business hours and
 * reply targets, macros, the website chat and the survey. Admins change them; members see them read only.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { useMailboxes, useTeam } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea, TimeInput } from "@/web/components/ui/input";
import { Card, CopyButton, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { IconArrowLeft, IconPlus, IconTrash } from "@/web/components/ui/icon";
import {
  MACRO_STEPS_MAX, PRIORITY_LABEL, STATUS_LABEL, TICKET_PRIORITIES, TICKET_STATUSES, describeStep, type BusinessHours, type HelpdeskSettings, type MacroStep,
  type SlaTargets, type WidgetSettings,
} from "@/shared/helpdesk";
import { useHelpdeskSettings, type HelpdeskSettingsOut } from "./helpdesk";

const TABS = [["general", "General"], ["hours", "Hours and targets"], ["macros", "Macros"], ["chat", "Website chat"], ["survey", "Survey"]] as const;
type Tab = (typeof TABS)[number][0];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const mins = (s: string) => { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); };

function useSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<HelpdeskSettings>) => api.patch<HelpdeskSettingsOut>("/helpdesk/settings", patch),
    onSuccess: (d) => { qc.setQueryData(["helpdesk", "settings"], d); qc.invalidateQueries({ queryKey: ["helpdesk", "tickets"] }); toast.success("Saved"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function HelpdeskSettingsPage() {
  const q = useHelpdeskSettings();
  const [tab, setTab] = useState<Tab>(() => (TABS.find(([k]) => `#${k}` === window.location.hash)?.[0] ?? "general"));
  const pick = (t: Tab) => { setTab(t); history.replaceState(null, "", `#${t}`); };
  const ro = !q.data?.canManage;
  return (
    <>
      <Link to="/app/inbox" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-fg max-sm:min-h-11"><IconArrowLeft className="h-3.5 w-3.5" aria-hidden />Shared inbox</Link>
      <PageHeader title="Helpdesk" description="Turn shared inboxes into tickets with owners and reply times, add a chat to your website and ask customers how it went." />
      <div role="tablist" aria-label="Helpdesk settings" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} id={`hd-tab-${k}`} aria-controls={`hd-panel-${k}`} onClick={() => pick(k)}
            className={cn("-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 max-sm:min-h-11", tab === k ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>{label}</button>
        ))}
      </div>
      {ro && q.data && <p className="mb-4 rounded-lg bg-fill px-3 py-2 text-sm text-muted">Only workspace admins can change these settings.</p>}
      <div role="tabpanel" id={`hd-panel-${tab}`} aria-labelledby={`hd-tab-${tab}`} className="max-w-[880px] space-y-4">
        {q.isPending ? <Card className="space-y-3 p-5"><Skeleton className="h-5 w-1/3" /><Skeleton className="h-10" /><Skeleton className="h-10" /></Card>
          : q.error ? <Card className="p-5 text-sm"><p className="text-bad">{errorMessage(q.error)}</p><Button size="sm" variant="secondary" className="mt-3" onClick={() => q.refetch()}>Try again</Button></Card>
          : tab === "general" ? <General s={q.data.settings} ro={ro} />
          : tab === "hours" ? <Hours s={q.data.settings} ro={ro} />
          : tab === "macros" ? <Macros ro={ro} />
          : tab === "chat" ? <WebsiteChat d={q.data} ro={ro} />
          : <Survey s={q.data.settings} ro={ro} />}
      </div>
    </>
  );
}

function SaveBar({ dirty, busy, onSave, ro }: { dirty: boolean; busy: boolean; onSave: () => void; ro: boolean }) {
  if (ro) return null;
  return <div className="flex justify-end border-t border-line pt-4"><Button onClick={onSave} loading={busy} disabled={!dirty}>Save changes</Button></div>;
}

function General({ s, ro }: { s: HelpdeskSettings; ro: boolean }) {
  const boxes = useMailboxes();
  const [ids, setIds] = useState(s.mailboxIds);
  const [chats, setChats] = useState(s.chats);
  const save = useSave();
  const dirty = JSON.stringify([ids, chats]) !== JSON.stringify([s.mailboxIds, s.chats]);
  const list = boxes.data ?? [];
  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="text-base font-semibold">Inboxes that work as a helpdesk</h2>
        <p className="mt-1 text-sm text-muted">New mail to these inboxes becomes a ticket with a number, an owner and reply times. Mail that arrived before you turn this on stays as it is.</p>
      </div>
      {boxes.isPending ? <Skeleton className="h-24" /> : !list.length ? (
        <EmptyState title="No shared inboxes yet" body="Add a mailbox first, then pick it here." action={<Link to="/app/mailboxes" className="text-sm font-medium text-brand hover:underline">Go to mailboxes</Link>} />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {list.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="min-w-0 truncate font-mono text-sm">{m.address}</span>
              <Switch label={`Helpdesk for ${m.address}`} checked={ids.includes(m.id)} disabled={ro} onChange={(v) => setIds(v ? [...ids, m.id] : ids.filter((x) => x !== m.id))} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-start justify-between gap-3 rounded-lg border border-line px-4 py-3">
        <div><p className="text-sm font-medium">Customer chats</p><p className="text-sm text-muted">WhatsApp, Messenger and Instagram chats connected in Chat channels become tickets too.</p></div>
        <Switch label="Customer chats become tickets" checked={chats} disabled={ro} onChange={setChats} />
      </div>
      <SaveBar ro={ro} dirty={dirty} busy={save.isPending} onSave={() => save.mutate({ mailboxIds: ids, chats })} />
    </Card>
  );
}

function zones(current: string) {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Perth", "Asia/Kathmandu", "Europe/London", "America/New_York", "UTC"];
  return all.includes(current) ? all : [current, ...all];
}
function Hours({ s, ro }: { s: HelpdeskSettings; ro: boolean }) {
  const [h, setH] = useState<BusinessHours>(s.hours);
  const [sla, setSla] = useState<SlaTargets>(s.sla);
  const save = useSave();
  const dirty = JSON.stringify([h, sla]) !== JSON.stringify([s.hours, s.sla]);
  const setDay = (i: number, v: BusinessHours["days"][number]) => setH({ ...h, days: h.days.map((d, j) => (j === i ? v : d)) });
  const bad = h.days.some((d) => d && d.end <= d.start);
  const hours = (m: number) => Math.round((m / 60) * 100) / 100;
  return (
    <>
      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold">Business hours</h2>
          <p className="mt-1 text-sm text-muted">Reply times only count while you are open. The website chat shows you as away outside these hours.</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="text-sm font-medium">Time zone
            <Select value={h.timezone} disabled={ro} onChange={(e) => setH({ ...h, timezone: e.target.value })} className="mt-1 w-72 max-w-full">{zones(h.timezone).map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</Select>
          </label>
          <label className="flex items-center gap-2 text-sm"><Switch label="Open every hour of every day" checked={h.always} disabled={ro} onChange={(v) => setH({ ...h, always: v })} />Open all the time</label>
        </div>
        {!h.always && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {h.days.map((d, i) => (
              <li key={i} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="w-28 text-sm font-medium">{DAYS[i]}</span>
                <Switch label={`Open on ${DAYS[i]}`} checked={!!d} disabled={ro} onChange={(v) => setDay(i, v ? { start: 540, end: 1020 } : null)} />
                {d ? (
                  <span className="flex items-center gap-2 text-sm">
                    <TimeInput aria-label={`${DAYS[i]} opens`} value={hhmm(d.start)} disabled={ro} onChange={(e) => setDay(i, { ...d, start: mins(e.target.value) })} className="w-28" />
                    <span className="text-muted">to</span>
                    <TimeInput aria-label={`${DAYS[i]} closes`} value={hhmm(d.end % 1440)} disabled={ro} onChange={(e) => setDay(i, { ...d, end: mins(e.target.value) || 1440 })} className="w-28" />
                  </span>
                ) : <span className="text-sm text-subtle">Closed</span>}
              </li>
            ))}
          </ul>
        )}
        <label className="block text-sm font-medium">Holidays <span className="font-normal text-muted">(one date per line, like 2026-12-25)</span>
          <Textarea rows={3} disabled={ro} value={h.holidays.join("\n")} onChange={(e) => setH({ ...h, holidays: e.target.value.split(/\s+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 60) })} className="mt-1 font-mono" />
        </label>
        {bad && <p className="text-sm text-bad" role="alert">Each open day must close after it opens.</p>}
      </Card>
      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold">Reply targets</h2>
          <p className="mt-1 text-sm text-muted">In working hours. A ticket shows as close when a quarter of the time is left, and as overdue after. Waiting on customer and on hold pause the resolve clock.</p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[420px] text-sm">
            <thead className="bg-fill text-left text-xs text-muted"><tr><th className="px-4 py-2 font-medium">Priority</th><th className="px-4 py-2 font-medium">First reply in (hours)</th><th className="px-4 py-2 font-medium">Solve in (hours)</th></tr></thead>
            <tbody className="divide-y divide-line">
              {[...TICKET_PRIORITIES].reverse().map((p) => (
                <tr key={p}>
                  <td className="px-4 py-2 font-medium">{PRIORITY_LABEL[p]}</td>
                  {(["first", "resolve"] as const).map((k) => (
                    <td key={k} className="px-4 py-2">
                      <Input type="number" min={0.25} step={0.25} disabled={ro} aria-label={`${PRIORITY_LABEL[p]} ${k === "first" ? "first reply" : "solve"} hours`} value={hours(sla[p][k])}
                        onChange={(e) => setSla({ ...sla, [p]: { ...sla[p], [k]: Math.max(5, Math.round(Number(e.target.value) * 60) || 5) } })} className="w-28" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <SaveBar ro={ro} dirty={dirty && !bad} busy={save.isPending} onSave={() => save.mutate({ hours: h, sla })} />
      </Card>
    </>
  );
}

interface MacroOut { id: string; name: string; steps: MacroStep[] }
function Macros({ ro }: { ro: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["helpdesk", "macros"], queryFn: () => api.get<{ macros: MacroOut[] }>("/helpdesk/macros") });
  const team = useTeam();
  const snippets = useQuery({ queryKey: ["mail-snippets"], queryFn: () => api.get<{ snippets: { id: string; name: string }[] }>("/mail/snippets"), staleTime: 60_000 });
  const [edit, setEdit] = useState<MacroOut | "new" | null>(null);
  const [del, setDel] = useState<MacroOut | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/helpdesk/macros/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["helpdesk", "macros"] }); setDel(null); toast.success("Macro deleted"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const person = (id: string) => team.data?.members.find((m) => m.userId === id)?.name;
  const snippet = (id: string) => snippets.data?.snippets.find((x) => x.id === id)?.name;
  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-base font-semibold">Macros</h2><p className="mt-1 text-sm text-muted">Several steps in one click on a ticket: set the status or priority, pick an owner, add a note, start a reply.</p></div>
        {!ro && <Button size="sm" onClick={() => setEdit("new")}><IconPlus className="h-4 w-4" aria-hidden />New macro</Button>}
      </div>
      {q.isPending ? <Skeleton className="h-24" /> : q.error ? <p className="text-sm text-bad">{errorMessage(q.error)}</p> : !q.data.macros.length ? (
        <EmptyState title="No macros yet" body="For example: Ask for the order number, which assigns it to you, starts the reply and waits on the customer." />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {q.data.macros.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1"><p className="text-sm font-medium">{m.name}</p><p className="truncate text-xs text-muted">{m.steps.map((st) => describeStep(st, { person, snippet })).join(", then ")}</p></div>
              {!ro && <><Button size="sm" variant="secondary" onClick={() => setEdit(m)}>Edit</Button><Button size="icon" variant="ghost" aria-label={`Delete ${m.name}`} onClick={() => setDel(m)}><IconTrash className="h-4 w-4" /></Button></>}
            </li>
          ))}
        </ul>
      )}
      {edit && <MacroDialog initial={edit === "new" ? null : edit} onClose={() => setEdit(null)} people={(team.data?.members ?? []).filter((m) => m.kind === "human").map((m) => ({ id: m.userId, name: m.name || m.email || "Teammate" }))} snippets={snippets.data?.snippets ?? []} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} busy={remove.isPending} title={`Delete ${del?.name ?? "macro"}?`} description="Tickets keep everything the macro already did." />
    </Card>
  );
}

function MacroDialog({ initial, onClose, people, snippets }: { initial: MacroOut | null; onClose: () => void; people: { id: string; name: string }[]; snippets: { id: string; name: string }[] }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [steps, setSteps] = useState<MacroStep[]>(initial?.steps ?? [{ type: "status", status: "pending" }]);
  const save = useMutation({
    mutationFn: () => initial ? api.patch(`/helpdesk/macros/${initial.id}`, { name, steps }) : api.post("/helpdesk/macros", { name, steps }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["helpdesk", "macros"] }); toast.success("Macro saved"); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = (i: number, st: MacroStep) => setSteps(steps.map((x, j) => (j === i ? st : x)));
  const blank = (type: MacroStep["type"]): MacroStep => type === "status" ? { type, status: "pending" } : type === "priority" ? { type, priority: "high" } : type === "assign" ? { type, to: "me" } : type === "note" ? { type, text: "" } : { type, text: "" };
  const valid = name.trim() && steps.length && steps.every((st) => st.type !== "note" || st.text.trim()) && steps.every((st) => st.type !== "reply" || st.text?.trim() || st.snippetId);
  return (
    <Dialog open onClose={onClose} title={initial ? "Edit macro" : "New macro"} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid}>Save macro</Button></>}>
      <label className="block text-sm font-medium">Name<Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="mt-1" placeholder="Ask for the order number" /></label>
      <p className="mt-4 text-sm font-medium">Steps, in order</p>
      <ol className="mt-2 space-y-2">
        {steps.map((st, i) => (
          <li key={i} className="flex flex-wrap items-start gap-2 rounded-lg border border-line p-2">
            <span className="mt-2 w-5 text-center text-xs text-subtle">{i + 1}</span>
            <Select aria-label={`Step ${i + 1} action`} value={st.type} onChange={(e) => set(i, blank(e.target.value as MacroStep["type"]))} className="w-40">
              <option value="status">Set status</option><option value="priority">Set priority</option><option value="assign">Assign</option><option value="note">Add a note</option><option value="reply">Start a reply</option>
            </Select>
            <div className="min-w-0 flex-1">
              {st.type === "status" ? <Select aria-label="Status" value={st.status} onChange={(e) => set(i, { ...st, status: e.target.value as typeof st.status })}>{TICKET_STATUSES.map((x) => <option key={x} value={x}>{STATUS_LABEL[x]}</option>)}</Select>
                : st.type === "priority" ? <Select aria-label="Priority" value={st.priority} onChange={(e) => set(i, { ...st, priority: e.target.value as typeof st.priority })}>{[...TICKET_PRIORITIES].reverse().map((x) => <option key={x} value={x}>{PRIORITY_LABEL[x]}</option>)}</Select>
                : st.type === "assign" ? <Select aria-label="Owner" value={st.to} onChange={(e) => set(i, { ...st, to: e.target.value })}><option value="me">The person running it</option><option value="none">Nobody</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
                : st.type === "note" ? <Textarea aria-label="Note" rows={2} maxLength={2000} value={st.text} onChange={(e) => set(i, { ...st, text: e.target.value })} placeholder="Only your team sees notes" />
                : <div className="space-y-2">
                    {snippets.length > 0 && <Select aria-label="Saved reply" value={st.snippetId ?? ""} onChange={(e) => set(i, { ...st, snippetId: e.target.value || undefined })}><option value="">Write the text below</option>{snippets.map((x) => <option key={x.id} value={x.id}>Saved reply: {x.name}</option>)}</Select>}
                    {!st.snippetId && <Textarea aria-label="Reply text" rows={3} maxLength={4000} value={st.text ?? ""} onChange={(e) => set(i, { ...st, text: e.target.value })} placeholder="The reply opens with this text. You still press Send." />}
                  </div>}
            </div>
            <Button size="icon" variant="ghost" aria-label={`Remove step ${i + 1}`} disabled={steps.length === 1} onClick={() => setSteps(steps.filter((_, j) => j !== i))}><IconTrash className="h-4 w-4" /></Button>
          </li>
        ))}
      </ol>
      {steps.length < MACRO_STEPS_MAX && <Button size="sm" variant="secondary" className="mt-2" onClick={() => setSteps([...steps, blank("note")])}><IconPlus className="h-4 w-4" aria-hidden />Add a step</Button>}
    </Dialog>
  );
}

function WebsiteChat({ d, ro }: { d: HelpdeskSettingsOut; ro: boolean }) {
  const boxes = useMailboxes();
  const [w, setW] = useState<WidgetSettings>(d.settings.widget);
  const [domains, setDomains] = useState(d.settings.widget.domains.join("\n"));
  const save = useSave();
  const qc = useQueryClient();
  const rotate = useMutation({ mutationFn: () => api.post<HelpdeskSettingsOut>("/helpdesk/settings/widget-key"), onSuccess: (x) => { qc.setQueryData(["helpdesk", "settings"], x); toast.success("New snippet ready. Replace it on your site."); }, onError: (e) => toast.error(errorMessage(e)) });
  useEffect(() => { setW(d.settings.widget); setDomains(d.settings.widget.domains.join("\n")); }, [d.settings.widget]);
  const next = { ...w, domains: domains.split(/[\s,]+/).filter(Boolean) };
  const dirty = JSON.stringify(next) !== JSON.stringify(d.settings.widget);
  const [tried, setTried] = useState(false);
  const tryHere = () => {
    if (document.querySelector("[data-mq-chat]")) { toast("The chat is already open in the corner of this page."); return; }
    const sc = document.createElement("script");
    sc.src = "/widget.js"; sc.async = true; sc.dataset.key = d.widgetKey;
    document.body.appendChild(sc); setTried(true);
  };
  return (
    <>
      <Card className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-base font-semibold">Website chat</h2><p className="mt-1 text-sm text-muted">A small chat button for your website. Chats land here as tickets. Outside business hours visitors leave a message and get your reply by email.</p></div>
          <Switch label="Website chat on" checked={w.on} disabled={ro} onChange={(v) => setW({ ...w, on: v })} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium">Title<Input value={w.title} maxLength={60} disabled={ro} onChange={(e) => setW({ ...w, title: e.target.value })} className="mt-1" /></label>
          <label className="text-sm font-medium">Colour
            <span className="mt-1 flex items-center gap-2">
              <Select value={w.color ? "custom" : "brand"} disabled={ro} onChange={(e) => setW({ ...w, color: e.target.value === "brand" ? null : "#4338ca" })} className="flex-1"><option value="brand">Workspace brand</option><option value="custom">Pick a colour</option></Select>
              {w.color && <input type="color" aria-label="Chat colour" value={w.color} disabled={ro} onChange={(e) => setW({ ...w, color: e.target.value })} className="h-9 w-12 cursor-pointer rounded-md border border-line-strong bg-surface max-sm:h-11" />}
            </span>
          </label>
          <label className="text-sm font-medium sm:col-span-2">Greeting<Textarea rows={2} maxLength={300} value={w.greeting} disabled={ro} onChange={(e) => setW({ ...w, greeting: e.target.value })} className="mt-1" /></label>
          <label className="text-sm font-medium">Websites it may run on <span className="font-normal text-muted">(one per line)</span>
            <Textarea rows={3} value={domains} disabled={ro} onChange={(e) => setDomains(e.target.value)} placeholder="yourshop.com" className="mt-1 font-mono" />
            <span className="mt-1 block text-xs font-normal text-muted">Its subdomains are included. Other sites cannot use your chat.</span>
          </label>
          <div className="space-y-4">
            <label className="block text-sm font-medium">Email replies come from
              <Select value={w.mailboxId ?? ""} disabled={ro} onChange={(e) => setW({ ...w, mailboxId: e.target.value || null })} className="mt-1"><option value="">Pick a mailbox</option>{(boxes.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}</Select>
            </label>
            <label className="block text-sm font-medium">Ask for the visitor's email
              <Select value={w.askEmail} disabled={ro} onChange={(e) => setW({ ...w, askEmail: e.target.value as WidgetSettings["askEmail"] })} className="mt-1"><option value="after">After their first message</option><option value="before">Before the chat starts</option><option value="never">Never</option></Select>
            </label>
          </div>
        </div>
        <div className="flex items-start justify-between gap-3 rounded-lg border border-line px-4 py-3">
          <div><p className="text-sm font-medium">Automatic answers</p><p className="text-sm text-muted">When a first question clearly matches one of your saved replies, the chat shows it at once. Your team still sees the chat.</p></div>
          <Switch label="Automatic answers from saved replies" checked={w.botAnswers} disabled={ro} onChange={(v) => setW({ ...w, botAnswers: v })} />
        </div>
        <SaveBar ro={ro} dirty={dirty} busy={save.isPending} onSave={() => save.mutate({ widget: next })} />
      </Card>
      <Card className="space-y-3 p-5">
        <h2 className="text-base font-semibold">Add it to your website</h2>
        <p className="text-sm text-muted">Paste this just before the closing body tag on every page. It loads after your page and adds about 6 KB.</p>
        <pre className="overflow-x-auto rounded-lg bg-fill p-3 font-mono text-xs [overflow-wrap:anywhere]" data-testid="widget-snippet">{d.snippet}</pre>
        <div className="flex flex-wrap gap-2">
          <CopyButton value={d.snippet} label="Copy snippet" toastText="Snippet copied" />
          {d.settings.widget.on && <Button size="sm" variant="secondary" onClick={tryHere} disabled={tried}>{tried ? "Open in the corner" : "Try it on this page"}</Button>}
          {!ro && <Button size="sm" variant="ghost" onClick={() => rotate.mutate()} loading={rotate.isPending}>Make a new snippet</Button>}
        </div>
      </Card>
    </>
  );
}

function Survey({ s, ro }: { s: HelpdeskSettings; ro: boolean }) {
  const save = useSave();
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Ask how it went</h2>
          <p className="mt-1 text-sm text-muted">When a ticket is solved, the customer gets one short question: Great, Okay or Not good, with room for a comment. Email tickets get a short mail from the same inbox; website chats see it in the chat. Ratings show on the ticket.</p>
        </div>
        <Switch label="Send a survey when a ticket is solved" checked={s.csat.on} disabled={ro || save.isPending} onChange={(v) => save.mutate({ csat: { on: v } })} />
      </div>
    </Card>
  );
}
