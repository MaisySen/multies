/**
 * Round 21 (R21.4): task types (task, story, bug, epic) and epics in the web app. The type icon sits
 * before the key on board cards and list rows; the task panel has a type picker, an epic picker and,
 * for an epic, its items with a progress bar; the Epics panel lists a project's epics.
 */
import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { IconBook, IconBug, IconCheckCircle, IconCircle, IconClose, IconMountain, IconPlus, IconTasks, type IconComponent } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { showError } from "@/web/lib/show-error";
import { Dialog } from "@/web/components/ui/dialog";
import { Input, Select } from "@/web/components/ui/input";
import { Button } from "@/web/components/ui/button";
import { Skeleton } from "@/web/components/ui/misc";
import { dueLabel, useTasks, type Project, type Task } from "./data";

export type TaskType = "task" | "story" | "bug" | "epic";
export const TASK_TYPES: TaskType[] = ["task", "story", "bug", "epic"];
export const TYPE_META: Record<TaskType, { label: string; Icon: IconComponent; color: string }> = {
  task: { label: "Task", Icon: IconTasks, color: "#4a90d9" },
  story: { label: "Story", Icon: IconBook, color: "#2f9e62" },
  bug: { label: "Bug", Icon: IconBug, color: "#d9534f" },
  epic: { label: "Epic", Icon: IconMountain, color: "#8a5cc7" },
};
export const typeOf = (t: { type?: string } | undefined): TaskType => (t?.type && t.type in TYPE_META ? t.type as TaskType : "task");

export interface EpicProgress {
  done: number; total: number; percent: number; items: number; subtasks: number;
  points: { done: number; total: number; percent: number } | null; start: string | null; end: string | null;
}
export type Epic = Task & { progress: EpicProgress };

/** The small type icon shown before a task's key. */
export function TypeIcon({ type, className }: { type?: string; className?: string }) {
  const meta = TYPE_META[typeOf({ type })];
  return <meta.Icon className={cn("h-3.5 w-3.5 shrink-0", className)} style={{ color: meta.color }} aria-label={meta.label} role="img" data-testid={`type-icon-${typeOf({ type })}`} />;
}

/** Four buttons: Task, Story, Bug, Epic. The selected one is in the brand colour. */
export function TypePicker({ value, onChange, disabled }: { value: TaskType; onChange: (t: TaskType) => void; disabled?: TaskType[] }) {
  return (
    <div role="radiogroup" aria-label="Type" className="inline-flex flex-wrap gap-1">
      {TASK_TYPES.map((k) => {
        const { label, Icon, color } = TYPE_META[k];
        const on = value === k;
        return (
          <button key={k} type="button" role="radio" aria-checked={on} disabled={disabled?.includes(k)} onClick={() => !on && onChange(k)}
            className={cn("inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12.5px] transition-colors disabled:opacity-40",
              on ? "border-[#0071E3] bg-[#0071E3]/10 font-medium text-[#0071E3]" : "border-line text-muted hover:border-line-strong hover:text-fg")}>
            <Icon className="h-3.5 w-3.5" style={{ color: on ? "#0071E3" : color }} aria-hidden />{label}
          </button>
        );
      })}
    </div>
  );
}

/** done of total with a bar; percent on the right. */
export function EpicProgressBar({ progress, className }: { progress: EpicProgress; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill" role="progressbar" aria-label="Epic progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
        <div className="h-full rounded-full bg-[#0071E3] transition-[width]" style={{ width: `${progress.percent}%` }} />
      </div>
      <span className="shrink-0 text-[12px] tabular-nums text-muted" data-testid="epic-progress">{progress.done} of {progress.total} done, {progress.percent}%</span>
    </div>
  );
}

export const useEpics = (projectId?: string) =>
  useQuery({ queryKey: ["epics", projectId ?? ""], staleTime: 15_000, queryFn: async () => (await api.get<{ epics: Epic[] }>(`/epics${projectId ? `?project=${projectId}` : ""}`)).epics });

/** The Type and Epic rows of the task panel's details list. */
export function TaskTypeRows({ task, onSave }: { task: Task; onSave: (patch: Record<string, unknown>) => void }) {
  const epics = useEpics(task.projectId);
  const type = typeOf(task);
  const inEpic = !!task.parentId && !!epics.data?.some((e) => e.id === task.parentId);
  // A subtask of a story, task or bug stays where it is; only top level items and epic items pick an epic.
  const canPickEpic = type !== "epic" && (!task.parentId || inEpic);
  return (
    <Fragment>
      <dt className="text-subtle">Type</dt>
      <dd><TypePicker value={type} onChange={(t) => onSave({ type: t })} disabled={task.parentId && !inEpic ? ["epic"] : inEpic ? ["epic"] : undefined} /></dd>
      {canPickEpic && (
        <>
          <dt className="text-subtle">Epic</dt>
          <dd><Select aria-label="Epic" value={inEpic ? task.parentId! : ""} onChange={(e) => onSave({ parentId: e.target.value || null })} className="h-8 text-[13px]">
            <option value="">No epic</option>
            {epics.data?.map((e) => <option key={e.id} value={e.id}>{e.ref} {e.title}</option>)}
          </Select></dd>
        </>
      )}
    </Fragment>
  );
}

/** For an epic: its progress, its items and an "Add to epic" picker. */
export function EpicSection({ epic, onChanged }: { epic: Task; onChanged: () => void }) {
  const qc = useQueryClient();
  const [, setParams] = useSearchParams();
  const onOpen = (id: string) => setParams((p) => { const n = new URLSearchParams(p); n.set("task", id); return n; }, { replace: true });
  const detail = useQuery({ queryKey: ["epic", epic.id, epic.version], queryFn: () => api.get<{ epic: Epic; items: Task[] }>(`/epics/${epic.id}`) });
  const candidates = useTasks({ projectId: epic.projectId });
  const [busy, setBusy] = useState(false);
  const items = detail.data?.items ?? [];
  const inside = new Set(items.map((t) => t.id));
  const pickable = (candidates.data ?? []).filter((t) => t.id !== epic.id && typeOf(t) !== "epic" && !inside.has(t.id));
  const refresh = async () => {
    await detail.refetch();
    void qc.invalidateQueries({ queryKey: ["tasks"] });
    void qc.invalidateQueries({ queryKey: ["epics"] });
    onChanged();
  };
  const move = async (ids: string[], remove = false) => {
    setBusy(true);
    try { await (remove ? api.del(`/epics/${epic.id}/items`, { ids }) : api.post(`/epics/${epic.id}/items`, { ids })); await refresh(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const toggle = async (t: Task) => {
    try { await api.patch(`/tasks/${t.id}`, { status: t.status === "done" ? "todo" : "done" }); await refresh(); } catch (e) { showError(e as Error); }
  };
  return (
    <section className="mt-6" aria-label="Epic items" data-testid="epic-section">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">In this epic {detail.data && <span className="font-normal normal-case">{items.length} {items.length === 1 ? "item" : "items"}</span>}</h3>
      {detail.data ? <EpicProgressBar progress={detail.data.epic.progress} className="mt-2" /> : <Skeleton className="mt-2 h-4" />}
      <ul className="mt-2 space-y-1">
        {items.map((s) => (
          <li key={s.id} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-hover">
            <button aria-label={s.status === "done" ? `Mark ${s.title} as not done` : `Mark ${s.title} as done`} onClick={() => void toggle(s)}>
              {s.status === "done" ? <IconCheckCircle className="h-4 w-4 text-ok" /> : <IconCircle className="h-4 w-4 text-muted" />}
            </button>
            <TypeIcon type={s.type} />
            <span className="font-mono text-[11.5px] text-subtle">{s.ref}</span>
            <button className={cn("min-w-0 truncate text-left text-[13px] hover:underline", s.status === "done" && "text-subtle line-through")} onClick={() => onOpen(s.id)}>{s.title}</button>
            <button aria-label={`Take ${s.title} out of this epic`} disabled={busy} onClick={() => void move([s.id], true)} className="ml-auto rounded p-0.5 text-subtle opacity-0 hover:text-fg group-hover:opacity-100 focus:opacity-100"><IconClose className="h-3.5 w-3.5" /></button>
          </li>
        ))}
        {detail.data && !items.length && <li className="px-1 py-1 text-[13px] text-muted">Nothing in this epic yet.</li>}
      </ul>
      <Select aria-label="Add to epic" value="" disabled={busy || !pickable.length} onChange={(e) => e.target.value && void move([e.target.value])} className="mt-1.5 h-8 text-[13px]">
        <option value="">{pickable.length ? "Add to epic" : "No other tasks to add"}</option>
        {pickable.map((t) => <option key={t.id} value={t.id}>{TYPE_META[typeOf(t)].label}: {t.ref} {t.title}</option>)}
      </Select>
    </section>
  );
}

/** The project's epics, each with its progress; click one to open it. A quick way to start an epic, too. */
export function EpicsDialog({ project, onClose, onOpen }: { project: Project; onClose: () => void; onOpen: (id: string) => void }) {
  const epics = useEpics(project.id);
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.post("/tasks", { title, projectId: project.id, type: "epic" });
      setTitle(""); await epics.refetch(); void qc.invalidateQueries({ queryKey: ["tasks"] });
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={`Epics in ${project.name}`} description="Big pieces of work. Each epic groups stories, tasks and bugs and shows how far along they are." className="max-w-xl">
      <div data-testid="epics-panel">
        {epics.isPending ? <Skeleton className="h-24" /> : (
          <ul className="space-y-2">
            {epics.data?.map((e) => (
              <li key={e.id}>
                <button onClick={() => onOpen(e.id)} className="w-full rounded-lg border border-line bg-elevated p-3 text-left transition-colors hover:border-line-strong" data-testid="epic-row">
                  <div className="flex items-center gap-2">
                    <TypeIcon type="epic" />
                    <span className="font-mono text-[11.5px] text-subtle">{e.ref}</span>
                    <span className="min-w-0 truncate text-[13.5px] font-medium">{e.title}</span>
                    <span className="ml-auto shrink-0 text-[12px] text-subtle">{e.progress.items} {e.progress.items === 1 ? "item" : "items"}{e.progress.end ? `, ends ${dueLabel(e.progress.end)}` : ""}</span>
                  </div>
                  <EpicProgressBar progress={e.progress} className="mt-2" />
                </button>
              </li>
            ))}
            {!epics.data?.length && <li className="py-6 text-center text-[13px] text-muted">No epics yet. Start one below, or set a task's type to Epic.</li>}
          </ul>
        )}
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Input aria-label="New epic" placeholder="New epic, for example Checkout redesign" value={title} onChange={(e) => setTitle(e.target.value)} className="h-9 text-[13px]" />
          <Button type="submit" size="sm" loading={busy} disabled={!title.trim()}><IconPlus className="h-4 w-4" />Add epic</Button>
        </form>
      </div>
    </Dialog>
  );
}
