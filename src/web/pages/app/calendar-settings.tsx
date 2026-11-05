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
import { nextTabKey } from "@/web/lib/tab-keys";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { useConfig } from "@/web/lib/queries";
import { LoadErrorInline } from "@/web/components/load-error-t1g";
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-calendar"; // R104B

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
    onSuccess: (r) => { setFresh(r.feed); qc.setQueryData(calendarKeys.feed, r.feed); if (feed.data?.enabled) toast.success(tr("calendar.new_address_made_the_old_one_has_stopped_working")); },
    onError: showError,
  });
  const off = useMutation({
    mutationFn: () => api.del("/calendar/feed"),
    onSuccess: () => { setFresh(null); qc.invalidateQueries({ queryKey: calendarKeys.feed }); toast.success(tr("calendar.calendar_feed_turned_off")); },
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
    <Section id="calendar-feed" title={tr("calendar.subscribe_in_google_calendar_apple_calendar_or_o")} description={tr("calendar.your_meetings_and_the_due_dates_of_your_tasks_in")}>
      {!f ? null : !f.enabled ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted">{tr("calendar.turn_on_a_private_calendar_address_just_for_you")}</p>
          <Button onClick={() => make.mutate()} loading={make.isPending}><IconCalendarDays className="size-4" />{tr("calendar.turn_on_calendar_feed")}</Button>
        </div>
      ) : (
        <div className="space-y-4" data-testid="calendar-feed">
          {url ? (
            <>
              <Field label={tr("calendar.your_calendar_address")}>
                {(p) => (
                  <div className="flex items-center gap-2">
                    <Input {...p} readOnly value={url} data-testid="calendar-feed-url" onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12.5px]" />
                    <CopyButton value={url} />
                  </div>
                )}
              </Field>
              <div className="flex flex-wrap gap-2">
                <a className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-white hover:opacity-90" href={fresh?.webcalUrl}><IconCalendarDays className="size-4" />{tr("calendar.open_in_apple_calendar")}</a>
                <a className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-fill px-3 text-[13px] text-fg hover:bg-hover" href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(fresh?.webcalUrl ?? url)}`} target="_blank" rel="noreferrer">{tr("calendar.add_to_google_calendar")}</a>
              </div>
              <p className="text-[12.5px] text-muted">{tr("calendar.copy_it_now_for_your_safety_multies_shows_it_onl")}</p>
            </>
          ) : (
            <p className="text-sm text-muted">{tr("calendar.your_calendar_feed_is_on_its_address_ends_in")} <span className="font-mono text-fg">{f.hint}</span>{tr("calendar.ics_for_your_safety_it_is_shown_only_when_it_is")}</p>
          )}
          <ul className="space-y-1.5 text-[13px] text-muted">
            <li><span className="font-medium text-fg">{tr("calendar.google_calendar")}</span> {tr("calendar.other_calendars_plus_from_url_paste_the_address")}</li>
            <li><span className="font-medium text-fg">{tr("calendar.apple_calendar")}</span> {tr("calendar.file_new_calendar_subscription_paste_the_address")}</li>
            <li><span className="font-medium text-fg">{tr("calendar.outlook")}</span> {tr("calendar.add_calendar_subscribe_from_web_paste_the_addres")}</li>
          </ul>
          <Switch checked={f.includeTasks} onChange={(v) => tasks.mutate(v)} label={tr("calendar.include_the_due_dates_of_my_tasks")} />
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <Button variant="secondary" size="sm" onClick={() => make.mutate()} loading={make.isPending}><IconRefresh className="size-4" />{tr("calendar.reset_link")}</Button>
            <Button variant="ghost" size="sm" onClick={() => off.mutate()} loading={off.isPending}>{tr("calendar.turn_off")}</Button>
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
    onSuccess: (r) => { setUrl(""); refresh(); toast.success(tr("calendar.name_added_its_events_show_on_the_calendar", { name: r.source.name })); },
    onError: showError,
  });
  const patch = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/calendar/sources/${id}`, { enabled }), onSuccess: refresh, onError: showError });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/calendar/sources/${id}`), onSuccess: refresh, onError: showError });
  const added = new Set((sources.data ?? []).map((s) => s.address));
  const [davUrl, setDavUrl] = useState<Record<string, string>>({});
  return (
    <Section id="other-calendars" title={tr("calendar.other_calendars")} description={tr("calendar.see_your_own_calendars_beside_your_work_read_onl")}>
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
                <Switch checked={s.enabled} onChange={(v) => patch.mutate({ id: s.id, enabled: v })} label={tr("calendar.show_name", { name: s.name })} />
                <button type="button" aria-label={tr("calendar.remove_name", { name: s.name })} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg" onClick={() => remove.mutate(s.id)}><IconTrash className="size-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-2">
          <div className="text-[13px] font-medium">{tr("calendar.connect_a_calendar")}</div>
          {(options.data ?? []).length === 0 && <p className="text-[13px] text-muted">{tr("calendar.connect_a_mailbox_from_fastmail_icloud_zoho_yaho")}</p>}
          {(options.data ?? []).map((o) => (
            <div key={o.connectionId} className="flex flex-wrap items-center gap-2 text-sm">
              <IconMail className="size-4 text-muted" />
              <span className="min-w-0 flex-1 truncate">{o.address}</span>
              {o.caldav ? (
                <Button size="sm" variant="secondary" disabled={added.has(o.address)} loading={add.isPending && add.variables?.connectionId === o.connectionId} onClick={() => add.mutate({ kind: "caldav", connectionId: o.connectionId, ...(davUrl[o.connectionId]?.trim() ? { url: davUrl[o.connectionId].trim() } : {}) })}>{added.has(o.address) ? tr("calendar.shown") : tr("calendar.show_its_calendar")}</Button>
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
          <Field label={tr("calendar.add_a_calendar_link_ics")} hint={tr("calendar.google_settings_your_calendar_secret_address_in")}>
            {(p) => (
              <div className="flex gap-2">
                <Input {...p} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" data-testid="ics-url" />
                <Button type="submit" loading={add.isPending && add.variables?.kind === "ics"}><IconLink className="size-4" />{tr("common.add")}</Button>
              </div>
            )}
          </Field>
        </form>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- R99: sync with your phone (CalDAV and CardDAV)
// R115 (R99 lows): the shown-once password field takes focus when the create form is replaced (it used to drop to the page body).

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
      <Field label={tr("calendar.server_address")}>
        {(p) => (
          <div className="flex items-center gap-2">
            <Input {...p} readOnly value={server} data-testid="dav-server" onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12.5px]" />
            <CopyButton value={server} />
          </div>
        )}
      </Field>
      <Field label={tr("calendar.user_name")}>
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
    const next = nextTabKey(GUIDES, tab, e.key); // R115 (R99 low): Home and End too
    if (!next) return;
    e.preventDefault();
    setTab(next);
    document.getElementById(`dav-guide-tab-${next}`)?.focus();
  };
  const steps: Record<Guide, React.ReactNode[]> = {
    iphone: [
      <>{tr("calendar.easiest_on_your_iphone_or_ipad_tap")} <span className="font-medium text-fg">{tr("calendar.download_profile")}</span> {tr("calendar.below_then_open_settings_profile_downloaded_inst")}</>,
      <>{tr("calendar.by_hand_settings_apps_calendar_calendar_accounts")} <span className="font-mono text-fg">{host}</span>{tr("calendar.your_email_as_user_name_the_app_password_as_pass")}</>,
      <>{tr("calendar.for_contacts_do_the_same_under_settings_apps_con")}</>,
    ],
    mac: [
      <>{tr("calendar.easiest_download_the_profile_below_and_open_it_t")}</>,
      <>{tr("calendar.by_hand_calendar_settings_accounts_add_an_other")} <span className="font-mono text-fg">{host}</span>.</>,
      <>{tr("calendar.contacts_settings_accounts_add_an_other_contacts")}</>,
    ],
    android: [
      <>{tr("calendar.android_has_no_built_in_caldav_so_install_a_free")}</>,
      <>{tr("calendar.add_an_account_with_a_web_address_and_user_name")}</>,
      <>{tr("calendar.pick_the_multies_calendars_and_the_contacts_book")}</>,
    ],
    outlook: [
      <>{tr("calendar.outlook_on_the_web_and_on_windows_can_only_subsc")}</>,
      <>{tr("calendar.for_two_way_sync_on_windows_a_free_caldav_add_in")}</>,
      <>{tr("calendar.outlook_on_iphone_android_and_mac_uses_the_accou")}</>,
    ],
  };
  return (
    <div className="rounded-xl border border-line">
      <div role="tablist" aria-label={tr("calendar.setup_guides")} className="flex gap-1 overflow-x-auto border-b border-line p-1" onKeyDown={onKey}>
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
            <IconCalendarDays className="size-4" />{tr("calendar.download_profile")}
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
    onSuccess: () => { setRevoking(null); qc.invalidateQueries({ queryKey: davKeys.passwords }); toast.success(tr("calendar.app_password_revoked_that_device_stops_syncing_n")); },
    onError: showError,
  });
  const close = () => { setCreating(false); setMade(null); setName(""); };
  const data = list.data;
  const full = !!data && data.passwords.length >= data.max;
  return (
    <Section id="calendar-sync" title={tr("calendar.sync_with_your_phone")} description={tr("calendar.see_and_edit_your_meetings_task_due_dates_and_co")}>
      {list.isPending ? (
        <SkeletonRows rows={2} rowHeight={52} label={tr("calendar.loading_app_passwords")} />
      ) : list.isError || !data ? (
        <LoadErrorInline onRetry={() => list.refetch()} />
      ) : (
        <div className="space-y-5" data-testid="dav-sync">
          <ServerFields server={data.server} username={data.username} />
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13px] font-medium text-fg">{tr("calendar.app_passwords")}</h3>
              <Button size="sm" onClick={() => setCreating(true)} disabled={full} className="max-md:min-h-11" data-testid="dav-create">{tr("calendar.create_app_password")}</Button>
            </div>
            {data.passwords.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-muted" data-testid="dav-empty">{tr("calendar.no_app_passwords_yet_make_one_for_each_phone_or")}</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line" data-testid="dav-list">
                {data.passwords.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3 max-sm:flex-col max-sm:items-start">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium text-fg" title={p.name}>{p.name}</div>
                      <div className="text-[12.5px] text-muted">{tr("calendar.ends_in")} <span className="font-mono">{p.hint}</span> {tr("calendar.created")} {new Date(p.createdAt).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })} · {when(p.lastUsedAt)}</div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setRevoking(p)} aria-label={tr("calendar.revoke_name", { name: p.name })} className="max-md:min-h-11"><IconTrash className="size-4" />{tr("calendar.revoke")}</Button>
                  </li>
                ))}
              </ul>
            )}
            {full && <p className="text-[12.5px] text-muted">{tr("calendar.you_have_the_most_app_passwords_allowed_max_revo", { max: data.max })}</p>}
          </div>
          <SyncGuides server={data.server} />
        </div>
      )}
      <Dialog
        open={creating}
        onClose={close}
        title={made ? tr("calendar.your_app_password") : tr("calendar.create_app_password")}
        description={made ? tr("calendar.copy_it_into_your_device_now_for_your_safety_mul") : tr("calendar.name_it_after_the_device_you_will_use_it_on_so_y")}
        footer={made ? <Button onClick={close} data-testid="dav-done">{tr("common.done")}</Button> : (
          <>
            <Button variant="ghost" onClick={close}>{tr("common.cancel")}</Button>
            <Button onClick={() => create.mutate(name)} loading={create.isPending} disabled={!name.trim()} data-testid="dav-create-submit">{tr("common.create")}</Button>
          </>
        )}
      >
        {made ? (
          <div className="space-y-4">
            <Field label={tr("calendar.app_password")}>
              {(p) => (
                <div className="flex items-center gap-2">
                  <Input {...p} readOnly autoFocus value={made.password} data-testid="dav-password" onFocus={(e) => e.currentTarget.select()} className="font-mono text-[15px] tracking-wide" />
                  <CopyButton value={made.password} toastText={tr("calendar.app_password_copied")} />
                </div>
              )}
            </Field>
            <ServerFields server={made.server} username={made.username} />
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(name); }}>
            <Field label={tr("calendar.device_name")}>
              {(p) => <Input {...p} autoFocus value={name} maxLength={60} placeholder={tr("calendar.for_example_my_iphone")} onChange={(e) => setName(e.target.value)} data-testid="dav-name" />}
            </Field>
          </form>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        title={`Revoke ${revoking?.name ?? "app password"}?`}
        description={tr("calendar.that_device_stops_syncing_at_once_your_calendar")}
        confirmLabel={tr("calendar.revoke")}
        busy={revoke.isPending}
      />
    </Section>
  );
}
