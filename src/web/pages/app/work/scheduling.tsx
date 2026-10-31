/** Booking page settings: weekly hours, slot rules and the public link, plus the bookings guests made. */
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconCalendarClock, IconExternalLink } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useConfig } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { useDialogs } from "@/web/components/ui/confirm";
import { Field, Input, Select, Textarea, TimeInput } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";

type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type Hours = Partial<Record<Day, [string, string][]>>;
interface Page { slug: string; title: string; description: string; timezone: string; hours: Hours; slotMin: number; bufferMin: number; maxDaysAhead: number; minNoticeMin: number; video: boolean; enabled: boolean; url: string }
interface Booking { id: string; startsAt: string; durationMin: number; name: string; email: string; note: string; status: "confirmed" | "cancelled"; meetingUrl: string | null }

const DAYS: [Day, string][] = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const ZONES = (() => {
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  return fn ? fn("timeZone") : ["UTC", "America/New_York", "America/Los_Angeles", "America/Sao_Paulo", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Kathmandu", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland"];
})();
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const fmt = (s: string) => new Date(s).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const WEEKDAYS: [string, string] = ["09:00", "17:00"];

export function SchedulingPage() {
  const { confirm, dialogs } = useDialogs();
  const config = useConfig();
  const qc = useQueryClient();
  const enabled = !!config.data?.scheduling;
  const page = useQuery({ queryKey: ["scheduling", "page"], enabled, queryFn: async () => (await api.get<{ page: Page | null }>("/scheduling/page")).page });
  const bookings = useQuery({ queryKey: ["scheduling", "bookings"], enabled, queryFn: async () => (await api.get<{ bookings: Booking[] }>("/scheduling/bookings?upcoming=1")).bookings });
  const [draft, setDraft] = useState<Omit<Page, "url"> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (page.isSuccess && !draft) {
      setDraft(page.data ?? { slug: "", title: "", description: "", timezone: localZone(), hours: { mon: [WEEKDAYS], tue: [WEEKDAYS], wed: [WEEKDAYS], thu: [WEEKDAYS], fri: [WEEKDAYS] }, slotMin: 30, bufferMin: 0, maxDaysAhead: 30, minNoticeMin: 120, video: true, enabled: true });
    }
  }, [page.isSuccess, page.data, draft]);

  if (config.isSuccess && !enabled) {
    return <Card><EmptyState icon={<IconCalendarClock />} title="Booking pages are off" body="Booking pages aren't switched on for this server yet. Ask whoever runs it to switch them on." /></Card>;
  }
  if (!draft) return <Skeleton className="h-64" />;

  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => setDraft({ ...draft, [k]: v });
  const setDay = (d: Day, on: boolean) => set("hours", { ...draft.hours, [d]: on ? [WEEKDAYS] : [] });
  const setTime = (d: Day, i: 0 | 1, v: string) => {
    const r = [...(draft.hours[d]?.[0] ?? WEEKDAYS)] as [string, string];
    r[i] = v;
    set("hours", { ...draft.hours, [d]: [r] });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.put<{ page: Page }>("/scheduling/page", { ...draft, slug: draft.slug || undefined, title: draft.title || undefined });
      setDraft(r.page);
      qc.setQueryData(["scheduling", "page"], r.page);
      toast.success("Booking page saved.");
    } catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  const cancel = async (b: Booking) => {
    if (!(await confirm({ title: `Cancel ${b.name}'s booking?`, description: `${fmt(b.startsAt)}. They will get an email saying it is cancelled.`, confirmLabel: "Cancel booking" }))) return;
    try { await api.post(`/scheduling/bookings/${b.id}/cancel`); qc.invalidateQueries({ queryKey: ["scheduling", "bookings"] }); } catch (err) { showError(err as Error); }
  };
  const url = page.data?.url;

  return (
    <div className="max-w-4xl space-y-6">
      {dialogs}
      <PageHeader title="Booking page" description="Share a link so clients and partners can pick a time that suits you. Bookings become meetings with a video link." />
      {url && (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] text-muted">Your public link</div>
            <a href={url} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium text-brand" data-testid="booking-link">{url}</a>
          </div>
          {!page.data?.enabled && <Badge tone="warn">Paused</Badge>}
          <CopyButton value={url} label="Copy link" />
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-muted hover:bg-hover hover:text-fg">Open<IconExternalLink className="h-3.5 w-3.5" aria-hidden /></a>
        </Card>
      )}

      <form onSubmit={save} className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card className="p-4">
          <h2 className="mb-3 text-[15px] font-semibold">Weekly hours</h2>
          <div className="divide-y divide-line">
            {DAYS.map(([d, label]) => {
              const r = draft.hours[d]?.[0];
              return (
                <div key={d} className="flex min-h-12 flex-wrap items-center gap-3 py-2">
                  <Switch checked={!!r} onChange={(v) => setDay(d, v)} label={`Open on ${label}`} />
                  <span className="w-24 text-sm">{label}</span>
                  {r ? (
                    <div className="flex items-center gap-2 text-sm">
                      <TimeInput aria-label={`${label} from`} className="w-32" value={r[0]} onChange={(e) => setTime(d, 0, e.target.value)} step={900} />
                      <span className="text-muted">to</span>
                      <TimeInput aria-label={`${label} until`} className="w-32" value={r[1]} onChange={(e) => setTime(d, 1, e.target.value)} step={900} />
                    </div>
                  ) : <span className="text-sm text-subtle">Unavailable</span>}
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="space-y-4 p-4">
          <Field label="Link">{(p) => <Input {...p} value={draft.slug} onChange={(e) => set("slug", e.target.value.toLowerCase())} placeholder="your-name" maxLength={40} />}</Field>
          <Field label="Title">{(p) => <Input {...p} value={draft.title} onChange={(e) => set("title", e.target.value)} placeholder="Intro call" maxLength={120} />}</Field>
          <Field label="Description">{(p) => <Textarea {...p} value={draft.description} onChange={(e) => set("description", e.target.value)} rows={2} maxLength={1000} />}</Field>
          <Field label="Time zone">{(p) => <Select {...p} value={draft.timezone} onChange={(e) => set("timezone", e.target.value)}>{ZONES.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</Select>}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Meeting length">{(p) => <Select {...p} value={draft.slotMin} onChange={(e) => set("slotMin", Number(e.target.value))}>{[15, 30, 45, 60].map((n) => <option key={n} value={n}>{n} min</option>)}</Select>}</Field>
            <Field label="Buffer">{(p) => <Select {...p} value={draft.bufferMin} onChange={(e) => set("bufferMin", Number(e.target.value))}>{[0, 5, 10, 15, 30, 60].map((n) => <option key={n} value={n}>{n ? `${n} min` : "None"}</option>)}</Select>}</Field>
            <Field label="Book up to">{(p) => <Select {...p} value={draft.maxDaysAhead} onChange={(e) => set("maxDaysAhead", Number(e.target.value))}>{[7, 14, 30, 60, 90].map((n) => <option key={n} value={n}>{n} days ahead</option>)}</Select>}</Field>
            <Field label="Notice">{(p) => <Select {...p} value={draft.minNoticeMin} onChange={(e) => set("minNoticeMin", Number(e.target.value))}>{([[0, "None"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [1440, "1 day"], [2880, "2 days"]] as [number, string][]).map(([n, l]) => <option key={n} value={n}>{l}</option>)}</Select>}</Field>
          </div>
          <div className="flex items-center justify-between text-sm"><span>Video link on each booking</span><Switch checked={draft.video} onChange={(v) => set("video", v)} label="Video link on each booking" /></div>
          <div className="flex items-center justify-between text-sm"><span>Accept bookings</span><Switch checked={draft.enabled} onChange={(v) => set("enabled", v)} label="Accept bookings" /></div>
          <Button type="submit" className="w-full" disabled={busy}>{busy ? "Saving..." : url ? "Save changes" : "Create booking page"}</Button>
        </Card>
      </form>

      <section aria-labelledby="bk-upcoming" className="space-y-3">
        <h2 id="bk-upcoming" className="text-[15px] font-semibold">Upcoming bookings</h2>
        {bookings.isLoading ? <Skeleton className="h-16" /> : !bookings.data?.length ? (
          <Card><EmptyState icon={<IconCalendarClock />} title="No bookings yet" body="When someone picks a time on your page it shows here and in Meetings." /></Card>
        ) : (
          <Card className="divide-y divide-line">
            {bookings.data.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="w-40 shrink-0 text-sm tabular-nums">{fmt(b.startsAt)}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{b.name}</div>
                  <div className="truncate text-[12.5px] text-muted">{b.email}{b.note ? ` · ${b.note}` : ""}</div>
                </div>
                {b.status === "cancelled" ? <Badge>Cancelled</Badge> : (
                  <>
                    {b.meetingUrl && <a href={b.meetingUrl} className="text-sm text-brand">Meeting</a>}
                    <Button size="sm" variant="ghost" onClick={() => cancel(b)} aria-label={`Cancel booking with ${b.name}`}>Cancel</Button>
                  </>
                )}
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
