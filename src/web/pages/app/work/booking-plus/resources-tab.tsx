/**
 * R92: Resources tab. Rooms, desks, vehicles and equipment on a day grid (a card list on phones), booking with the
 * resource's rules, approvals for admins, and check in from the QR code printed at each resource.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconArrowLeft, IconArrowRight, IconBuilding, IconCheckCircle, IconEdit, IconPlus } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { useMe } from "@/web/lib/queries";
import { QrCode } from "@/web/components/qr";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { useDialogs } from "@/web/components/ui/confirm";
import { DateInput, Field, Input, Select, TimeInput } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { RESOURCE_KINDS, RESOURCE_KIND_LABEL, WEEK_DAYS, durationLabel, type ResourceKind, type WeekDay } from "@/shared/booking-plus";
import { Section, ZONES, dayLabel, timeLabel, whenLabel, ymd, zone } from "./common";
import { LoadError } from "@/web/components/load-error-t1g";

interface Resource {
  id: string; name: string; kind: ResourceKind; location: string; description: string; capacity: number | null; timezone: string; days: WeekDay[]; openFrom: string; openTo: string;
  stepMin: number; minMin: number; maxMin: number; quotaMinWeek: number | null; needsApproval: boolean; checkinRequired: boolean; releaseAfterMin: number; archived: boolean;
  checkinUrl: string | null;
}
type GridResource = Resource & { open: { from: string; to: string } | null };
interface RBooking { id: string; resourceId: string; userId: string; userName: string; title: string; startsAt: string; endsAt: string; status: "pending" | "confirmed" | "declined" | "cancelled" | "released"; checkedInAt: string | null; mine: boolean }
interface Grid { date: string; resources: GridResource[]; bookings: RBooking[] }
const DAY_LABEL: Record<WeekDay, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const PX_PER_MIN = 1.6;

function freeStarts(r: GridResource, bookings: RBooking[], now = Date.now()) {
  if (!r.open) return [];
  const out: number[] = [];
  const from = Date.parse(r.open.from), to = Date.parse(r.open.to), step = r.stepMin * 60_000, min = r.minMin * 60_000;
  const busy = bookings.filter((b) => b.resourceId === r.id).map((b) => [Date.parse(b.startsAt), Date.parse(b.endsAt)]);
  for (let t = from; t + min <= to; t += step) {
    if (t + step <= now) continue;
    if (!busy.some(([s, e]) => t < e && s < t + min)) out.push(t);
  }
  return out;
}

export function ResourcesTab() {
  const qc = useQueryClient();
  const me = useMe();
  const isAdmin = me.data?.organization?.role !== "member";
  const [params, setParams] = useSearchParams();
  const [date, setDate] = useState(ymd(new Date()));
  const grid = useQuery({ queryKey: ["booking", "grid", date], queryFn: () => api.get<Grid>(`/booking/grid?date=${date}`) });
  const inbox = useQuery({ queryKey: ["booking", "inbox"], queryFn: () => api.get<{ mine: RBooking[]; pending: RBooking[] }>("/booking/inbox") });
  const [booking, setBooking] = useState<{ resource: GridResource; start: number } | null>(null);
  const [editing, setEditing] = useState<Resource | "new" | null>(null);
  const [printing, setPrinting] = useState<Resource | null>(null);
  const [checkin, setCheckin] = useState<{ checkedIn: boolean; resource: Resource; booking?: RBooking } | null>(null);
  const { confirm, dialogs } = useDialogs();
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["booking", "grid"] }); void qc.invalidateQueries({ queryKey: ["booking", "inbox"] }); };
  const names = useMemo(() => Object.fromEntries((grid.data?.resources ?? []).map((r) => [r.id, r.name])), [grid.data]);

  // Scanning the QR at a resource lands here with ?checkin=<id>&k=<key>.
  const checkinId = params.get("checkin"), key = params.get("k");
  useEffect(() => {
    if (!checkinId || !key) return;
    api.post<{ checkedIn: boolean; resource: Resource; booking?: RBooking }>(`/booking/resources/${checkinId}/check-in`, { key })
      .then((r) => { setCheckin(r); refresh(); })
      .catch((e) => showError(e as Error))
      .finally(() => setParams((p) => { const n = new URLSearchParams(p); n.delete("checkin"); n.delete("k"); return n; }, { replace: true }));
  }, [checkinId, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const shift = (days: number) => { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() + days); setDate(ymd(d)); };
  const cancel = async (b: RBooking) => {
    if (!(await confirm({ title: "Cancel this booking?", description: `${names[b.resourceId] ?? "Resource"}, ${whenLabel(b.startsAt)}`, confirmLabel: "Cancel booking", tone: "danger" }))) return;
    try { await api.post(`/booking/resource-bookings/${b.id}/cancel`); toast.success("Booking cancelled"); refresh(); } catch (e) { showError(e as Error); }
  };
  const decide = async (b: RBooking, approve: boolean) => {
    try { await api.post(`/booking/resource-bookings/${b.id}/decide`, { approve }); toast.success(approve ? "Approved" : "Declined"); refresh(); } catch (e) { showError(e as Error); }
  };

  const g = grid.data;
  // The next day any resource opens, so a closed day (a weekend) is one click from a bookable one.
  const nextOpen = useMemo(() => {
    const open = new Set((g?.resources ?? []).flatMap((r) => r.days));
    if (!open.size) return null;
    const keys: WeekDay[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const d = new Date(`${date}T00:00:00`);
    for (let i = 0; i < 7; i++) { d.setDate(d.getDate() + 1); if (open.has(keys[d.getDay()])) return ymd(d); }
    return null;
  }, [g, date]);
  const opens = (g?.resources ?? []).filter((r) => r.open);
  const windowFrom = opens.length ? Math.min(...opens.map((r) => Date.parse(r.open!.from))) : 0;
  const windowTo = opens.length ? Math.max(...opens.map((r) => Date.parse(r.open!.to))) : 0;
  const hasOpen = windowTo > windowFrom;
  const width = hasOpen ? ((windowTo - windowFrom) / 60_000) * PX_PER_MIN : 0;
  const hours: number[] = [];
  if (hasOpen) for (let t = Math.ceil(windowFrom / 3600_000) * 3600_000; t < windowTo; t += 3600_000) hours.push(t);
  const x = (t: number) => ((t - windowFrom) / 60_000) * PX_PER_MIN;

  return (
    <div className="space-y-6" data-testid="resources-tab">
      {dialogs}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Previous day" onClick={() => shift(-1)}><IconArrowLeft className="h-4 w-4" /></Button>
          <DateInput aria-label="Day" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-44" />
          <Button variant="ghost" size="icon" aria-label="Next day" onClick={() => shift(1)}><IconArrowRight className="h-4 w-4" /></Button>
          <Button variant="secondary" size="sm" onClick={() => setDate(ymd(new Date()))}>Today</Button>
        </div>
        <span className="flex-1" />
        {isAdmin && <Button onClick={() => setEditing("new")}><IconPlus className="h-4 w-4" />Add resource</Button>}
      </div>

      {grid.isPending ? <Skeleton className="h-56" />
        : grid.isError || !g ? <Card><LoadError onRetry={() => grid.refetch()} /></Card>
          : !g.resources.length ? (
            <Card><EmptyState icon={<IconBuilding />} title="No resources yet" body={isAdmin ? "Add rooms, desks, vehicles or equipment, set when they can be booked, and your team books them here." : "Your admins have not added any rooms, desks, vehicles or equipment yet."} action={isAdmin ? <Button onClick={() => setEditing("new")}>Add resource</Button> : undefined} /></Card>
          ) : (
            <>
              {/* Wider screens: a day grid that scrolls inside its card. Phones: one card per resource with free start times. */}
              <Card className="hidden overflow-hidden p-0 md:block" data-testid="resource-grid">
                {!hasOpen ? (
                  <div className="flex flex-wrap items-center gap-3 p-6">
                    <p className="text-[14px] text-muted">Everything is closed on {dayLabel(`${date}T12:00:00`)}.</p>
                    {nextOpen && <Button size="sm" variant="secondary" onClick={() => setDate(nextOpen)}>Go to {dayLabel(`${nextOpen}T12:00:00`)}</Button>}
                  </div>
                ) : (
                  <div className="flex">
                    <div className="w-52 shrink-0 border-r border-line">
                      <div className="h-9 border-b border-line" />
                      {g.resources.map((r) => (
                        <div key={r.id} className="flex h-14 items-center gap-2 border-b border-line px-3 last:border-b-0">
                          <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-medium" title={r.name}>{r.name}</p><p className="truncate text-[12px] text-subtle">{RESOURCE_KIND_LABEL[r.kind]}{r.capacity ? ` · ${r.capacity} seats` : ""}{r.location ? ` · ${r.location}` : ""}</p></div>
                          {isAdmin && <Button variant="ghost" size="icon" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><IconEdit className="h-4 w-4" /></Button>}
                        </div>
                      ))}
                    </div>
                    <div className="min-w-0 flex-1 overflow-x-auto">
                      <div style={{ width }} className="relative">
                        <div className="relative h-9 border-b border-line">
                          {hours.map((h) => <span key={h} className="absolute top-2 -translate-x-1/2 whitespace-nowrap text-[12px] text-subtle" style={{ left: Math.max(18, x(h)) }}>{timeLabel(new Date(h))}</span>)}
                        </div>
                        {g.resources.map((r) => {
                          const starts = freeStarts(r, g.bookings);
                          return (
                            <div key={r.id} className="relative h-14 border-b border-line last:border-b-0">
                              {hours.map((h) => <span key={h} className="absolute inset-y-0 w-px bg-line" style={{ left: x(h) }} aria-hidden />)}
                              {!r.open && <div className="absolute inset-0 flex items-center px-3 text-[13px] text-subtle">Closed</div>}
                              {starts.map((t) => (
                                <button key={t} type="button" aria-label={`Book ${r.name} at ${timeLabel(new Date(t))}`} onClick={() => setBooking({ resource: r, start: t })}
                                  className="group absolute inset-y-1 rounded-md outline-none transition-colors duration-150 hover:bg-brand-soft focus-visible:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand"
                                  style={{ left: x(t) + 1, width: r.stepMin * PX_PER_MIN - 2 }}>
                                  <IconPlus className="mx-auto hidden h-3.5 w-3.5 text-brand group-hover:block group-focus-visible:block" />
                                </button>
                              ))}
                              {g.bookings.filter((b) => b.resourceId === r.id).map((b) => (
                                <div key={b.id} title={`${b.userName}${b.title ? `: ${b.title}` : ""}, ${timeLabel(b.startsAt)} to ${timeLabel(b.endsAt)}`}
                                  className={cn("absolute inset-y-1 overflow-hidden rounded-md border px-2 py-1 text-[12px] leading-4", b.mine ? "border-brand/40 bg-brand-soft text-fg" : "border-line-strong bg-fill text-fg", b.status === "pending" && "border-dashed")}
                                  style={{ left: x(Date.parse(b.startsAt)) + 1, width: Math.max(24, x(Date.parse(b.endsAt)) - x(Date.parse(b.startsAt)) - 2) }}>
                                  <p className="truncate font-medium">{b.mine ? "You" : b.userName}{b.title ? `: ${b.title}` : ""}</p>
                                  <p className="truncate text-muted">{b.status === "pending" ? "Waiting for approval" : b.checkedInAt ? "Checked in" : `${timeLabel(b.startsAt)} to ${timeLabel(b.endsAt)}`}</p>
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </Card>
              <div className="space-y-3 md:hidden" data-testid="resource-cards">
                {!hasOpen && nextOpen && (
                  <div className="flex flex-wrap items-center gap-2 text-[14px] text-muted">
                    <span>Everything is closed on {dayLabel(`${date}T12:00:00`)}.</span>
                    <Button size="sm" variant="secondary" onClick={() => setDate(nextOpen)}>Go to {dayLabel(`${nextOpen}T12:00:00`)}</Button>
                  </div>
                )}
                {g.resources.map((r) => {
                  const starts = freeStarts(r, g.bookings);
                  const taken = g.bookings.filter((b) => b.resourceId === r.id);
                  return (
                    <Card key={r.id} className="space-y-3 p-4">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1"><p className="truncate text-[15px] font-semibold">{r.name}</p><p className="truncate text-[13px] text-subtle">{RESOURCE_KIND_LABEL[r.kind]}{r.open ? ` · open ${timeLabel(r.open.from)} to ${timeLabel(r.open.to)}` : " · closed this day"}</p></div>
                        {isAdmin && <Button variant="ghost" size="icon" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><IconEdit className="h-4 w-4" /></Button>}
                      </div>
                      {r.open && (starts.length ? (
                        <div className="flex flex-wrap gap-2">
                          {starts.slice(0, 12).map((t) => <button key={t} type="button" onClick={() => setBooking({ resource: r, start: t })} className="min-h-11 rounded-lg border border-line bg-surface px-3 text-[14px] font-medium outline-none transition-colors duration-150 hover:border-brand focus-visible:ring-2 focus-visible:ring-brand">{timeLabel(new Date(t))}</button>)}
                          {starts.length > 12 && <span className="self-center text-[13px] text-subtle">and {starts.length - 12} more</span>}
                        </div>
                      ) : <p className="text-[14px] text-muted">Fully booked.</p>)}
                      {taken.length > 0 && <ul className="space-y-1 text-[13px] text-muted">{taken.map((b) => <li key={b.id} className="truncate">{timeLabel(b.startsAt)} to {timeLabel(b.endsAt)} · {b.mine ? "You" : b.userName}{b.status === "pending" ? " (waiting)" : ""}</li>)}</ul>}
                    </Card>
                  );
                })}
              </div>
            </>
          )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="My bookings">
          {inbox.isPending ? <Skeleton className="h-24" /> : !inbox.data?.mine.length ? <p className="text-[14px] text-muted">Nothing booked. Pick a free time above.</p> : (
            <Card className="divide-y divide-line p-0">
              {inbox.data.mine.map((b) => (
                <div key={b.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-medium">{names[b.resourceId] ?? "Resource"}{b.title ? `: ${b.title}` : ""}</p><p className="text-[13px] text-subtle">{whenLabel(b.startsAt)} to {timeLabel(b.endsAt)}</p></div>
                  {b.status === "pending" ? <Badge tone="warn">Waiting</Badge> : b.checkedInAt ? <Badge tone="ok">Checked in</Badge> : null}
                  <Button variant="ghost" size="sm" onClick={() => cancel(b)}>Cancel</Button>
                </div>
              ))}
            </Card>
          )}
        </Section>
        {isAdmin && (
          <Section title="Waiting for approval">
            {!inbox.data?.pending.length ? <p className="text-[14px] text-muted">No requests waiting.</p> : (
              <Card className="divide-y divide-line p-0" data-testid="approvals">
                {inbox.data.pending.map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-medium">{b.userName} · {names[b.resourceId] ?? "Resource"}</p><p className="text-[13px] text-subtle">{whenLabel(b.startsAt)} to {timeLabel(b.endsAt)}{b.title ? ` · ${b.title}` : ""}</p></div>
                    <Button size="sm" variant="ghost" onClick={() => decide(b, false)}>Decline</Button>
                    <Button size="sm" onClick={() => decide(b, true)}>Approve</Button>
                  </div>
                ))}
              </Card>
            )}
          </Section>
        )}
      </div>

      {booking && <BookDialog resource={booking.resource} start={booking.start} bookings={g?.bookings ?? []} onClose={() => setBooking(null)} onDone={() => { setBooking(null); refresh(); }} />}
      {editing && <ResourceEditor resource={editing === "new" ? null : editing} onClose={() => setEditing(null)} onPrint={(r) => { setEditing(null); setPrinting(r); }} onSaved={() => { setEditing(null); refresh(); }} />}
      {printing?.checkinUrl && (
        <Dialog open onClose={() => setPrinting(null)} title={`Check in code for ${printing.name}`} footer={<><Button variant="ghost" onClick={() => setPrinting(null)}>Close</Button><Button onClick={() => window.print()}>Print</Button></>}>
          <div className="flex flex-col items-center gap-3 text-center">
            <QrCode value={printing.checkinUrl} size={240} label={`Check in QR code for ${printing.name}`} />
            <p className="text-[18px] font-semibold">{printing.name}</p>
            <p className="max-w-sm text-[14px] text-muted">Scan with your phone camera to check in to your booking.{printing.checkinRequired ? ` Bookings not checked in within ${printing.releaseAfterMin} minutes are released.` : ""}</p>
          </div>
        </Dialog>
      )}
      {checkin && (
        <Dialog open onClose={() => setCheckin(null)} title={checkin.checkedIn ? "You're checked in" : "No booking right now"} footer={<Button onClick={() => setCheckin(null)}>Done</Button>}>
          <div className="flex items-start gap-3" data-testid="checkin-result">
            {checkin.checkedIn && <IconCheckCircle className="h-6 w-6 shrink-0 text-ok" />}
            <p className="text-[15px]">{checkin.checkedIn && checkin.booking ? `${checkin.resource.name}, ${timeLabel(checkin.booking.startsAt)} to ${timeLabel(checkin.booking.endsAt)}.` : `You have no booking on ${checkin.resource.name} now. Pick a free time on the grid to book it.`}</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function BookDialog({ resource: r, start, bookings, onClose, onDone }: { resource: GridResource; start: number; bookings: RBooking[]; onClose: () => void; onDone: () => void }) {
  const close = r.open ? Date.parse(r.open.to) : start;
  const nextBusy = Math.min(close, ...bookings.filter((b) => b.resourceId === r.id && Date.parse(b.startsAt) >= start).map((b) => Date.parse(b.startsAt)));
  const lengths: number[] = [];
  for (let m = r.minMin; m <= r.maxMin && start + m * 60_000 <= nextBusy; m += r.stepMin) lengths.push(m);
  const [len, setLen] = useState(lengths[0] ?? r.minMin);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api.post<{ booking: RBooking }>("/booking/resource-bookings", { resourceId: r.id, startsAt: new Date(start).toISOString(), endsAt: new Date(start + len * 60_000).toISOString(), title });
      toast.success(res.booking.status === "pending" ? "Request sent. An admin will approve it." : `${r.name} is booked`);
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={`Book ${r.name}`} description={`${dayLabel(new Date(start))}, from ${timeLabel(new Date(start))}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="book-resource" disabled={busy || !lengths.length}>{r.needsApproval ? "Ask to book" : "Book"}</Button></>}>
      <form id="book-resource" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="How long">{(p) => <Select {...p} value={len} onChange={(e) => setLen(Number(e.target.value))}>{lengths.map((m) => <option key={m} value={m}>{durationLabel(m)}, until {timeLabel(new Date(start + m * 60_000))}</option>)}</Select>}</Field>
        <Field label="What for (optional)">{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Client call" data-autofocus />}</Field>
        <ul className="space-y-1 text-[13px] text-subtle">
          {r.needsApproval && <li>An admin approves bookings for this.</li>}
          {r.quotaMinWeek != null && <li>Up to {durationLabel(r.quotaMinWeek)} a week each.</li>}
          {r.checkinRequired && <li>Check in with the QR code there within {r.releaseAfterMin} minutes of the start, or the booking is released.</li>}
        </ul>
        {error && <p role="alert" className="text-[14px] text-bad">{error}</p>}
      </form>
    </Dialog>
  );
}

function ResourceEditor({ resource, onClose, onSaved, onPrint }: { resource: Resource | null; onClose: () => void; onSaved: () => void; onPrint: (r: Resource) => void }) {
  const { confirm, dialogs } = useDialogs();
  const [f, setF] = useState({
    name: resource?.name ?? "", kind: resource?.kind ?? ("room" as ResourceKind), location: resource?.location ?? "", capacity: resource?.capacity ? String(resource.capacity) : "",
    timezone: resource?.timezone ?? zone(), days: resource?.days ?? (["mon", "tue", "wed", "thu", "fri"] as WeekDay[]), openFrom: resource?.openFrom ?? "08:00", openTo: resource?.openTo ?? "18:00",
    stepMin: resource?.stepMin ?? 30, minMin: resource?.minMin ?? 30, maxMin: resource?.maxMin ?? 240, quota: resource?.quotaMinWeek ? String(resource.quotaMinWeek / 60) : "",
    needsApproval: resource?.needsApproval ?? false, checkinRequired: resource?.checkinRequired ?? false, releaseAfterMin: resource?.releaseAfterMin ?? 15,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const lengths = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440].filter((m) => m % f.stepMin === 0);
  const save = async (extra: Record<string, unknown> = {}) => {
    setError(null);
    if (!f.name.trim()) return setError("Give the resource a name.");
    setBusy(true);
    try {
      const body = { name: f.name, kind: f.kind, location: f.location, capacity: f.capacity ? Number(f.capacity) : null, timezone: f.timezone, days: f.days, openFrom: f.openFrom, openTo: f.openTo,
        stepMin: f.stepMin, minMin: f.minMin, maxMin: f.maxMin, quotaMinWeek: f.quota ? Math.round(Number(f.quota) * 60) : null, needsApproval: f.needsApproval, checkinRequired: f.checkinRequired, releaseAfterMin: f.releaseAfterMin, ...extra };
      if (resource) await api.patch(`/booking/resources/${resource.id}`, body); else await api.post("/booking/resources", body);
      toast.success(extra.archived ? "Resource archived" : "Resource saved");
      onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const archive = async () => {
    if (await confirm({ title: `Archive ${resource?.name}?`, description: "It leaves the grid. Bookings already made stay as they are.", confirmLabel: "Archive", tone: "danger" })) void save({ archived: true });
  };
  return (
    <Dialog open onClose={onClose} title={resource ? `Edit ${resource.name}` : "Add resource"}
      footer={<div className="flex w-full flex-wrap gap-2">{resource && <Button variant="ghost" onClick={archive}>Archive</Button>}{resource?.checkinUrl && <Button variant="ghost" onClick={() => onPrint(resource)}>Check in code</Button>}<span className="flex-1" /><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="resource-form" disabled={busy}>Save</Button></div>}>
      {dialogs}
      <form id="resource-form" onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <Field label="Name">{(p) => <Input {...p} value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={80} placeholder="Board room" data-autofocus />}</Field>
          <Field label="Kind">{(p) => <Select {...p} value={f.kind} onChange={(e) => set("kind", e.target.value as ResourceKind)}>{RESOURCE_KINDS.map((k) => <option key={k} value={k}>{RESOURCE_KIND_LABEL[k]}</option>)}</Select>}</Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
          <Field label="Where (optional)">{(p) => <Input {...p} value={f.location} onChange={(e) => set("location", e.target.value)} maxLength={120} placeholder="Level 2" />}</Field>
          <Field label="Seats (optional)">{(p) => <Input {...p} inputMode="numeric" value={f.capacity} onChange={(e) => set("capacity", e.target.value.replace(/\D/g, ""))} maxLength={5} />}</Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-muted">Open days</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEK_DAYS.map((d) => {
              const on = f.days.includes(d);
              return <button key={d} type="button" aria-pressed={on} onClick={() => set("days", on ? f.days.filter((x) => x !== d) : [...f.days, d])}
                className={cn("min-h-11 min-w-12 rounded-lg border px-2 text-[13px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-brand sm:min-h-9", on ? "border-brand bg-brand-soft text-fg" : "border-line text-muted hover:text-fg")}>{DAY_LABEL[d]}</button>;
            })}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Opens">{(p) => <TimeInput {...p} value={f.openFrom} onChange={(e) => set("openFrom", e.target.value)} />}</Field>
          <Field label="Closes">{(p) => <TimeInput {...p} value={f.openTo} onChange={(e) => set("openTo", e.target.value)} />}</Field>
          <Field label="Steps">{(p) => <Select {...p} value={f.stepMin} onChange={(e) => { const s = Number(e.target.value); setF({ ...f, stepMin: s, minMin: Math.max(s, Math.ceil(f.minMin / s) * s), maxMin: Math.max(s, Math.ceil(f.maxMin / s) * s) }); }}>{[15, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}</Select>}</Field>
          <Field label="Time zone">{(p) => <Select {...p} value={f.timezone} onChange={(e) => set("timezone", e.target.value)}>{ZONES.map((z) => <option key={z} value={z}>{z}</option>)}</Select>}</Field>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Shortest">{(p) => <Select {...p} value={f.minMin} onChange={(e) => set("minMin", Number(e.target.value))}>{lengths.map((m) => <option key={m} value={m}>{durationLabel(m)}</option>)}</Select>}</Field>
          <Field label="Longest">{(p) => <Select {...p} value={f.maxMin} onChange={(e) => set("maxMin", Number(e.target.value))}>{lengths.map((m) => <option key={m} value={m}>{durationLabel(m)}</option>)}</Select>}</Field>
          <Field label="Hours a week each" hint="Empty means no limit.">{(p) => <Input {...p} inputMode="decimal" value={f.quota} onChange={(e) => set("quota", e.target.value.replace(/[^\d.]/g, ""))} maxLength={5} />}</Field>
        </div>
        <Switch checked={f.needsApproval} onChange={(v) => set("needsApproval", v)} label="Admins approve each booking" />
        <Switch checked={f.checkinRequired} onChange={(v) => set("checkinRequired", v)} label="People check in with the QR code" />
        {f.checkinRequired && <Field label="Release a booking with no check in after">{(p) => <Select {...p} value={f.releaseAfterMin} onChange={(e) => set("releaseAfterMin", Number(e.target.value))}>{[5, 10, 15, 20, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}</Select>}</Field>}
        {error && <p role="alert" className="text-[14px] text-bad">{error}</p>}
      </form>
    </Dialog>
  );
}
