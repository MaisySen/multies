import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { IconCalendarPlus, IconEye, IconEyeOff } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { tr } from "@/web/i18n"; // POL4 (HQ MB-356)

/**
 * Round 23 (R23.4): the "Other calendars" layer on the work calendar. Events from the person's own
 * calendars (a connected mailbox's CalDAV account or an ICS link), read only, drawn muted with the
 * calendar's name. Fetched for the visible month; the server keeps them in memory for a few minutes.
 */
interface ExternalEvent { id: string; kind: string; title: string; start: string; end: string; allDay: boolean; sourceId: string | null; sourceName: string | null; color: string | null; url?: string | null }

/** The in-app path of an event's link (meetings carry an absolute app URL). */
export function appPath(url: string | null | undefined) {
  if (!url) return null;
  try { const u = new URL(url, "http://x"); return u.pathname.startsWith("/app/") ? `${u.pathname}${u.search}` : null; } catch { return null; }
}
interface Source { id: string; name: string; color: string; enabled: boolean }

export function useOtherCalendars() {
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showMeetings, setShowMeetings] = useState(true);
  const sources = useQuery({ queryKey: ["calendar", "sources"], queryFn: () => api.get<{ data: Source[] }>("/calendar/sources").then((r) => r.data), staleTime: 60_000 });
  const enabled = (sources.data ?? []).filter((s) => s.enabled);
  const events = useQuery({
    queryKey: ["calendar", "events", range?.from, range?.to],
    queryFn: () => api.get<{ events: ExternalEvent[]; errors: { name: string; message: string }[] }>(`/calendar/events?from=${encodeURIComponent(range!.from)}&to=${encodeURIComponent(range!.to)}`),
    // Round 23: the person's Multies meetings show here too, so the events are read even with no other calendar.
    enabled: !!range, staleTime: 120_000,
  });
  const list = (events.data?.events ?? []).filter((e) => e.kind === "external" && e.sourceId && !hidden.has(e.sourceId));
  const fcEvents = list.map((e) => ({
    id: `ext:${e.id}`, title: `${e.title}`, start: e.start, end: e.end, allDay: e.allDay, editable: false,
    // R35 (FullCalendar 7): one colour per event, so the source colour shows as the left edge (--mm-src in index.css).
    color: "var(--color-fill)", contrastColor: "var(--color-muted)",
    className: "mm-external-event", extendedProps: { readOnly: true, sourceName: e.sourceName, sourceColor: e.color ?? "#8E8E93" },
  }));
  const meetings = showMeetings ? (events.data?.events ?? []).filter((e) => e.kind === "meeting").map((e) => ({
    id: `mtg:${e.id}`, title: e.title, start: e.start, end: e.end, allDay: false, editable: false,
    color: "#0071E3", contrastColor: "#FFFFFF",
    className: "mm-meeting-event", extendedProps: { readOnly: true, href: appPath(e.url) },
  })) : [];
  const toggle = (id: string) => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return { setRange, events: [...meetings, ...fcEvents], meetingCount: meetings.length, showMeetings, toggleMeetings: () => setShowMeetings((v) => !v), sources: enabled, hidden, toggle, errors: events.data?.errors ?? [], loading: events.isFetching };
}

export function OtherCalendarsBar({ layer }: { layer: ReturnType<typeof useOtherCalendars> }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 px-1 text-[12.5px]" data-testid="other-calendars">
      <button type="button" onClick={layer.toggleMeetings} aria-pressed={layer.showMeetings} aria-label={layer.showMeetings ? tr("calendar.hide_meetings") : tr("calendar.show_meetings")} data-testid="calendar-meetings-toggle"
        className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors max-sm:h-11 max-sm:px-3.5", layer.showMeetings ? "border-line bg-fill text-fg" : "border-line text-subtle")}>
        <span className="size-2 rounded-full" style={{ background: layer.showMeetings ? "#0071E3" : "transparent", boxShadow: "inset 0 0 0 1.5px #0071E3" }} aria-hidden />
        {tr("calendar.meetings")}
        {layer.showMeetings ? <IconEye className="size-3.5 text-muted" /> : <IconEyeOff className="size-3.5" />}
      </button>
      <span className="font-medium text-muted">{tr("calendar.other_calendars")}</span>
      {layer.sources.map((s) => {
        const off = layer.hidden.has(s.id);
        return (
          <button key={s.id} type="button" onClick={() => layer.toggle(s.id)} aria-pressed={!off} aria-label={`${off ? "Show" : "Hide"} ${s.name}`}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors max-sm:h-11 max-sm:px-3.5", off ? "border-line text-subtle" : "border-line bg-fill text-fg")}>
            <span className="size-2 rounded-full" style={{ background: off ? "transparent" : s.color, boxShadow: `inset 0 0 0 1.5px ${s.color}` }} aria-hidden />
            {s.name}
            {off ? <IconEyeOff className="size-3.5" /> : <IconEye className="size-3.5 text-muted" />}
          </button>
        );
      })}
      <Link to="/app/settings/calendar#other-calendars" className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-brand-hover hover:bg-hover max-sm:h-11 max-sm:px-3.5">
        <IconCalendarPlus className="size-3.5" />{tr("calendar.connect_a_calendar")}
      </Link>
      {layer.errors.map((e) => <span key={e.name} className="text-[12px] text-[#C93400]">{e.name}: {e.message}</span>)}
    </div>
  );
}
