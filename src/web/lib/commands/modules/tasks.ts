import { ArrowDown, ArrowUp, CalendarDays, CircleDot, Flag, Rows3, Tag, UserRound } from "lucide-react";
import type { Command } from "../types";

const focused = (ctx: { focus: { kind: string | null } }) => ctx.focus.kind === "task";

/** The pickers a focused task opens inside the command menu (nested pages). */
export type TaskPickerPage = "status" | "assignee" | "priority" | "label" | "due";
export const TASK_PICKERS: { page: TaskPickerPage; key: string; title: string; icon: Command["icon"]; keywords: string[] }[] = [
  { page: "status", key: "S", title: "Change status...", icon: CircleDot, keywords: ["state", "done", "progress", "move"] },
  { page: "assignee", key: "A", title: "Assign to...", icon: UserRound, keywords: ["owner", "person", "assignee"] },
  { page: "priority", key: "P", title: "Set priority...", icon: Flag, keywords: ["urgent", "important"] },
  { page: "label", key: "L", title: "Add a label...", icon: Tag, keywords: ["tag", "labels"] },
  { page: "due", key: "D", title: "Set due date...", icon: CalendarDays, keywords: ["deadline", "date", "when"] },
];

/** Task keys: J/K walk the list; on a focused or open task, a single key opens its picker in the command menu. */
export const taskCommands: Command[] = [
  { id: "task-next", title: "Next task", group: "Tasks", scope: "tasks-list", keys: ["J"], keywords: ["down"], icon: ArrowDown, handler: "page" },
  { id: "task-prev", title: "Previous task", group: "Tasks", scope: "tasks-list", keys: ["K"], keywords: ["up"], icon: ArrowUp, handler: "page" },
  // R34 (MB-186): on a board with swimlanes, fold every lane or open them all.
  { id: "board-lanes-collapse", title: "Collapse or open all lanes", group: "Tasks", scope: "tasks-list", keys: ["Shift", "L"], keywords: ["swimlanes", "lanes", "board", "fold"], icon: Rows3, palette: true, handler: "page" },
  ...TASK_PICKERS.map((p): Command => ({
    id: `task-${p.page}`, title: p.title, group: "Tasks", scope: "task", keys: [p.key], keywords: p.keywords, icon: p.icon,
    palette: true, when: focused, handler: "run", run: (c) => c.openPalette(`task:${p.page}`),
  })),
  { id: "check-move", title: "Move a checklist item", group: "Tasks", scope: "writing", keys: ["Alt", "Up or Down"], keywords: ["reorder", "checklist"], handler: "local" },
  { id: "check-next", title: "Add the next checklist item", group: "Tasks", scope: "writing", keys: ["Enter"], keywords: ["checklist"], handler: "local" },
];
