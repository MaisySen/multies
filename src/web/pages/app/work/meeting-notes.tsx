/**
 * Round 23 (R23.1): the agenda and notes doc on a meeting page, and its action items made into tasks
 * in one click. The doc is made the first time someone opens Notes. Checklist items anywhere in the
 * doc are action items; "@Name" and "due Fri" in an item fill the assignee and due date, both of
 * which can be changed here before the tasks are made.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { CheckCircle2, Circle, ExternalLink, ListChecks, NotebookPen } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Input, Select } from "@/web/components/ui/input";
import { Card, Skeleton } from "@/web/components/ui/misc";
import { summaryItemsToAdd } from "@/shared/action-items";

interface Who { type: "member" | "agent"; id: string; name: string }
interface ActionItem {
  key: string; text: string; title: string; assignee: Who | null; due: string | null;
  task: { id: string; ref: string; title: string; status: string; done: boolean; due: string | null } | null;
}
export interface MeetingNotesView {
  meeting: { id: string; title: string; startsAt: string };
  doc: { id: string; title: string; version: number; content: Record<string, unknown>; text: string } | null;
  agenda: string[]; notes: string[]; actionItems: ActionItem[]; pending: number; people: Who[];
  /** The newest call recording's summary and the action items it heard (round 23 R23.2). */
  summary?: string | null; summaryActionItems?: { text: string; assignee: string | null; due: string | null }[];
}
interface Edit { assignee?: string; due?: string }

const NOTES_PROPS = { attributes: { class: "mm-prose mm-notes min-h-[220px] outline-none", "aria-label": "Meeting notes", role: "textbox", "aria-multiline": "true" } };
const whoKey = (w: Who | null) => (w ? `${w.type}:${w.id}` : "");
const dayLabel = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function MeetingNotes({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient();
  const key = ["meeting-notes", meetingId];
  const q = useQuery({ queryKey: key, queryFn: async () => api.get<MeetingNotesView>(`/meeting-notes/${meetingId}`), refetchOnWindowFocus: false });
  const [opening, setOpening] = useState(false);
  const open = async () => {
    setOpening(true);
    try { qc.setQueryData(key, await api.post<MeetingNotesView>(`/meeting-notes/${meetingId}`, {})); } catch (e) { showError(e as Error); } finally { setOpening(false); }
  };
  if (q.isPending) return <Skeleton className="mt-4 h-40" />;
  const n = q.data;
  if (!n) return null;
  if (!n.doc) {
    return (
      <Card className="mt-4 flex items-start gap-3 p-5" data-testid="meeting-notes">
        <NotebookPen className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold">Agenda and notes</h2>
          <p className="mt-1 text-[13px] text-muted">One doc for this meeting that everyone in the workspace can edit. Checklist items become tasks in one click.</p>
        </div>
        <Button size="sm" onClick={() => void open()} loading={opening} data-testid="open-notes"><NotebookPen className="h-4 w-4" />Notes</Button>
      </Card>
    );
  }
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" data-testid="meeting-notes">
      <NotesEditor meetingId={meetingId} doc={n.doc} onSaved={() => void qc.invalidateQueries({ queryKey: key })} />
      <div className="space-y-4">
        <ActionItems meetingId={meetingId} view={n} onDone={(v) => qc.setQueryData(key, v)} />
        <SummaryItems meetingId={meetingId} view={n} onDone={(v) => qc.setQueryData(key, v)} />
      </div>
    </div>
  );
}

function NotesEditor({ meetingId, doc, onSaved }: { meetingId: string; doc: NonNullable<MeetingNotesView["doc"]>; onSaved: () => void }) {
  const version = useRef(doc.version);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [state, setState] = useState<"saved" | "saving" | "unsaved">("saved");
  const extensions = useMemo(() => [StarterKit, TaskList, TaskItem.configure({ nested: true })], []);
  const editor = useEditor({ extensions, content: doc.content as never, editorProps: NOTES_PROPS, immediatelyRender: true, onUpdate: () => { setState("unsaved"); clearTimeout(timer.current); timer.current = setTimeout(() => void save(), 700); } });
  const save = async (): Promise<void> => {
    if (!editor) return;
    setState("saving");
    try {
      const r = await api.patch<{ doc: { version: number } }>(`/docs/${doc.id}`, { content: editor.getJSON(), version: version.current });
      version.current = r.doc.version;
      setState("saved");
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === "version_conflict") {
        // Someone saved the doc elsewhere: load theirs.
        const row = (await api.get<{ doc: { content: Record<string, unknown>; version: number } }>(`/docs/${doc.id}`)).doc;
        version.current = row.version;
        editor.commands.setContent(row.content as never, { emitUpdate: false });
        setState("saved");
        toast.message("The notes changed elsewhere, so the latest version is shown.");
        return;
      }
      setState("unsaved");
      showError(e as Error);
    }
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Card className="p-5">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[13px] font-semibold">Agenda and notes</h2>
        <span className="ml-auto text-[12px] text-subtle" role="status" data-testid="notes-state">{state === "saving" ? "Saving" : state === "unsaved" ? "Unsaved changes" : "Saved"}</span>
        <Link to={`/app/docs/${doc.id}`} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[12.5px] text-muted hover:bg-hover hover:text-fg" data-testid="open-doc" aria-label={`Open the doc for meeting ${meetingId}`}><ExternalLink className="h-3.5 w-3.5" />Open doc</Link>
      </div>
      <p className="mb-2 text-[12px] text-subtle">Type [ ] and a space for a checklist item. Use @Name and "due Fri" to assign it.</p>
      <EditorContent editor={editor} />
    </Card>
  );
}

function ActionItems({ meetingId, view, onDone }: { meetingId: string; view: MeetingNotesView; onDone: (v: MeetingNotesView) => void }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: async () => (await api.get<{ projects: { id: string; name: string }[] }>("/projects")).projects });
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = view.actionItems.filter((i) => !i.task);
  const made = view.actionItems.filter((i) => i.task);
  const set = (k: string, e: Edit) => setEdits((x) => ({ ...x, [k]: { ...x[k], ...e } }));
  const create = async () => {
    setBusy(true);
    try {
      const items = pending.map((i) => {
        const e = edits[i.key] ?? {};
        return { key: i.key, ...(e.assignee !== undefined ? { assignee: e.assignee || null } : {}), ...(e.due !== undefined ? { due: e.due || null } : {}) };
      });
      const r = await api.post<{ created: unknown[]; notes: MeetingNotesView }>(`/meeting-notes/${meetingId}/action-items`, { items, projectId: projectId || undefined });
      onDone(r.notes);
      setEdits({});
      toast.success(r.created.length ? `${r.created.length} ${r.created.length === 1 ? "task" : "tasks"} created` : "Those are tasks already");
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Card className="p-5" data-testid="action-items">
      <div className="mb-3 flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-muted" />
        <h2 className="text-[13px] font-semibold">Action items</h2>
        <span className="ml-auto text-[12px] text-subtle">{view.actionItems.length ? `${made.length} of ${view.actionItems.length} are tasks` : ""}</span>
      </div>
      {!view.actionItems.length && <p className="text-[13px] text-muted">Checklist items in the notes show here, ready to become tasks.</p>}
      <ul className="space-y-2">
        {pending.map((i) => {
          const e = edits[i.key] ?? {};
          return (
            <li key={i.key} className="rounded-lg border border-line p-2.5" data-testid="action-item">
              <div className="flex items-start gap-2"><Circle className="mt-0.5 h-4 w-4 shrink-0 text-subtle" /><span className="min-w-0 flex-1 text-[13px] font-medium">{i.title}</span></div>
              <div className="mt-2 grid grid-cols-2 gap-2 pl-6">
                <Select aria-label={`Assignee for ${i.title}`} className="h-8 text-[12.5px]" value={e.assignee ?? whoKey(i.assignee)} onChange={(ev) => set(i.key, { assignee: ev.target.value })}>
                  <option value="">No one</option>
                  {view.people.map((p) => <option key={whoKey(p)} value={whoKey(p)}>{p.name}</option>)}
                </Select>
                <Input type="date" aria-label={`Due date for ${i.title}`} className="h-8 text-[12.5px]" value={e.due ?? i.due ?? ""} onChange={(ev) => set(i.key, { due: ev.target.value })} />
              </div>
            </li>
          );
        })}
        {made.map((i) => (
          <li key={i.key} className="flex items-start gap-2 rounded-lg px-2.5 py-1.5" data-testid="action-item-task">
            <CheckCircle2 className={i.task?.done ? "mt-0.5 h-4 w-4 shrink-0 text-good" : "mt-0.5 h-4 w-4 shrink-0 text-brand"} />
            <div className="min-w-0 flex-1 text-[13px]">
              <span>{i.title}</span>
              {i.task ? (
                <Link to={`/app/tasks?view=list&task=${i.task.id}`} className="ml-2 text-[12px] text-brand-hover hover:underline">{i.task.ref} · {i.task.status}</Link>
              ) : <span className="ml-2 text-[12px] text-subtle">Task deleted</span>}
              {(i.assignee || i.due) && <div className="text-[12px] text-subtle">{[i.assignee?.name, i.due && `due ${dayLabel(i.due)}`].filter(Boolean).join(", ")}</div>}
            </div>
          </li>
        ))}
      </ul>
      {pending.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <Select aria-label="Project for the tasks" className="h-8 min-w-0 flex-1 text-[12.5px]" value={projectId} onChange={(ev) => setProjectId(ev.target.value)}>
            <option value="">Default project</option>
            {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Button size="sm" onClick={() => void create()} loading={busy} data-testid="create-tasks">Create {pending.length} {pending.length === 1 ? "task" : "tasks"}</Button>
        </div>
      )}
    </Card>
  );
}

/** On a doc page: "Notes for <meeting>, <date>" with a link back, when the doc is a meeting's notes. */
export function MeetingNotesBacklink({ docId }: { docId: string }) {
  const q = useQuery({ queryKey: ["meeting-for-doc", docId], queryFn: async () => (await api.get<{ meeting: { id: string; title: string; startsAt: string } | null }>(`/meeting-notes/by-doc/${docId}`)).meeting, staleTime: 60_000 });
  const m = q.data;
  if (!m) return null;
  const date = new Date(m.startsAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  return (
    <Link to={`/app/meetings/${m.id}`} data-testid="doc-meeting-link" className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[12px] text-muted hover:text-fg">
      <NotebookPen className="h-3 w-3" />Notes for {m.title}, {date}
    </Link>
  );
}

/** "From the call summary": the recording's action items, added to the notes and made tasks in one click. */
function SummaryItems({ meetingId, view, onDone }: { meetingId: string; view: MeetingNotesView; onDone: (v: MeetingNotesView) => void }) {
  const [busy, setBusy] = useState(false);
  const items = summaryItemsToAdd(view);
  if (!items.length) return null;
  const add = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ created: unknown[]; notes: MeetingNotesView }>(`/meeting-notes/${meetingId}/action-items`, { items });
      onDone(r.notes);
      toast.success(`${r.created.length} ${r.created.length === 1 ? "task" : "tasks"} created from the summary`);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Card className="p-5" data-testid="summary-items">
      <h2 className="mb-2 text-[13px] font-semibold">From the call summary</h2>
      <ul className="mb-3 space-y-1 text-[13px]">{items.map((i) => <li key={i.title} className="flex gap-2"><Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />{i.title}</li>)}</ul>
      <Button size="sm" onClick={() => void add()} loading={busy} data-testid="summary-items-add">Add to notes and make {items.length} {items.length === 1 ? "task" : "tasks"}</Button>
    </Card>
  );
}
