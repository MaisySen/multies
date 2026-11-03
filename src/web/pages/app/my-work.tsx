/** My Work (round 20), the Today home since R35: a large dated title, summary cards with depth, a Focus list and quick add. */
import { formatDateIn } from "@/web/i18n/intl"; // R104
import { Suspense, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatCount } from "@/web/lib/format-count";
import { api } from "@/web/lib/api";
import { MyWorkNewTask } from "./work/my-work-new-task-load"; // F13b (MB-306)
import { GetStartedCard } from "@/web/components/tours-r130"; // R130
import { displayFirstName } from "@/shared/display-name";
import { Link, useNavigate } from "react-router";
import { MyDay } from "./work/my-day-r95"; // R95
import { IconApprovals, IconCalendarClock, IconCheck, IconChat, IconChevronRight, IconClipboardCheck, IconCompose, IconDocs, IconInbox, IconMail, IconMention, IconPlus, IconAlertCircle, IconRefresh, IconSnooze, IconTasks, IconUserCheck, IconVideo, IconWarning, type IconComponent } from "@/web/components/ui/icon";
import { ClearDayArt } from "@/web/components/illustrations";
import { Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { useMyWork, type MyWorkItem } from "@/web/lib/search";
import { allClear, focusItems, nextMeeting } from "@/web/lib/today";
import { useConfig, useMe } from "@/web/lib/queries";
import { useCounts } from "@/web/lib/counts";
import { dayPart } from "@/web/lib/format";
import { LoadError } from "@/web/components/load-error-t1g";
import { Button } from "@/web/components/ui/button";
import { tr, uiLocale, tl } from "@/web/i18n"; // R104

/** R56 (MB-247): the tile reads the meeting's time in the same zone as the list under it (the zone My Work was built in), not the browser's. */
function meetingTime(at: string, timeZone?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  try { return new Date(at).toLocaleTimeString(undefined, timeZone ? { ...opts, timeZone } : opts); } catch { return new Date(at).toLocaleTimeString(undefined, opts); }
}

function Section({ title, icon, items, empty, tone, testId }: { title: string; icon: ReactNode; items: MyWorkItem[]; empty: string; tone?: "danger"; testId: string }) {
  return (
    <Card className="elev-1 min-w-0 overflow-hidden rounded-[var(--radius-r14)] border-0 p-0" data-testid={testId}>
      <div className="hairline-b flex items-center gap-2 px-4 py-3">
        <span className={cn("text-subtle [&_svg]:h-4 [&_svg]:w-4", tone === "danger" && items.length > 0 && "text-bad")}>{icon}</span>
        <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
        {items.length > 0 && <span className={cn("ml-auto rounded-full px-2 py-0.5 text-[11.5px] font-medium", tone === "danger" ? "bg-bad/10 text-bad" : "bg-brand/10 text-brand-hover")}>{items.length}</span>}
      </div>
      {items.length ? (
        <ul className="divide-y divide-line">
          {items.map((it) => (
            <li key={it.id}>
              <Link to={it.url} className="pressable block px-4 py-2.5 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none max-sm:py-3">
                <span className="block truncate text-[13.5px] text-fg">{it.title}</span>
                {it.subtitle && <span className="block truncate text-xs text-subtle">{it.subtitle}</span>}
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className="px-4 py-3 text-[13px] text-muted">{empty}</p>}
    </Card>
  );
}

/**
 * One summary card: a tinted glyph tile, the number, what it counts, and where it goes.
 * R46 mobile: on a phone it is a compact tile like the system Reminders lists (glyph left, number right, label under);
 * `wide` lays a card out in one row so a lone last card does not stretch into a tall empty box.
 */
function Stat({ to, icon: Glyph, tint, value, label, sub, testId, action, className, wide }: { className?: string; to: string; icon: IconComponent; tint: string; value: ReactNode; label: string; sub?: ReactNode; testId: string; action?: ReactNode; wide?: boolean }) {
  const shown = typeof value === "number" ? formatCount(value) : value;
  return (
    <div className={cn("elev-1 pressable relative flex min-w-0 flex-col rounded-[var(--radius-r14)] bg-surface p-4 transition-shadow duration-200 hover:shadow-[var(--shadow-e2)] max-sm:p-3", wide && "max-lg:flex-row max-lg:items-center max-lg:gap-3", className)} data-testid={testId}>
      <Link to={to} className="absolute inset-0 rounded-[var(--radius-r14)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" aria-label={`${label}: ${typeof shown === "string" ? shown : ""}`} />
      <div className={cn("flex items-start justify-between gap-2", wide && "max-lg:contents")}>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-r10)] text-white max-sm:h-7 max-sm:w-7 max-sm:rounded-full" style={{ background: tint }} aria-hidden><Glyph size={18} filled /></span>
        <span className={cn("truncate text-[26px] font-bold leading-8 tracking-tight tabular-nums text-fg sm:hidden", wide && "max-lg:order-3 max-lg:ml-auto")}>{shown}</span>
      </div>
      <span className="mt-3 hidden truncate text-[26px] font-bold leading-8 tracking-tight tabular-nums text-fg sm:block">{shown}</span>
      <div className={cn("min-w-0 max-sm:mt-2", wide && "max-lg:mt-0 max-lg:flex-1")}>
        <span className="block truncate text-[13px] font-medium text-fg max-sm:text-[13.5px] max-sm:font-semibold max-sm:text-muted">{label}</span>
        {sub && <span className="block truncate text-[12px] text-muted max-sm:text-[11.5px]">{sub}</span>}
      </div>
      {action && <div className={cn("relative z-10 mt-2", wide && "max-lg:mt-0")}>{action}</div>}
    </div>
  );
}

const FOCUS_ICON: Record<ReturnType<typeof focusItems>[number]["kind"], { icon: IconComponent; cls: string }> = {
  overdue: { icon: IconWarning, cls: "text-bad" }, due: { icon: IconTasks, cls: "text-brand-hover" }, mention: { icon: IconMention, cls: "text-brand-hover" },
  approval: { icon: IconApprovals, cls: "text-warn" }, mail: { icon: IconMail, cls: "text-muted" },
};


const QUICK: { to: string; label: string; icon: IconComponent }[] = [
  { to: "/app/mail?compose=1", label: "New email", icon: IconCompose },
  { to: "/app/docs?new=1", label: "New doc", icon: IconDocs },
  { to: "/app/meetings", label: "Meeting", icon: IconVideo },
  { to: "/app/chat", label: "Message", icon: IconChat },
];

export function MyWorkPage() {
  const q = useMyWork();
  const plus = !!useConfig().data?.tasksPlus; // R95: My Day
  const me = useMe();
  const counts = useCounts(true);
  const first = displayFirstName(me.data?.user.name, me.data?.user.email); // R41 (MB-224)
  // F13b (MB-306): a new task made here stays here. With My Day on it goes on today's list and gets focus; otherwise a
  // toast says it was added with Open.
  const [newTask, setNewTask] = useState(false);
  const [madeTask, setMadeTask] = useState<string | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const made = async (task: { id: string; ref: string }) => {
    void qc.invalidateQueries({ queryKey: ["my-work"] });
    if (plus) {
      try { await api.post("/my-day", { day: new Date().toLocaleDateString("en-CA"), taskId: task.id, start: null, minutes: 30 }); } catch { /* the task stands; it just is not on the day */ }
      await qc.invalidateQueries({ queryKey: ["my-day"] });
      setMadeTask(task.id);
      toast.success(`Added ${task.ref} to today`);
    } else {
      toast.success(`Added ${task.ref}`, { action: { label: "Open", onClick: () => navigate(`/app/tasks?task=${task.id}`) } });
    }
  };
  const w = q.data;
  const c = counts.data;
  const nothing = w && !w.overdue.length && !w.dueToday.length && !w.mentions.length && !w.threads.length && !w.assignedThreads?.length && !w.approvals.length && !w.meetings.length && !w.snoozed?.length;
  // POL2 (HQ MB-332): the account's day only; while it loads a placeholder holds the place, never the browser's day.
  const ui = uiLocale(); // R104: the day line in the app language
  const day = w ? (ui ? formatDateIn(new Date(`${w.date}T12:00:00Z`), ui, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }) : new Date(`${w.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })) : null;
  const next = w ? nextMeeting(w.meetings) : null;
  const focus = w ? focusItems(w) : [];
  const due = c?.tasks.dueToday ?? w?.dueToday.length ?? 0;
  const overdue = c?.tasks.overdue ?? w?.overdue.length ?? 0;
  const mentions = (w?.mentions.length ?? 0) + (c?.chat.mentions ?? 0);
  // R46 mobile: when every count is zero, one calm line says so instead of five tiles of zeros and a second empty card.
  const allQuiet = !!w && !!nothing && !!c && allClear({ unread: c.mail.inbox, due, overdue, mentions, approvals: w.approvals.length, meeting: !!next });
  return (
    <div data-testid="today">
      {/* Large title with the date above it, like the system Today screens. */}
      <div className="mb-5 flex flex-col gap-3 max-sm:mb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold uppercase tracking-[0.04em] text-brand-hover" data-testid="today-date"><span>{tr("mywork.my_work")}</span><span aria-hidden> · </span>{day ? <span className="text-muted">{day}</span> : <span className="skeleton inline-block h-3 w-28 align-middle" aria-hidden data-testid="today-date-loading" />}</p>
          <h1 data-large-title className="text-[32px] font-bold leading-[38px] tracking-[-0.025em] text-fg sm:text-[34px] sm:leading-[41px]">{first ? tr(`mywork.good_${dayPart()}_name`, { name: first }) : tr(`mywork.good_${dayPart()}`)}</h1>
          <p className={cn("mt-1 text-[14px] text-muted", allQuiet && "sr-only")}>{!w ? tr("mywork.what_is_waiting") : nothing ? tr("mywork.nothing_waiting") : overdue > 0 ? tr("mywork.overdue_and_due", { overdue: formatCount(overdue), due: formatCount(due) }) : tr(`mywork.${due ? "due" : "nothing_due"}${next ? "_next" : ""}_line`, { due: formatCount(due), title: next?.item.title ?? "" })}</p>
          {q.cachedAt !== null && q.isError && (
            /* F12 (MB-297): the read failed; the stored list stays on screen, said plainly, with Retry. */
            <p className="mt-2 inline-flex flex-wrap items-center gap-2 rounded-full bg-elevated py-1 pl-2.5 pr-1 text-[12px] font-medium text-muted" role="alert" data-testid="mywork-stale">
              <IconAlertCircle className="h-3.5 w-3.5" aria-hidden="true" />{tr("mywork.stale_list", { time: ui ? formatDateIn(new Date(q.cachedAt), ui, { hour: "numeric", minute: "2-digit" }) : new Date(q.cachedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) })}
              <Button size="sm" variant="secondary" onClick={() => void q.refetch()} data-testid="mywork-retry">{tr("common.retry")}</Button>
            </p>
          )}
          {q.cachedAt !== null && !q.isError && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-elevated px-2.5 py-1 text-[12px] font-medium text-muted" role="status" data-testid="mywork-updating">
              <IconRefresh className="h-3.5 w-3.5 motion-safe:animate-spin [animation-duration:1.6s]" aria-hidden="true" />{tr("mywork.updating_list", { time: ui ? formatDateIn(new Date(q.cachedAt), ui, { hour: "numeric", minute: "2-digit" }) : new Date(q.cachedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) })}
            </p>
          )}
        </div>
        <Link to="/app/tasks" className="pressable inline-flex h-8 items-center gap-1 self-start rounded-lg px-3 text-[13px] text-muted hover:bg-elevated hover:text-fg max-sm:hidden sm:self-auto">{tr("mywork.all_tasks")}<IconChevronRight size={14} /></Link>
      </div>

      <GetStartedCard />{/* R130: Get started checklist (TOURS_R130), nothing when hidden or done */}
      {/* R46 mobile: one row that scrolls sideways with snap, fading at the right edge so the cut off chip reads as "more". */}
      <div className="no-scrollbar -mx-4 mb-5 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto px-4 pb-1 [mask-image:linear-gradient(to_right,#000_calc(100%-40px),transparent)] max-sm:mb-4 sm:mx-0 sm:flex-wrap sm:px-0 sm:[mask-image:none]" role="group" aria-label={tr("mywork.quick_add")} data-testid="today-quick">
        <button type="button" onClick={() => setNewTask(true)} data-testid="mywork-new-task" className="pressable elev-1 inline-flex min-h-9 shrink-0 snap-start items-center gap-1.5 rounded-full bg-surface px-3.5 text-[13px] font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand max-sm:min-h-11 max-sm:px-4 max-sm:text-[14px]">
          <IconPlus size={16} className="text-brand-hover dark:text-brand-hover" />{tr("mywork.new_task")}
        </button>
        {QUICK.map((k) => (
          <Link key={k.label} to={k.to} className="pressable elev-1 inline-flex min-h-9 shrink-0 snap-start items-center gap-1.5 rounded-full bg-surface px-3.5 text-[13px] font-medium text-fg hover:bg-hover max-sm:min-h-11 max-sm:px-4 max-sm:text-[14px] last:mr-6 sm:last:mr-0">
            <k.icon size={16} className="text-brand-hover dark:text-brand-hover" />{tl("mywork", k.label)}
          </Link>
        ))}
      </div>

      {q.isPending && !w ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div>
      ) : !w ? (
        <LoadError onRetry={() => q.refetch()} />
      ) : (
        <>
          {allQuiet ? (
            <div className="elev-1 mb-6 flex items-center gap-3 rounded-[var(--radius-r14)] bg-surface p-4" data-testid="today-clear" role="status">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#34C759]/15 text-[#248A3D] dark:text-[#30D158]" aria-hidden><IconCheck size={22} /></span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-fg">{tr("mywork.you_re_all_clear")}</p>
                <p className="text-[13px] text-muted">{tr("mywork.no_unread_mail_nothing_due_no_meetings_mentions")}</p>
              </div>
            </div>
          ) : (
          <div className="mb-6 grid grid-cols-2 gap-3 max-sm:gap-2.5 lg:grid-cols-5" data-testid="today-cards">
            <Stat testId="today-mail" to="/app/mail" icon={IconInbox} tint="#0071E3" value={c?.mail.inbox ?? "0"} label={tr("mywork.unread_mail")} sub={c ? `${formatCount(c.mail.important)} important` : undefined} />
            <Stat testId="today-tasks" to="/app/tasks" icon={IconTasks} tint={overdue > 0 ? "#D70015" : "#34C759"} value={due} label={tr("mywork.due_today")} sub={overdue > 0 ? <span className="text-bad">{tr("mywork.n_overdue", { n: formatCount(overdue) })}</span> : tr("mywork.nothing_overdue")} />
            <Stat testId="today-meeting" to={next?.item.url ?? "/app/meetings"} icon={IconVideo} tint="#30B0C7" value={next?.item.at ? meetingTime(next.item.at, w?.timeZone) : "None"} label={tr("mywork.next_meeting")} sub={next?.item.title ?? "No meetings today"}
              action={next?.joinable ? <Link to={next.item.url} className="pressable inline-flex h-8 items-center gap-1 rounded-full bg-brand px-3 text-[12.5px] font-semibold text-white" data-testid="today-join"><IconVideo size={14} filled />{tr("mywork.join")}</Link> : undefined} />
            <Stat testId="today-mentions" to="/app/notifications" icon={IconMention} tint="#5856D6" value={mentions} label={tr("mywork.mentions")} sub={c && c.chat.unread > 0 ? `${formatCount(c.chat.unread)} unread in chat` : "All caught up"} />
            <Stat className="max-lg:col-span-2" wide testId="today-approvals" to="/app/approvals" icon={IconApprovals} tint="#FF9500" value={w.approvals.length} label={tr("mywork.approvals_waiting")} sub={w.approvals.length ? "Open Approvals" : "None waiting"} />
          </div>
          )}

          {plus && <MyDay focusTaskId={madeTask} userEmail={me.data?.user.email} />}

          {allQuiet ? null : nothing ? (
            <EmptyState className="mb-4" art={<ClearDayArt />} title={tr("mywork.you_re_clear_for_today")} body={tr("mywork.nothing_is_due_nobody_is_waiting_on_you_and_ther")} />
          ) : (
            <section className="mb-6" aria-labelledby="focus-h" data-testid="today-focus">
              <h2 id="focus-h" className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-[0.04em] text-subtle">{tr("mywork.focus")}</h2>
              <ol className="elev-1 overflow-hidden rounded-[var(--radius-r14)] bg-surface">
                {focus.map((it, i) => (
                  <li key={`${it.kind}-${it.id}`} className={cn(i > 0 && "hairline-t")}>
                    <Link to={it.url} className="pressable flex items-center gap-3 px-4 py-3 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none">
                      <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full bg-fill", FOCUS_ICON[it.kind].cls)} aria-hidden>{(() => { const G = FOCUS_ICON[it.kind].icon; return <G size={16} />; })()}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-fg">{it.title}</span>
                        {it.subtitle && <span className="block truncate text-[12px] text-subtle">{it.subtitle}</span>}
                      </span>
                      <IconChevronRight size={16} className="shrink-0 text-subtle" />
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {!allQuiet && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {w.overdue.length > 0 && <Section testId="mywork-overdue" title={tr("mywork.overdue")} tone="danger" icon={<IconSnooze />} items={w.overdue} empty="" />}
            <Section testId="mywork-due" title={tr("mywork.due_today")} icon={<IconTasks />} items={w.dueToday} empty={tr("mywork.no_tasks_due_today")} />
            <Section testId="mywork-meetings" title={tr("mywork.today_s_meetings")} icon={<IconVideo />} items={w.meetings} empty={tr("mywork.no_meetings_today")} />
            <Section testId="mywork-mentions" title={tr("mywork.mentions")} icon={<IconMention />} items={w.mentions} empty={tr("mywork.nobody_has_mentioned_you_lately")} />
            <Section testId="mywork-approvals" title={tr("mywork.approvals_waiting")} icon={<IconClipboardCheck />} items={w.approvals} empty={tr("mywork.no_agent_emails_are_waiting_for_you")} />
            {w.assignedThreads && w.assignedThreads.length > 0 && <Section testId="mywork-assigned-mail" title={tr("mywork.mail_assigned_to_you")} icon={<IconUserCheck />} items={w.assignedThreads} empty="" />}
            <Section testId="mywork-threads" title={tr("mywork.mail_on_my_tasks")} icon={<IconInbox />} items={w.threads} empty={tr("mywork.no_open_tasks_came_from_mail")} />
            {w.snoozed && w.snoozed.length > 0 && <Section testId="mywork-snoozed" title={tr("mywork.snoozed_mail_coming_back")} icon={<IconCalendarClock />} items={w.snoozed} empty="" />}
          </div>
          )}
        </>
      )}
      {newTask && <Suspense fallback={null}><MyWorkNewTask onClose={() => setNewTask(false)} onMade={made} /></Suspense>}
    </div>
  );
}
