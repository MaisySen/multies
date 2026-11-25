/**
 * MPT-11 (NAV1 slice 2): "N waiting in Triage" above a project's board and list, with a link to the Triage page
 * filtered to the project. The rules are in src/web/lib/triage-waiting-nav1.ts. The query key starts with "triage",
 * so the count refreshes when the Triage page accepts or declines an item (it refreshes every "triage" query).
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { IconInbox } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { triageWaitingLine } from "@/web/lib/triage-waiting-nav1";
import { tr } from "@/web/i18n";

export function TriageWaiting({ projectId, triageOn, view }: { projectId: string; triageOn: boolean; view: string }) {
  const enabled = !!projectId && triageOn && (view === "board" || view === "list");
  const q = useQuery({
    queryKey: ["triage", "count", projectId],
    queryFn: () => api.get<{ count: number }>(`/triage/count?projectId=${encodeURIComponent(projectId)}`),
    enabled, refetchInterval: 30_000, retry: false,
  });
  const line = triageWaitingLine({ projectId, triageOn, view, count: q.data?.count, failed: q.isError });
  if (!line) return null;
  const text = tr("tasks.n_waiting_in_triage", { count: line.count });
  return (
    <div className="mb-3" data-testid="triage-waiting">
      <Link to={line.href} aria-label={text}
        className="inline-flex min-h-6 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] font-medium text-brand-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
        <IconInbox className="h-3.5 w-3.5" aria-hidden />{text}
      </Link>
    </div>
  );
}
