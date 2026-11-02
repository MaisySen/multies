/**
 * R84: the pieces Tasks gained this round, kept in one place so the list, the board, the side panel and the task page
 * share them: coloured tag chips and the tag picker, the people picker for several assignees, the avatar stack,
 * the Tags and Workspace fields dialogs, the pinned view tabs with their menu, the Save view dialog, the description
 * editor (formatting toolbar, preview, @mentions) and the @mention box for comments.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Avatar, Skeleton } from "@/web/components/ui/misc";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { useDialogs } from "@/web/components/ui/confirm";
import {
  IconBold, IconCheck, IconCode, IconGlobe, IconHeading2, IconItalic, IconLink, IconList, IconListOrdered, IconLock, IconMore,
  IconPencilLine, IconPin, IconPinOff, IconPlus, IconSquareCheck, IconTag, IconTrash, IconUserRound,
} from "@/web/components/ui/icon";
import { applyFormat, mentionAt, mentionHandle, renderNotes, type Fmt } from "@/web/lib/task-text-r84";
import { isAgentLike, useTags, useWorkspaceFields, type AssigneeOption, type FieldType, type SavedView, type Tag, type WorkspaceField } from "./data";
import { LoadErrorInline } from "@/web/components/load-error-t1g";
import { chipsInHtml, tokenKeys, useEditableTokens, useMentionPicker, useMentionsOn, useResolved } from "@/web/components/mentions-td5"; // TD5

export const TAG_PALETTE = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#9333ea", "#0891b2", "#db2777", "#64748b", "#ca8a04", "#4f46e5"];
const GREY = "#8a8f98";
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

// ---------------------------------------------------------------- tags

/** name (any case) -> colour, from the workspace tags. A label with no tag row shows grey. */
export function useTagColour() {
  const tags = useTags();
  return useMemo(() => {
    const m = new Map((tags.data ?? []).map((t) => [t.name.toLowerCase(), t.color]));
    return (name: string) => m.get(name.toLowerCase()) ?? GREY;
  }, [tags.data]);
}

export function TagChip({ name, color, onRemove, className }: { name: string; color: string; onRemove?: () => void; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-[11rem] items-center gap-1 rounded-full border px-2 py-px text-[11.5px] font-medium leading-5 text-fg", className)}
      style={{ borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 14%, transparent)` }} data-testid="tag-chip">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove tag ${name}`} className="-mr-1 grid h-4 w-4 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg max-sm:h-6 max-sm:w-6">
          <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      )}
    </span>
  );
}

export function TagChips({ labels, max = 3, className, oneLine }: { labels: string[]; max?: number; className?: string; oneLine?: boolean }) {
  const colour = useTagColour();
  if (!labels.length) return null;
  // R84F: one line in table cells (cn does not merge classes, so wrap and nowrap never meet in one list).
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", oneLine ? "flex-nowrap overflow-hidden" : "flex-wrap", className)}>
      {labels.slice(0, max).map((l) => <TagChip key={l} name={l} color={colour(l)} />)}
      {labels.length > max && <span className="shrink-0 text-[11.5px] text-subtle" title={labels.slice(max).join(", ")}>+{labels.length - max}</span>}
    </span>
  );
}

/** Keyboard list for the pickers: arrows move, Enter picks, the active row scrolls into view. */
function useListKeys(count: number, onPick: (i: number) => void) {
  const [active, setActive] = useState(0);
  useEffect(() => { if (active >= count) setActive(Math.max(0, count - 1)); }, [count, active]);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(count - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" && count > 0) { e.preventDefault(); onPick(active); }
  };
  return { active, setActive, onKeyDown };
}

/** A small panel under a trigger, closed by Esc or a click outside (focus goes back to the trigger). */
function Pop({ label, trigger, children, open, setOpen, align = "start", testId, className }: {
  label: string; trigger: ReactNode; children: ReactNode; open: boolean; setOpen: (o: boolean) => void; align?: "start" | "end"; testId?: string; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey, true); };
  }, [open, setOpen]);
  return (
    <div ref={ref} className="relative min-w-0">
      <button ref={btn} type="button" aria-expanded={open} aria-controls={id} aria-haspopup="dialog" onClick={() => setOpen(!open)} data-testid={testId}
        className="flex min-h-8 w-full min-w-0 items-center rounded-md px-1 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand max-sm:min-h-11">
        <span className="sr-only">{label}: </span>{trigger}
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={label} data-testid={testId ? `${testId}-panel` : undefined}
          className={cn("absolute z-50 mt-1 w-72 max-w-[calc(100vw-2rem)] animate-pop-in rounded-[var(--radius-r14)] border border-line bg-elevated p-2 shadow-pop", align === "end" ? "right-0" : "left-0", className)}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Pick tags for a task: search, tick, or create a new one by typing its name and pressing Enter. */
export function TagPicker({ value, onChange, label = "Tags" }: { value: string[]; onChange: (next: string[]) => void; label?: string }) {
  const tags = useTags();
  const qc = useQueryClient();
  const colour = useTagColour();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const all = tags.data ?? [];
  const lower = new Set(value.map((v) => v.toLowerCase()));
  const shown = all.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase()));
  const canCreate = !!q.trim() && !all.some((t) => t.name.toLowerCase() === q.trim().toLowerCase());
  const rows = shown.length + (canCreate ? 1 : 0);
  const toggle = (name: string) => onChange(lower.has(name.toLowerCase()) ? value.filter((v) => v.toLowerCase() !== name.toLowerCase()) : [...value, name]);
  const create = async () => {
    const name = q.trim();
    if (!name) return;
    try {
      const r = await api.post<{ tag: Tag }>("/tasks/tags", { name });
      void qc.invalidateQueries({ queryKey: ["task-tags"] });
      onChange([...value, r.tag.name]);
      setQ("");
    } catch (e) { showError(e as Error); }
  };
  const keys = useListKeys(rows, (i) => (i < shown.length ? toggle(shown[i]!.name) : void create()));
  return (
    <Pop label={label} open={open} setOpen={(o) => { setOpen(o); if (!o) setQ(""); }} testId="tag-picker"
      trigger={value.length ? <span className="flex min-w-0 flex-wrap gap-1 py-1">{value.map((l) => <TagChip key={l} name={l} color={colour(l)} />)}</span> : <span className="text-[13px] text-subtle">Add tags</span>}>
      <Input autoFocus aria-label="Find or create a tag" placeholder="Find or create a tag" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={keys.onKeyDown} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base" />
      <ul role="listbox" aria-label="Tags" aria-multiselectable className="mt-1.5 max-h-64 overflow-y-auto">
        {tags.isLoading && <li className="p-2"><Skeleton className="h-5" /></li>}
        {shown.map((t, i) => {
          const on = lower.has(t.name.toLowerCase());
          return (
            <li key={t.id} role="option" aria-selected={on} onMouseEnter={() => keys.setActive(i)} onClick={() => toggle(t.name)}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] max-sm:py-2.5", keys.active === i && "bg-hover")}>
              <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              {on && <IconCheck className="h-3.5 w-3.5 text-brand-hover" aria-hidden />}
            </li>
          );
        })}
        {canCreate && (
          <li role="option" aria-selected={false} onMouseEnter={() => keys.setActive(shown.length)} onClick={() => void create()}
            className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-brand-hover max-sm:py-2.5", keys.active === shown.length && "bg-hover")}>
            <IconPlus className="h-3.5 w-3.5" aria-hidden />Create tag “{q.trim()}”
          </li>
        )}
        {!tags.isLoading && !rows && <li className="px-2 py-2 text-[12.5px] text-muted">No tags yet. Type a name to make one.</li>}
      </ul>
    </Pop>
  );
}

/** Manage the workspace's tags: rename, recolour, delete, add. */
export function TagsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tags = useTags(true);
  const qc = useQueryClient();
  const { confirm, dialogs } = useDialogs();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const role = useMe().data?.organization?.role;
  const admin = role === "owner" || role === "admin"; // R84F: only admins rename, recolour or delete workspace tags
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["task-tags"] }); void qc.invalidateQueries({ queryKey: ["tasks"] }); void qc.invalidateQueries({ queryKey: ["task"] }); };
  const patch = async (t: Tag, body: Partial<Tag>) => { try { await api.patch(`/tasks/tags/${t.id}`, body); refresh(); } catch (e) { showError(e as Error); } };
  const add = async () => {
    const clean = name.trim();
    if (!clean) return;
    const same = tags.data?.find((t) => t.name.toLowerCase() === clean.toLowerCase());
    if (same) { setNote(`${same.name} is already a tag.`); return; } // R84F: say so instead of doing nothing
    try { await api.post("/tasks/tags", { name: clean }); setName(""); setNote(""); refresh(); } catch (e) { showError(e as Error); }
  };
  const remove = async (t: Tag) => {
    if (!(await confirm({ title: `Delete the tag ${t.name}?`, description: t.count ? `It comes off ${t.count} ${t.count === 1 ? "task" : "tasks"}. The tasks stay.` : "No tasks use it.", confirmLabel: "Delete tag" }))) return;
    try { await api.del(`/tasks/tags/${t.id}`); refresh(); } catch (e) { showError(e as Error); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Tags" description={admin ? "Tags are shared across the workspace. Renaming one renames it on every task." : "Tags are shared across the workspace. You can add tags; workspace admins rename, recolour and delete them."}>
      {dialogs}
      {tags.error ? (
        <LoadErrorInline onRetry={() => tags.refetch()} />
      ) : (
        <ul className="space-y-1.5" aria-label="Workspace tags">
          {tags.isLoading && [0, 1, 2].map((i) => <li key={i}><Skeleton className="h-9" /></li>)}
          {tags.data?.map((t) => (
            <li key={t.id} className="flex items-center gap-2" data-testid="tag-row">
              {admin ? <Menu label={`Colour of ${t.name}`} align="start" trigger={<button type="button" className="grid h-8 w-8 place-items-center rounded-md hover:bg-hover max-sm:h-11 max-sm:w-11"><span className="h-4 w-4 rounded-full" style={{ background: t.color }} /></button>}>
                {TAG_PALETTE.map((c, i) => (
                  <MenuItem key={c} checked={c === t.color} onSelect={() => void patch(t, { color: c })} icon={<span className="h-3.5 w-3.5 rounded-full" style={{ background: c }} />}>{COLOUR_NAMES[i]}</MenuItem>
                ))}
              </Menu> : <span className="grid h-8 w-8 place-items-center max-sm:h-11 max-sm:w-11" aria-hidden><span className="h-4 w-4 rounded-full" style={{ background: t.color }} /></span>}
              <Input aria-label={`Name of tag ${t.name}`} defaultValue={t.name} key={t.name} readOnly={!admin} className="h-8 flex-1 text-[13px] max-sm:h-11 max-sm:text-base"
                onBlur={(e) => { if (!admin) return; const v = e.target.value.trim(); if (v && v !== t.name) void patch(t, { name: v }); else e.target.value = t.name; }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
              <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-subtle">{t.count ?? 0} {t.count === 1 ? "task" : "tasks"}</span>
              {admin && <Button variant="ghost" size="icon" aria-label={`Delete tag ${t.name}`} onClick={() => void remove(t)}><IconTrash className="h-4 w-4" aria-hidden /></Button>}
            </li>
          ))}
          {tags.data && !tags.data.length && <li className="flex items-center gap-2 rounded-lg border border-dashed border-line p-3 text-[13px] text-muted"><IconTag className="h-4 w-4" aria-hidden />No tags yet. Add launch, client or blocked below.</li>}
        </ul>
      )}
      <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Input aria-label="New tag name" placeholder="New tag" value={name} onChange={(e) => { setName(e.target.value); setNote(""); }} className="h-9 flex-1 text-[13px] max-sm:h-11 max-sm:text-base" maxLength={40}
          aria-describedby={note ? "tag-add-note" : undefined} />
        <Button type="submit" disabled={!name.trim()}><IconPlus className="h-4 w-4" aria-hidden />Add tag</Button>
      </form>
      {note && <p id="tag-add-note" role="status" className="mt-1.5 text-[12px] text-muted">{note}</p>}
    </Dialog>
  );
}
const COLOUR_NAMES = ["Blue", "Green", "Amber", "Red", "Purple", "Teal", "Pink", "Slate", "Gold", "Indigo"];

// ---------------------------------------------------------------- workspace fields

const WS_TYPES: { id: FieldType; label: string }[] = [
  { id: "text", label: "Text" }, { id: "number", label: "Number" }, { id: "date", label: "Date" }, { id: "select", label: "Dropdown" },
  { id: "checkbox", label: "Checkbox" }, { id: "person", label: "Person" }, { id: "url", label: "Link" }, { id: "multiselect", label: "Multi select" }, { id: "currency", label: "Money" },
];
export const wsTypeLabel = (t: FieldType) => WS_TYPES.find((x) => x.id === t)?.label ?? t;

/** Fields defined once for every project: Client, Budget, Stage. Each project gets a copy that stays in step. */
export function WorkspaceFieldsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const fields = useWorkspaceFields();
  const qc = useQueryClient();
  const { confirm, dialogs } = useDialogs();
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState("");
  const [busy, setBusy] = useState(false);
  const role = useMe().data?.organization?.role;
  const admin = role === "owner" || role === "admin"; // R84F: a workspace field lands on every project, so admins manage them
  const refresh = () => { for (const k of [["workspace-fields"], ["fields"], ["tasks"], ["task"]]) void qc.invalidateQueries({ queryKey: k }); };
  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.post("/fields/workspace", { name, type, ...(type === "select" || type === "multiselect" ? { options: options.split(",").map((x) => x.trim()).filter(Boolean).map((label) => ({ label })) } : {}) });
      setName(""); setOptions(""); refresh();
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const patch = async (f: WorkspaceField, body: Record<string, unknown>) => { try { await api.patch(`/fields/workspace/${f.key}`, body); refresh(); } catch (e) { showError(e as Error); } };
  const remove = async (f: WorkspaceField) => {
    if (!(await confirm({ title: `Delete the field ${f.name}?`, description: `It comes off all ${f.projects} ${f.projects === 1 ? "project" : "projects"}, with its values.`, confirmLabel: "Delete field" }))) return;
    try { await api.del(`/fields/workspace/${f.key}`); refresh(); } catch (e) { showError(e as Error); }
  };
  const choice = type === "select" || type === "multiselect";
  return (
    <Dialog open={open} onClose={onClose} title="Workspace fields" description={admin ? "These fields show on every project, as columns in the task list, in filters and in bulk edit." : "These fields show on every project, as columns in the task list, in filters and in bulk edit. Workspace admins add and change them."}>
      {dialogs}
      {fields.error ? (
        <LoadErrorInline onRetry={() => fields.refetch()} />
      ) : (
        <ul className="space-y-2" aria-label="Workspace fields list">
          {fields.isLoading && [0, 1].map((i) => <li key={i}><Skeleton className="h-10" /></li>)}
          {fields.data?.map((f) => (
            <li key={f.key} className="rounded-lg border border-line p-2.5" data-testid="ws-field-row">
              <div className="flex items-center gap-2">
                <Input aria-label={`Name of ${f.name}`} defaultValue={f.name} key={f.name} readOnly={!admin} className="h-8 flex-1 text-[13px] max-sm:h-11 max-sm:text-base"
                  onBlur={(e) => admin && e.target.value.trim() && e.target.value !== f.name && void patch(f, { name: e.target.value.trim() })} />
                <span className="whitespace-nowrap text-[12px] text-subtle">{wsTypeLabel(f.type)}</span>
                {admin && <Button variant="ghost" size="icon" aria-label={`Delete ${f.name}`} onClick={() => void remove(f)}><IconTrash className="h-4 w-4" aria-hidden /></Button>}
              </div>
              {(f.type === "select" || f.type === "multiselect") && (
                <Input aria-label={`Options for ${f.name}`} defaultValue={f.options.map((o) => o.label).join(", ")} readOnly={!admin} placeholder="Options, separated by commas" className="mt-2 h-8 text-[12.5px] max-sm:h-11 max-sm:text-base"
                  onBlur={(e) => {
                    if (!admin) return;
                    const labels = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
                    if (labels.join(",") === f.options.map((o) => o.label).join(",")) return;
                    void patch(f, { options: labels.map((label) => ({ id: f.options.find((o) => o.label === label)?.id, label })) });
                  }} />
              )}
              <p className="mt-1 text-[11.5px] text-subtle">On {f.projects} {f.projects === 1 ? "project" : "projects"}</p>
            </li>
          ))}
          {fields.data && !fields.data.length && <li className="rounded-lg border border-dashed border-line p-3 text-[13px] text-muted">{admin ? "No workspace fields yet. Add Client, Budget or Stage below and every project gets it." : "No workspace fields yet. A workspace admin can add Client, Budget or Stage for every project."}</li>}
        </ul>
      )}
      {admin && <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input aria-label="New workspace field name" placeholder="Field name, e.g. Client" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} className="h-9 text-[13px] max-sm:h-11 max-sm:text-base" maxLength={60} />
        <Select aria-label="New workspace field type" value={type} onChange={(e) => setType(e.target.value as FieldType)} className="h-9 text-[13px]">
          {WS_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </Select>
        {choice && <Input aria-label="New workspace field options" placeholder="Options, separated by commas" value={options} onChange={(e) => setOptions(e.target.value)} className="h-9 text-[13px] sm:col-span-2 max-sm:h-11 max-sm:text-base" />}
        <Button onClick={() => void add()} disabled={busy || !name.trim()} className="sm:col-span-2"><IconPlus className="h-4 w-4" aria-hidden />Add to every project</Button>
      </div>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- people

export function AvatarStack({ people, max = 3, size = "sm" }: { people: { id: string; name: string }[]; max?: number; size?: "sm" | "md" }) {
  if (!people.length) return null;
  const cls = size === "md" ? "h-7 w-7 text-[10.5px]" : "h-5 w-5 text-[9px]";
  return (
    <span className="inline-flex items-center" title={people.map((p) => p.name).join(", ")}>
      <span className="sr-only">{people.map((p) => p.name).join(", ")}</span>
      {people.slice(0, max).map((p, i) => <Avatar key={p.id} label={initials(p.name)} className={cn(cls, "ring-2 ring-surface", i > 0 && "-ml-1.5")} />)}
      {people.length > max && <span aria-hidden className={cn(cls, "-ml-1.5 grid place-items-center rounded-full bg-fill font-semibold text-muted ring-2 ring-surface")}>+{people.length - max}</span>}
    </span>
  );
}

/** Several people on one task. The first picked is the main assignee (shown first everywhere). Keys are "member:id" or "agent:id". */
export function AssigneePicker({ value, people, onChange, label = "Assignees" }: { value: string[]; people: AssigneeOption[]; onChange: (next: string[]) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const key = (p: AssigneeOption) => (p.id.includes(":") ? p.id : `${p.type}:${p.id}`); // the options carry "member:<id>" already
  const picked = value.map((k) => people.find((p) => key(p) === k)).filter(Boolean) as AssigneeOption[];
  const shown = people.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()) || (p.email ?? "").toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (p: AssigneeOption) => onChange(value.includes(key(p)) ? value.filter((k) => k !== key(p)) : [...value, key(p)].slice(0, 10));
  const keys = useListKeys(shown.length, (i) => toggle(shown[i]!));
  return (
    <Pop label={label} open={open} setOpen={(o) => { setOpen(o); if (!o) setQ(""); }} testId="assignee-picker"
      trigger={picked.length ? (
        <span className="flex min-w-0 items-center gap-2 py-0.5"><AvatarStack people={picked} size="md" /><span className="truncate text-[13px]">{picked.length === 1 ? picked[0]!.name : `${picked[0]!.name} and ${picked.length - 1} more`}</span></span>
      ) : <span className="flex items-center gap-1.5 text-[13px] text-subtle"><IconUserRound className="h-4 w-4" aria-hidden />Nobody</span>}>
      <Input autoFocus aria-label="Find a person" placeholder="Find a person or agent" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={keys.onKeyDown} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base" />
      <ul role="listbox" aria-label="People" aria-multiselectable className="mt-1.5 max-h-72 overflow-y-auto">
        {shown.map((p, i) => {
          const at = value.indexOf(key(p));
          return (
            <li key={key(p)} role="option" aria-selected={at >= 0} onMouseEnter={() => keys.setActive(i)} onClick={() => toggle(p)}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] max-sm:py-2.5", keys.active === i && "bg-hover")}>
              <Avatar label={initials(p.name)} className="h-6 w-6 text-[10px]" />
              <span className="min-w-0 flex-1 truncate">{p.name}{isAgentLike(p) && <span className="text-subtle"> (agent)</span>}</span>
              {at === 0 && value.length > 1 && <span className="text-[11px] text-subtle">Main</span>}
              {at >= 0 && <IconCheck className="h-3.5 w-3.5 text-brand-hover" aria-hidden />}
            </li>
          );
        })}
        {!shown.length && <li className="px-2 py-2 text-[12.5px] text-muted">Nobody matches “{q}”.</li>}
      </ul>
      {value.length > 0 && (
        <div className="mt-1.5 flex items-center justify-between border-t border-line pt-1.5">
          <span className="text-[11.5px] text-subtle">{value.length} on this task</span>
          <Button size="sm" variant="ghost" onClick={() => onChange([])}>Clear</Button>
        </div>
      )}
    </Pop>
  );
}

// ---------------------------------------------------------------- @mentions

/** Wires @mention suggestions onto an input or textarea. Returns the key handler and the list to render. */
export function useMentions(ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>, value: string, setValue: (v: string) => void, people: AssigneeOption[], initialMap?: Record<string, string>) {
  const members = people.filter((p) => p.type === "member");
  // TD5: with MENTIONS_TD5 on, one picker offers people and records (records go in as @[Title] and save as tokens).
  const on = useMentionsOn();
  const picker = useMentionPicker(ref, value, setValue, members.map((p) => ({ key: p.id, name: p.name, insert: `@${mentionHandle(p, members)} `, hint: `@${mentionHandle(p, members)}` })), { enabled: on, initialMap });
  const [at, setAt] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const matches = at ? members.filter((p) => p.name.toLowerCase().includes(at.query.toLowerCase()) || (p.email ?? "").toLowerCase().startsWith(at.query.toLowerCase())).slice(0, 6) : [];
  const sync = () => { const el = ref.current; if (el) { setAt(mentionAt(el.value, el.selectionStart ?? el.value.length)); setActive(0); } };
  const pick = (p: AssigneeOption) => {
    const el = ref.current;
    if (!el || !at) return;
    const caret = el.selectionStart ?? value.length;
    const word = `@${mentionHandle(p, members)} `;
    const next = value.slice(0, at.start) + word + value.slice(caret);
    setValue(next);
    setAt(null);
    requestAnimationFrame(() => { el.focus(); const pos = at.start + word.length; el.setSelectionRange(pos, pos); });
  };
  const onKeyDown = (e: ReactKeyboardEvent): boolean => {
    if (!at || !matches.length) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % matches.length); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); return true; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[active]!); return true; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setAt(null); return true; }
    return false;
  };
  const list = at && matches.length ? (
    <ul role="listbox" aria-label="Mention someone" className="absolute bottom-full left-0 z-50 mb-1 w-64 max-w-full rounded-lg border border-line bg-elevated p-1 shadow-pop" data-testid="mention-list">
      {matches.map((p, i) => (
        <li key={p.id} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(p); }} onMouseEnter={() => setActive(i)}
          className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] max-sm:py-2.5", i === active && "bg-hover")}>
          <Avatar label={initials(p.name)} className="h-5 w-5 text-[9px]" /><span className="truncate">{p.name}</span><span className="ml-auto text-[11.5px] text-subtle">@{mentionHandle(p, members)}</span>
        </li>
      ))}
    </ul>
  ) : null;
  if (on) return picker;
  return { onKeyDown, sync, list, open: !!list, toTokens: (t: string) => t, reset: () => setAt(null), activeId: undefined as string | undefined };
}

/** The comment box with @mention suggestions. Enter sends (unless picking a person). */
export function CommentBox({ people, onSend }: { people: AssigneeOption[]; onSend: (body: string) => Promise<void> | void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const m = useMentions(ref, text, setText, people);
  const send = async () => { const body = m.toTokens(text).trim(); if (!body) return; await onSend(body); setText(""); m.reset(); };
  return (
    <form className="relative mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {m.list}
      <Input ref={ref} aria-label="Write a comment" placeholder="Write a comment, @ to mention" value={text} role="combobox" aria-expanded={m.open} aria-autocomplete="list"
        onChange={(e) => { setText(e.target.value); requestAnimationFrame(m.sync); }} onKeyDown={(e) => { m.onKeyDown(e); }} onClick={m.sync} className="h-9 text-[13px] max-sm:h-11 max-sm:text-base" />
      <Button type="submit" variant="secondary" disabled={!text.trim()}>Send</Button>
    </form>
  );
}

// ---------------------------------------------------------------- description

const TOOLS: { fmt: Fmt; label: string; icon: ReactNode; keys?: string }[] = [
  { fmt: "bold", label: "Bold", icon: <IconBold className="h-4 w-4" aria-hidden />, keys: "Ctrl+B" },
  { fmt: "italic", label: "Italic", icon: <IconItalic className="h-4 w-4" aria-hidden />, keys: "Ctrl+I" },
  { fmt: "heading", label: "Heading", icon: <IconHeading2 className="h-4 w-4" aria-hidden /> },
  { fmt: "bullets", label: "Bulleted list", icon: <IconList className="h-4 w-4" aria-hidden /> },
  { fmt: "numbers", label: "Numbered list", icon: <IconListOrdered className="h-4 w-4" aria-hidden /> },
  { fmt: "checks", label: "Checklist", icon: <IconSquareCheck className="h-4 w-4" aria-hidden /> },
  { fmt: "link", label: "Link", icon: <IconLink className="h-4 w-4" aria-hidden />, keys: "Ctrl+K" },
  { fmt: "code", label: "Code", icon: <IconCode className="h-4 w-4" aria-hidden /> },
];

/** The task description: reads as formatted text, click (or Enter) to edit with a toolbar; saves when you leave it. */
export function DescriptionEditor({ value, onSave, people }: { value: string; onSave: (v: string) => void; people: AssigneeOption[] }) {
  const on = useMentionsOn(); // TD5
  const editable = useEditableTokens(value, on);
  const resolved = useResolved(on ? tokenKeys(value) : [], on);
  const [draft, setDraft] = useState(editable.text);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const m = useMentions(ref, draft, setDraft, people, editable.map);
  useEffect(() => { if (!editing) setDraft(editable.text); }, [editable.text, editing]);
  const run = (fmt: Fmt) => {
    const el = ref.current;
    if (!el) return;
    const r = applyFormat(draft, el.selectionStart, el.selectionEnd, fmt);
    setDraft(r.text);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(r.start, r.end); });
  };
  const finish = () => { setEditing(false); const out = m.toTokens(draft); if (out !== value) onSave(out); };
  if (!editing) {
    return (
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Description</h3>
          <button type="button" onClick={() => setEditing(true)} className="rounded-md px-2 py-0.5 text-[12.5px] text-brand-hover hover:bg-hover max-sm:py-2.5" data-testid="edit-description">{value ? "Edit" : "Add"}</button>
        </div>
        <div onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) setEditing(true); }}
          className="task-notes min-h-16 cursor-text [&_a]:text-brand-hover [&_a]:underline [&_code]:rounded [&_code]:bg-fill [&_code]:px-1 [&_code]:text-[12.5px] [&_h4]:mb-1 [&_h4]:mt-2 [&_h4]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ul.checks]:list-none [&_ul.checks]:pl-0 [&_.mention]:font-medium [&_.mention]:text-brand-hover rounded-lg border border-transparent px-2.5 py-2 text-[13.5px] leading-relaxed hover:border-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand" data-testid="description-view">
          {value ? <div dangerouslySetInnerHTML={{ __html: on ? chipsInHtml(renderNotes(value), resolved.data) : renderNotes(value) }} /> : <span className="text-subtle">Add a description. Use @ to mention someone.</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="mt-4" ref={wrapRef} onBlur={(e) => { if (!wrapRef.current?.contains(e.relatedTarget as Node)) finish(); }}>
      <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-subtle">Description</h3>
      <div className="rounded-lg border border-line-strong focus-within:ring-2 focus-within:ring-brand/40">
        <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b border-line px-1 py-1">
          {TOOLS.map((t) => (
            <button key={t.fmt} type="button" aria-label={t.label} title={t.keys ? `${t.label} (${t.keys})` : t.label} onMouseDown={(e) => e.preventDefault()} onClick={() => run(t.fmt)}
              className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg max-sm:h-10 max-sm:w-10">{t.icon}</button>
          ))}
          <span className="ml-auto pr-1 text-[11px] text-subtle max-sm:hidden">Esc to finish</span>
        </div>
        <div className="relative">
          {m.list}
          <Textarea ref={ref} autoFocus aria-label="Description" value={draft} placeholder="What needs doing, and why. Use @ to mention someone."
            onChange={(e) => { setDraft(e.target.value); requestAnimationFrame(m.sync); }} onClick={m.sync}
            onKeyDown={(e) => {
              if (m.onKeyDown(e)) return;
              const mod = e.metaKey || e.ctrlKey;
              if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); run("bold"); }
              else if (mod && e.key.toLowerCase() === "i") { e.preventDefault(); run("italic"); }
              else if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); run("link"); }
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
              else if (mod && e.key === "Enter") { e.preventDefault(); finish(); }
            }}
            className="min-h-32 rounded-none border-0 text-[13.5px] leading-relaxed focus:ring-0 max-sm:text-base" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- saved views

/**
 * Pinned views as a row of tabs above the list or board ("All tasks" clears the view). Arrow keys move between them.
 * The options for the open view (rename, share, unpin, delete) sit in one menu after the row, outside the scrolling strip.
 */
export function ViewTabs({ views, activeId, onOpen, onAll, onEdit, onDelete, onRename }: {
  views: SavedView[]; activeId: string | null; onOpen: (v: SavedView) => void; onAll: () => void;
  onEdit: (v: SavedView, patch: Partial<Pick<SavedView, "shared" | "pinned" | "name">>) => void; onDelete: (v: SavedView) => void; onRename: (v: SavedView) => void;
}) {
  const pinned = views.filter((v) => v.pinned).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const ref = useRef<HTMLDivElement>(null);
  const active = views.find((v) => v.id === activeId);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[data-view-tab]") ?? [])];
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]?.focus();
  };
  if (!pinned.length) return null;
  return (
    <nav aria-label="Pinned views" className="mb-2 flex min-w-0 items-center gap-1" data-testid="view-tabs">
      <div ref={ref} onKeyDown={onKeyDown} className="-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 py-0.5 [scrollbar-width:none]">
        <Tab label="All tasks" active={!activeId} onClick={onAll} />
        {pinned.map((v) => <Tab key={v.id} label={v.name} active={activeId === v.id} onClick={() => onOpen(v)} icon={v.shared ? undefined : <IconLock className="h-3 w-3" aria-hidden />} hint={v.shared ? undefined : "only you"} />)}
      </div>
      {active && (
        <Menu label="View options" trigger={<button type="button" title={`${active.name} options`} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11"><IconMore className="h-4 w-4" aria-hidden /></button>}>
          {active.canEdit !== false && <MenuItem onSelect={() => onRename(active)} icon={<IconPencilLine className="h-4 w-4" />}>Rename</MenuItem>}
          {active.canEdit !== false && <MenuItem onSelect={() => onEdit(active, { shared: !active.shared })} icon={active.shared ? <IconLock className="h-4 w-4" /> : <IconGlobe className="h-4 w-4" />}>{active.shared ? "Make private" : "Share with workspace"}</MenuItem>}
          {active.canEdit !== false && <MenuItem onSelect={() => onEdit(active, { pinned: !active.pinned })} icon={active.pinned ? <IconPinOff className="h-4 w-4" /> : <IconPin className="h-4 w-4" />}>{active.pinned ? "Unpin" : "Pin as a tab"}</MenuItem>}
          {active.canEdit !== false && <MenuItem danger onSelect={() => onDelete(active)} icon={<IconTrash className="h-4 w-4" />}>Delete view</MenuItem>}
          {active.canEdit === false && <MenuItem onSelect={() => undefined} icon={<IconLock className="h-4 w-4" />}>Shared by a teammate, only they or an admin can change it</MenuItem>}
        </Menu>
      )}
    </nav>
  );
}

function Tab({ label, active, onClick, icon, hint }: { label: string; active: boolean; onClick: () => void; icon?: ReactNode; hint?: string }) {
  return (
    <button type="button" data-view-tab aria-current={active ? "page" : undefined} onClick={onClick}
      className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none max-sm:h-11",
        active ? "bg-brand-soft text-brand-hover" : "text-muted hover:bg-hover hover:text-fg")}>
      {icon}{label}{hint && <span className="sr-only">, {hint}</span>}
    </button>
  );
}

/** Save the current filters, sort and grouping as a view. */
export function SaveViewDialog({ open, onClose, onSave, summary, initial }: {
  open: boolean; onClose: () => void; onSave: (v: { name: string; shared: boolean; pinned: boolean }) => Promise<void>; summary: string[]; initial?: { name: string; shared: boolean; pinned: boolean };
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [shared, setShared] = useState(initial?.shared ?? false);
  const [pinned, setPinned] = useState(initial?.pinned ?? true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(initial?.name ?? ""); setShared(initial?.shared ?? false); setPinned(initial?.pinned ?? true); } }, [open, initial?.name, initial?.shared, initial?.pinned]);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await onSave({ name: name.trim(), shared, pinned }); onClose(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Save view" description="Saves the filters, sort and grouping you have now."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy} disabled={!name.trim()}>Save view</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="block text-[13px] font-medium">Name
          <Input data-autofocus autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. My week, Client work" className="mt-1 h-9 max-sm:h-11 max-sm:text-base"
            aria-describedby={name.length >= 50 ? "view-name-left" : undefined} />
          {name.length >= 50 && <span id="view-name-left" className="mt-1 block text-[12px] font-normal text-muted">{name.length >= 60 ? "View names can be up to 60 characters." : `${60 - name.length} characters left`}</span>}
        </label>
        {summary.length > 0 && <p className="text-[12.5px] text-muted">{summary.join(" · ")}</p>}
        <fieldset>
          <legend className="text-[13px] font-medium">Who sees it</legend>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {[{ v: false, label: "Only me", hint: "Private to you", icon: <IconLock className="h-4 w-4" aria-hidden /> }, { v: true, label: "Everyone", hint: "Shared with the workspace", icon: <IconGlobe className="h-4 w-4" aria-hidden /> }].map((o) => (
              <label key={String(o.v)} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-[13px]", shared === o.v ? "border-brand bg-brand-soft/50" : "border-line hover:bg-hover")}>
                <input type="radio" name="view-who" className="mt-0.5 accent-[var(--color-brand)]" checked={shared === o.v} onChange={() => setShared(o.v)} />
                <span><span className="flex items-center gap-1.5 font-medium">{o.icon}{o.label}</span><span className="text-[12px] text-muted">{o.hint}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex cursor-pointer items-center gap-2 text-[13px]">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="h-4 w-4 accent-[var(--color-brand)]" />
          <IconPin className="h-4 w-4 text-muted" aria-hidden />Pin as a tab
        </label>
      </form>
    </Dialog>
  );
}

export { applyFormat, mentionAt, mentionHandle, renderNotes };
