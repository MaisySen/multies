import { IconInfo } from "@/web/components/ui/icon";
import { TASK_LIST_LIMIT } from "@/shared/task-list-limit";

/**
 * R45b: shown when a task list read came back full (the server sends at most TASK_LIST_LIMIT tasks per read), so the
 * board, list or backlog does not quietly show short counts for a big project.
 */
export function ListCapNotice({ what, hint, className = "" }: { what: string; hint: string; className?: string }) {
  return (
    <p role="status" data-testid="list-cap-notice"
      className={`flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] leading-snug text-muted ${className}`}>
      <IconInfo className="mt-px h-4 w-4 shrink-0 text-subtle" aria-hidden />
      <span>Showing the first {TASK_LIST_LIMIT.toLocaleString("en")} {what}. {hint}</span>
    </p>
  );
}
