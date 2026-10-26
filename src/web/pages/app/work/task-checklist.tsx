/**
 * R26 (MB-85): the Checklist section of the task panel and the small "3/5" chip on cards and rows.
 * Add (Enter adds the next one), tick, rename inline, drag or Alt+Up/Down to reorder, delete, and make a subtask.
 */
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, GripVertical, ListChecks, ListTree, Square, Trash2 } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Input } from "@/web/components/ui/input";
import { cn } from "@/web/lib/cn";

export interface ChecklistItem { id: string; taskId: string; title: string; done: boolean; position: number; assignee: string | null; due: string | null }
interface Checklist { taskId: string; items: ChecklistItem[]; total: number; done: number }

export function ChecklistChip({ checklist }: { checklist?: { total: number; done: number } }) {
  if (!checklist?.total) return null;
  const all = checklist.done === checklist.total;
  return (
    <span className={cn("inline-flex items-center gap-0.5", all && "text-ok")} title={`Checklist: ${checklist.done} of ${checklist.total} done`} aria-label={`Checklist ${checklist.done} of ${checklist.total}`}>
      <ListChecks className="h-3 w-3" />{checklist.done}/{checklist.total}
    </span>
  );
}

export function TaskChecklist({ taskId, onSubtask }: { taskId: string; onSubtask?: () => void }) {
  const qc = useQueryClient();
  const key = ["checklist", taskId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Checklist>(`/tasks/${taskId}/checklist`) });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const items = q.data?.items ?? [];
  const done = items.filter((i) => i.done).length;

  const refresh = async () => { await qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ["tasks"] }); };
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { showError(e as Error); } await refresh(); };
  const setLocal = (next: ChecklistItem[]) => qc.setQueryData<Checklist>(key, (old) => (old ? { ...old, items: next, total: next.length, done: next.filter((i) => i.done).length } : old));

  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    await run(() => api.post(`/tasks/${taskId}/checklist`, { title }));
    addRef.current?.focus();
  };
  const tick = (i: ChecklistItem) => { setLocal(items.map((x) => (x.id === i.id ? { ...x, done: !x.done } : x))); void run(() => api.patch(`/checklist-items/${i.id}`, { done: !i.done })); };
  const rename = (i: ChecklistItem, title: string) => { setEditing(null); if (title.trim() && title.trim() !== i.title) void run(() => api.patch(`/checklist-items/${i.id}`, { title: title.trim() })); };
  const reorder = (ids: string[]) => { setLocal(ids.map((id) => items.find((x) => x.id === id)!)); void run(() => api.post(`/tasks/${taskId}/checklist/reorder`, { ids })); };
  const move = (id: string, by: number) => {
    const ids = items.map((x) => x.id);
    const i = ids.indexOf(id); const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(ids);
  };
  const dropOn = (target: string) => {
    if (!dragId || dragId === target) return;
    const ids = items.map((x) => x.id).filter((x) => x !== dragId);
    ids.splice(ids.indexOf(target), 0, dragId);
    setDragId(null);
    reorder(ids);
  };

  return (
    <section className="mt-6" aria-label="Checklist">
      <div className="flex items-center gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Checklist</h3>
        {items.length > 0 && <span className="text-[12px] text-subtle" data-testid="checklist-progress">{done} of {items.length}</span>}
      </div>
      {items.length > 0 && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-fill" role="progressbar" aria-label="Checklist progress" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done}>
          <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${(done / items.length) * 100}%` }} />
        </div>
      )}
      <ul className="mt-2 space-y-0.5">
        {items.map((i) => (
          <li key={i.id} draggable={editing !== i.id} onDragStart={() => setDragId(i.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => dropOn(i.id)} onDragEnd={() => setDragId(null)}
            onKeyDown={(e) => { if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); move(i.id, e.key === "ArrowUp" ? -1 : 1); } }}
            className={cn("group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-hover", dragId === i.id && "opacity-50")}>
            <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-subtle opacity-0 group-hover:opacity-100" aria-hidden />
            <button type="button" role="checkbox" aria-checked={i.done} aria-label={i.done ? `Untick ${i.title}` : `Tick ${i.title}`} onClick={() => tick(i)} className="shrink-0">
              {i.done ? <CheckSquare className="h-4 w-4 text-brand" /> : <Square className="h-4 w-4 text-muted" />}
            </button>
            {editing === i.id ? (
              <Input autoFocus aria-label="Item title" defaultValue={i.title} className="h-7 text-[13px]"
                onBlur={(e) => rename(i, e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") rename(i, (e.target as HTMLInputElement).value); if (e.key === "Escape") { e.stopPropagation(); setEditing(null); } }} />
            ) : (
              <button type="button" onClick={() => setEditing(i.id)} title="Rename" aria-label={`Rename ${i.title}`} className={cn("min-w-0 flex-1 truncate text-left text-[13px]", i.done && "text-subtle line-through")}>{i.title}</button>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
              <button type="button" aria-label={`Make ${i.title} a subtask`} title="Make a subtask" onClick={() => void run(async () => { await api.post(`/checklist-items/${i.id}/to-subtask`); onSubtask?.(); })} className="rounded p-1 text-subtle hover:text-fg"><ListTree className="h-3.5 w-3.5" /></button>
              <button type="button" aria-label={`Delete ${i.title}`} title="Delete" onClick={() => { setLocal(items.filter((x) => x.id !== i.id)); void run(() => api.del(`/checklist-items/${i.id}`)); }} className="rounded p-1 text-subtle hover:text-bad"><Trash2 className="h-3.5 w-3.5" /></button>
            </span>
          </li>
        ))}
      </ul>
      <form className="mt-1.5" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Input ref={addRef} aria-label="New checklist item" placeholder="Add an item and press Enter" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 text-[13px]" />
      </form>
      {items.length > 1 && <p className="mt-1 text-[11.5px] text-subtle">Drag to reorder, or Alt and the arrow keys.</p>}
    </section>
  );
}
