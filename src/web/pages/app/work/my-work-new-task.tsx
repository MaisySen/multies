/**
 * F13b (MB-306): New task from My Work opens the task dialog right here (loaded on first use) and stays on My Work.
 */
import { NewTaskDialog } from "./tasks";
import { useProjects, useTaskMutations } from "./data";

export function MyWorkNewTask({ onClose, onMade }: { onClose: () => void; onMade: (task: { id: string; ref: string }) => Promise<void> }) {
  const projects = useProjects();
  const { create } = useTaskMutations();
  if (!projects.data) return null;
  const open = projects.data.filter((p) => !p.archived);
  return (
    <NewTaskDialog projects={open} projectId={open[0]?.id} onClose={onClose}
      onCreate={async (body, more) => { const r = await create.mutateAsync(body); await onMade(r.task); if (!more) onClose(); }} />
  );
}
