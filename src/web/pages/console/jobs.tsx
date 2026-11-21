/**
 * OPS1: Jobs and maintenance in the operator console (/console/jobs). Two tabs, kept in the address bar (?tab=):
 * Queue (default: numbers, a per type breakdown and the job list, opening on jobs that failed for good) and Data moves
 * (imports and exports). The tabs live in jobs-queue.tsx and jobs-moves.tsx.
 */
import { PageHeader } from "@/web/components/ui/misc";
import { QueryTabs, TabPanel, useQueryTab } from "./components/detail-tabs";
import { JobsQueueTab } from "./jobs-queue";
import { JobsDataMovesTab } from "./jobs-moves";

const TABS = [
  { id: "queue", label: "Queue" },
  { id: "moves", label: "Data moves" },
] as const;

export function ConsoleJobsPage() {
  const tab = useQueryTab(TABS);
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Platform" title="Jobs" description="Background work across every workspace: what is waiting, what failed for good, and imports and exports." />
      {/* Switching tabs starts that tab with its own default filters. */}
      <QueryTabs tabs={TABS} label="Jobs sections" testIdPrefix="console-jobs-tab" />
      <TabPanel testIdPrefix="console-jobs-tab" current={tab}>{tab === "moves" ? <JobsDataMovesTab /> : <JobsQueueTab />}</TabPanel>
    </div>
  );
}
