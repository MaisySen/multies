/**
 * R36: skeletons shaped like the views they stand in for, so nothing jumps when data arrives. All built on the one
 * Skeleton (components/ui/misc.tsx: shimmer, flat under reduced motion).
 */
import { Skeleton } from "@/web/components/ui/misc";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";

/** A month grid: 7 columns by 5 weeks, a few event bars, the toolbar on top. */
export function CalendarSkeleton({ label = "Loading the calendar" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="rounded-xl border border-line bg-surface p-3" data-testid="calendar-skeleton">
      <div className="mb-3 flex items-center gap-2"><Skeleton className="h-7 w-28" /><Skeleton className="h-7 w-16" /><Skeleton className="ml-auto h-7 w-40" /></div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-line">
        {Array.from({ length: 35 }, (_, i) => (
          <div key={i} className="h-[92px] bg-surface p-1.5">
            <Skeleton className="h-3 w-5" />
            {(i * 7) % 5 === 0 && <Skeleton className="mt-2 h-4 w-11/12" />}
            {(i * 3) % 7 === 1 && <Skeleton className="mt-1 h-4 w-2/3" />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A timeline: a row label and a bar per row, staggered like real work. */
export function TimelineSkeleton() {
  return (
    <div role="status" aria-label="Loading the timeline" aria-busy="true" className="rounded-xl border border-line bg-surface p-3" data-testid="timeline-skeleton">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-3">
          <Skeleton className="h-3.5 w-40 shrink-0" />
          <Skeleton className="h-5 rounded-full" style={{ marginLeft: `${(i * 37) % 45}%`, width: `${18 + ((i * 13) % 22)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Sprint cards or workload rows: a header block and list rows. */
export function PanelListSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="space-y-3" data-testid="panel-list-skeleton">
      <div className="rounded-xl border border-line bg-surface p-4"><Skeleton className="h-4 w-48" /><Skeleton className="mt-3 h-2 w-full rounded-full" /></div>
      <SkeletonRows rows={6} rowHeight={44} avatar label={label} className="rounded-xl border border-line bg-surface" />
    </div>
  );
}
