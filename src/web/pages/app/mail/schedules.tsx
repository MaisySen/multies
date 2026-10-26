import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconBellRing, IconCalendarClock, IconCalendarDays, IconClock, IconClose, IconEdit, IconInbox, IconSnooze, IconSunrise, IconToday, type IconComponent } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { isoToZonedInput, zonedDateTime } from "@/web/lib/format";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { EmptyState, Skeleton } from "@/web/components/ui/misc";
import type { MessageListItem } from "@/web/lib/types";

/** Round 20 (R20.3): Snoozed and Scheduled views, the snooze menu, send later and the returned strip. */

export type ScheduleView = "snoozed" | "scheduled";
export const SCHEDULE_VIEWS: { id: ScheduleView; label: string; icon: IconComponent }[] = [
  { id: "snoozed", label: "Snoozed", icon: IconSnooze },
  { id: "scheduled", label: "Scheduled", icon: IconCalendarClock },
];
export const isScheduleView = (v: string): v is ScheduleView => v === "snoozed" || v === "scheduled";

export type When = { preset: "later_today" | "tomorrow" | "next_week" } | { local: string };

export interface ScheduleItem {
  id: string;
  kind: "snooze" | "send" | "remind";
  status: "pending" | "returned" | "failed";
  mailboxId: string;
  threadId: string | null;
  messageId: string | null;
  dueAt: string;
  error: string | null;
  message: MessageListItem | null;
  send: { to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; inReplyToId: string | null; remindDays: number | null } | null;
}

const PRESETS: { id: "later_today" | "tomorrow" | "next_week"; label: string; icon: IconComponent }[] = [
  { id: "later_today", label: "Later today", icon: IconToday },
  { id: "tomorrow", label: "Tomorrow", icon: IconSunrise },
  { id: "next_week", label: "Next week", icon: IconCalendarDays },
];

/** "Tomorrow, 8:00 am" style labels, in the person's zone, so a choice says what it means. */
export function presetHint(id: "later_today" | "tomorrow" | "next_week") {
  return id === "later_today" ? "In about 3 hours" : id === "tomorrow" ? "8:00 am" : "Monday, 8:00 am";
}

export const scheduleKeys = { all: ["mail", "schedules"] as const, view: (view: string, mailboxId: string) => ["mail", "schedules", view, mailboxId] as const };

export function useScheduleList(view: ScheduleView | "returned", mailboxId: string, enabled = true) {
  return useQuery({
    queryKey: scheduleKeys.view(view, mailboxId),
    enabled: enabled && !!mailboxId,
    queryFn: async () => (await api.get<{ items: ScheduleItem[] }>(`/mail-schedules?${new URLSearchParams({ view, mailboxId })}`)).items,
    refetchInterval: 30_000,
  });
}

/** A date and time picker in the person's own zone. */
function PickTime({ open, title, onClose, onPick }: { open: boolean; title: string; onClose: () => void; onPick: (local: string) => void }) {
  const [value, setValue] = useState(() => isoToZonedInput(new Date(Date.now() + 24 * 3_600_000)).slice(0, 11) + "09:00");
  return (
    <Dialog open={open} onClose={onClose} title={title} description="Times are in your own time zone."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => { onPick(value); onClose(); }} disabled={!value}>Save</Button></>}>
      <label className="block text-[13px] text-muted">Date and time
        <input type="datetime-local" aria-label="Date and time" value={value} onChange={(e) => setValue(e.target.value)}
          className="mt-1.5 h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg outline-none focus:border-[#0071E3]" />
      </label>
    </Dialog>
  );
}

/** The snooze button in the reader toolbar. */
export function SnoozeMenu({ messageId, onDone }: { messageId: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const snooze = useMutation({
    mutationFn: (when: When) => api.post<{ dueAt: string }>("/mail-schedules/snooze", { messageId, ...when }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["mail"] });
      toast.success(`Snoozed until ${zonedDateTime(r.dueAt)}`);
      onDone?.();
    },
    onError: (e) => showError(e),
  });
  return (
    <>
      <Menu label="Snooze" trigger={<button type="button" className="rounded-md p-2 text-muted hover:bg-hover hover:text-fg" title="Snooze" data-testid="snooze-menu"><IconSnooze className="h-4 w-4" /></button>}>
        <MenuLabel>Snooze until</MenuLabel>
        {PRESETS.map((p) => (
          <MenuItem key={p.id} icon={<p.icon />} onSelect={() => snooze.mutate({ preset: p.id })}>
            <span className="flex-1">{p.label}</span><span className="text-[12px] text-subtle">{presetHint(p.id)}</span>
          </MenuItem>
        ))}
        <MenuItem icon={<IconCalendarClock />} onSelect={() => setPicking(true)}>Pick date and time</MenuItem>
      </Menu>
      <PickTime open={picking} title="Snooze until" onClose={() => setPicking(false)} onPick={(local) => snooze.mutate({ local })} />
    </>
  );
}

/** Send later, next to Send in Compose. Compose sits at the bottom of the screen, so this opens upward. */
export function SendLaterMenu({ disabled, onPick }: { disabled?: boolean; onPick: (when: When) => void }) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(), 0);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey, true); };
  }, [open]);
  const pick = (w: When) => { setOpen(false); onPick(w); };
  return (
    <div ref={ref} className="relative">
      <button type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-label="Schedule for later" onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-line px-2.5 py-2 text-muted hover:bg-hover hover:text-fg disabled:opacity-50" title="Send later" data-testid="send-later"><IconClock className="h-4 w-4" /></button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-50 mb-1.5 min-w-56 origin-bottom-left animate-pop-in rounded-xl border border-line bg-elevated p-1 shadow-pop">
          <MenuLabel>Send later</MenuLabel>
          {PRESETS.map((p) => (
            <MenuItem key={p.id} icon={<p.icon />} onSelect={() => pick({ preset: p.id })}>
              <span className="flex-1">{p.label}</span><span className="text-[12px] text-subtle">{presetHint(p.id)}</span>
            </MenuItem>
          ))}
          <MenuItem icon={<IconCalendarClock />} onSelect={() => { setOpen(false); setPicking(true); }}>Pick date and time</MenuItem>
        </div>
      )}
      <PickTime open={picking} title="Send later" onClose={() => setPicking(false)} onPick={(local) => onPick({ local })} />
    </div>
  );
}

export const REMIND_CHOICES = [0, 1, 2, 3, 5, 7, 14] as const;

/** "Remind me if no reply" in Compose. 0 means off. */
export function RemindSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <label className={cn("flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] hover:bg-hover", value ? "text-[#0071E3]" : "text-muted")} title="Bring this thread back if nobody replies">
      <IconBellRing className="h-3.5 w-3.5" aria-hidden />
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} className="cursor-pointer bg-transparent outline-none" aria-label="Remind me if no reply">
        {REMIND_CHOICES.map((n) => <option key={n} value={n}>{n === 0 ? "No reminder" : `Remind in ${n} day${n > 1 ? "s" : ""}`}</option>)}
      </select>
    </label>
  );
}

function Chip({ tone, children }: { tone: "brand" | "warn"; children: React.ReactNode }) {
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", tone === "brand" ? "bg-[#0071E3]/10 text-[#0071E3]" : "bg-amber-500/15 text-amber-700 dark:text-amber-400")}>{children}</span>;
}

/** Snoozed threads and reminders that came back: on top of Inbox, marked, until opened. */
export function ReturnedStrip({ items, onOpen }: { items: ScheduleItem[]; onOpen: (item: ScheduleItem) => void }) {
  if (!items.length) return null;
  return (
    <ul aria-label="Back in your inbox" className="border-b border-line bg-[#0071E3]/[0.03]">
      {items.map((it) => it.message && (
        <li key={it.id}>
          <button type="button" onClick={() => onOpen(it)} data-testid="returned-row" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover">
            {it.kind === "snooze" ? <IconSnooze className="h-4 w-4 shrink-0 text-[#0071E3]" aria-hidden /> : <IconBellRing className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">{it.message.subject || "(no subject)"}</span>
              <span className="block truncate text-[12.5px] text-muted">{it.message.from.name || it.message.from.address} · {it.message.snippet}</span>
            </span>
            {it.kind === "snooze" ? <Chip tone="brand">Snoozed</Chip> : <Chip tone="warn">No reply yet</Chip>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The Snoozed and Scheduled views. `onEdit` puts a scheduled message back into Compose. */
export function ScheduleListView({ view, mailboxId, onOpen, onEdit }: {
  view: ScheduleView; mailboxId: string; onOpen: (messageId: string) => void; onEdit: (item: ScheduleItem) => void;
}) {
  const qc = useQueryClient();
  const list = useScheduleList(view, mailboxId);
  const [moving, setMoving] = useState<ScheduleItem | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: ["mail"] });
  const cancel = useMutation({
    mutationFn: (it: ScheduleItem) => api.del(`/mail-schedules/${it.id}`),
    onSuccess: (_r, it) => { done(); toast.success(it.kind === "snooze" ? "Back in Inbox" : it.kind === "send" ? "Scheduled send cancelled" : "Reminder removed"); },
    onError: (e) => showError(e),
  });
  const move = useMutation({
    mutationFn: ({ it, local }: { it: ScheduleItem; local: string }) => api.patch<{ dueAt: string }>(`/mail-schedules/${it.id}`, { local }),
    onSuccess: (r) => { done(); toast.success(`Moved to ${zonedDateTime(r.dueAt)}`); },
    onError: (e) => showError(e),
  });
  if (list.isPending) return <div className="p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="mb-2 h-14" />)}</div>;
  const items = list.data ?? [];
  if (!items.length) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <EmptyState icon={view === "snoozed" ? <IconSnooze /> : <IconCalendarClock />} title={view === "snoozed" ? "Nothing snoozed" : "Nothing scheduled"}
          body={view === "snoozed" ? "Snooze a thread from its toolbar and it comes back to the top of Inbox when you choose." : "Use the clock next to Send to send a message later, or set a reminder for when nobody replies."} />
      </div>
    );
  }
  return (
    <>
      <ul className="divide-y divide-line" aria-label={view === "snoozed" ? "Snoozed threads" : "Scheduled mail"}>
        {items.map((it) => {
          const subject = it.send?.subject ?? it.message?.subject ?? "";
          const who = it.send ? `To: ${it.send.to.join(", ")}` : it.message ? (it.message.from.name || it.message.from.address) : "";
          return (
            <li key={it.id} data-testid="schedule-row" className="flex items-center gap-3 px-4 py-3">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => it.messageId && onOpen(it.messageId)} disabled={!it.messageId}>
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{subject || "(no subject)"}</span>
                  {it.kind === "remind" && <Chip tone="warn">Reminder</Chip>}
                  {it.status === "failed" && <Chip tone="warn">Not sent</Chip>}
                </span>
                <span className="block truncate text-[12.5px] text-muted">{who}</span>
                <span className="block text-[12px] text-subtle">
                  {it.kind === "snooze" ? "Back " : it.kind === "send" ? "Sends " : "If no reply by "}{zonedDateTime(it.dueAt)}
                  {it.send?.remindDays ? `, reminder after ${it.send.remindDays} day${it.send.remindDays > 1 ? "s" : ""}` : ""}
                </span>
                {it.error && <span className="block text-[12px] text-bad">{it.error}</span>}
                {(it.send as { held?: string | null } | null)?.held && <span className="block text-[12px] text-warn" data-testid="queued-reason">Queued until tomorrow: {(it.send as { held?: string | null }).held!.replace(/ ?Queued until tomorrow[^.]*\./, "")}</span>}
              </button>
              <div className="flex shrink-0 items-center gap-1">
                {it.kind === "send" && (
                  <button type="button" className="rounded-md p-2 text-muted hover:bg-hover hover:text-fg" title="Edit" aria-label="Edit" onClick={() => onEdit(it)}><IconEdit className="h-4 w-4" /></button>
                )}
                <button type="button" className="rounded-md p-2 text-muted hover:bg-hover hover:text-fg" title="Change time" aria-label="Change time" onClick={() => setMoving(it)}><IconClock className="h-4 w-4" /></button>
                <button type="button" className="rounded-md px-2 py-1.5 text-[12.5px] font-medium text-muted hover:bg-hover hover:text-fg" onClick={() => cancel.mutate(it)}>
                  {it.kind === "snooze" ? <span className="flex items-center gap-1"><IconInbox className="h-3.5 w-3.5" aria-hidden />Unsnooze</span> : <span className="flex items-center gap-1"><IconClose className="h-3.5 w-3.5" aria-hidden />Cancel</span>}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <PickTime open={!!moving} title="Change time" onClose={() => setMoving(null)} onPick={(local) => moving && move.mutate({ it: moving, local })} />
    </>
  );
}
