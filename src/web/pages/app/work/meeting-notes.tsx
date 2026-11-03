/**
 * Round 23 (R23.1): the agenda and notes doc on a meeting page, and its action items made into tasks
 * in one click. The doc is made the first time someone opens Notes. Checklist items anywhere in the
 * doc are action items; "@Name" and "due Fri" in an item fill the assignee and due date, both of
 * which can be changed here before the tasks are made.
 */
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import type { Transaction } from "@tiptap/pm/state";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { IconAgent, IconCheckCircle, IconChecklist, IconCircle, IconExternalLink, IconNotes, IconUserRound } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Input, Select } from "@/web/components/ui/input";
import { Card, Skeleton } from "@/web/components/ui/misc";
import { summaryItemsToAdd } from "@/shared/action-items";
import { mentionMatches } from "@/web/lib/mention-match";
import { useMe } from "@/web/lib/queries";
import { tone } from "@/web/components/app-bits";
import { colourFor, type CollabSession, type Peer } from "./doc-collab";
import { docExtensions, liveDomEvents, liveKeyDown, useCollabDoc, useCollabSession } from "./collab-editor";
import { collabMode, editingLabel, initialsOf } from "./collab-logic";

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
interface MentionState { query: string; from: number; to: number; top: number; left: number; matches: Who[]; index: number }

function mentionAt(editor: Editor, people: Who[], prev: MentionState | null): MentionState | null {
  const sel = editor.state.selection;
  if (!sel.empty || !people.length) return null;
  const $from = sel.$from;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset, undefined, "\ufffc");
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  if (!m) return null;
  const query = m[2];
  const matches = mentionMatches(people, query);
  const from = sel.from - query.length - 1;
  let top = 0, left = 0;
  try {
    const at = editor.view.coordsAtPos(from);
    const box = (editor.view.dom as HTMLElement).getBoundingClientRect();
    top = at.bottom - box.top + 4; left = Math.max(0, at.left - box.left);
  } catch { /* positions are only for placing the list */ }
  const index = prev && prev.query === query ? Math.min(prev.index, Math.max(0, matches.length - 1)) : 0;
  return { query, from, to: sel.from, top, left, matches, index };
}

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
        <IconNotes className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold">Agenda and notes</h2>
          <p className="mt-1 text-[13px] text-muted">One doc for this meeting that everyone in the workspace can edit. Checklist items become tasks in one click.</p>
        </div>
        <Button size="sm" onClick={() => void open()} loading={opening} data-testid="open-notes"><IconNotes className="h-4 w-4" />Notes</Button>
      </Card>
    );
  }
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" data-testid="meeting-notes">
      <NotesEditor meetingId={meetingId} doc={n.doc} people={n.people} onSaved={() => void qc.invalidateQueries({ queryKey: key })} />
      <div className="space-y-4">
        <ActionItems meetingId={meetingId} view={n} onDone={(v) => qc.setQueryData(key, v)} />
        <SummaryItems meetingId={meetingId} view={n} onDone={(v) => qc.setQueryData(key, v)} />
      </div>
    </div>
  );
}

/** Opens the notes doc's room (the same room as the doc page), then the editor: live when it answers, else the single editor. */
function NotesEditor(props: { meetingId: string; doc: NonNullable<MeetingNotesView["doc"]>; people: Who[]; onSaved: () => void }) {
  const collab = useCollabSession(props.doc.id);
  if (!collab) return <Card className="p-5" data-testid="notes-connecting"><Skeleton className="h-[260px]" /></Card>;
  return <NotesBody key={`${props.doc.id}:${collabMode(collab.session)}`} {...props} session={collab.session} />;
}

/** Who else has the notes open: small avatars in their caret colour and "Maya is editing". */
function NotesPresence({ peers }: { peers: Peer[] }) {
  const label = editingLabel(peers.map((x) => x.name));
  return (
    <div className="mb-2 flex items-center gap-2" data-testid="notes-presence" aria-label={label}>
      <div className="flex -space-x-1.5">
        {peers.slice(0, 4).map((x) => (
          <span key={x.clientId} data-testid="notes-peer" title={x.name}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10.5px] font-semibold text-white ring-2 ring-surface"
            style={{ background: tone(x.color) }}>{initialsOf(x.name)}</span>
        ))}
      </div>
      <span className="text-[12px] text-muted">{label}</span>
    </div>
  );
}

function NotesBody({ meetingId, doc, people, onSaved, session }: { meetingId: string; doc: NonNullable<MeetingNotesView["doc"]>; people: Who[]; onSaved: () => void; session: CollabSession | null }) {
  const me = useMe();
  const userName = me.data?.user.name || me.data?.user.email || "Someone";
  const userColour = colourFor(me.data?.user.id ?? userName);
  // Stable options: a new extensions array or editorProps object makes Tiptap redraw the shared doc.
  const extensions = useMemo(() => docExtensions(session), [session]);
  // The @ mention picker: typing "@" and a few letters lists the people who can be assigned.
  const [picker, setPicker] = useState<MentionState | null>(null);
  const pickerRef = useRef<MentionState | null>(null);
  pickerRef.current = picker;
  const choose = useRef<(w: Who) => void>(() => {});
  const onUpdate = useRef<(tr?: Transaction) => void>(() => {});
  const editorProps = useMemo(() => ({
    ...NOTES_PROPS,
    handleKeyDown: (v: EditorView, e: KeyboardEvent) => {
      const p = pickerRef.current;
      if (!p || !p.matches.length) return session ? liveKeyDown(v, e) : false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { const d = e.key === "ArrowDown" ? 1 : -1; setPicker({ ...p, index: (p.index + d + p.matches.length) % p.matches.length }); return true; }
      if (e.key === "Enter" || e.key === "Tab") { choose.current(p.matches[p.index]); return true; }
      if (e.key === "Escape") { setPicker(null); return true; }
      return session ? liveKeyDown(v, e) : false;
    },
    ...(session ? { handleDOMEvents: liveDomEvents } : {}),
  }), [session]);
  const editor = useEditor({
    extensions, editorProps, immediatelyRender: true,
    // Live: the room is the content, so no content key at all.
    ...(session ? {} : { content: doc.content as never }),
    onUpdate: ({ editor: ed, transaction }) => { onUpdate.current(transaction); if (!isChangeOrigin(transaction)) setPicker(mentionAt(ed, people, pickerRef.current)); },
    onSelectionUpdate: ({ editor: ed }) => setPicker(mentionAt(ed, people, pickerRef.current)),
    onBlur: () => setTimeout(() => setPicker(null), 150),
  });
  choose.current = (w: Who) => {
    const p = pickerRef.current;
    if (!editor || !p) return;
    editor.chain().focus().insertContentAt({ from: p.from, to: p.to }, `@${w.name} `).run();
    setPicker(null);
  };
  // The same save loop as the doc page: live, only the leader saves; solo, every change with the row version.
  const { state, peers, schedule } = useCollabDoc({
    doc, session, editor, delayMs: 700, user: { name: userName, color: userColour },
    onSaved: () => onSaved(),
    // Another person's save reached the room: the action items card reads the row again.
    onRemoteSaved: () => onSaved(),
    onSoloConflict: async ({ setState, setVersion, editor: ed }) => {
      // Someone saved the doc elsewhere: load theirs.
      const row = (await api.get<{ doc: { content: Record<string, unknown>; version: number } }>(`/docs/${doc.id}`)).doc;
      setVersion(row.version);
      ed.commands.setContent(row.content as never, { emitUpdate: false });
      setState("saved");
      toast.message("The notes changed elsewhere, so the latest version is shown.");
    },
  });
  onUpdate.current = schedule;
  return (
    <Card className="p-5">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[13px] font-semibold">Agenda and notes</h2>
        {session && <span className="ml-1 inline-flex items-center gap-1 text-[12px] text-subtle" data-testid="notes-live"><span className="h-1.5 w-1.5 rounded-full bg-good" aria-hidden />Live</span>}
        <span className="ml-auto text-[12px] text-subtle" role="status" data-testid="notes-state">{state === "saving" ? "Saving" : state === "unsaved" ? "Unsaved changes" : "Saved"}</span>
        <Link to={`/app/docs/${doc.id}`} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[12.5px] text-muted hover:bg-hover hover:text-fg" data-testid="open-doc" aria-label={`Open the doc for meeting ${meetingId}`}><IconExternalLink className="h-3.5 w-3.5" />Open doc</Link>
      </div>
      {session && peers.length > 0 && <NotesPresence peers={peers} />}
      <p className="mb-2 text-[12px] text-subtle">Type [ ] and a space for a checklist item. Type @ to pick who it is for, and "due Fri" for a date.</p>
      <div className="relative">
        <EditorContent editor={editor} />
        {picker && picker.matches.length > 0 && (
          <ul role="listbox" aria-label="People to mention" data-testid="mention-picker" style={{ top: picker.top, left: picker.left }}
            className="absolute z-20 max-h-56 w-56 overflow-auto rounded-lg border border-line bg-surface py-1 text-[13px] shadow-pop">
            {picker.matches.map((w, i) => (
              <li key={`${w.type}:${w.id}`} role="option" aria-selected={i === picker.index}
                onMouseDown={(e) => { e.preventDefault(); choose.current(w); }}
                className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 ${i === picker.index ? "bg-brand text-white" : "hover:bg-hover"}`}>
                {w.type === "agent" ? <IconAgent className="h-3.5 w-3.5 shrink-0" /> : <IconUserRound className="h-3.5 w-3.5 shrink-0" />}
                <span className="truncate">{w.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
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
        <IconChecklist className="h-4 w-4 text-muted" />
        <h2 className="text-[13px] font-semibold">Action items</h2>
        <span className="ml-auto text-[12px] text-subtle">{view.actionItems.length ? `${made.length} of ${view.actionItems.length} are tasks` : ""}</span>
      </div>
      {!view.actionItems.length && <p className="text-[13px] text-muted">Checklist items in the notes show here, ready to become tasks.</p>}
      <ul className="space-y-2">
        {pending.map((i) => {
          const e = edits[i.key] ?? {};
          return (
            <li key={i.key} className="rounded-lg border border-line p-2.5" data-testid="action-item">
              <div className="flex items-start gap-2"><IconCircle className="mt-0.5 h-4 w-4 shrink-0 text-subtle" /><span className="min-w-0 flex-1 text-[13px] font-medium">{i.title}</span></div>
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
            <IconCheckCircle className={i.task?.done ? "mt-0.5 h-4 w-4 shrink-0 text-good" : "mt-0.5 h-4 w-4 shrink-0 text-brand"} />
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
      <IconNotes className="h-3 w-3" />Notes for {m.title}, {date}
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
      <ul className="mb-3 space-y-1 text-[13px]">{items.map((i) => <li key={i.title} className="flex gap-2"><IconCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />{i.title}</li>)}</ul>
      <Button size="sm" onClick={() => void add()} loading={busy} data-testid="summary-items-add">Add to notes and make {items.length} {items.length === 1 ? "task" : "tasks"}</Button>
    </Card>
  );
}
