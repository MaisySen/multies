/**
 * OPS1: Jobs and maintenance in the operator console (/console/jobs). Two tabs, kept in the address bar (?tab=):
 * Queue (default: numbers, a per type breakdown and the job list, opening on jobs that failed for good) and Data moves
 * (imports and exports). The tabs live in jobs-queue.tsx and jobs-moves.tsx.
 */
import { Link, useSearchParams } from "react-router";
import { PageHeader } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { JobsQueueTab } from "./jobs-queue";
import { JobsDataMovesTab } from "./jobs-moves";

const TABS = [
  { id: "queue", label: "Queue" },
  { id: "moves", label: "Data moves" },
] as const;

export function ConsoleJobsPage() {
  const [params] = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get("tab"))?.id ?? "queue";
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Platform" title="Jobs" description="Background work across every workspace: what is waiting, what failed for good, and imports and exports." />
      <nav aria-label="Sections" className="overflow-x-auto border-b border-line">
        <ul className="flex min-w-max gap-1">
          {TABS.map((t) => (
            <li key={t.id}>
              {/* Switching tabs starts that tab with its own default filters. */}
              <Link to={t.id === "queue" ? "/console/jobs" : `/console/jobs?tab=${t.id}`} replace aria-current={tab === t.id ? "page" : undefined}
                data-testid={`console-jobs-tab-${t.id}`}
                className={cn("-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors", tab === t.id ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {tab === "moves" ? <JobsDataMovesTab /> : <JobsQueueTab />}
    </div>
  );
}
