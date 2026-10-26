/**
 * R27 (teardown): the Watch button in the task panel header, and Duplicate in its More menu.
 * Watchers hear about new comments and status changes. The count opens the list of who watches.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Users } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { cn } from "@/web/lib/cn";

interface Watcher { userId: string; name: string; email: string | null; source: "manual" | "auto"; since: string }
interface Watchers { taskId: string; watching: boolean; count: number; watchers: Watcher[] }

const btn = "inline-flex h-10 items-center justify-center gap-1 rounded-md px-2 text-[12.5px] text-muted hover:bg-elevated hover:text-fg sm:h-auto sm:py-1.5";

export function WatchButton({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const key = ["task-watchers", taskId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Watchers>(`/tasks/${taskId}/watchers`) });
  const watching = !!q.data?.watching;
  const toggle = async () => {
    try {
      const next = watching ? await api.del<Watchers>(`/tasks/${taskId}/watchers/me`) : await api.post<Watchers>(`/tasks/${taskId}/watchers`, {});
      qc.setQueryData(key, next);
      toast.success(watching ? "You stopped watching this task" : "Watching: you'll hear about comments and status changes");
    } catch (e) { showError(e as Error); }
  };
  const remove = async (userId: string) => {
    try { qc.setQueryData(key, await api.del<Watchers>(`/tasks/${taskId}/watchers/${encodeURIComponent(userId)}`)); } catch (e) { showError(e as Error); }
  };
  if (!q.data) return null;
  return (
    <div className="flex items-center">
      <button type="button" onClick={() => void toggle()} aria-pressed={watching} data-testid="watch-task"
        className={cn(btn, watching && "text-brand-hover hover:text-brand-hover")} title={watching ? "Stop watching" : "Watch this task"}>
        {watching ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        <span className="hidden sm:inline">{watching ? "Watching" : "Watch"}</span>
      </button>
      <Menu trigger={<button type="button" className={btn} aria-label={`${q.data.count} watching`} data-testid="watcher-count"><Users className="h-3.5 w-3.5" />{q.data.count}</button>}>
        {q.data.watchers.length === 0 && <MenuItem onSelect={() => undefined}>Nobody is watching yet</MenuItem>}
        {q.data.watchers.map((w) => (
          <MenuItem key={w.userId} icon={<EyeOff />} onSelect={() => void remove(w.userId)}>
            <span className="whitespace-nowrap">{w.name}</span><span className="ml-auto pl-3 text-[12px] text-subtle">Remove</span>
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}

/** Duplicates the task with its subtasks and checklist, then opens the copy. */
export function useDuplicateTask() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async (taskId: string) => {
    try {
      const r = await api.post<{ task: { id: string; ref: string }; copied: { subtasks: number; checklistItems: number } }>(`/tasks/${taskId}/duplicate`, {});
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      const extra = [r.copied.subtasks ? `${r.copied.subtasks} subtask${r.copied.subtasks === 1 ? "" : "s"}` : "", r.copied.checklistItems ? `${r.copied.checklistItems} checklist item${r.copied.checklistItems === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
      toast.success(`Duplicated as ${r.task.ref}${extra ? ` with ${extra}` : ""}`);
      navigate(`/app/tasks?task=${encodeURIComponent(r.task.id)}`);
    } catch (e) { showError(e as Error); }
  };
}
