/** My Work (round 20), the Today home since R35: a large dated title, summary cards with depth, a Focus list and quick add. */
import type { ReactNode } from "react";
import { displayFirstName } from "@/shared/display-name";
import { Link } from "react-router";
import { IconApprovals, IconCalendarClock, IconCheck, IconChat, IconChevronRight, IconClipboardCheck, IconCompose, IconDocs, IconInbox, IconMail, IconMention, IconPlus, IconRefresh, IconSnooze, IconTasks, IconToday, IconUserCheck, IconVideo, IconWarning, type IconComponent } from "@/web/components/ui/icon";
import { ClearDayArt } from "@/web/components/illustrations";
import { Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { useMyWork, type MyWorkItem } from "@/web/lib/search";
import { allClear, focusItems, nextMeeting } from "@/web/lib/today";
import { useMe } from "@/web/lib/queries";
import { useCounts } from "@/web/lib/counts";
import { dayPart } from "@/web/lib/format";

function Section({ title, icon, items, empty, tone, testId }: { title: string; icon: ReactNode; items: MyWorkItem[]; empty: string; tone?: "danger"; testId: string }) {
  return (
    <Card className="elev-1 min-w-0 overflow-hidden rounded-[var(--radius-r14)] border-0 p-0" data-testid={testId}>
      <div className="hairline-b flex items-center gap-2 px-4 py-3">
        <span className={cn("text-subtle [&_svg]:h-4 [&_svg]:w-4", tone === "danger" && items.length > 0 && "text-bad")}>{icon}</span>
        <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
        {items.length > 0 && <span className={cn("ml-auto rounded-full px-2 py-0.5 text-[11.5px] font-medium", tone === "danger" ? "bg-bad/10 text-bad" : "bg-[#0071E3]/10 text-[#0071E3]")}>{items.length}</span>}
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
  return (
    <div className={cn("elev-1 pressable relative flex min-w-0 flex-col rounded-[var(--radius-r14)] bg-surface p-4 transition-shadow duration-200 hover:shadow-[var(--shadow-e2)] max-sm:p-3", wide && "max-lg:flex-row max-lg:items-center max-lg:gap-3", className)} data-testid={testId}>
      <Link to={to} className="absolute inset-0 rounded-[var(--radius-r14)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" aria-label={`${label}: ${typeof value === "number" || typeof value === "string" ? value : ""}`} />
      <div className={cn("flex items-start justify-between gap-2", wide && "max-lg:contents")}>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-r10)] text-white max-sm:h-7 max-sm:w-7 max-sm:rounded-full" style={{ background: tint }} aria-hidden><Glyph size={18} filled /></span>
        <span className={cn("truncate text-[26px] font-bold leading-8 tracking-tight tabular-nums text-fg sm:hidden", wide && "max-lg:order-3 max-lg:ml-auto")}>{value}</span>
      </div>
      <span className="mt-3 hidden truncate text-[26px] font-bold leading-8 tracking-tight tabular-nums text-fg sm:block">{value}</span>
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
  { to: "/app/tasks?new=1", label: "New task", icon: IconPlus },
  { to: "/app/mail?compose=1", label: "New email", icon: IconCompose },
  { to: "/app/docs?new=1", label: "New doc", icon: IconDocs },
  { to: "/app/meetings", label: "Meeting", icon: IconVideo },
  { to: "/app/chat", label: "Message", icon: IconChat },
];

export function MyWorkPage() {
  const q = useMyWork();
  const me = useMe();
  const counts = useCounts(true);
  const first = displayFirstName(me.data?.user.name, me.data?.user.email); // R41 (MB-224)
  const w = q.data;
  const c = counts.data;
  const nothing = w && !w.overdue.length && !w.dueToday.length && !w.mentions.length && !w.threads.length && !w.assignedThreads?.length && !w.approvals.length && !w.meetings.length && !w.snoozed?.length;
  const day = w ? new Date(`${w.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    : new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
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
          <p className="text-[13px] font-semibold uppercase tracking-[0.04em] text-[#0071E3] dark:text-brand-hover" data-testid="today-date"><span>My Work</span><span aria-hidden> · </span><span className="text-muted">{day}</span></p>
          <h1 data-large-title className="text-[32px] font-bold leading-[38px] tracking-[-0.025em] text-fg sm:text-[34px] sm:leading-[41px]">Good {dayPart()}{first ? `, ${first}` : ""}</h1>
          <p className={cn("mt-1 text-[14px] text-muted", allQuiet && "sr-only")}>{!w ? "What is waiting on you today." : nothing ? "Nothing is waiting on you. Enjoy the quiet." : overdue > 0 ? `${overdue} overdue and ${due} due today. Start with the top of Focus.` : `${due ? `${due} due today` : "Nothing due today"}${next ? `, next up: ${next.item.title}` : ""}.`}</p>
          {q.cachedAt !== null && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-elevated px-2.5 py-1 text-[12px] font-medium text-muted" role="status" data-testid="mywork-updating">
              <IconRefresh className="h-3.5 w-3.5 motion-safe:animate-spin [animation-duration:1.6s]" aria-hidden="true" />Updating. Showing your list from {new Date(q.cachedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            </p>
          )}
        </div>
        <Link to="/app/tasks" className="pressable inline-flex h-8 items-center gap-1 self-start rounded-lg px-3 text-[13px] text-muted hover:bg-elevated hover:text-fg max-sm:hidden sm:self-auto">All tasks<IconChevronRight size={14} /></Link>
      </div>

      {/* R46 mobile: one row that scrolls sideways with snap, fading at the right edge so the cut off chip reads as "more". */}
      <div className="no-scrollbar -mx-4 mb-5 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto px-4 pb-1 [mask-image:linear-gradient(to_right,#000_calc(100%-40px),transparent)] max-sm:mb-4 sm:mx-0 sm:flex-wrap sm:px-0 sm:[mask-image:none]" role="group" aria-label="Quick add" data-testid="today-quick">
        {QUICK.map((k) => (
          <Link key={k.label} to={k.to} className="pressable elev-1 inline-flex min-h-9 shrink-0 snap-start items-center gap-1.5 rounded-full bg-surface px-3.5 text-[13px] font-medium text-fg hover:bg-hover max-sm:min-h-11 max-sm:px-4 max-sm:text-[14px] last:mr-6 sm:last:mr-0">
            <k.icon size={16} className="text-[#0071E3] dark:text-brand-hover" />{k.label}
          </Link>
        ))}
      </div>

      {q.isPending && !w ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div>
      ) : q.isError || !w ? (
        <EmptyState icon={<IconToday />} title="My Work didn't load" body="Check your connection and try again in a moment." />
      ) : (
        <>
          {allQuiet ? (
            <div className="elev-1 mb-6 flex items-center gap-3 rounded-[var(--radius-r14)] bg-surface p-4" data-testid="today-clear" role="status">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#34C759]/15 text-[#248A3D] dark:text-[#30D158]" aria-hidden><IconCheck size={22} /></span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-fg">You're all clear</p>
                <p className="text-[13px] text-muted">No unread mail, nothing due, no meetings, mentions or approvals waiting.</p>
              </div>
            </div>
          ) : (
          <div className="mb-6 grid grid-cols-2 gap-3 max-sm:gap-2.5 lg:grid-cols-5" data-testid="today-cards">
            <Stat testId="today-mail" to="/app/mail" icon={IconInbox} tint="#0071E3" value={c?.mail.inbox ?? "0"} label="Unread mail" sub={c ? `${c.mail.important} important` : undefined} />
            <Stat testId="today-tasks" to="/app/tasks" icon={IconTasks} tint={overdue > 0 ? "#D70015" : "#34C759"} value={due} label="Due today" sub={overdue > 0 ? <span className="text-bad">{overdue} overdue</span> : "Nothing overdue"} />
            <Stat testId="today-meeting" to={next?.item.url ?? "/app/meetings"} icon={IconVideo} tint="#30B0C7" value={next?.item.at ? new Date(next.item.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "None"} label="Next meeting" sub={next?.item.title ?? "No meetings today"}
              action={next?.joinable ? <Link to={next.item.url} className="pressable inline-flex h-8 items-center gap-1 rounded-full bg-[#0071E3] px-3 text-[12.5px] font-semibold text-white" data-testid="today-join"><IconVideo size={14} filled />Join</Link> : undefined} />
            <Stat testId="today-mentions" to="/app/notifications" icon={IconMention} tint="#5856D6" value={mentions} label="Mentions" sub={c && c.chat.unread > 0 ? `${c.chat.unread} unread in chat` : "All caught up"} />
            <Stat className="max-lg:col-span-2" wide testId="today-approvals" to="/app/approvals" icon={IconApprovals} tint="#FF9500" value={w.approvals.length} label="Approvals waiting" sub={w.approvals.length ? "Open Approvals" : "None waiting"} />
          </div>
          )}

          {allQuiet ? null : nothing ? (
            <EmptyState className="mb-4" art={<ClearDayArt />} title="You're clear for today" body="Nothing is due, nobody is waiting on you and there are no meetings today." />
          ) : (
            <section className="mb-6" aria-labelledby="focus-h" data-testid="today-focus">
              <h2 id="focus-h" className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-[0.04em] text-subtle">Focus</h2>
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

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {w.overdue.length > 0 && <Section testId="mywork-overdue" title="Overdue" tone="danger" icon={<IconSnooze />} items={w.overdue} empty="" />}
            <Section testId="mywork-due" title="Due today" icon={<IconTasks />} items={w.dueToday} empty="No tasks due today." />
            <Section testId="mywork-meetings" title="Today's meetings" icon={<IconVideo />} items={w.meetings} empty="No meetings today." />
            <Section testId="mywork-mentions" title="Mentions" icon={<IconMention />} items={w.mentions} empty="Nobody has mentioned you lately." />
            <Section testId="mywork-approvals" title="Approvals waiting" icon={<IconClipboardCheck />} items={w.approvals} empty="No agent emails are waiting for you." />
            {w.assignedThreads && w.assignedThreads.length > 0 && <Section testId="mywork-assigned-mail" title="Mail assigned to you" icon={<IconUserCheck />} items={w.assignedThreads} empty="" />}
            <Section testId="mywork-threads" title="Mail on my tasks" icon={<IconInbox />} items={w.threads} empty="No open tasks came from mail." />
            {w.snoozed && w.snoozed.length > 0 && <Section testId="mywork-snoozed" title="Snoozed mail coming back" icon={<IconCalendarClock />} items={w.snoozed} empty="" />}
          </div>
        </>
      )}
    </div>
  );
}
