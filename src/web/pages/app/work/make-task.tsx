import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, ListPlus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import type { Task } from "./data";

/** "Make task" on any thread: one click, and chips for the tasks already made from it. */
export function MakeTask({ messageId, threadId, compact }: { messageId: string; threadId: string; compact?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const linked = useQuery({ queryKey: ["tasks", { threadId }], queryFn: async () => (await api.get<{ tasks: Task[] }>(`/tasks?threadId=${encodeURIComponent(threadId)}`)).tasks, staleTime: 15_000 });
  const make = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ task: Task }>("/tasks/from-email", { messageId }, { idempotencyKey: `task-from-${messageId}-${Date.now() >> 12}` });
      await qc.invalidateQueries({ queryKey: ["tasks"] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`${r.task.ref} created`, { action: { label: "Open", onClick: () => navigate(`/app/tasks?view=list&task=${r.task.id}`) } });
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {linked.data?.map((t) => (
        <button key={t.id} onClick={() => navigate(`/app/tasks?view=list&task=${t.id}`)} data-testid="linked-task"
          className={cn("inline-flex items-center gap-1 rounded-full border border-line bg-elevated px-2 py-0.5 text-[12px] hover:border-line-strong", t.status === "done" ? "text-subtle line-through" : "text-fg")}>
          <CheckSquare className="h-3 w-3" />{t.ref} {t.statusName}
        </button>
      ))}
      <button onClick={make} disabled={busy} aria-label="Make task from this email" title="Make task (t)"
        className={cn("inline-flex items-center gap-1.5 rounded-md text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50", compact ? "p-2" : "border border-line px-2.5 py-1.5")}>
        <ListPlus className="h-4 w-4" />{!compact && "Make task"}
      </button>
    </div>
  );
}
