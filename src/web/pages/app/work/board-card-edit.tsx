/**
 * R36: inline editing on board cards (rea: files/teardowns/rea/clickup/inline-edit-r36.md). The title edits in place
 * (pencil or double click; Enter saves, Escape cancels, leaving the field saves), and status, priority, due date
 * and assignee change from small popovers on the card, without opening the task. Optimistic with rollback
 * (lib/inline-task-edit.ts). Keys and pointer presses inside an editor stay inside it, so they never start a drag.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IconCalendar, IconCheck, IconFileEdit, IconFlag, IconUser } from "@/web/components/ui/icon";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { Avatar } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { initials, initialsLabel } from "@/web/lib/format";
import { cleanTitle, dueInputValue, editTask } from "@/web/lib/inline-task-edit";
import { PRIORITY_COLOR, PRIORITY_LABEL, dueLabel, isOverdue, useAssignees, useProjects, type Priority, type Project, type Task } from "./data";

const keep = { onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(), onPointerDown: (e: React.PointerEvent) => e.stopPropagation() };
const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low", "none"];
const chip = "inline-flex h-6 shrink-0 items-center whitespace-nowrap gap-1 rounded-md px-1.5 text-[11.5px] text-subtle transition-colors duration-100 hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand motion-reduce:transition-none";

export function CardTitle({ t, onOpen }: { t: Task; onOpen?: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(t.title);
  const done = useRef(false);
  useEffect(() => { if (!editing) setV(t.title); }, [t.title, editing]);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = save ? cleanTitle(v, t.title) : null;
    if (next) void editTask(qc, t, { title: next }, (x) => ({ ...x, title: next }));
  };
  if (editing) {
    return (
      <span {...keep} className="block">
        <textarea autoFocus aria-label="Task title" value={v} rows={Math.min(4, Math.max(1, Math.ceil(v.length / 34)))} maxLength={500}
          onChange={(e) => setV(e.target.value)} onBlur={() => finish(true)} onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } }}
          data-testid="card-title-input"
          className="block w-full resize-none rounded-md border border-brand/50 bg-surface px-1.5 py-1 text-[13.5px] font-medium leading-snug text-fg outline-none ring-2 ring-brand/20" />
        <span className="mt-1 block text-[10.5px] text-subtle">Enter to save, Esc to cancel</span>
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1">
      <button type="button" onClick={onOpen} onDoubleClick={(e) => { e.preventDefault(); done.current = false; setEditing(true); }}
        className="block min-h-6 min-w-0 flex-1 text-left text-[13.5px] font-medium leading-snug text-fg outline-none focus-visible:underline">{t.title}</button>
      <button type="button" {...keep} onClick={() => { done.current = false; setEditing(true); }} aria-label={`Rename ${t.title}`} data-testid="card-rename"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-subtle opacity-0 transition-opacity duration-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:hidden motion-reduce:transition-none">
        <IconFileEdit className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

/** Status, priority, due and assignee as one tap popovers on the card's footer. */
export function CardQuickEdits({ t, project }: { t: Task; project: Project }) {
  const qc = useQueryClient();
  const people = useAssignees();
  const [dueOpen, setDueOpen] = useState(false);
  const save = (patch: Record<string, unknown>, display: (x: Task) => Task, doneMsg?: string) => void editTask(qc, t, patch, display, doneMsg);
  return (
    <span {...keep} className="flex items-center gap-0.5" data-testid="card-quick-edits">
      {/* The column already says the status, so its chip shows on hover or keyboard focus only (no extra ink at rest). */}
      <span className="hidden group-focus-within:inline-flex group-hover:inline-flex">
      <Menu align="start" label={`Status: ${t.statusName}`} trigger={
        <button type="button" className={chip} title={t.statusName} data-testid="card-status"><span className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: t.statusColor }} /></button>}>
        {project.statuses.map((s) => (
          <MenuItem key={s.id} onSelect={() => s.id !== t.statusId && save({ statusId: s.id }, (x) => ({ ...x, statusId: s.id, statusName: s.name, statusColor: s.color, status: s.category }), `Moved to ${s.name}`)}
            icon={<span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />}>
            <span className="flex-1">{s.name}</span>{s.id === t.statusId && <IconCheck className="h-3.5 w-3.5 text-brand" />}
          </MenuItem>
        ))}
      </Menu>
      </span>
      <Menu align="start" label={`Priority: ${PRIORITY_LABEL[t.priority]}`} trigger={
        <button type="button" className={cn(chip, t.priority !== "none" && PRIORITY_COLOR[t.priority])} data-testid="card-priority">
          <IconFlag className="h-3 w-3" />{t.priority !== "none" && <span>{PRIORITY_LABEL[t.priority]}</span>}
        </button>}>
        {PRIORITIES.map((p) => (
          <MenuItem key={p} onSelect={() => p !== t.priority && save({ priority: p }, (x) => ({ ...x, priority: p }))} icon={<IconFlag className={cn("h-3.5 w-3.5", PRIORITY_COLOR[p])} />}>
            <span className="flex-1">{PRIORITY_LABEL[p]}</span>{p === t.priority && <IconCheck className="h-3.5 w-3.5 text-brand" />}
          </MenuItem>
        ))}
      </Menu>
      <span className="relative">
        <button type="button" className={cn(chip, isOverdue(t) && "text-bad")} aria-label={t.due ? `Due ${dueLabel(t.due)}, change` : "Set a due date"} aria-expanded={dueOpen} onClick={() => setDueOpen((o) => !o)} data-testid="card-due">
          <IconCalendar className="h-3 w-3" />{t.due && <span>{dueLabel(t.due)}</span>}
        </button>
        {dueOpen && (
          <span className="absolute left-0 z-50 mt-1.5 flex animate-pop-in items-center gap-1.5 rounded-[var(--radius-r14)] border border-line bg-elevated p-2 shadow-pop">
            <input type="date" autoFocus aria-label="Due date" defaultValue={dueInputValue(t.due)}
              onKeyDown={(e) => { if (e.key === "Escape") setDueOpen(false); if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
              onBlur={(e) => { const v = e.currentTarget.value; setDueOpen(false); if (v !== dueInputValue(t.due)) save({ dueAt: v || null }, (x) => ({ ...x, due: v ? `${v}T00:00:00.000Z` : null })); }}
              className="h-8 rounded-md border border-line bg-surface px-2 text-[13px]" />
          </span>
        )}
      </span>
      {/* R44: the avatar's initials are visible text (axe reads on screen text, aria-hidden or not), so the name must contain
          them as a whole word (WCAG 2.5.3). Not in brackets: axe drops parenthetical text before it compares, which is why
          R43's "Assignee: Ann Brown (AB)" still failed. */}
      <Menu align="end" label={t.assignee ? initialsLabel("Assignee", t.assignee.name) : "Assign"} trigger={
        <button type="button" className={chip} data-testid="card-assignee">
          {t.assignee ? <Avatar label={initials(t.assignee.name)} className="h-5 w-5 text-[9px]" /> : <IconUser className="h-3.5 w-3.5" />}
        </button>}>
        <MenuItem onSelect={() => t.assigneeId && save({ assignee: null }, (x) => ({ ...x, assigneeId: null, assignee: null }))} icon={<IconUser className="h-3.5 w-3.5" />}>No one</MenuItem>
        {(people.data ?? []).slice(0, 12).map((p) => (
          <MenuItem key={p.id} onSelect={() => p.id !== t.assigneeId && save({ assignee: p.id }, (x) => ({ ...x, assigneeId: p.id, assignee: { type: p.type, id: p.id.split(":")[1], name: p.name, email: p.email } }))}
            icon={<Avatar label={initials(p.name)} className="h-5 w-5 text-[9px]" />}>
            <span className="flex-1 truncate">{p.name}</span>{p.id === t.assigneeId && <IconCheck className="h-3.5 w-3.5 text-brand" />}
          </MenuItem>
        ))}
      </Menu>
    </span>
  );
}

/**
 * R70 (MB-251): the card's move handle. Dragging works as before (pointer anywhere on the card, keyboard on this
 * handle); a click or tap now opens a menu: another column of this project, or another project (the task lands in
 * that project's first column). A keyboard press still starts the keyboard drag, so the menu opens on pointer clicks only.
 */
export function MoveHandle({ t, project, dragProps, children }: { t: Task; project: Project; dragProps: Record<string, unknown>; children: React.ReactNode }) {
  const qc = useQueryClient();
  const projects = useProjects();
  const others = (projects.data ?? []).filter((p) => p.id !== project.id && p.statuses.length > 0).slice(0, 8);
  const toStatus = (s: Project["statuses"][number]) => void editTask(qc, t, { statusId: s.id }, (x) => ({ ...x, statusId: s.id, statusName: s.name, statusColor: s.color, status: s.category }), `Moved to ${s.name}`);
  const toProject = (p: Project) => {
    const s = p.statuses[0];
    void editTask(qc, t, { projectId: p.id, statusId: s.id }, (x) => ({ ...x, projectId: p.id, statusId: s.id, statusName: s.name, statusColor: s.color, status: s.category }), `Moved to ${p.name}`)
      .then((ok) => { if (ok) void qc.invalidateQueries({ queryKey: ["tasks"] }); });
  };
  return (
    <Menu align="end" label={`Move ${t.title}`} trigger={
      <button type="button" {...dragProps} aria-roledescription="Draggable task" aria-label={`Move ${t.title}`} data-testid="card-move"
        onClickCapture={(e) => { if (e.detail === 0) e.stopPropagation(); }}
        className="grid h-6 w-6 place-items-center rounded text-subtle hover:bg-surface hover:text-fg max-sm:h-9 max-sm:w-9">{children}</button>}>
      <div className="px-2.5 pb-1 pt-1.5 text-[11.5px] font-medium text-subtle">Move to</div>
      {project.statuses.map((s) => (
        <MenuItem key={s.id} onSelect={() => s.id !== t.statusId && toStatus(s)} icon={<span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />}>
          <span className="flex-1">{s.name}</span>{s.id === t.statusId && <IconCheck className="h-3.5 w-3.5 text-brand" />}
        </MenuItem>
      ))}
      {others.length > 0 && <div className="mt-1 border-t border-line px-2.5 pb-1 pt-2 text-[11.5px] font-medium text-subtle">Another project</div>}
      {others.map((p) => (
        <MenuItem key={p.id} onSelect={() => toProject(p)} icon={<span className="h-2.5 w-2.5 rounded-sm bg-fill" />}><span className="flex-1 truncate">{p.name}</span></MenuItem>
      ))}
    </Menu>
  );
}
