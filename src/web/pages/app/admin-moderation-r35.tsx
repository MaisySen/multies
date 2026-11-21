/**
 * R35 (Apple 1.2): the operator console's link to the moderation queue. The queue itself is /console/moderation since
 * OPS1 (pages/console/moderation*.tsx; /app/admin/reports redirects there).
 */
import { Link } from "react-router";
import { IconFlag } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { useOpenReportCount } from "@/web/lib/open-report-count";

/** The operator console's link to the queue, with the open count. */
export function ModerationLink() {
  const n = useOpenReportCount(true);
  const open = n.data ?? 0;
  return (
    <Link to="/console/moderation" data-testid="moderation-link" className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card transition-colors duration-150 hover:bg-hover">
      <IconFlag className={cn("h-5 w-5", open ? "text-bad" : "text-muted")} aria-hidden />
      <span className="flex-1"><span className="block text-[14px] font-semibold">Moderation</span><span className="block text-[12.5px] text-muted">{open ? `${open} report${open === 1 ? "" : "s"} to review within 24 hours` : "No open reports"}</span></span>
      {open > 0 && <span className="rounded-full bg-bad px-2 text-[12px] font-semibold tabular-nums text-white">{open}</span>}
    </Link>
  );
}
