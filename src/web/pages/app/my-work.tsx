/** My Work (round 20): everything waiting on me today, from every part of the workspace. */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { AlarmClock, AtSign, CalendarClock, CheckSquare, ClipboardCheck, Inbox, Sun, UserCheck, Video } from "lucide-react";
import { Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { useMyWork, type MyWorkItem } from "@/web/lib/search";
import { useMe } from "@/web/lib/queries";
import { dayPart } from "@/web/lib/format";

function Section({ title, icon, items, empty, tone, testId }: { title: string; icon: ReactNode; items: MyWorkItem[]; empty: string; tone?: "danger"; testId: string }) {
  return (
    <Card className="p-0" data-testid={testId}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className={cn("text-subtle [&_svg]:h-4 [&_svg]:w-4", tone === "danger" && items.length > 0 && "text-bad")}>{icon}</span>
        <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
        {items.length > 0 && <span className={cn("ml-auto rounded-full px-2 py-0.5 text-[11.5px] font-medium", tone === "danger" ? "bg-bad/10 text-bad" : "bg-[#0071E3]/10 text-[#0071E3]")}>{items.length}</span>}
      </div>
      {items.length ? (
        <ul className="divide-y divide-line">
          {items.map((it) => (
            <li key={it.id}>
              <Link to={it.url} className="block px-4 py-2.5 hover:bg-hover">
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

export function MyWorkPage() {
  const q = useMyWork();
  const me = useMe();
  const first = me.data?.user.name.split(" ")[0];
  const w = q.data;
  const nothing = w && !w.overdue.length && !w.dueToday.length && !w.mentions.length && !w.threads.length && !w.assignedThreads?.length && !w.approvals.length && !w.meetings.length && !w.snoozed?.length;
  const day = w ? new Date(`${w.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }) : "";
  return (
    <div>
      <PageHeader eyebrow="My Work" title={`Good ${dayPart()}${first ? `, ${first}` : ""}`} description={w ? `What is waiting on you today, ${day}.` : "What is waiting on you today."}
        actions={<Link to="/app/tasks" className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] text-muted hover:bg-elevated hover:text-fg">All tasks</Link>} />
      {q.isPending ? <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div> : q.isError || !w ? (
        <EmptyState icon={<Sun />} title="My Work didn't load" body="Check your connection and try again in a moment." />
      ) : (
        <>
          {nothing && <EmptyState className="mb-4" icon={<Sun />} title="You're clear for today" body="Nothing is due, nobody is waiting on you and there are no meetings today." />}
          <div className="grid gap-4 md:grid-cols-2">
            {w.overdue.length > 0 && <Section testId="mywork-overdue" title="Overdue" tone="danger" icon={<AlarmClock />} items={w.overdue} empty="" />}
            <Section testId="mywork-due" title="Due today" icon={<CheckSquare />} items={w.dueToday} empty="No tasks due today." />
            <Section testId="mywork-meetings" title="Today's meetings" icon={<Video />} items={w.meetings} empty="No meetings today." />
            <Section testId="mywork-mentions" title="Mentions" icon={<AtSign />} items={w.mentions} empty="Nobody has mentioned you lately." />
            <Section testId="mywork-approvals" title="Approvals waiting" icon={<ClipboardCheck />} items={w.approvals} empty="No agent emails are waiting for you." />
            {w.assignedThreads && w.assignedThreads.length > 0 && <Section testId="mywork-assigned-mail" title="Mail assigned to you" icon={<UserCheck />} items={w.assignedThreads} empty="" />}
            <Section testId="mywork-threads" title="Mail on my tasks" icon={<Inbox />} items={w.threads} empty="No open tasks came from mail." />
            {w.snoozed && w.snoozed.length > 0 && <Section testId="mywork-snoozed" title="Snoozed mail coming back" icon={<CalendarClock />} items={w.snoozed} empty="" />}
          </div>
        </>
      )}
    </div>
  );
}
