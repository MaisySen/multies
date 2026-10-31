/**
 * R97 notification centre (web): mail delivery (as it happens or a daily or weekly digest), quiet hours, pause and the
 * new mail switch, all in the person's own time zone; plus the status line on the Notifications page. Shown only when
 * the server answers `delivery` (flag NOTIFICATION_CENTRE).
 */
import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Card, Switch } from "@/web/components/ui/misc";
import { Select, TimeInput } from "@/web/components/ui/input";
import { Button } from "@/web/components/ui/button";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { IconBell, IconClock } from "@/web/components/ui/icon";
import { inQuietHours, isPaused, type Delivery, type DeliveryPatch, type PausePreset } from "@/shared/notification-centre";

export type ChannelPrefs = { inApp: boolean; push: boolean; mail?: boolean };
export interface SettingsAnswer { settings: Record<string, ChannelPrefs>; delivery?: Delivery }
export const SETTINGS_KEY = ["notifications", "settings-r97"] as const;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const PAUSE_LABELS: Record<PausePreset, string> = { "1h": "For 1 hour", "3h": "For 3 hours", tomorrow: "Until tomorrow morning" };

export function useNotificationSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api.get<SettingsAnswer>("/notifications/settings"), staleTime: 30_000 });
}

/** Saves a change and puts the answer in the cache; on an error the cache is left as it was (the control rolls back). */
export function useSaveSettings() {
  const qc = useQueryClient();
  return async (body: { settings?: Record<string, Partial<ChannelPrefs>>; delivery?: DeliveryPatch }, done?: string) => {
    const prev = qc.getQueryData<SettingsAnswer>(SETTINGS_KEY);
    if (prev && body.settings) {
      const next = { ...prev, settings: { ...prev.settings } };
      for (const [k, v] of Object.entries(body.settings)) next.settings[k] = { ...next.settings[k], ...v } as ChannelPrefs;
      qc.setQueryData(SETTINGS_KEY, next);
    }
    try {
      const r = await api.put<SettingsAnswer>("/notifications/settings", body);
      qc.setQueryData(SETTINGS_KEY, r);
      void qc.invalidateQueries({ queryKey: ["notifications", "settings"] });
      if (done) toast.success(done);
      return true;
    } catch (e) {
      if (prev) qc.setQueryData(SETTINGS_KEY, prev);
      showError(e as Error);
      return false;
    }
  };
}

export function formatClock(iso: string, tz: string) {
  try { return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit", weekday: "short" }).format(new Date(iso)); } catch { return iso; }
}
function zoneLabel(tz: string) { return tz.replace(/_/g, " ").replace("/", ", "); }

function Row({ label, hint, children, id }: { label: string; hint?: string; children: React.ReactNode; id?: string }) {
  return (
    <div className="grid gap-2 border-b border-line px-4 py-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,280px)] sm:items-center sm:gap-6">
      <div className="min-w-0"><div id={id} className="text-[13.5px] font-medium">{label}</div>{hint && <p className="text-[12.5px] text-muted">{hint}</p>}</div>
      <div className="flex min-w-0 items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}

function CardHead({ title, text }: { title: string; text: string }) {
  return <div className="border-b border-line px-4 py-3"><h3 className="text-[14px] font-semibold">{title}</h3><p className="text-[12.5px] text-muted">{text}</p></div>;
}

/** The three delivery cards under the category table on Settings, Notifications. */
export function DeliverySettings({ delivery, anyMail }: { delivery: Delivery; anyMail: boolean }) {
  const save = useSaveSettings();
  const zones = useMemo(() => {
    const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    return all.includes(delivery.timezone) ? all : [delivery.timezone, ...all];
  }, [delivery.timezone]);
  const d = delivery;
  const now = new Date();
  const paused = isPaused(now, d);
  const quietNow = !paused && inQuietHours(now, d);
  const setDays = (day: number) => {
    const days = d.quiet.days.includes(day) ? d.quiet.days.filter((x) => x !== day) : [...d.quiet.days, day];
    void save({ delivery: { quiet: { days } } });
  };
  return (
    <div className="space-y-4" data-testid="notification-delivery">
      <Card className="p-0" data-testid="mail-delivery">
        <CardHead title="Mail" text="Pick the categories above with the Mail switch. Choose whether each one arrives on its own or in one digest." />
        <Row label="How mail arrives" id="nc-freq-label" hint={anyMail ? undefined : "Turn on Mail for at least one category to get mail."}>
          <Select aria-labelledby="nc-freq-label" data-testid="digest-frequency" className="w-full sm:w-56" value={d.digest.frequency}
            onChange={(e) => void save({ delivery: { digest: { frequency: e.target.value as Delivery["digest"]["frequency"] } } }, "Mail delivery saved")}>
            <option value="off">Each one as it happens</option>
            <option value="daily">Daily digest</option>
            <option value="weekly">Weekly digest</option>
          </Select>
        </Row>
        {d.digest.frequency !== "off" && (
          <Row label="Digest time" id="nc-time-label" hint={`In your time zone, ${zoneLabel(d.timezone)}. Only unread items are listed; nothing new means no mail.`}>
            {d.digest.frequency === "weekly" && (
              <Select aria-label="Digest day" data-testid="digest-weekday" className="w-full sm:w-36" value={String(d.digest.weekday)}
                onChange={(e) => void save({ delivery: { digest: { weekday: Number(e.target.value) } } }, "Digest day saved")}>
                {DAY_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
              </Select>
            )}
            <TimeInput aria-labelledby="nc-time-label" data-testid="digest-time" className="w-full sm:w-32" step={900} value={d.digest.time}
              onChange={(e) => { if (e.target.value) void save({ delivery: { digest: { time: e.target.value.slice(0, 5) } } }, "Digest time saved"); }} />
          </Row>
        )}
      </Card>

      <Card className="p-0" data-testid="quiet-hours">
        <CardHead title="Quiet hours" text="Phone and browser alerts and single mails stay silent during these hours. Everything still lands in Notifications." />
        <Row label="Use quiet hours" hint={quietNow ? "Quiet hours are on right now." : undefined}>
          <Switch label="Use quiet hours" checked={d.quiet.enabled} onChange={(v) => void save({ delivery: { quiet: { enabled: v } } }, v ? "Quiet hours on" : "Quiet hours off")} />
        </Row>
        {d.quiet.enabled && (<>
          <Row label="From and until" id="nc-quiet-label">
            <TimeInput aria-label="Quiet hours start" data-testid="quiet-start" className="w-full sm:w-32" step={900} value={d.quiet.start}
              onChange={(e) => { if (e.target.value) void save({ delivery: { quiet: { start: e.target.value.slice(0, 5) } } }); }} />
            <span className="text-[13px] text-muted">to</span>
            <TimeInput aria-label="Quiet hours end" data-testid="quiet-end" className="w-full sm:w-32" step={900} value={d.quiet.end}
              onChange={(e) => { if (e.target.value) void save({ delivery: { quiet: { end: e.target.value.slice(0, 5) } } }); }} />
          </Row>
          <Row label="Days" hint="The day a quiet period starts.">
            <div role="group" aria-label="Quiet days" className="flex flex-wrap gap-1">
              {DAYS.map((n, i) => (
                <button key={n} type="button" aria-pressed={d.quiet.days.includes(i)} aria-label={DAY_NAMES[i]} onClick={() => setDays(i)}
                  className={cn("h-8 min-w-10 rounded-lg border px-2 text-[12.5px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-10",
                    d.quiet.days.includes(i) ? "border-brand bg-brand text-white" : "border-line-strong text-muted hover:text-fg")}>{n}</button>
              ))}
            </div>
          </Row>
          <Row label="Let mentions and approvals through" hint="They still alert you during quiet hours.">
            <Switch label="Let mentions and approvals through" checked={d.quiet.allowUrgent} onChange={(v) => void save({ delivery: { quiet: { allowUrgent: v } } })} />
          </Row>
        </>)}
        <Row label="Time zone" id="nc-zone-label" hint="Quiet hours and digests follow this zone.">
          <Select aria-labelledby="nc-zone-label" data-testid="delivery-zone" className="w-full sm:w-64" value={d.timezone}
            onChange={(e) => void save({ delivery: { timezone: e.target.value } }, "Time zone saved")}>
            {zones.map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}
          </Select>
        </Row>
      </Card>

      <Card className="p-0" data-testid="pause-card">
        <CardHead title="Pause and new mail" text="Pause every alert for a while, or stop alerts for each new mail." />
        <Row label={paused ? `Paused until ${formatClock(d.pausedUntil!, d.timezone)}` : "Pause alerts"} hint={paused ? "Alerts start again by themselves." : "Items still land in Notifications."}>
          {paused
            ? <Button size="sm" variant="secondary" onClick={() => void save({ delivery: { pause: "resume" } }, "Alerts are back on")}>Resume now</Button>
            : <PauseMenu />}
        </Row>
        <Row label="Alert me for each new mail" hint="Phone and browser alerts for new mail in mailboxes you can open.">
          <Switch label="Alert me for each new mail" checked={d.newMail} onChange={(v) => void save({ delivery: { newMail: v } })} />
        </Row>
      </Card>
    </div>
  );
}

export function PauseMenu({ size = "sm" }: { size?: "sm" | "md" }) {
  const save = useSaveSettings();
  return (
    <Menu label="Pause alerts" trigger={<Button size={size} variant="secondary" data-testid="pause-alerts"><IconClock className="h-4 w-4" />Pause</Button>}>
      {(Object.keys(PAUSE_LABELS) as PausePreset[]).map((p) => (
        <MenuItem key={p} onSelect={() => void save({ delivery: { pause: p } }, "Alerts paused")}>{PAUSE_LABELS[p]}</MenuItem>
      ))}
    </Menu>
  );
}

/** Notifications page: one quiet line while alerts are paused or in quiet hours, with the way back. */
export function AlertStatusLine() {
  const q = useNotificationSettings();
  const save = useSaveSettings();
  const d = q.data?.delivery;
  if (!d) return null;
  const now = new Date();
  const paused = isPaused(now, d);
  const quiet = !paused && inQuietHours(now, d);
  if (!paused && !quiet) return null;
  return (
    <div role="status" data-testid="alert-status" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-fill px-3 py-2 text-[13px]">
      <IconBell className="h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">{paused ? `Alerts paused until ${formatClock(d.pausedUntil!, d.timezone)}. New items still arrive here.` : `Quiet hours until ${d.quiet.end}. New items still arrive here.`}</span>
      {paused && <Button size="sm" variant="ghost" onClick={() => void save({ delivery: { pause: "resume" } }, "Alerts are back on")}>Resume</Button>}
    </div>
  );
}
