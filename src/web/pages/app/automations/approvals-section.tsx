import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconWorkflow } from "@/web/components/ui/icon";
import { Card } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import type { RunDto } from "./api";

/** R90: flow steps waiting for this person's OK, shown on Home, Approvals. Hidden when there are none. */
export function FlowApprovalsSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["flow-approvals"], retry: false, refetchInterval: 30_000, queryFn: async () => (await api.get<{ approvals: (RunDto & { asked: string })[] }>("/flows/approvals")).approvals });
  if (!q.data?.length) return null;
  const decide = async (id: string, decision: "approve" | "reject") => {
    try { await api.post(`/flows/runs/${id}/decide`, { decision }); toast.success(decision === "approve" ? "Approved" : "Rejected"); await qc.invalidateQueries({ queryKey: ["flow-approvals"] }); }
    catch (e) { showError(e as Error); }
  };
  return (
    <section aria-label="Automation steps waiting for an OK" className="mb-6">
      <h2 className="mb-2 text-[13px] font-semibold">Automations waiting for an OK</h2>
      <Card className="divide-y divide-line">
        {q.data.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3 p-4">
            <IconWorkflow className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium">{r.asked || "OK to go on?"}</p>
              <p className="text-[12px] text-subtle"><Link className="underline underline-offset-2 hover:text-fg" to={`/app/automations/runs/${r.id}`}>{r.flowName}</Link> · {timeAgo(r.startedAt)}</p>
            </div>
            <div className="flex gap-2"><Button size="sm" onClick={() => void decide(r.id, "approve")}>Approve</Button><Button size="sm" variant="outline" onClick={() => void decide(r.id, "reject")}>Reject</Button></div>
          </div>
        ))}
      </Card>
    </section>
  );
}
