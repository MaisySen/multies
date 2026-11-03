import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconListPlus, IconTasks, IconVideo } from "@/web/components/ui/icon";
import { startMeeting } from "./meeting-start";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import type { Task } from "./data";

/**
 * R50 (MB-238): one code path for making a task from a thread, shared by the inline button and the phone reply bar.
 * Both read the same query, so a task made from either shows as a chip at once.
 */
export function useMakeTask(messageId: string, threadId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const linked = useQuery({ queryKey: ["tasks", { threadId }], queryFn: async () => (await api.get<{ tasks: Task[] }>(`/tasks?threadId=${encodeURIComponent(threadId)}`)).tasks, staleTime: 15_000 });
  // A push, not a replace: Back from the task lands on this thread again.
  const open = (taskId: string) => navigate(`/app/tasks?view=list&task=${encodeURIComponent(taskId)}`);
  const make = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ task: Task }>("/tasks/from-email", { messageId }, { idempotencyKey: `task-from-${messageId}-${Date.now() >> 12}` });
      await qc.invalidateQueries({ queryKey: ["tasks"] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`${r.task.ref} created`, { action: { label: "Open", onClick: () => open(r.task.id) } });
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return { linked, busy, make, open };
}

/** R50: the chip's accessible name keeps the ref and status; on a phone the visible text is the title. */
export function chipLabel(t: Pick<Task, "ref" | "title" | "statusName">) {
  return `Task ${t.ref}: ${t.title || "Untitled"}, ${t.statusName}`;
}

/** "Make task" on any thread: one click, and chips for the tasks already made from it. */
export function MakeTask({ messageId, threadId, compact, shortcut }: { messageId: string; threadId: string; compact?: boolean; shortcut?: boolean }) {
  const navigate = useNavigate();
  const { linked, busy, make, open } = useMakeTask(messageId, threadId);
  // "t" makes a task from the open message, next to the reader's other shortcuts.
  const makeRef = useRef(make);
  makeRef.current = make;
  useEffect(() => {
    if (!shortcut) return;
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== "t" || e.metaKey || e.ctrlKey || e.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable || document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      void makeRef.current();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [shortcut]);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {linked.data?.map((t) => (
        <button key={t.id} onClick={() => open(t.id)} data-testid="linked-task" aria-label={chipLabel(t)}
          className={cn("inline-flex items-center gap-1 rounded-full border border-line bg-elevated px-2 py-0.5 text-[12px] hover:border-line-strong max-sm:min-h-11 max-sm:max-w-[70vw] max-sm:gap-1.5 max-sm:px-3.5 max-sm:text-[13px]", t.status === "done" ? "text-subtle line-through" : "text-fg")}>
          <IconTasks className="h-3 w-3 shrink-0 max-sm:h-4 max-sm:w-4" aria-hidden />
          <span className="max-sm:hidden">{t.ref} {t.statusName}</span>
          <span className="truncate sm:hidden">Task: {t.title || "Untitled"}</span>
        </button>
      ))}
      <button onClick={make} disabled={busy} aria-label="Make task from this email" title={shortcut ? "Make task (t)" : "Make task"}
        className={cn("inline-flex items-center gap-1.5 rounded-md text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50 max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center", compact ? "p-2" : "border border-line px-2.5 py-1.5 max-sm:px-3.5")}>
        <IconListPlus className="h-4 w-4" />{!compact && "Make task"}
      </button>
      <button onClick={() => void startMeeting({ type: "thread", id: threadId }, navigate)} aria-label="Start a meeting about this email" title="Start a meeting"
        className={cn("inline-flex items-center gap-1.5 rounded-md text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center", compact ? "p-2" : "border border-line px-2.5 py-1.5 max-sm:px-3.5")}>
        <IconVideo className="h-4 w-4" />{!compact && "Meeting"}
      </button>
    </div>
  );
}

/**
 * R50 (MB-238): the task action in the phone thread reply bar, a 44 px round button under the thumb. One tap makes a
 * task from the thread; when the thread already has one, the same tap opens it instead of making a second.
 */
export function MakeTaskBarButton({ messageId, threadId }: { messageId: string; threadId: string }) {
  const { linked, busy, make, open } = useMakeTask(messageId, threadId);
  const existing = linked.data?.find((t) => t.status !== "done") ?? linked.data?.[0];
  return (
    <button type="button" data-testid="reply-bar-task" disabled={busy || linked.isLoading}
      onClick={() => (existing ? open(existing.id) : void make())}
      aria-label={existing ? `Open task ${existing.ref}` : "Make a task"}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line-strong text-fg transition-colors duration-150 active:bg-hover disabled:opacity-50">
      {existing ? <IconTasks className="h-[18px] w-[18px] text-brand-hover" aria-hidden /> : <IconListPlus className="h-[18px] w-[18px]" aria-hidden />}
    </button>
  );
}
