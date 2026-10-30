/**
 * R30: skeleton rows the same height as the loaded rows, so a list does not jump when data arrives.
 */
import { Skeleton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { skeletonWidths } from "@/web/lib/skeleton";

export function SkeletonRows({ rows = 5, rowHeight = 44, label = "Loading", className, avatar }: { rows?: number; rowHeight?: number; label?: string; className?: string; avatar?: boolean }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className={cn("divide-y divide-line", className)} data-testid="skeleton-rows">
      {skeletonWidths(rows).map((w, i) => (
        <div key={i} className="flex items-center gap-3 px-3" style={{ height: rowHeight }}>
          {avatar && <Skeleton className="h-6 w-6 shrink-0 rounded-full" />}
          <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
          <Skeleton className="ml-auto h-3 w-14 shrink-0" />
        </div>
      ))}
    </div>
  );
}
