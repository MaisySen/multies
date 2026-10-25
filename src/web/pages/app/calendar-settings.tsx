import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Link2, Mail, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { CopyButton, Switch } from "@/web/components/ui/misc";
import { Field, Input } from "@/web/components/ui/input";
import { Section } from "./settings";

/**
 * Round 23 (R23.4): Settings > Calendar. A personal calendar feed (a secret .ics address that can be
 * reset or turned off) and the person's other calendars, shown read only on the work calendar.
 */
export interface FeedState { enabled: boolean; hint: string | null; includeTasks: boolean; createdAt: string | null; resetAt: string | null; url?: string; webcalUrl?: string }
export interface CalendarSourceView { id: string; kind: "caldav" | "ics"; name: string; color: string; enabled: boolean; address: string | null; host: string | null; calendars: { name: string; color: string | null }[] }
export interface CalendarOption { connectionId: string; address: string; provider: string; caldav: boolean; message: string | null }

export const calendarKeys = { feed: ["calendar", "feed"] as const, sources: ["calendar", "sources"] as const, options: ["calendar", "options"] as const };

export function CalendarSettings() {
  return (
    <div className="space-y-6">
      <FeedSection />
      <OtherCalendarsSection />
    </div>
  );
}

function FeedSection() {
  const qc = useQueryClient();
  const feed = useQuery({ queryKey: calendarKeys.feed, queryFn: () => api.get<{ feed: FeedState }>("/calendar/feed").then((r) => r.feed) });
  // The address is only known right after it is made (only its hash is kept).
  const [fresh, setFresh] = useState<FeedState | null>(null);
  const make = useMutation({
    mutationFn: () => api.post<{ feed: FeedState }>("/calendar/feed", {}),
    onSuccess: (r) => { setFresh(r.feed); qc.setQueryData(calendarKeys.feed, r.feed); if (feed.data?.enabled) toast.success("New address made. The old one has stopped working."); },
    onError: showError,
  });
  const off = useMutation({
    mutationFn: () => api.del("/calendar/feed"),
    onSuccess: () => { setFresh(null); qc.invalidateQueries({ queryKey: calendarKeys.feed }); toast.success("Calendar feed turned off."); },
    onError: showError,
  });
  const tasks = useMutation({
    mutationFn: (includeTasks: boolean) => api.patch<{ feed: FeedState }>("/calendar/feed", { includeTasks }),
    onSuccess: (r) => qc.setQueryData(calendarKeys.feed, { ...r.feed, url: fresh?.url, webcalUrl: fresh?.webcalUrl }),
    onError: showError,
  });
  const f = feed.data;
  const url = fresh?.url;
  return (
    <Section id="calendar-feed" title="Subscribe in Google Calendar, Apple Calendar or Outlook" description="Your meetings and the due dates of your tasks, in the calendar app you already use. It refreshes about once an hour. Anyone with the address can read it, so keep it to yourself.">
      {!f ? null : !f.enabled ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted">Turn on a private calendar address just for you.</p>
          <Button onClick={() => make.mutate()} loading={make.isPending}><CalendarDays className="size-4" />Turn on calendar feed</Button>
        </div>
      ) : (
        <div className="space-y-4" data-testid="calendar-feed">
          {url ? (
            <>
              <Field label="Your calendar address">
                {(p) => (
                  <div className="flex items-center gap-2">
                    <Input {...p} readOnly value={url} data-testid="calendar-feed-url" onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12.5px]" />
                    <CopyButton value={url} />
                  </div>
                )}
              </Field>
              <div className="flex flex-wrap gap-2">
                <a className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#0071E3] px-3 text-[13px] font-medium text-white hover:opacity-90" href={fresh?.webcalUrl}><CalendarDays className="size-4" />Open in Apple Calendar</a>
                <a className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-fill px-3 text-[13px] text-fg hover:bg-hover" href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(fresh?.webcalUrl ?? url)}`} target="_blank" rel="noreferrer">Add to Google Calendar</a>
              </div>
              <p className="text-[12.5px] text-muted">Copy it now: for your safety Multies shows it only once. Lost it? Reset below for a new one.</p>
            </>
          ) : (
            <p className="text-sm text-muted">Your calendar feed is on. Its address ends in <span className="font-mono text-fg">{f.hint}</span>.ics. For your safety it is shown only when it is made: reset to get a new one (the old one stops working).</p>
          )}
          <ul className="space-y-1.5 text-[13px] text-muted">
            <li><span className="font-medium text-fg">Google Calendar:</span> Other calendars, plus, From URL, paste the address, Add calendar.</li>
            <li><span className="font-medium text-fg">Apple Calendar:</span> File, New Calendar Subscription, paste the address (or use the button above on a Mac or iPhone).</li>
            <li><span className="font-medium text-fg">Outlook:</span> Add calendar, Subscribe from web, paste the address, Import.</li>
          </ul>
          <Switch checked={f.includeTasks} onChange={(v) => tasks.mutate(v)} label="Include the due dates of my tasks" />
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <Button variant="secondary" size="sm" onClick={() => make.mutate()} loading={make.isPending}><RefreshCw className="size-4" />Reset link</Button>
            <Button variant="ghost" size="sm" onClick={() => off.mutate()} loading={off.isPending}>Turn off</Button>
          </div>
        </div>
      )}
    </Section>
  );
}

export function OtherCalendarsSection() {
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: calendarKeys.sources, queryFn: () => api.get<{ data: CalendarSourceView[] }>("/calendar/sources").then((r) => r.data) });
  const options = useQuery({ queryKey: calendarKeys.options, queryFn: () => api.get<{ data: CalendarOption[] }>("/calendar/sources/options").then((r) => r.data) });
  const [url, setUrl] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: calendarKeys.sources }); qc.invalidateQueries({ queryKey: ["calendar", "events"] }); };
  const add = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.post<{ source: CalendarSourceView }>("/calendar/sources", b),
    onSuccess: (r) => { setUrl(""); refresh(); toast.success(`${r.source.name} added. Its events show on the calendar.`); },
    onError: showError,
  });
  const patch = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/calendar/sources/${id}`, { enabled }), onSuccess: refresh, onError: showError });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/calendar/sources/${id}`), onSuccess: refresh, onError: showError });
  const added = new Set((sources.data ?? []).map((s) => s.address));
  const [davUrl, setDavUrl] = useState<Record<string, string>>({});
  return (
    <Section id="other-calendars" title="Other calendars" description="See your own calendars beside your work, read only. Only you see them; nothing is copied into Multies.">
      <div className="space-y-5">
        {(sources.data ?? []).length > 0 && (
          <ul className="divide-y divide-line rounded-xl border border-line" data-testid="calendar-sources">
            {sources.data!.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.name}</div>
                  <div className="truncate text-[12px] text-muted">{s.kind === "caldav" ? `${s.address} (${s.calendars.map((c) => c.name).join(", ")})` : `Calendar link from ${s.host}`}</div>
                </div>
                <Switch checked={s.enabled} onChange={(v) => patch.mutate({ id: s.id, enabled: v })} label={`Show ${s.name}`} />
                <button type="button" aria-label={`Remove ${s.name}`} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg" onClick={() => remove.mutate(s.id)}><Trash2 className="size-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-2">
          <div className="text-[13px] font-medium">Connect a calendar</div>
          {(options.data ?? []).length === 0 && <p className="text-[13px] text-muted">Connect a mailbox from Fastmail, iCloud, Zoho, Yahoo or GMX in Connected accounts and its calendar can show here too.</p>}
          {(options.data ?? []).map((o) => (
            <div key={o.connectionId} className="flex flex-wrap items-center gap-2 text-sm">
              <Mail className="size-4 text-muted" />
              <span className="min-w-0 flex-1 truncate">{o.address}</span>
              {o.caldav ? (
                <Button size="sm" variant="secondary" disabled={added.has(o.address)} loading={add.isPending && add.variables?.connectionId === o.connectionId} onClick={() => add.mutate({ kind: "caldav", connectionId: o.connectionId, ...(davUrl[o.connectionId]?.trim() ? { url: davUrl[o.connectionId].trim() } : {}) })}>{added.has(o.address) ? "Shown" : "Show its calendar"}</Button>
              ) : <span className="text-[12.5px] text-muted">{o.message}</span>}
              {o.caldav && o.message && !added.has(o.address) && (
                // A custom mail server: its calendar may live at another address (round 23 follow up).
                <div className="basis-full pl-6">
                  <p className="mb-1 text-[12px] text-muted">{o.message}</p>
                  <Input value={davUrl[o.connectionId] ?? ""} onChange={(e) => setDavUrl((m) => ({ ...m, [o.connectionId]: e.target.value }))} placeholder="https://dav.example.com/ (optional)" aria-label={`CalDAV address for ${o.address}`} data-testid="caldav-url" />
                </div>
              )}
            </div>
          ))}
        </div>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (url.trim()) add.mutate({ kind: "ics", url: url.trim() }); }}>
          <Field label="Add a calendar link (ICS)" hint="Google: Settings, your calendar, Secret address in iCal format. Outlook: Settings, Shared calendars, Publish a calendar, ICS link.">
            {(p) => (
              <div className="flex gap-2">
                <Input {...p} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" data-testid="ics-url" />
                <Button type="submit" loading={add.isPending && add.variables?.kind === "ics"}><Link2 className="size-4" />Add</Button>
              </div>
            )}
          </Field>
        </form>
      </div>
    </Section>
  );
}
