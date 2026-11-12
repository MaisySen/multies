/** The portfolio: every project in one table, with a health flag people set by hand. */
import { useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconBriefcase } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Select } from "@/web/components/ui/input";
import { cn } from "@/web/lib/cn";
import { shortDate } from "@/web/lib/format";
import { hoursText } from "./time";
import { tone } from "@/web/components/app-bits";

export type Health = "on_track" | "at_risk" | "off_track";
export interface PortfolioRow {
  id: string; name: string; key: string; color: string; archived: boolean; owner: { id: string; name: string } | null;
  health: Health | null; healthNote: string; progress: number; total: number; done: number; overdue: number;
  timeLoggedSeconds: number; nextDue: string | null; nextDueTask: { id: string; ref: string; title: string } | null;
}
interface Member { userId: string; name: string; email: string }

export const HEALTH: Record<Health, { label: string; cls: string }> = {
  on_track: { label: "On track", cls: "bg-ok/15 text-ok" },
  at_risk: { label: "At risk", cls: "bg-warn/15 text-warn" },
  off_track: { label: "Off track", cls: "bg-bad/15 text-bad" },
};
const day = { format: (d: Date) => shortDate(d, { day: "numeric", month: "short" }) };

export function PortfolioPage() {
  const [archived, setArchived] = useState(false);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["portfolio", archived], queryFn: async () => (await api.get<{ projects: PortfolioRow[] }>(`/portfolio${archived ? "?archived=1" : ""}`)).projects });
  // AIS1 (audit row 41): a project owner is a person, so AI agent members (isAgent) are not offered.
  const team = useQuery({ queryKey: ["portfolio-members"], staleTime: 120_000, queryFn: async () => (await api.get<{ assignees: { id: string; type: string; name: string; email: string | null; isAgent?: boolean }[] }>("/tasks/assignees")).assignees
    .filter((a) => a.type === "member" && !a.isAgent).map<Member>((a) => ({ userId: a.id.replace(/^member:/, ""), name: a.name, email: a.email ?? "" })) });
  const save = async (id: string, patch: Record<string, unknown>) => {
    try { await api.patch(`/projects/${id}`, patch); await qc.invalidateQueries({ queryKey: ["portfolio"] }); } catch (e) { showError(e as Error); }
  };
  const rows = q.data ?? [];
  const counts = { on_track: 0, at_risk: 0, off_track: 0 } as Record<Health, number>;
  for (const r of rows) if (r.health) counts[r.health]++;
  return (
    <div>
      <PageHeader title="Portfolio" description="Every project at a glance. Health is set by the team, so it says what people think, not a formula."
        actions={<label className="flex items-center gap-2 text-[13px] text-muted"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />Show archived</label>} />
      {q.isPending ? <Skeleton className="h-64" /> : !rows.length ? (
        <EmptyState icon={<IconBriefcase />} title="No projects yet" body="Projects you create in Tasks show here with their progress and health." />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2 text-[12.5px]" aria-label="Health summary">
            {(Object.keys(HEALTH) as Health[]).map((h) => <span key={h} className={cn("rounded-full px-2.5 py-1 font-medium", HEALTH[h].cls)}>{counts[h]} {HEALTH[h].label.toLowerCase()}</span>)}
            <span className="rounded-full bg-fill px-2.5 py-1 text-muted">{rows.length - counts.on_track - counts.at_risk - counts.off_track} not set</span>
          </div>
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-[13px]" data-testid="portfolio-table">
              <thead className="border-b border-line bg-surface text-left text-[12px] text-subtle">
                <tr>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Health</th>
                  <th className="px-3 py-2 font-medium">Progress</th>
                  <th className="px-3 py-2 font-medium">Overdue</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">Owner</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">Time logged</th>
                  <th className="hidden px-3 py-2 font-medium sm:table-cell">Next due</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0 align-middle">
                    <td className="px-3 py-2.5">
                      <Link to={`/app/tasks?project=${r.id}&view=list`} className="inline-flex items-center gap-2 font-medium hover:underline">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: tone(r.color) }} aria-hidden />{r.name}
                      </Link>
                      {r.archived && <span className="ml-2 text-[11.5px] text-subtle">archived</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <Select aria-label={`Health of ${r.name}`} value={r.health ?? ""} onChange={(e) => void save(r.id, { health: e.target.value || null })}
                        className={cn("h-7 w-auto! border-0 text-[12.5px] font-medium", r.health ? HEALTH[r.health].cls : "bg-fill text-muted")}>
                        <option value="">Not set</option>
                        {(Object.keys(HEALTH) as Health[]).map((h) => <option key={h} value={h}>{HEALTH[h].label}</option>)}
                      </Select>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex min-w-[120px] items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill" role="progressbar" aria-label={`${r.name} progress`} aria-valuenow={r.progress} aria-valuemin={0} aria-valuemax={100}>
                          <div className="h-full rounded-full bg-brand" style={{ width: `${r.progress}%` }} />
                        </div>
                        <span className="w-10 text-right tabular-nums text-muted">{r.progress}%</span>
                      </div>
                      <div className="text-[11.5px] text-subtle">{r.done} of {r.total} done</div>
                    </td>
                    <td className={cn("px-3 py-2.5 tabular-nums", r.overdue ? "font-medium text-bad" : "text-subtle")}>{r.overdue}</td>
                    <td className="hidden px-3 py-2.5 md:table-cell">
                      <Select aria-label={`Owner of ${r.name}`} value={r.owner?.id ?? ""} onChange={(e) => void save(r.id, { ownerId: e.target.value || null })} className="h-7 w-auto! text-[12.5px]">
                        <option value="">Nobody</option>
                        {(team.data ?? []).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                      </Select>
                    </td>
                    <td className="hidden px-3 py-2.5 tabular-nums text-muted md:table-cell">{hoursText(r.timeLoggedSeconds)}</td>
                    <td className="hidden px-3 py-2.5 sm:table-cell">
                      {r.nextDue ? <span title={r.nextDueTask?.title}>{day.format(new Date(r.nextDue))}<span className="ml-1.5 font-mono text-[11.5px] text-subtle">{r.nextDueTask?.ref}</span></span> : <span className="text-subtle">-</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
