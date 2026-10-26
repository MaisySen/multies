import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import { cached } from "./offline";
import { kv } from "./kv";
import { keys } from "./queries";
import { applyOrder, draftItem, patchItem, removeItem, sortItems, summarise } from "./checklist";
import type { ChecklistItem, ChecklistView, Task } from "@/api/types";

/** R27: the checklist inside one task. */
export const checklistKey = (taskId: string) => ["task", taskId, "checklist"] as const;

export function useChecklist(taskId: string) {
  const { api, mode } = useSession();
  return useQuery({
    queryKey: checklistKey(taskId),
    queryFn: () => cached<ChecklistView>(kv(), `task:${mode}:${taskId}:checklist`, () => api.checklist(taskId)),
    select: (d) => ({ ...d, items: sortItems(d.items) }),
    enabled: !!taskId,
  });
}

type Ctx = { before?: ChecklistView };

/**
 * Every change shows at once and rolls back if the server says no. The task rows' "3/5" badge
 * follows the same optimistic copy.
 */
export function useChecklistMutations(taskId: string) {
  const { api } = useSession();
  const qc = useQueryClient();
  const key = checklistKey(taskId);

  const setItems = (items: ChecklistItem[]) => {
    const c = summarise(items);
    qc.setQueryData<ChecklistView>(key, (d) => ({ taskId, ...(d ?? {}), items, ...c }));
    qc.setQueriesData<{ tasks: Task[] }>({ queryKey: keys.tasks }, (d) => d && { tasks: d.tasks.map((t) => (t.id === taskId ? { ...t, checklist: c } : t)) });
  };
  const optimistic = async (change: (items: ChecklistItem[]) => ChecklistItem[]): Promise<Ctx> => {
    await qc.cancelQueries({ queryKey: key });
    const before = qc.getQueryData<ChecklistView>(key);
    setItems(change(before?.items ?? []));
    return { before };
  };
  const rollback = (_e: Error, _v: unknown, ctx?: Ctx) => { if (ctx?.before) setItems(ctx.before.items); };
  const settle = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: keys.tasks });
  };

  return {
    add: useMutation({
      mutationFn: (title: string) => api.addChecklistItem(taskId, title),
      onMutate: (title) => optimistic((items) => [...items, draftItem(taskId, title, items)]),
      onError: rollback,
      onSettled: settle,
    }),
    toggle: useMutation({
      mutationFn: (v: { id: string; done: boolean }) => api.updateChecklistItem(v.id, { done: v.done }),
      onMutate: (v) => optimistic((items) => patchItem(items, v.id, { done: v.done })),
      onError: rollback,
      onSettled: settle,
    }),
    rename: useMutation({
      mutationFn: (v: { id: string; title: string }) => api.updateChecklistItem(v.id, { title: v.title }),
      onMutate: (v) => optimistic((items) => patchItem(items, v.id, { title: v.title })),
      onError: rollback,
      onSettled: settle,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.deleteChecklistItem(id),
      onMutate: (id) => optimistic((items) => removeItem(items, id)),
      onError: rollback,
      onSettled: settle,
    }),
    reorder: useMutation({
      mutationFn: (ids: string[]) => api.reorderChecklist(taskId, ids),
      onMutate: (ids) => optimistic((items) => applyOrder(items, ids)),
      onError: rollback,
      onSettled: settle,
    }),
  };
}
