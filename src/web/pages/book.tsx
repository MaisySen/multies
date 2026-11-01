/** The public booking page (/book/:slug) and the guest's cancel page. Works on phones, light and dark. */
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { IconMapPin, IconCalendarX, IconClock, IconDue, IconVideo } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { Logo } from "@/web/components/logo";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Textarea } from "@/web/components/ui/input";
import { Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { directionsLinks } from "@/shared/maps-r115"; // R115

interface PublicPage { page: { slug: string; title: string; description: string; timezone: string; slotMin: number; video: boolean; host: string; organization: string; location?: { address: string; lat: number | null; lon: number | null } }; slots: string[] }
interface Booked { booking: { id: string; startsAt: string; durationMin: number; guestUrl: string | null; status: string }; cancelUrl: string; icsUrl: string }

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const dayKey = (s: string) => new Date(s).toLocaleDateString("en-CA");
const dayLabel = (s: string) => new Date(s).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const timeLabel = (s: string) => new Date(s).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const full = (s: string) => new Date(s).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-bg px-4 py-8 text-fg sm:py-12">
      <div className="mx-auto max-w-2xl">{children}</div>
      <div className="mt-8 flex items-center justify-center gap-2 text-[12px] text-subtle">Scheduling by <Logo className="h-4" /></div>
    </main>
  );
}

export function BookingPage() {
  const { slug = "" } = useParams();
  const q = useQuery({ queryKey: ["book", slug], queryFn: () => api.get<PublicPage>(`/book/${encodeURIComponent(slug)}?days=21`), retry: false });
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Booked | null>(null);
  const days = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of q.data?.slots ?? []) m.set(dayKey(s), [...(m.get(dayKey(s)) ?? []), s]);
    return [...m.entries()];
  }, [q.data]);
  const current = day ?? days[0]?.[0] ?? null;

  if (q.isLoading) return <Shell><Skeleton className="h-80" /></Shell>;
  if (q.isError || !q.data) {
    return <Shell><Card><EmptyState icon={<IconCalendarX />} title="This booking page isn't available" body="The link may be wrong, or the page is paused. Check with the person who sent it." /></Card></Shell>;
  }
  const p = q.data.page;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!slot) return;
    setBusy(true); setError(null);
    try {
      setDone(await api.post<Booked>(`/book/${encodeURIComponent(slug)}`, { startsAt: slot, name: form.name, email: form.email, note: form.note || undefined, timezone: zone() }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      if (err instanceof ApiError && err.status === 409) { setSlot(null); q.refetch(); }
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <Shell>
        <Card className="p-6 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-ok-soft text-ok" aria-hidden><IconDue className="h-5 w-5" /></div>
          <h1 className="text-xl font-semibold">You're booked</h1>
          <p className="mt-2 text-sm text-muted">{p.title} with {p.host}</p>
          <p className="mt-1 text-[15px] font-medium" data-testid="booked-time">{full(done.booking.startsAt)}</p>
          <p className="mt-3 text-[13px] text-muted">A confirmation is on its way to {form.email}.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <a href={done.icsUrl} className="inline-flex h-11 items-center rounded-lg bg-brand px-4 text-sm font-medium text-white">Add to calendar</a>
            {done.booking.guestUrl && <a href={done.booking.guestUrl} className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-line px-4 text-sm"><IconVideo className="h-4 w-4" aria-hidden />Video link</a>}
          </div>
          <p className="mt-5 text-[12.5px] text-muted">Can't make it? <a href={done.cancelUrl} className="text-brand underline">Cancel this booking</a></p>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-6">
        <p className="text-[13px] text-muted">{p.host}{p.organization ? ` · ${p.organization}` : ""}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{p.title}</h1>
        {p.description && <p className="mt-2 text-sm leading-relaxed text-muted">{p.description}</p>}
        <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
          <span className="inline-flex items-center gap-1.5"><IconClock className="h-4 w-4" aria-hidden />{p.slotMin} minutes</span>
          {p.video && <span className="inline-flex items-center gap-1.5"><IconVideo className="h-4 w-4" aria-hidden />Video call, no app needed</span>}
          <span>Times in {zone().replace(/_/g, " ")}</span>
        </p>
        {p.location && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]" data-testid="book-location">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-fg"><IconMapPin className="h-4 w-4 shrink-0 text-muted" aria-hidden /><span className="break-words">{p.location.address}</span></span>
            <a href={directionsLinks(p.location).google} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-fg underline decoration-brand underline-offset-2 hover:text-brand sm:min-h-0">Get directions</a>
            <a href={directionsLinks(p.location).apple} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-fg underline decoration-brand underline-offset-2 hover:text-brand sm:min-h-0">Apple Maps</a>
          </div>
        )}
      </header>

      {!days.length ? (
        <Card><EmptyState icon={<IconCalendarX />} title="No free times right now" body="Check back later, or reply to the person who sent you this link." /></Card>
      ) : (
        <Card className="p-4">
          <h2 className="mb-3 text-[15px] font-semibold">Pick a day</h2>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
            {days.map(([k, list]) => (
              <button key={k} type="button" aria-pressed={k === current} onClick={() => { setDay(k); setSlot(null); }}
                className={cn("min-h-11 shrink-0 rounded-xl border px-3 py-2 text-left text-sm transition-colors", k === current ? "border-brand bg-brand/10 text-fg ring-1 ring-brand" : "border-line hover:bg-hover")}>
                <span className="block font-medium">{dayLabel(list[0])}</span>
                <span className="block text-[12px] text-muted">{list.length === 1 ? "1 time" : `${list.length} times`}</span>
              </button>
            ))}
          </div>
          <h2 className="mb-3 mt-4 text-[15px] font-semibold">Pick a time</h2>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {(days.find(([k]) => k === current)?.[1] ?? []).map((s) => (
              <button key={s} type="button" aria-pressed={slot === s} onClick={() => setSlot(s)}
                className={cn("min-h-11 rounded-lg border text-sm tabular-nums transition-colors", slot === s ? "border-brand bg-brand text-white" : "border-line hover:bg-hover")}>
                {timeLabel(s)}
              </button>
            ))}
          </div>
        </Card>
      )}

      {slot && (
        <Card className="mt-4 p-4">
          <h2 className="text-[15px] font-semibold">Your details</h2>
          <p className="mt-1 text-[13px] text-muted">{full(slot)}</p>
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Field label="Name">{(fp) => <Input {...fp} required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} />}</Field>
            <Field label="Email">{(fp) => <Input {...fp} required type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={200} />}</Field>
            <Field label="Anything to share before the call? (optional)">{(fp) => <Textarea {...fp} rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={1000} />}</Field>
            {error && <p role="alert" className="text-sm text-bad">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>{busy ? "Booking..." : "Confirm booking"}</Button>
          </form>
        </Card>
      )}
    </Shell>
  );
}

export function BookingCancelPage() {
  const { slug = "", id = "" } = useParams();
  const [params] = useSearchParams();
  const token = params.get("t") ?? "";
  const q = useQuery({ queryKey: ["book", "booking", id], queryFn: () => api.get<{ booking: { startsAt: string; status: string; name: string }; page: { title: string } }>(`/book/bookings/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`), retry: false });
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const cancel = async () => {
    setBusy(true);
    try { await api.post(`/book/bookings/${encodeURIComponent(id)}/cancel`, { token }); setCancelled(true); } catch { setBusy(false); }
  };
  if (q.isLoading) return <Shell><Skeleton className="h-48" /></Shell>;
  if (q.isError || !q.data) return <Shell><Card><EmptyState icon={<IconCalendarX />} title="Booking not found" body="The cancel link may be incomplete. Open it again from your confirmation email." /></Card></Shell>;
  const done = cancelled || q.data.booking.status === "cancelled";
  return (
    <Shell>
      <Card className="p-6 text-center">
        <h1 className="text-xl font-semibold">{done ? "Booking cancelled" : "Cancel this booking?"}</h1>
        <p className="mt-2 text-sm text-muted">{q.data.page.title}</p>
        <p className="mt-1 text-[15px] font-medium">{full(q.data.booking.startsAt)}</p>
        {done ? (
          <p className="mt-4 text-sm text-muted">The host has been told. <Link to={`/book/${slug}`} className="text-brand underline">Pick a new time</Link></p>
        ) : (
          <Button variant="danger" className="mt-5" disabled={busy} onClick={cancel}>{busy ? "Cancelling..." : "Cancel booking"}</Button>
        )}
      </Card>
    </Shell>
  );
}
