/**
 * The notifications inbox: mentions, assignments, comments, approvals and due-soon items in one place.
 * R31 triage: Inbox / Later / Done with counts, grouped by day, keyboard triage (J/K, Enter or O, E done with undo,
 * H snooze, U read, Shift E undo) and hover buttons. Every action is optimistic and rolls back on an error.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateInput } from "@/web/components/ui/input"; // R67 (MB-250)
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconBell, IconCheck, IconCheckCircle, IconCheckDouble, IconClock, IconInbox, IconMail, IconRead } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { isTypingTarget } from "@/web/lib/shortcuts";
import { groupByDay, moveOut, nextFocus, pickedDateIso, SNOOZE_LABELS, TRIAGE_VIEWS, triageActionFor, VIEW_LABELS, type SnoozePreset, type TriageView, type ViewCounts } from "@/web/lib/triage";
import { Button } from "@/web/components/ui/button";
import { Card, EmptyState, PageHeader, Switch } from "@/web/components/ui/misc";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { BrowserNotifications } from "@/web/components/browser-notifications-r32"; // R32: web push
import { CaughtUpArt } from "@/web/components/illustrations"; // R36
import { KindTile } from "@/web/components/premium4-r39"; // R39 premium pass 4
import { NOTIFICATION_FILTER_KEY, readStoredFilter } from "@/web/lib/premium4-r39";
import { AlertStatusLine, DeliverySettings, PauseMenu, useNotificationSettings, useSaveSettings, type ChannelPrefs } from "@/web/components/notification-centre-r97"; // R97
import { LoadError, LoadErrorInline } from "@/web/components/load-error-t1g";

export type NotificationCategory = "mention" | "assignment" | "comment" | "approval" | "due_soon" | "chat" | "email" | "status";
export interface InboxItem { id: string; type: string; category: NotificationCategory; entityType: string; entityId: string; title: string; actor: { name: string } | null; read: boolean; createdAt: string; link: string; doneAt: string | null; snoozedUntil: string | null }
interface InboxPage { notifications: InboxItem[]; unread: number; counts: Record<NotificationCategory, number>; hasMore: boolean; view: TriageView; viewCounts: ViewCounts }

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  mention: "Mentions", assignment: "Assigned to me", comment: "Comments and replies", approval: "Approvals", due_soon: "Due soon", chat: "Direct messages", email: "Mail on tasks", status: "Status changes",
};
const FILTERS: (NotificationCategory | "all")[] = ["all", "mention", "assignment", "comment", "approval", "due_soon", "chat", "email", "status"];
/** Where an item lives, read from its entity type. */
const PLACE: Record<string, string> = { task: "Task", chat_message: "Chat", approval: "Approvals", message: "Mail", thread: "Inbox", goal: "Goals", meeting: "Meetings", file_request: "Secure share", secret: "Secure share", share: "Secure share" };

export function useUnreadNotifications(enabled: boolean) {
  return useQuery({ queryKey: ["notifications", "count"], enabled, refetchInterval: 30_000, queryFn: async () => (await api.get<InboxPage>("/notifications?limit=1")).unread });
}

export function NotificationsPage() {
  const centreQ = useNotificationSettings(); // R97: pause menu and status line when the centre is on
  const [view, setView] = useState<TriageView>("inbox");
  // R39: the chosen filter chip sticks per device.
  const [filter, setFilterState] = useState<NotificationCategory | "all">(() => readStoredFilter(FILTERS, "all"));
  const setFilter = useCallback((f: NotificationCategory | "all") => { setFilterState(f); try { localStorage.setItem(NOTIFICATION_FILTER_KEY, f); } catch { /* storage blocked */ } }, []);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const lastDone = useRef<string[]>([]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = useMemo(() => ["notifications", "triage", view, filter, unreadOnly] as const, [view, filter, unreadOnly]);
  const q = useQuery({
    queryKey: key, refetchInterval: 30_000,
    queryFn: () => api.get<InboxPage>(`/notifications?view=${view}&limit=100${filter !== "all" ? `&category=${filter}` : ""}${unreadOnly ? "&unread=1" : ""}`),
  });
  const items = useMemo(() => q.data?.notifications ?? [], [q.data]);
  const ids = useMemo(() => items.map((n) => n.id), [items]);
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ["notifications"] }), [qc]);
  useEffect(() => { if (!focus || !ids.includes(focus)) setFocus(ids[0] ?? null); }, [ids, focus]);

  /** Applies an optimistic change, runs the request, rolls back on an error. */
  const optimistic = useCallback(async (change: (p: InboxPage) => InboxPage, run: () => Promise<unknown>) => {
    const before = qc.getQueryData<InboxPage>(key);
    if (before) qc.setQueryData(key, change(before));
    try { await run(); return true; } catch (e) { if (before) qc.setQueryData(key, before); showError(e as Error); return false; } finally { void refresh(); }
  }, [qc, key, refresh]);

  const undone = useCallback(async (id: string) => {
    try { await api.post(`/notifications/${id}/undone`, {}); } catch (e) { showError(e as Error); }
    lastDone.current = lastDone.current.filter((x) => x !== id);
    void refresh();
  }, [refresh]);

  const done = useCallback(async (n: InboxItem) => {
    if (view === "done") return;
    setFocus(nextFocus(ids, n.id));
    const ok = await optimistic((p) => moveOut(p, view, n.id, "done"), () => api.post(`/notifications/${n.id}/done`, {}));
    if (ok) {
      lastDone.current = [n.id, ...lastDone.current].slice(0, 20);
      toast.success("Marked done", { id: "notif-undo", action: { label: "Undo", onClick: () => void undone(n.id) } });
    }
  }, [view, ids, optimistic, undone]);

  const snooze = useCallback(async (n: InboxItem, body: { preset: SnoozePreset } | { until: string }) => {
    setSnoozeFor(null);
    setFocus(nextFocus(ids, n.id));
    const ok = await optimistic((p) => (view === "later" ? p : moveOut(p, view, n.id, "later")), () => api.post(`/notifications/${n.id}/snooze`, body));
    if (ok) toast.success("Snoozed", { id: "notif-undo", action: { label: "Undo", onClick: () => void undone(n.id) } });
  }, [ids, optimistic, view, undone]);

  const toggleRead = useCallback(async (n: InboxItem) => {
    await optimistic((p) => ({ ...p, notifications: p.notifications.map((x) => (x.id === n.id ? { ...x, read: !x.read } : x)), unread: Math.max(0, p.unread + (n.read ? 1 : -1)) }),
      () => (n.read ? api.post(`/notifications/${n.id}/unread`, {}) : api.post("/notifications/read", { ids: [n.id] })));
  }, [optimistic]);

  const open = useCallback(async (n: InboxItem) => {
    if (!n.read) { try { await api.post("/notifications/read", { ids: [n.id] }); void refresh(); } catch { /* opening still works */ } }
    navigate(n.link);
  }, [navigate, refresh]);

  const restore = useCallback(async (n: InboxItem) => {
    await optimistic((p) => moveOut(p, view, n.id, "inbox"), () => api.post(`/notifications/${n.id}/undone`, {}));
  }, [optimistic, view]);

  // Page-local keys (J/K, Enter or O, E, Shift E, H, U). Typing in a field, a dialog or a modifier lets them through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector("[role=dialog]")) return;
      const action = triageActionFor(e);
      if (!action) return;
      const i = focus ? ids.indexOf(focus) : -1;
      const cur = i >= 0 ? items[i] : undefined;
      if (action === "next") setFocus(ids[Math.min(ids.length - 1, i + 1)] ?? null);
      else if (action === "prev") setFocus(ids[Math.max(0, i - 1)] ?? null);
      else if (action === "undo") { const id = lastDone.current[0]; if (id) void undone(id).then(() => toast("Back in the inbox")); }
      else if (!cur) return;
      else if (action === "open") void open(cur);
      else if (action === "done") void done(cur);
      else if (action === "snooze") setSnoozeFor(cur.id);
      else if (action === "toggle-read") void toggleRead(cur);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, ids, items, open, done, toggleRead, undone]);
  useEffect(() => { if (focus) document.getElementById(`ntf-${focus}`)?.scrollIntoView({ block: "nearest" }); }, [focus]);

  const markAll = async () => { try { await api.post("/notifications/read", filter === "all" ? {} : { category: filter }); await refresh(); } catch (e) { showError(e as Error); } };
  /** Everything shown in the Inbox to Done, in one request (the server writes in chunks). */
  const doneAll = async () => {
    const shown = [...ids];
    if (!shown.length) return;
    const ok = await optimistic((pg) => ({ ...pg, notifications: [], unread: Math.max(0, pg.unread - pg.notifications.filter((x) => !x.read).length), viewCounts: { ...pg.viewCounts, inbox: Math.max(0, pg.viewCounts.inbox - shown.length), done: pg.viewCounts.done + shown.length } }),
      () => api.post("/notifications/done", { ids: shown }));
    if (ok) {
      lastDone.current = [...shown, ...lastDone.current].slice(0, 200);
      toast.success(`${shown.length} marked done`, { id: "notif-undo", action: { label: "Undo", onClick: () => void Promise.all(shown.map((id) => api.post(`/notifications/${id}/undone`, {}))).then(refresh, (e: Error) => showError(e)) } });
    }
  };
  const counts = q.data?.counts;
  const vc = q.data?.viewCounts;
  const groups = groupByDay(items, view);
  // R97: the Pause menu shows when the centre is on and alerts are not already paused (the status line offers Resume).
  const centre = !!centreQ.data?.delivery && !(centreQ.data.delivery.pausedUntil && Date.parse(centreQ.data.delivery.pausedUntil) > Date.now());
  return (
    <div>
      <PageHeader title="Notifications" description="Mentions, work assigned to you, comments, approvals and anything due soon. Mark each one done or snooze it until later."
        actions={<div className="flex flex-wrap gap-2">{centre && <PauseMenu />}<Link to="/app/settings/notifications" className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] text-muted transition-colors duration-150 hover:bg-elevated hover:text-fg max-sm:min-h-11">Settings</Link>
          <Button size="sm" variant="secondary" onClick={markAll} disabled={!q.data?.unread}><IconCheckDouble className="h-4 w-4" />Mark all read</Button>
          {view === "inbox" && <Button size="sm" variant="secondary" onClick={() => void doneAll()} disabled={!items.length}><IconCheck className="h-4 w-4" />Mark all done</Button>}</div>} />
      <AlertStatusLine />
      <div className="mb-3 inline-flex rounded-lg bg-fill p-0.5" role="tablist" aria-label="Notification views">
        {TRIAGE_VIEWS.map((v) => (
          <button key={v} role="tab" aria-selected={view === v} data-testid={`triage-tab-${v}`} onClick={() => { setView(v); setFocus(null); }}
            className={cn("rounded-md px-3.5 py-1.5 text-[13px] transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
              view === v ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg", "max-sm:min-h-11")}>
            {VIEW_LABELS[v]}<span className="ml-1.5 tabular-nums text-subtle" data-testid={`triage-count-${v}`}>{vc ? vc[v] : ""}</span>
          </button>
        ))}
      </div>
      <div className="-mx-4 mb-4 flex items-center gap-1.5 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none] max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&>*]:shrink-0" role="group" aria-label="Filter notifications">
        {FILTERS.map((f) => (
          <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
            className={cn("rounded-full border px-3 py-1 text-[12.5px] tabular-nums transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11 max-sm:px-3.5", filter === f ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-line-strong hover:text-fg")}>
            {f === "all" ? "All" : CATEGORY_LABELS[f]}{f === "all" ? (q.data?.unread ? ` ${q.data.unread}` : "") : counts?.[f] ? ` ${counts[f]}` : ""}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-[13px] text-muted max-sm:min-h-11 max-sm:pl-2"><input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />Unread only</label>
      </div>
      {q.isPending ? <Card className="p-0"><SkeletonRows rows={6} label="Loading notifications" /></Card> : q.isError && !q.data ? (
        // POL2 (HQ MB-323): a failed read is not "all caught up"; it says so and offers Retry.
        <Card className="p-0" data-testid="notifications-error"><LoadError onRetry={() => q.refetch()} /></Card>
      ) : !items.length ? (
        view === "inbox" ? (
          <EmptyState icon={<IconCheckCircle />} art={<CaughtUpArt />} title="You're all caught up" body="When someone mentions you, assigns you work or needs an approval, it shows here."
            action={<Button size="sm" variant="secondary" onClick={() => setView("done")}>View done</Button>} />
        ) : view === "later" ? (
          <EmptyState icon={<IconClock />} art={<CaughtUpArt />} title="Nothing snoozed" body="Press H on a notification to snooze it. It comes back to your inbox at the time you pick." action={<Button size="sm" variant="secondary" onClick={() => setView("inbox")}>Back to inbox</Button>} />
        ) : (
          <EmptyState icon={<IconBell />} art={<CaughtUpArt />} title="Nothing done yet" body="Press E on a notification to mark it done. Done items stay here." action={<Button size="sm" variant="secondary" onClick={() => setView("inbox")}>Back to inbox</Button>} />
        )
      ) : (
        <Card className="p-0">
          <div data-testid="notifications-list" role="region" aria-label={`${VIEW_LABELS[view]} notifications`}>
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h2 className="sticky top-0 z-[1] border-b border-line bg-elevated/90 px-4 py-1.5 text-[11.5px] font-medium uppercase tracking-wide text-subtle backdrop-blur">{g.label}</h2>
                <ul>
                  {g.items.map((n) => (
                    <li key={n.id} id={`ntf-${n.id}`} aria-current={focus === n.id ? "true" : undefined} data-testid="notification-row" data-id={n.id}
                      onMouseEnter={() => setFocus(n.id)}
                      className={cn("group relative flex flex-wrap items-start gap-3 border-b border-line py-3 pl-2.5 pr-4 last:border-0 sm:flex-nowrap transition-colors duration-150 motion-reduce:transition-none", focus === n.id && "bg-fill")}>
                      <span className={cn("mt-4 h-2 w-2 shrink-0 rounded-full transition-colors duration-150 motion-reduce:transition-none", n.read ? "bg-transparent" : "bg-brand")} aria-hidden />
                      <KindTile kind={n.category} actor={n.actor?.name} />
                      <button onClick={() => void open(n)} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded">
                        <span className={cn("block text-[14px] leading-snug", !n.read && "font-semibold")}>{n.title}</span>
                        <span className="text-[12px] text-subtle">
                          {n.actor?.name ? `${n.actor.name} · ` : ""}{CATEGORY_LABELS[n.category]}{PLACE[n.entityType] ? ` in ${PLACE[n.entityType]}` : ""} · {timeAgo(n.createdAt)}
                          {n.snoozedUntil ? ` · back ${timeAgo(n.snoozedUntil).replace(/ ago$/, "")}` : ""}{n.read ? "" : " · unread"}
                        </span>
                      </button>
                      <div className={cn("flex shrink-0 items-center gap-0.5 opacity-0 max-sm:-mt-2 max-sm:basis-full max-sm:justify-end transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100", focus === n.id && "opacity-100")}>
                        {view !== "done" && <IconButton label="Mark done (E)" onClick={() => void done(n)}><IconCheck /></IconButton>}
                        {view !== "done" && <IconButton label="Snooze (H)" onClick={() => setSnoozeFor(snoozeFor === n.id ? null : n.id)}><IconClock /></IconButton>}
                        {view !== "inbox" && <IconButton label="Move to inbox" onClick={() => void restore(n)}><IconInbox /></IconButton>}
                        <IconButton label={n.read ? "Mark unread (U)" : "Mark read (U)"} onClick={() => void toggleRead(n)}>{n.read ? <IconMail /> : <IconRead />}</IconButton>
                      </div>
                      {snoozeFor === n.id && <SnoozeMenu onPick={(b) => void snooze(n, b)} onClose={() => setSnoozeFor(null)} />}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Card>
      )}
      <p className="mt-3 text-[12px] text-subtle max-sm:hidden">J and K to move, Enter to open, E done, H snooze, U read, Shift E undo.</p>
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-10 max-sm:w-10 [&_svg]:h-4 [&_svg]:w-4">
      {children}
    </button>
  );
}

/** The small snooze popover: three presets and a date. Esc closes it. */
function SnoozeMenu({ onPick, onClose }: { onPick: (b: { preset: SnoozePreset } | { until: string }) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [date, setDate] = useState("");
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("mousedown", onDown); };
  }, [onClose]);
  const min = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return (
    <div ref={ref} role="menu" aria-label="Snooze until" data-testid="snooze-menu"
      className="absolute right-4 top-11 z-10 w-56 rounded-xl border border-line bg-bg p-1 shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150">
      {(Object.keys(SNOOZE_LABELS) as SnoozePreset[]).map((p) => (
        <button key={p} role="menuitem" onClick={() => onPick({ preset: p })}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-fill focus-visible:bg-fill focus-visible:outline-none">
          <IconClock className="h-3.5 w-3.5 text-subtle" />{SNOOZE_LABELS[p]}
        </button>
      ))}
      <form className="mt-1 flex items-center gap-1 border-t border-line px-1.5 pt-1.5" onSubmit={(e) => { e.preventDefault(); const iso = pickedDateIso(date); if (iso) onPick({ until: iso }); }}>
        <label className="sr-only" htmlFor="snooze-date">Pick a date</label>
        <DateInput id="snooze-date" min={min} value={date} onChange={(e) => setDate(e.target.value)} className="h-7 min-w-0 flex-1 rounded-md border border-line bg-bg px-1.5 text-[12.5px]" />
        <Button size="sm" variant="secondary" type="submit" disabled={!date}>Set</Button>
      </form>
    </div>
  );
}

/** Settings, Notifications: per category, show in the inbox and push to my phone. */
export function NotificationSettings() {
  // R97: one query for the switches and the delivery settings; Mail column and delivery cards only when the server has them.
  const q = useNotificationSettings();
  const saveAll = useSaveSettings();
  const save = (c: NotificationCategory, patch: Partial<ChannelPrefs>) => void saveAll({ settings: { [c]: patch } });
  const delivery = q.data?.delivery;
  const s = q.data?.settings;
  const cols = delivery ? "grid-cols-[minmax(0,1fr)_52px_52px_52px] sm:grid-cols-[minmax(0,1fr)_96px_96px_96px]" : "grid-cols-[minmax(0,1fr)_64px_64px] sm:grid-cols-[minmax(0,1fr)_96px_96px]";
  const anyMail = !!s && Object.values(s).some((v) => v.mail);
  return (
    <div className="space-y-4">
      <div><h2 className="text-[15px] font-semibold">Notifications</h2><p className="text-[13.5px] text-muted">{delivery ? "Choose what shows in your inbox, what buzzes your phone and what reaches you by mail. Phone alerts carry no message text, only what to open." : "Choose what shows in your inbox and what buzzes your phone. Phone alerts carry no message text, only what to open."}</p></div>
      <BrowserNotifications />
      {q.isPending ? <Card className="p-0"><SkeletonRows rows={8} label="Loading notification settings" /></Card> : q.isError ? (
        <Card className="p-4"><LoadErrorInline onRetry={() => q.refetch()} /></Card>
      ) : (<>
        <Card className="p-0">
          {/* R39 premium pass 4: a grouped list with a kind tile per row instead of a bare table. */}
          <div data-testid="notification-settings" role="table" aria-label="Notification settings" className="text-[13.5px]">
            <div role="row" className={cn("grid items-center border-b border-line px-4 py-2 text-[12px] font-medium text-subtle", cols)}>
              <span role="columnheader">Category</span>
              <span role="columnheader" className="text-center"><span className="sm:hidden">Inbox</span><span className="max-sm:hidden">In the inbox</span></span>
              <span role="columnheader" className="text-center">Phone</span>
              {delivery && <span role="columnheader" className="text-center">Mail</span>}
            </div>
            {(Object.keys(CATEGORY_LABELS) as NotificationCategory[]).map((c) => (
              <div role="row" key={c} className={cn("grid items-center border-b border-line px-4 py-2.5 last:border-0", cols)}>
                <span role="cell" className="flex min-w-0 items-center gap-3"><KindTile kind={c} size="sm" /><span className="truncate font-medium">{CATEGORY_LABELS[c]}</span></span>
                <span role="cell" className="flex justify-center"><Switch label={`${CATEGORY_LABELS[c]} in the inbox`} checked={s?.[c]?.inApp ?? true} onChange={(v) => save(c, { inApp: v })} /></span>
                <span role="cell" className="flex justify-center"><Switch label={`${CATEGORY_LABELS[c]} on my phone`} checked={s?.[c]?.push ?? true} onChange={(v) => save(c, { push: v })} /></span>
                {delivery && <span role="cell" className="flex justify-center"><Switch label={`${CATEGORY_LABELS[c]} by mail`} checked={s?.[c]?.mail ?? false} onChange={(v) => save(c, { mail: v })} /></span>}
              </div>
            ))}
          </div>
        </Card>
        {delivery && <DeliverySettings delivery={delivery} anyMail={anyMail} />}
      </>)}
    </div>
  );
}
