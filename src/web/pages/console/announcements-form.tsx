/**
 * OPS1: the Announcements form: text with a live count, tone, audience, an optional link, an optional window in the
 * operator's local time (the app's DateInput and TimeInput, so the day reads in the operator's own order, never a
 * fixed mm/dd/yyyy), and whether people can close it. Beside it a live preview draws the real
 * AnnouncementBanner exactly as customers will see it, and a plain sentence says who sees it and when.
 * Validation is the server's own (announcementInput from shared/announcement.ts).
 */
import { useMemo, useState, type ReactNode } from "react";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { Card } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { DateInput, Field, Input, Textarea, TimeInput } from "@/web/components/ui/input";
import { Switch } from "@/web/components/ui/misc";
import { AnnouncementBanner } from "@/web/components/announcement-banner";
import {
  ANNOUNCEMENT_LINK_LABEL_MAX, ANNOUNCEMENT_TEXT_MAX, announcementInput, type Announcement, type AnnouncementAudience, type AnnouncementTone, type PublicAnnouncement,
} from "@/shared/announcement";
import { useOperatorAction } from "./components/reason-dialog";
import { formatDateTime } from "./components/format";

export interface AnnouncementState {
  announcement: Announcement | null;
  status: "live" | "scheduled" | "ended" | null;
  updatedByEmail: string | null;
}

export const TONES: { value: AnnouncementTone; label: string; hint: string; swatch: string }[] = [
  { value: "info", label: "Information", hint: "News or a heads up.", swatch: "bg-brand-soft border-brand/25" },
  { value: "warning", label: "Warning", hint: "Something people should plan around.", swatch: "bg-warn-soft border-warn/20" },
  { value: "critical", label: "Critical", hint: "An outage or something urgent.", swatch: "bg-bad-soft border-bad/20" },
];

export const AUDIENCES: { value: AnnouncementAudience; label: string; hint: string }[] = [
  { value: "all", label: "Everyone", hint: "Everyone signed in to Multies." },
  { value: "admins", label: "Workspace owners and admins", hint: "Only owners and admins of each workspace." },
];

export interface AnnouncementDraft {
  text: string; tone: AnnouncementTone; audience: AnnouncementAudience; linkLabel: string; linkUrl: string;
  /** The day (yyyy-mm-dd) and time (HH:mm) in the operator's own time zone ("" = not set). */
  startsDate: string; startsTime: string; endsDate: string; endsTime: string; dismissible: boolean;
}

/** A day and time as a datetime-local value: no day is "" (not set); a day without a time is midnight. */
export function joinLocal(date: string, time: string): string {
  return date ? `${date}T${time || "00:00"}` : "";
}

/** An instant as a datetime-local value in this browser's time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** A datetime-local value (this browser's time zone) as an ISO instant; null when empty or not a time. */
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function draftFrom(a: Announcement | null): AnnouncementDraft {
  const starts = toLocalInput(a?.startsAt ?? null), ends = toLocalInput(a?.endsAt ?? null);
  return {
    text: a?.text ?? "", tone: a?.tone ?? "info", audience: a?.audience ?? "all",
    linkLabel: a?.linkLabel ?? "", linkUrl: a?.linkUrl ?? "",
    startsDate: starts.slice(0, 10), startsTime: starts.slice(11, 16), endsDate: ends.slice(0, 10), endsTime: ends.slice(11, 16),
    dismissible: a?.dismissible ?? true,
  };
}

/** The body PUT /api/console/announcements takes (without the reason). */
export function bodyOf(d: AnnouncementDraft) {
  return {
    text: d.text, tone: d.tone, audience: d.audience,
    linkLabel: d.linkLabel.trim() || null, linkUrl: d.linkUrl.trim() || null,
    startsAt: fromLocalInput(joinLocal(d.startsDate, d.startsTime)), endsAt: fromLocalInput(joinLocal(d.endsDate, d.endsTime)), dismissible: d.dismissible,
  };
}

/** Field to message, from the same rules the server applies. */
export function problemsOf(d: AnnouncementDraft): Record<string, string> {
  const out: Record<string, string> = {};
  if (d.startsTime && !d.startsDate) out.startsAt = "Pick a day for this time.";
  if (d.endsTime && !d.endsDate) out.endsAt = "Pick a day for this time.";
  const r = announcementInput.safeParse(bodyOf(d));
  if (r.success) return out;
  for (const i of r.error.issues) {
    const k = String(i.path[0] ?? "text");
    if (!out[k]) out[k] = i.message;
  }
  return out;
}

/** "Everyone signed in to Multies sees it from ... until you remove it." */
export function whoAndWhen(d: AnnouncementDraft): string {
  const who = d.audience === "admins" ? "Owners and admins of every workspace see it" : "Everyone signed in to Multies sees it";
  const start = fromLocalInput(joinLocal(d.startsDate, d.startsTime)), end = fromLocalInput(joinLocal(d.endsDate, d.endsTime));
  const from = start && Date.parse(start) > Date.now() ? `from ${formatDateTime(start)}` : "as soon as you publish";
  const until = end ? `until ${formatDateTime(end)}` : "until you remove it";
  return `${who} ${from}, ${until}.`;
}

function Choice({ checked, onSelect, label, hint, swatch, testId, name }: {
  checked: boolean; onSelect: () => void; label: string; hint: string; swatch?: string; testId: string; name: string;
}) {
  return (
    <label className={cn(
      "flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-brand/50",
      checked ? "border-brand bg-brand-soft/40" : "border-line hover:bg-hover",
    )} data-testid={testId}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="mt-1 accent-brand" />
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium">
          {swatch && <span className={cn("h-3 w-3 shrink-0 rounded-sm border", swatch)} aria-hidden />}
          {label}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
}

function Group({ legend, children, className }: { legend: string; children: ReactNode; className?: string }) {
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className="mb-1.5 text-[13px] font-medium text-fg/90">{legend}</legend>
      <div className={cn("grid gap-2", className)}>{children}</div>
    </fieldset>
  );
}

function zoneName(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "your time zone"; } catch { return "your time zone"; }
}

export function AnnouncementForm({ current }: { current: Announcement | null }) {
  const [d, setD] = useState<AnnouncementDraft>(() => draftFrom(current));
  const [tried, setTried] = useState(false);
  const set = <K extends keyof AnnouncementDraft>(k: K, v: AnnouncementDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const problems = useMemo(() => problemsOf(d), [d]);
  const valid = Object.keys(problems).length === 0;
  // Show a field's problem once it has something in it, or after a publish attempt.
  const shown = (k: keyof AnnouncementDraft) => (tried || (typeof d[k] === "string" && d[k] !== "") ? problems[k] : undefined);
  // The window's problems are filed under the server's names (startsAt, endsAt); show them once either half is filled.
  const windowProblem = (k: "startsAt" | "endsAt") => {
    const filled = k === "startsAt" ? d.startsDate || d.startsTime : d.endsDate || d.endsTime;
    return tried || filled ? problems[k] : undefined;
  };
  const count = d.text.trim().length;
  const preview: PublicAnnouncement = {
    id: "preview", text: d.text.trim() || "Your announcement text shows here.", tone: d.tone, audience: d.audience,
    linkLabel: d.linkLabel.trim() || null, linkUrl: d.linkUrl.trim().startsWith("https://") ? d.linkUrl.trim() : null,
    startsAt: null, endsAt: null, dismissible: d.dismissible,
  };
  const sentence = whoAndWhen(d);

  const publish = useOperatorAction<void>({
    title: "Publish this announcement?",
    description: () => `${sentence}${current ? " It replaces the current announcement." : ""} Open sessions may take a few minutes to show it.`,
    confirmLabel: "Publish",
    run: (_v, reason) => api.put<AnnouncementState>("/console/announcements", { ...bodyOf(d), reason }),
    success: "Announcement published",
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card className="space-y-5 p-4 sm:p-5" data-testid="console-announcements-form">
        <h2 className="text-[15px] font-semibold">{current ? "Publish a new version" : "Write an announcement"}</h2>
        <Field label="Text" error={shown("text")} hint={<span data-testid="console-announcements-count" className={cn("tabular-nums", count > ANNOUNCEMENT_TEXT_MAX && "text-bad")}>{count} of {ANNOUNCEMENT_TEXT_MAX} characters. One line of plain text.</span>}>
          {(p) => <Textarea {...p} rows={3} value={d.text} onChange={(e) => set("text", e.target.value)} data-testid="console-announcements-text" placeholder="Scheduled maintenance tonight from 22:00 UTC. Mail may arrive a few minutes late." />}
        </Field>
        <Group legend="Tone" className="sm:grid-cols-3">
          {TONES.map((t) => <Choice key={t.value} name="ann-tone" checked={d.tone === t.value} onSelect={() => set("tone", t.value)} label={t.label} hint={t.hint} swatch={t.swatch} testId={`console-announcements-tone-${t.value}`} />)}
        </Group>
        <Group legend="Who sees it" className="sm:grid-cols-2">
          {AUDIENCES.map((a) => <Choice key={a.value} name="ann-audience" checked={d.audience === a.value} onSelect={() => set("audience", a.value)} label={a.label} hint={a.hint} testId={`console-announcements-audience-${a.value}`} />)}
        </Group>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Link label (optional)" error={shown("linkLabel")} hint={`Up to ${ANNOUNCEMENT_LINK_LABEL_MAX} characters, for example "Status page".`}>
            {(p) => <Input {...p} value={d.linkLabel} onChange={(e) => set("linkLabel", e.target.value)} data-testid="console-announcements-link-label" autoComplete="off" />}
          </Field>
          <Field label="Link (optional)" error={shown("linkUrl")} hint="A full https:// address. Opens in a new tab.">
            {(p) => <Input {...p} type="url" value={d.linkUrl} onChange={(e) => set("linkUrl", e.target.value)} data-testid="console-announcements-link-url" placeholder="https://" autoComplete="off" />}
          </Field>
        </div>
        <div className="grid gap-4">
          <Field label="Starts (optional)" error={windowProblem("startsAt")} hint={`Your local time (${zoneName()}). Empty starts at once.`}>
            {(p) => (
              <span className="grid grid-cols-[minmax(0,1fr)_minmax(0,8.5rem)] sm:grid-cols-[minmax(0,13rem)_minmax(0,9rem)] gap-2">
                <DateInput {...p} value={d.startsDate} onChange={(e) => set("startsDate", e.target.value)} data-testid="console-announcements-starts" />
                <span className="relative min-w-0"><TimeInput aria-label="Start time" aria-invalid={p["aria-invalid"]} value={d.startsTime} onChange={(e) => set("startsTime", e.target.value)} data-testid="console-announcements-starts-time" /></span>
              </span>
            )}
          </Field>
          <Field label="Ends (optional)" error={windowProblem("endsAt")} hint="Empty keeps it up until you remove it.">
            {(p) => (
              <span className="grid grid-cols-[minmax(0,1fr)_minmax(0,8.5rem)] sm:grid-cols-[minmax(0,13rem)_minmax(0,9rem)] gap-2">
                <DateInput {...p} value={d.endsDate} onChange={(e) => set("endsDate", e.target.value)} data-testid="console-announcements-ends" />
                <span className="relative min-w-0"><TimeInput aria-label="End time" aria-invalid={p["aria-invalid"]} value={d.endsTime} onChange={(e) => set("endsTime", e.target.value)} data-testid="console-announcements-ends-time" /></span>
              </span>
            )}
          </Field>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-line px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-sm font-medium">People can dismiss it</span>
            <span className="block text-xs text-muted">Off keeps it on screen until it ends or you remove it.</span>
          </span>
          <Switch checked={d.dismissible} onChange={(v) => set("dismissible", v)} label="People can dismiss it" testId="console-announcements-dismissible" />
        </div>
        <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted">Open sessions may take a few minutes to show a change.</p>
          <Button onClick={() => { setTried(true); if (valid) publish.open(); }} data-testid="console-announcements-publish">Publish</Button>
        </div>
      </Card>
      <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <Card className="space-y-3 p-4 sm:p-5">
          <h2 className="text-[15px] font-semibold">Preview</h2>
          <p className="text-sm text-muted">Exactly as it shows at the top of the web app. The phone app does not show it yet.</p>
          <div className="overflow-hidden rounded-lg border border-line bg-bg" data-testid="console-announcements-preview">
            <div className="flex h-9 items-center gap-2 border-b border-line bg-surface px-3" aria-hidden>
              <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
              <span className="h-2 w-24 rounded-full bg-fill" />
            </div>
            <AnnouncementBanner announcement={preview} role="owner" preview />
            <div className="space-y-2 p-3" aria-hidden>
              <span className="block h-2 w-3/4 rounded-full bg-fill" />
              <span className="block h-2 w-1/2 rounded-full bg-fill" />
            </div>
          </div>
          <p className="text-sm" data-testid="console-announcements-who">{sentence}</p>
        </Card>
      </div>
      {publish.dialog}
    </div>
  );
}
