/** R30: the designed empty state and the board skeleton for the Tasks page. */
import { CalendarDays, FilterX, ListPlus } from "lucide-react";
import { Button } from "@/web/components/ui/button";
import { EmptyState, Skeleton } from "@/web/components/ui/misc";
import type { EmptyCopy } from "@/web/lib/empty-states";

export function TasksEmpty({ copy, onClear, onNew, icon }: { copy: EmptyCopy; onClear: () => void; onNew: () => void; icon?: "calendar" }) {
  const Icon = icon === "calendar" ? CalendarDays : copy.action === "clear" ? FilterX : ListPlus;
  return (
    <div className="rounded-xl border border-line bg-surface" data-testid="tasks-empty">
      <EmptyState icon={<Icon />} title={copy.title} body={copy.body}
        action={copy.action && <Button variant={copy.action === "clear" ? "secondary" : "primary"} onClick={copy.action === "clear" ? onClear : onNew}>{copy.actionLabel}</Button>} />
    </div>
  );
}

/** Columns of card shaped placeholders, the size of real cards, while the board loads. */
export function BoardSkeleton({ columns = 4 }: { columns?: number }) {
  return (
    <div role="status" aria-label="Loading tasks" aria-busy="true" className="flex gap-3 overflow-hidden" data-testid="board-skeleton">
      {Array.from({ length: columns }, (_, c) => (
        <div key={c} className="w-72 shrink-0 rounded-xl bg-fill/60 p-2">
          <Skeleton className="mx-1 mb-3 mt-1 h-3.5 w-24" />
          {Array.from({ length: 3 - (c % 2) }, (_, i) => (
            <div key={i} className="mb-2 h-[76px] rounded-lg border border-line bg-surface p-3">
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="mt-3 h-3 w-1/3" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
