import { IconArrowDown, IconArrowUp, IconCalendarDays, IconCircleDot, IconFlag, IconRows, IconTag, IconUserRound, IconWarning } from "@/web/components/ui/icon";
import type { Command } from "../types";

const focused = (ctx: { focus: { kind: string | null } }) => ctx.focus.kind === "task";

/** The pickers a focused task opens inside the command menu (nested pages). */
export type TaskPickerPage = "status" | "assignee" | "priority" | "label" | "due";
export const TASK_PICKERS: { page: TaskPickerPage; key: string; title: string; icon: Command["icon"]; keywords: string[] }[] = [
  { page: "status", key: "S", title: "Change status...", icon: IconCircleDot, keywords: ["state", "done", "progress", "move"] },
  { page: "assignee", key: "A", title: "Assign to...", icon: IconUserRound, keywords: ["owner", "person", "assignee"] },
  { page: "priority", key: "P", title: "Set priority...", icon: IconFlag, keywords: ["urgent", "important"] },
  { page: "label", key: "L", title: "Add a label...", icon: IconTag, keywords: ["tag", "labels"] },
  { page: "due", key: "D", title: "Set due date...", icon: IconCalendarDays, keywords: ["deadline", "date", "when"] },
];

/** Task keys: J/K walk the list; on a focused or open task, a single key opens its picker in the command menu. */
export const taskCommands: Command[] = [
  { id: "task-next", title: "Next task", group: "Tasks", scope: "tasks-list", keys: ["J"], keywords: ["down"], icon: IconArrowDown, handler: "page" },
  { id: "task-prev", title: "Previous task", group: "Tasks", scope: "tasks-list", keys: ["K"], keywords: ["up"], icon: IconArrowUp, handler: "page" },
  // R34 (MB-186): on a board with swimlanes, fold every lane or open them all.
  { id: "board-lanes-collapse", title: "Collapse or open all lanes", group: "Tasks", scope: "tasks-list", keys: ["Shift", "L"], keywords: ["swimlanes", "lanes", "board", "fold"], icon: IconRows, palette: true, handler: "page" },
  // R37: on the timeline, list the tasks that start before what they wait on is finished (with Fix and Fix all).
  { id: "timeline-clashes", title: "Show date clashes", group: "Tasks", scope: "tasks-list", keys: ["Shift", "D"], keywords: ["dependencies", "timeline", "gantt", "blocked", "schedule", "overlap"], icon: IconWarning, palette: true, handler: "page" },
  ...TASK_PICKERS.map((p): Command => ({
    id: `task-${p.page}`, title: p.title, group: "Tasks", scope: "task", keys: [p.key], keywords: p.keywords, icon: p.icon,
    palette: true, when: focused, handler: "run", run: (c) => c.openPalette(`task:${p.page}`),
  })),
  // R45: the backlog's keyboard selection (sprints.tsx); the list handles these keys itself.
  { id: "backlog-extend", title: "Select more backlog rows", group: "Tasks", scope: "tasks-list", keys: ["Shift", "Up or Down"], keywords: ["backlog", "select", "multi"], handler: "local" },
  { id: "backlog-toggle", title: "Select or clear a backlog row", group: "Tasks", scope: "tasks-list", keys: ["Space"], keywords: ["backlog", "select", "checkbox"], handler: "local" },
  { id: "backlog-move", title: "Move the selected backlog rows to a sprint", group: "Tasks", scope: "tasks-list", keys: ["M"], keywords: ["backlog", "sprint", "move"], handler: "local" },
  { id: "backlog-clear", title: "Clear the backlog selection", group: "Tasks", scope: "tasks-list", keys: ["Esc"], keywords: ["backlog", "select", "deselect"], handler: "local" },
  { id: "check-move", title: "Move a checklist item", group: "Tasks", scope: "writing", keys: ["Alt", "Up or Down"], keywords: ["reorder", "checklist"], handler: "local" },
  { id: "check-next", title: "Add the next checklist item", group: "Tasks", scope: "writing", keys: ["Enter"], keywords: ["checklist"], handler: "local" },
];
