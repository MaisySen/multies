import { useEffect } from "react";
import { getFocus, setFocus, setFocusList, stepFocus, useFocus } from "./focus";
import { useCommandHandlers } from "./use-commands";

/**
 * R31: keyboard focus on a task list. J/K move it over the visible rows, the open task takes it, and the
 * focused row gets a ring (data-kb-focus, styled in index.css) and scrolls into view.
 */
export function useTaskListFocus(ids: string[], openId: string | null) {
  const key = ids.join(",");
  useEffect(() => { setFocusList("task", key ? key.split(",") : []); }, [key]);
  useEffect(() => { if (openId) setFocus("task", openId); }, [openId]);
  useEffect(() => () => { setFocusList(null, []); setFocus(null, null); }, []);
  const focus = useFocus();
  useEffect(() => {
    for (const el of document.querySelectorAll("[data-kb-focus]")) el.removeAttribute("data-kb-focus");
    if (focus.kind !== "task" || !focus.id) return;
    const el = document.querySelector(`[data-task-id="${CSS.escape(focus.id)}"]`);
    if (el) { el.setAttribute("data-kb-focus", ""); el.scrollIntoView({ block: "nearest" }); }
  });
  const step = (dir: 1 | -1) => { const id = stepFocus(getFocus(), dir); if (!id) return false; setFocus("task", id); };
  useCommandHandlers({ "task-next": () => step(1), "task-prev": () => step(-1) });
}
