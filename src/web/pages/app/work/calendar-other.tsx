import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CalendarPlus, Eye, EyeOff } from "lucide-react";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";

/**
 * Round 23 (R23.4): the "Other calendars" layer on the work calendar. Events from the person's own
 * calendars (a connected mailbox's CalDAV account or an ICS link), read only, drawn muted with the
 * calendar's name. Fetched for the visible month; the server keeps them in memory for a few minutes.
 */
interface ExternalEvent { id: string; kind: string; title: string; start: string; end: string; allDay: boolean; sourceId: string | null; sourceName: string | null; color: string | null }
interface Source { id: string; name: string; color: string; enabled: boolean }

export function useOtherCalendars() {
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const sources = useQuery({ queryKey: ["calendar", "sources"], queryFn: () => api.get<{ data: Source[] }>("/calendar/sources").then((r) => r.data), staleTime: 60_000 });
  const enabled = (sources.data ?? []).filter((s) => s.enabled);
  const events = useQuery({
    queryKey: ["calendar", "events", range?.from, range?.to],
    queryFn: () => api.get<{ events: ExternalEvent[]; errors: { name: string; message: string }[] }>(`/calendar/events?from=${encodeURIComponent(range!.from)}&to=${encodeURIComponent(range!.to)}`),
    enabled: !!range && enabled.length > 0, staleTime: 120_000,
  });
  const list = (events.data?.events ?? []).filter((e) => e.kind === "external" && e.sourceId && !hidden.has(e.sourceId));
  const fcEvents = list.map((e) => ({
    id: `ext:${e.id}`, title: `${e.title}`, start: e.start, end: e.end, allDay: e.allDay, editable: false,
    backgroundColor: "var(--color-fill)", borderColor: e.color ?? "#8E8E93", textColor: "var(--color-muted)",
    classNames: ["mm-external-event"], extendedProps: { readOnly: true, sourceName: e.sourceName },
  }));
  const toggle = (id: string) => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return { setRange, events: fcEvents, sources: enabled, hidden, toggle, errors: events.data?.errors ?? [], loading: events.isFetching };
}

export function OtherCalendarsBar({ layer }: { layer: ReturnType<typeof useOtherCalendars> }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 px-1 text-[12.5px]" data-testid="other-calendars">
      <span className="font-medium text-muted">Other calendars</span>
      {layer.sources.map((s) => {
        const off = layer.hidden.has(s.id);
        return (
          <button key={s.id} type="button" onClick={() => layer.toggle(s.id)} aria-pressed={!off} aria-label={`${off ? "Show" : "Hide"} ${s.name}`}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors", off ? "border-line text-subtle" : "border-line bg-fill text-fg")}>
            <span className="size-2 rounded-full" style={{ background: off ? "transparent" : s.color, boxShadow: `inset 0 0 0 1.5px ${s.color}` }} aria-hidden />
            {s.name}
            {off ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5 text-muted" />}
          </button>
        );
      })}
      <Link to="/app/settings/calendar#other-calendars" className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[#0071E3] hover:bg-hover">
        <CalendarPlus className="size-3.5" />Connect a calendar
      </Link>
      {layer.errors.map((e) => <span key={e.name} className="text-[12px] text-[#C93400]">{e.name}: {e.message}</span>)}
    </div>
  );
}
