/** Round 21: the sprint list hook and the task panel rows (Sprint, Estimate). Kept apart from sprints.tsx so the view stays in its own chunk. */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { Input, Select } from "@/web/components/ui/input";
import type { Task } from "./data";

export interface Sprint {
  id: string; projectId: string; name: string; goal: string; status: "planned" | "active" | "completed";
  startAt: string; endAt: string; startedAt: string | null; completedAt: string | null; carriedOver: number; version: number;
  counts?: { tasks: number; done: number; points: number; donePoints: number };
}
export function useSprints(projectId: string | undefined) {
  return useQuery({ queryKey: ["sprints", projectId ?? ""], enabled: !!projectId, staleTime: 15_000,
    queryFn: async () => api.get<{ unit: "points" | "hours"; sprints: Sprint[] }>(`/sprints?projectId=${projectId}`) });
}


/** Rows for the task panel: Sprint ("Move to sprint") and the estimate. */
export function SprintFields({ task, onSave }: { task: Task; onSave: (patch: Record<string, unknown>) => void }) {
  const list = useSprints(task.projectId);
  const [pts, setPts] = useState(task.points != null ? String(task.points) : "");
  useEffect(() => { setPts(task.points != null ? String(task.points) : ""); }, [task.id, task.points]);
  const unit = list.data?.unit ?? "points";
  const options = (list.data?.sprints ?? []).filter((s) => s.status !== "completed" || s.id === task.sprintId);
  const commit = () => {
    const v = pts.trim() === "" ? null : Number(pts);
    if (v !== null && (!Number.isFinite(v) || v < 0)) { setPts(task.points != null ? String(task.points) : ""); return; }
    if (v !== (task.points ?? null)) onSave({ points: v });
  };
  return (
    <>
      <dt className="text-subtle">Sprint</dt>
      <dd><Select aria-label="Move to sprint" value={task.sprintId ?? ""} onChange={(e) => onSave({ sprintId: e.target.value || null })} className="h-8 text-[13px]">
        <option value="">Backlog</option>
        {options.map((s) => <option key={s.id} value={s.id} disabled={s.status === "completed"}>{s.name}{s.status === "active" ? " (active)" : s.status === "completed" ? " (completed)" : ""}</option>)}
      </Select></dd>
      <dt className="text-subtle">Estimate</dt>
      <dd className="flex items-center gap-2"><Input aria-label="Estimate" type="number" min={0} max={1000} step="0.5" inputMode="decimal" placeholder="None" value={pts}
        onChange={(e) => setPts(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="h-8 w-24 text-[13px]" />
        <span className="text-[12.5px] text-subtle">{unit}</span></dd>
    </>
  );
}
