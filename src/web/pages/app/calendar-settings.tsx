import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCalendarDays, IconLink, IconMail, IconRefresh, IconTrash } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { CopyButton, Switch } from "@/web/components/ui/misc";
import { Field, Input } from "@/web/components/ui/input";
import { Section } from "./settings";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { useConfig } from "@/web/lib/queries";

/**
 * Round 23 (R23.4): Settings > Calendar. A personal calendar feed (a secret .ics address that can be
 * reset or turned off) and the person's other calendars, shown read only on the work calendar.
 */
export interface FeedState { enabled: boolean; hint: string | null; includeTasks: boolean; createdAt: string | null; resetAt: string | null; url?: string; webcalUrl?: string }
export interface CalendarSourceView { id: string; kind: "caldav" | "ics"; name: string; color: string; enabled: boolean; address: string | null; host: string | null; calendars: { name: string; color: string | null }[] }
export interface CalendarOption { connectionId: string; address: string; provider: string; caldav: boolean; message: string | null }

export const calendarKeys = { feed: ["calendar", "feed"] as const, sources: ["calendar", "sources"] as const, options: ["calendar", "options"] as const };

export function CalendarSettings() {
  const davSync = !!useConfig().data?.davSync;
  return (
    <div className="space-y-6">
      <FeedSection />
      {davSync && <PhoneSyncSection />}
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
          <Button onClick={() => make.mutate()} loading={make.isPending}><IconCalendarDays className="size-4" />Turn on calendar feed</Button>
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
                <a className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#0071E3] px-3 text-[13px] font-medium text-white hover:opacity-90" href={fresh?.webcalUrl}><IconCalendarDays className="size-4" />Open in Apple Calendar</a>
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
            <Button variant="secondary" size="sm" onClick={() => make.mutate()} loading={make.isPending}><IconRefresh className="size-4" />Reset link</Button>
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
                <button type="button" aria-label={`Remove ${s.name}`} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg" onClick={() => remove.mutate(s.id)}><IconTrash className="size-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-2">
          <div className="text-[13px] font-medium">Connect a calendar</div>
          {(options.data ?? []).length === 0 && <p className="text-[13px] text-muted">Connect a mailbox from Fastmail, iCloud, Zoho, Yahoo or GMX in Connections, Mail accounts and its calendar can show here too.</p>}
          {(options.data ?? []).map((o) => (
            <div key={o.connectionId} className="flex flex-wrap items-center gap-2 text-sm">
              <IconMail className="size-4 text-muted" />
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
                <Button type="submit" loading={add.isPending && add.variables?.kind === "ics"}><IconLink className="size-4" />Add</Button>
              </div>
            )}
          </Field>
        </form>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- R99: sync with your phone (CalDAV and CardDAV)

export interface AppPasswordView { id: string; name: string; hint: string; createdAt: string; lastUsedAt: string | null }
interface AppPasswordList { passwords: AppPasswordView[]; server: string; username: string; max: number }
interface CreatedPassword { password: string; item: AppPasswordView; server: string; username: string }
export const davKeys = { passwords: ["calendar", "dav-passwords"] as const };

const GUIDES = ["iphone", "mac", "android", "outlook"] as const;
type Guide = (typeof GUIDES)[number];
const GUIDE_LABEL: Record<Guide, string> = { iphone: "iPhone and iPad", mac: "Mac", android: "Android", outlook: "Outlook" };

function when(iso: string | null) {
  if (!iso) return "Never used";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 15) return "Used just now";
  if (mins < 60 * 24) return `Used today at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return `Used ${d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}`;
}

function ServerFields({ server, username }: { server: string; username: string }) {
  return (
    <div className="grid gap-3">
      <Field label="Server address">
        {(p) => (
          <div className="flex items-center gap-2">
            <Input {...p} readOnly value={server} data-testid="dav-server" onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12.5px]" />
            <CopyButton value={server} />
          </div>
        )}
      </Field>
      <Field label="User name">
        {(p) => (
          <div className="flex items-center gap-2">
            <Input {...p} readOnly value={username} onFocus={(e) => e.currentTarget.select()} className="text-[13px]" />
            <CopyButton value={username} />
          </div>
        )}
      </Field>
    </div>
  );
}

function SyncGuides({ server }: { server: string }) {
  const [tab, setTab] = useState<Guide>("iphone");
  let host = server;
  try { host = new URL(server).host; } catch { /* keep the address */ }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = GUIDES.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1);
    const next = GUIDES[(i + GUIDES.length) % GUIDES.length];
    setTab(next);
    document.getElementById(`dav-guide-tab-${next}`)?.focus();
  };
  const steps: Record<Guide, React.ReactNode[]> = {
    iphone: [
      <>Easiest: on your iPhone or iPad, tap <span className="font-medium text-fg">Download profile</span> below, then open Settings, Profile Downloaded, Install. Paste your app password when it asks.</>,
      <>By hand: Settings, Apps, Calendar, Calendar Accounts, Add Account, Other, Add CalDAV Account. Server <span className="font-mono text-fg">{host}</span>, your email as user name, the app password as password.</>,
      <>For contacts do the same under Settings, Apps, Contacts, Add CardDAV Account.</>,
    ],
    mac: [
      <>Easiest: download the profile below and open it, then System Settings, Privacy and Security, Profiles, Install.</>,
      <>By hand: Calendar, Settings, Accounts, add an Other CalDAV Account, choose Manual, and enter your email, the app password and <span className="font-mono text-fg">{host}</span>.</>,
      <>Contacts: Settings, Accounts, add an Other Contacts Account, choose CardDAV, same details.</>,
    ],
    android: [
      <>Android has no built in CalDAV, so install a free CalDAV and CardDAV sync app from your app store.</>,
      <>Add an account with a web address and user name. Paste the server address below, your email and the app password.</>,
      <>Pick the Multies calendars and the contacts book. They show up in your phone&apos;s Calendar and Contacts apps.</>,
    ],
    outlook: [
      <>Outlook on the web and on Windows can only subscribe to calendars, read only: use the calendar feed above.</>,
      <>For two way sync on Windows, a free CalDAV add in for Outlook works with the server address below.</>,
      <>Outlook on iPhone, Android and Mac uses the accounts on the device: follow those steps instead.</>,
    ],
  };
  return (
    <div className="rounded-xl border border-line">
      <div role="tablist" aria-label="Setup guides" className="flex gap-1 overflow-x-auto border-b border-line p-1" onKeyDown={onKey}>
        {GUIDES.map((g) => (
          <button
            key={g} id={`dav-guide-tab-${g}`} role="tab" type="button" aria-selected={tab === g} aria-controls={`dav-guide-${g}`} tabIndex={tab === g ? 0 : -1}
            onClick={() => setTab(g)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-[13px] transition-colors duration-150 max-md:min-h-11 ${tab === g ? "bg-fill font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg"}`}
          >{GUIDE_LABEL[g]}</button>
        ))}
      </div>
      <div role="tabpanel" id={`dav-guide-${tab}`} aria-labelledby={`dav-guide-tab-${tab}`} className="space-y-3 p-4">
        <ol className="list-decimal space-y-2 pl-5 text-[13px] text-muted" data-testid="dav-guide-steps">
          {steps[tab].map((s, i) => <li key={i}>{s}</li>)}
        </ol>
        {(tab === "iphone" || tab === "mac") && (
          <a href="/api/dav/profile.mobileconfig" download className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-fill px-3 text-[13px] text-fg transition-colors duration-150 hover:bg-hover max-md:min-h-11" data-testid="dav-profile">
            <IconCalendarDays className="size-4" />Download profile
          </a>
        )}
      </div>
    </div>
  );
}

export function PhoneSyncSection() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: davKeys.passwords, queryFn: () => api.get<AppPasswordList>("/dav/passwords"), retry: 1 });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [made, setMade] = useState<CreatedPassword | null>(null);
  const [revoking, setRevoking] = useState<AppPasswordView | null>(null);
  const create = useMutation({
    mutationFn: (n: string) => api.post<CreatedPassword>("/dav/passwords", { name: n }),
    onSuccess: (r) => { setMade(r); setName(""); qc.invalidateQueries({ queryKey: davKeys.passwords }); },
    onError: showError,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/dav/passwords/${id}`),
    onSuccess: () => { setRevoking(null); qc.invalidateQueries({ queryKey: davKeys.passwords }); toast.success("App password revoked. That device stops syncing now."); },
    onError: showError,
  });
  const close = () => { setCreating(false); setMade(null); setName(""); };
  const data = list.data;
  const full = !!data && data.passwords.length >= data.max;
  return (
    <Section id="calendar-sync" title="Sync with your phone" description="See and edit your meetings, task due dates and contacts in the calendar and contacts apps on your phone or computer. Each device gets its own app password, so you can stop one without touching the others.">
      {list.isPending ? (
        <SkeletonRows rows={2} rowHeight={52} label="Loading app passwords" />
      ) : list.isError || !data ? (
        <div className="flex flex-col items-start gap-3" role="alert">
          <p className="text-sm text-muted">Sync settings did not load. Check your connection and try again.</p>
          <Button variant="secondary" size="sm" onClick={() => list.refetch()}><IconRefresh className="size-4" />Try again</Button>
        </div>
      ) : (
        <div className="space-y-5" data-testid="dav-sync">
          <ServerFields server={data.server} username={data.username} />
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13px] font-medium text-fg">App passwords</h3>
              <Button size="sm" onClick={() => setCreating(true)} disabled={full} className="max-md:min-h-11" data-testid="dav-create">Create app password</Button>
            </div>
            {data.passwords.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-muted" data-testid="dav-empty">No app passwords yet. Make one for each phone or computer you want to sync. Your Multies password never works here.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line" data-testid="dav-list">
                {data.passwords.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3 max-sm:flex-col max-sm:items-start">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium text-fg" title={p.name}>{p.name}</div>
                      <div className="text-[12.5px] text-muted">Ends in <span className="font-mono">{p.hint}</span> · Created {new Date(p.createdAt).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })} · {when(p.lastUsedAt)}</div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setRevoking(p)} aria-label={`Revoke ${p.name}`} className="max-md:min-h-11"><IconTrash className="size-4" />Revoke</Button>
                  </li>
                ))}
              </ul>
            )}
            {full && <p className="text-[12.5px] text-muted">You have the most app passwords allowed ({data.max}). Revoke one you no longer use to make another.</p>}
          </div>
          <SyncGuides server={data.server} />
        </div>
      )}
      <Dialog
        open={creating}
        onClose={close}
        title={made ? "Your app password" : "Create app password"}
        description={made ? "Copy it into your device now. For your safety Multies shows it only once." : "Name it after the device you will use it on, so you know which one to revoke later."}
        footer={made ? <Button onClick={close} data-testid="dav-done">Done</Button> : (
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button onClick={() => create.mutate(name)} loading={create.isPending} disabled={!name.trim()} data-testid="dav-create-submit">Create</Button>
          </>
        )}
      >
        {made ? (
          <div className="space-y-4">
            <Field label="App password">
              {(p) => (
                <div className="flex items-center gap-2">
                  <Input {...p} readOnly value={made.password} data-testid="dav-password" onFocus={(e) => e.currentTarget.select()} className="font-mono text-[15px] tracking-wide" />
                  <CopyButton value={made.password} toastText="App password copied" />
                </div>
              )}
            </Field>
            <ServerFields server={made.server} username={made.username} />
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(name); }}>
            <Field label="Device name">
              {(p) => <Input {...p} autoFocus value={name} maxLength={60} placeholder="For example, my iPhone" onChange={(e) => setName(e.target.value)} data-testid="dav-name" />}
            </Field>
          </form>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        title={`Revoke ${revoking?.name ?? "app password"}?`}
        description="That device stops syncing at once. Your calendar and contacts stay in Multies. You can make a new password any time."
        confirmLabel="Revoke"
        busy={revoke.isPending}
      />
    </Section>
  );
}
