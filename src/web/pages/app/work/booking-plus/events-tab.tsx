/** R92: Events tab. Free events with RSVP tickets, capacity and waitlist, a public page, door check in and CSV export. */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconCamera, IconDownload, IconEdit, IconExternalLink, IconMegaphone, IconPlus, IconUndo } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { useDialogs } from "@/web/components/ui/confirm";
import { DateInput, Field, Input, Select, Textarea, TimeInput } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, Skeleton, StatTile, Switch } from "@/web/components/ui/misc";
import { formatTicketCode, readScan } from "@/shared/booking-plus";
import { ZONES, dayLabel, localIso, timeLabel, ymd, zone } from "./common";

interface EventRow {
  id: string; slug: string; title: string; description: string; location: string; onlineUrl: string; startsAt: string; endsAt: string; timezone: string;
  capacity: number | null; waitlist: boolean; status: "draft" | "published" | "cancelled"; going: number; waiting: number; checkedIn: number; url: string; mine?: boolean;
}
interface Ticket { id: string; name: string; email: string; status: "going" | "waitlist" | "cancelled"; checkedInAt: string | null; createdAt: string }
const STATUS: Record<EventRow["status"], [string, "neutral" | "ok" | "bad"]> = { draft: ["Draft", "neutral"], published: ["Open", "ok"], cancelled: ["Cancelled", "bad"] };

export function EventsTab() {
  const list = useQuery({ queryKey: ["booking", "events"], queryFn: async () => (await api.get<{ events: EventRow[] }>("/booking/events")).events });
  const [editing, setEditing] = useState<EventRow | "new" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="space-y-4" data-testid="events-tab">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[14px] text-muted">Free events with tickets by email, a waitlist when full, and check in at the door from a phone.</p>
        <Button onClick={() => setEditing("new")}><IconPlus className="h-4 w-4" />New event</Button>
      </div>
      {list.isPending ? <div className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
        : list.isError ? <Card><EmptyState title="Events did not load" body="Check your connection and try again." action={<Button variant="secondary" onClick={() => list.refetch()}>Try again</Button>} /></Card>
          : !list.data.length ? <Card><EmptyState icon={<IconMegaphone />} title="No events yet" body="Make a free event, share its page and people get a QR ticket by email." action={<Button onClick={() => setEditing("new")}>New event</Button>} /></Card>
            : (
              <div className="grid gap-3 md:grid-cols-2">
                {list.data.map((e) => (
                  <Card key={e.id} className="flex items-start gap-4 p-4 transition-colors duration-150 hover:border-line-strong">
                    <div className="flex w-14 shrink-0 flex-col items-center rounded-lg border border-line bg-fill py-1.5" aria-hidden>
                      <span className="text-[11px] font-semibold uppercase text-brand-hover">{new Date(e.startsAt).toLocaleDateString(undefined, { month: "short" })}</span>
                      <span className="text-[20px] font-semibold leading-6">{new Date(e.startsAt).getDate()}</span>
                    </div>
                    <button type="button" onClick={() => setOpenId(e.id)} className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-brand">
                      <span className="block truncate text-[15px] font-semibold" title={e.title}>{e.title}</span>
                      <span className="block text-[13px] text-muted">{dayLabel(e.startsAt)}, {timeLabel(e.startsAt)}{e.location ? ` · ${e.location}` : ""}</span>
                      <span className="mt-1 block text-[13px] text-subtle">{e.going}{e.capacity != null ? ` of ${e.capacity}` : ""} going{e.waiting ? ` · ${e.waiting} waiting` : ""}{e.checkedIn ? ` · ${e.checkedIn} in` : ""}</span>
                    </button>
                    <Badge tone={STATUS[e.status][1]}>{STATUS[e.status][0]}</Badge>
                  </Card>
                ))}
              </div>
            )}
      {editing && <EventEditor event={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); setOpenId(id); }} />}
      {openId && <EventDialog id={openId} onClose={() => setOpenId(null)} onEdit={(e) => { setOpenId(null); setEditing(e); }} />}
    </div>
  );
}

function EventEditor({ event, onClose, onSaved }: { event: EventRow | null; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const start = event ? new Date(event.startsAt) : new Date(Date.now() + 7 * 86400_000);
  const [f, setF] = useState({
    title: event?.title ?? "", description: event?.description ?? "", location: event?.location ?? "", onlineUrl: event?.onlineUrl ?? "",
    date: ymd(start), from: event ? start.toTimeString().slice(0, 5) : "18:00", to: event ? new Date(event.endsAt).toTimeString().slice(0, 5) : "20:00",
    timezone: event?.timezone ?? zone(), capacity: event?.capacity != null ? String(event.capacity) : "", waitlist: event?.waitlist ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const save = async (publish: boolean) => {
    setError(null);
    if (!f.title.trim()) return setError("Give the event a title.");
    const startsAt = localIso(f.date, f.from);
    let endsAt = localIso(f.date, f.to);
    if (new Date(endsAt) <= new Date(startsAt)) endsAt = new Date(new Date(endsAt).getTime() + 86400_000).toISOString();
    const cap = f.capacity.trim() ? Number(f.capacity) : null;
    if (cap != null && (!Number.isInteger(cap) || cap < 1)) return setError("Capacity must be a whole number, or empty for no limit.");
    setBusy(true);
    try {
      const body = { title: f.title, description: f.description, location: f.location, onlineUrl: f.onlineUrl, startsAt, endsAt, timezone: f.timezone, capacity: cap, waitlist: f.waitlist, ...(publish ? { status: "published" } : {}) };
      const r = event ? await api.patch<{ event: EventRow }>(`/booking/events/${event.id}`, body) : await api.post<{ event: EventRow }>("/booking/events", body);
      toast.success(publish ? "Event is open. Share its page." : "Saved as a draft.");
      void qc.invalidateQueries({ queryKey: ["booking", "events"] });
      void qc.invalidateQueries({ queryKey: ["booking", "event", r.event.id] });
      onSaved(r.event.id);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void save(event?.status === "published" || !event); };
  return (
    <Dialog open onClose={onClose} title={event ? "Edit event" : "New event"}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>{(!event || event.status === "draft") && <Button variant="secondary" disabled={busy} onClick={() => save(false)}>Save draft</Button>}<Button type="submit" form="event-form" disabled={busy}>{event?.status === "published" ? "Save" : "Publish"}</Button></>}>
      <form id="event-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Title">{(p) => <Input {...p} value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={120} placeholder="Open studio evening" data-autofocus />}</Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Day">{(p) => <DateInput {...p} value={f.date} onChange={(e) => set("date", e.target.value)} />}</Field>
          <Field label="Starts">{(p) => <TimeInput {...p} value={f.from} onChange={(e) => set("from", e.target.value)} />}</Field>
          <Field label="Ends">{(p) => <TimeInput {...p} value={f.to} onChange={(e) => set("to", e.target.value)} />}</Field>
        </div>
        <Field label="Time zone">{(p) => <Select {...p} value={f.timezone} onChange={(e) => set("timezone", e.target.value)}>{ZONES.map((z) => <option key={z} value={z}>{z}</option>)}</Select>}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Place (optional)">{(p) => <Input {...p} value={f.location} onChange={(e) => set("location", e.target.value)} maxLength={200} />}</Field>
          <Field label="Online link (optional)" hint="Only people with a ticket see it.">{(p) => <Input {...p} type="url" value={f.onlineUrl} onChange={(e) => set("onlineUrl", e.target.value)} placeholder="https://" maxLength={500} />}</Field>
        </div>
        <div className="grid items-end gap-4 sm:grid-cols-2">
          <Field label="Capacity" hint="Empty means no limit.">{(p) => <Input {...p} inputMode="numeric" value={f.capacity} onChange={(e) => set("capacity", e.target.value.replace(/\D/g, ""))} maxLength={4} />}</Field>
          <Switch checked={f.waitlist} onChange={(v) => set("waitlist", v)} label="Waitlist when full" />
        </div>
        <Field label="About (optional)">{(p) => <Textarea {...p} rows={4} value={f.description} onChange={(e) => set("description", e.target.value)} maxLength={5000} />}</Field>
        <p className="text-[13px] text-subtle">Tickets are free. Paid tickets are not available yet.</p>
        {error && <p role="alert" className="text-[14px] text-bad">{error}</p>}
      </form>
    </Dialog>
  );
}

function EventDialog({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (e: EventRow) => void }) {
  const qc = useQueryClient();
  const { confirm, dialogs } = useDialogs();
  const q = useQuery({ queryKey: ["booking", "event", id], queryFn: () => api.get<{ event: EventRow; tickets: Ticket[] }>(`/booking/events/${id}`) });
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState("");
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["booking", "event", id] }); void qc.invalidateQueries({ queryKey: ["booking", "events"] }); };
  const e = q.data?.event;
  const cancelEvent = async () => {
    if (!e || !(await confirm({ title: "Cancel this event?", description: "Everyone going or waiting gets an email, and tickets stop working.", confirmLabel: "Cancel event", tone: "danger" }))) return;
    try { const r = await api.post<{ mailed: number }>(`/booking/events/${id}/cancel`); toast.success(`Event cancelled. ${r.mailed} ${r.mailed === 1 ? "person" : "people"} emailed.`); refresh(); } catch (err) { showError(err as Error); }
  };
  const remove = async () => {
    if (!e || !(await confirm({ title: "Delete this event?", description: "Its page and its list are deleted.", confirmLabel: "Delete event", tone: "danger" }))) return;
    try { await api.del(`/booking/events/${id}`); refresh(); onClose(); } catch (err) { showError(err as Error); }
  };
  const tickets = (q.data?.tickets ?? []).filter((t) => !filter || `${t.name} ${t.email}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Dialog open onClose={onClose} title={e?.title ?? "Event"} className="sm:max-w-3xl"
      footer={e && <div className="flex w-full flex-wrap items-center gap-2">
        {e.status !== "cancelled" && <Button variant="ghost" onClick={() => onEdit(e)}><IconEdit className="h-4 w-4" />Edit</Button>}
        {e.status === "published" && <Button variant="ghost" onClick={cancelEvent}>Cancel event</Button>}
        {e.status !== "published" && <Button variant="ghost" onClick={remove}>Delete</Button>}
        <span className="flex-1" />
        <a className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-[14px] font-medium text-fg hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" href={`/api/booking/events/${id}/attendees.csv`} download><IconDownload className="h-4 w-4" />Export CSV</a>
        {e.status === "published" && <Button onClick={() => setScanning(true)}><IconCamera className="h-4 w-4" />Check in</Button>}
      </div>}>
      {dialogs}
      {!e ? <Skeleton className="h-56" /> : (
        <div className="space-y-4" data-testid="event-detail">
          <div className="flex flex-wrap items-center gap-2 text-[14px] text-muted">
            <Badge tone={STATUS[e.status][1]}>{STATUS[e.status][0]}</Badge>
            <span>{dayLabel(e.startsAt)}, {timeLabel(e.startsAt)} to {timeLabel(e.endsAt)}</span>
            {e.status !== "draft" && <span className="ml-auto flex items-center gap-1"><CopyButton value={e.url} label="Copy link" toastText="Event link copied" /><a href={e.url} target="_blank" rel="noreferrer" className="inline-flex h-9 w-9 items-center justify-center rounded-lg hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" aria-label="Open the event page"><IconExternalLink className="h-4 w-4" /></a></span>}
          </div>
          {e.status === "draft" && <p className="rounded-lg bg-fill px-3 py-2 text-[14px] text-muted">This is a draft. Publish it to open its page.</p>}
          <div className="grid grid-cols-3 gap-3">
            <StatTile label="Going" value={e.capacity != null ? `${e.going} of ${e.capacity}` : e.going} />
            <StatTile label="Waitlist" value={e.waiting} />
            <StatTile label="Checked in" value={e.checkedIn} />
          </div>
          {q.data!.tickets.length === 0 ? <p className="text-[14px] text-muted">Nobody has a ticket yet.</p> : (
            <div className="space-y-2">
              <Input aria-label="Find a person" placeholder="Find a person" value={filter} onChange={(x) => setFilter(x.target.value)} />
              <ul className="max-h-[360px] divide-y divide-line overflow-y-auto rounded-lg border border-line">
                {tickets.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-medium" title={t.name}>{t.name}</p><p className="truncate text-[13px] text-subtle" title={t.email}>{t.email}</p></div>
                    <Badge tone={t.checkedInAt ? "brand" : t.status === "going" ? "ok" : t.status === "waitlist" ? "warn" : "neutral"}>{t.checkedInAt ? "Checked in" : t.status === "going" ? "Going" : t.status === "waitlist" ? "Waitlist" : "Cancelled"}</Badge>
                  </li>
                ))}
                {!tickets.length && <li className="px-3 py-3 text-[14px] text-muted">No one matches.</li>}
              </ul>
            </div>
          )}
        </div>
      )}
      {scanning && e && <Scanner eventId={id} title={e.title} onClose={() => { setScanning(false); refresh(); }} />}
    </Dialog>
  );
}

type ScanResult = { result: "ok" | "already" | "unknown" | "cancelled" | "waitlist" | "undone"; ticket?: Ticket };
const RESULT: Record<ScanResult["result"], [string, string]> = {
  ok: ["Checked in", "border-ok/40 bg-ok-soft"], already: ["Already checked in", "border-warn/40 bg-warn-soft"], unknown: ["Ticket not found", "border-bad/40 bg-bad-soft"],
  cancelled: ["This ticket was cancelled", "border-bad/40 bg-bad-soft"], waitlist: ["On the waitlist, not a ticket yet", "border-warn/40 bg-warn-soft"], undone: ["Check in undone", "border-line bg-fill"],
};

/** Door check in. Reads QR codes with the camera where the browser can (BarcodeDetector), and always takes a typed code. */
function Scanner({ eventId, title, onClose }: { eventId: string; title: string; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState<"off" | "on" | "unsupported" | "denied">("off");
  const [code, setCode] = useState("");
  const [last, setLast] = useState<(ScanResult & { code: string }) | null>(null);
  const busy = useRef(false);
  const seen = useRef<{ code: string; at: number } | null>(null);
  const supported = typeof window !== "undefined" && "BarcodeDetector" in window;

  const check = async (raw: string, undo = false) => {
    const s = readScan(raw);
    if (!s) { setLast({ result: "unknown", code: raw }); return; }
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await api.post<ScanResult>(`/booking/events/${eventId}/check-in`, { code: s.code, ticketId: s.ticketId, undo });
      setLast({ ...r, code: s.code });
      if (navigator.vibrate) navigator.vibrate(r.result === "ok" ? 60 : [40, 60, 40]);
    } catch (e) { showError(e as Error); } finally { busy.current = false; }
  };

  useEffect(() => {
    if (camera !== "on") return;
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const Detector = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
        const det = new Detector({ formats: ["qr_code"] });
        while (!stop) {
          const found = await det.detect(video.current).catch(() => []);
          const raw = found[0]?.rawValue;
          if (raw && !(seen.current && seen.current.code === raw && Date.now() - seen.current.at < 4000)) {
            seen.current = { code: raw, at: Date.now() };
            await check(raw);
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch { setCamera("denied"); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [camera]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open onClose={onClose} title="Check in" description={title}>
      <div className="space-y-4" data-testid="scanner">
        {camera === "on" ? (
          <video ref={video} className="aspect-square w-full rounded-xl bg-black object-cover" muted playsInline aria-label="Camera view" />
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong p-6 text-center">
            <IconCamera className="h-8 w-8 text-subtle" />
            {supported ? <Button onClick={() => setCamera("on")}>Scan with the camera</Button> : <p className="text-[14px] text-muted">This browser can't read QR codes with the camera. Type the ticket code below.</p>}
            {camera === "denied" && <p className="text-[13px] text-bad">The camera is blocked. Allow it in the browser, or type the code.</p>}
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); void check(code); setCode(""); }} className="flex gap-2">
          <Input aria-label="Ticket code" placeholder="Ticket code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" className="font-mono tracking-widest" maxLength={12} />
          <Button type="submit" variant="secondary" disabled={!code.trim()}>Check</Button>
        </form>
        {last && (
          <div role="status" aria-live="polite" className={cn("flex items-center gap-3 rounded-xl border p-4", RESULT[last.result][1])}>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold">{RESULT[last.result][0]}</p>
              <p className="truncate text-[13px] text-muted">{last.ticket ? `${last.ticket.name} · ${formatTicketCode(last.code)}` : formatTicketCode(last.code)}</p>
            </div>
            {(last.result === "ok" || last.result === "already") && <Button size="sm" variant="ghost" onClick={() => check(last.code, true)}><IconUndo className="h-4 w-4" />Undo</Button>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
