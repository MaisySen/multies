import { useCallback, useEffect, useReducer, useRef } from "react";
import { UNDO_WINDOW_MS, emptyUndo, hiddenIds, newestPending, undoReducer, type PendingAction } from "./swipe";

/**
 * R31: rows swiped away hide at once; the action runs when the undo window closes, unless Undo is
 * tapped first. Leaving the screen runs whatever is still waiting (nothing is lost).
 */
export function useUndoQueue(windowMs = UNDO_WINDOW_MS) {
  const [state, dispatch] = useReducer(undoReducer, emptyUndo);
  const jobs = useRef(new Map<string, { run: () => void; timer: ReturnType<typeof setTimeout> }>());

  const commit = useCallback((key: string) => {
    const job = jobs.current.get(key);
    if (!job) return;
    clearTimeout(job.timer);
    jobs.current.delete(key);
    dispatch({ type: "commit", key });
    job.run();
  }, []);

  const push = useCallback((rowId: string, label: string, run: () => void) => {
    // A second action on the same row replaces the first: drop its job without running it.
    for (const [k, j] of jobs.current) if (k.startsWith(`${rowId}#`)) { clearTimeout(j.timer); jobs.current.delete(k); }
    const key = `${rowId}#${Date.now()}`;
    const timer = setTimeout(() => commit(key), windowMs);
    jobs.current.set(key, { run, timer });
    const action: PendingAction = { key, rowId, label, at: Date.now() };
    dispatch({ type: "add", action });
  }, [commit, windowMs]);

  const undo = useCallback((key: string) => {
    const job = jobs.current.get(key);
    if (job) clearTimeout(job.timer);
    jobs.current.delete(key);
    dispatch({ type: "undo", key });
  }, []);

  useEffect(() => () => {
    for (const [, j] of jobs.current) { clearTimeout(j.timer); j.run(); }
    jobs.current.clear();
  }, []);

  return { hidden: hiddenIds(state), newest: newestPending(state), push, undo, commit };
}
