import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, MessageSquareText, Pencil, Trash2 } from "lucide-react";
import { api } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { useDialogs } from "@/web/components/ui/confirm";
import { Textarea } from "@/web/components/ui/input";
import { Avatar, Card, Kbd } from "@/web/components/ui/misc";
import { fullDate, initials, mailDate } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows"; // R30

/** Round 22 (R22.2): internal notes on a shared inbox thread. Team only, never sent to anyone outside. */
interface Person { userId: string; name: string; email: string | null }
export interface ThreadNote {
  id: string; body: string; createdAt: string; editedAt: string | null; canEdit: boolean; canDelete: boolean;
  author: { type: "member" | "agent"; id: string; name: string }; mentions: { userId: string; name: string }[];
}
interface NotesResponse { comments: ThreadNote[]; mentionable: Person[] }

const MAX = 4000;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The open "@name" being typed just before the caret, if any. */
function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[\w@]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /\n/.test(query) || /\s{2}/.test(query) || (query.match(/ /g)?.length ?? 0) > 2) return null;
  return { start: at, query };
}

/** A note's text with mentioned names picked out. */
function NoteText({ note }: { note: ThreadNote }) {
  const names = note.mentions.map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return <>{note.body}</>;
  const re = new RegExp(`(@(?:${names.map(escapeRe).join("|")}))`, "gi");
  return <>{note.body.split(re).map((part, i) => (i % 2 ? <span key={i} className="rounded bg-brand-soft px-0.5 font-medium text-brand-hover">{part}</span> : part))}</>;
}

function NoteEditor({ people, initial = "", submitLabel, busy, onSubmit, onCancel, autoFocus }: {
  people: Person[]; initial?: string; submitLabel: string; busy: boolean; onSubmit: (body: string, mentions: string[]) => void; onCancel?: () => void; autoFocus?: boolean;
}) {
  const [text, setText] = useState(initial);
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const matches = useMemo(() => {
    if (!open) return [];
    const q = open.query.toLowerCase();
    return people.filter((p) => p.name.toLowerCase().includes(q) || (p.email ?? "").toLowerCase().startsWith(q)).slice(0, 6);
  }, [open, people]);

  const sync = (value: string, caret: number) => { setOpen(mentionQuery(value, caret)); setActive(0); };
  const pick = (p: Person) => {
    if (!open) return;
    const caret = ref.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, open.start)}@${p.name} ${text.slice(caret)}`;
    setText(next);
    setPicked((x) => [...new Set([...x, p.userId])]);
    setOpen(null);
    const pos = open.start + p.name.length + 2;
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(pos, pos); });
  };
  const submit = () => {
    const body = text.trim();
    if (!body || busy) return;
    // Only people still named in the text are sent along; the server checks access again.
    onSubmit(body, picked.filter((id) => { const p = people.find((x) => x.userId === id); return !!p && body.toLowerCase().includes(`@${p.name.toLowerCase()}`); }));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && matches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[active]); return; }
      if (e.key === "Escape") { e.preventDefault(); setOpen(null); return; }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    if (e.key === "Escape" && onCancel) { e.preventDefault(); onCancel(); }
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref} value={text} rows={initial ? 3 : 2} maxLength={MAX} autoFocus={autoFocus}
        aria-label="Write a team note" placeholder="Add a note for your team. Type @ to mention someone."
        className="resize-y bg-surface/80"
        role="combobox" aria-expanded={!!open && matches.length > 0} aria-controls="note-mentions" aria-autocomplete="list"
        onChange={(e) => { setText(e.target.value); sync(e.target.value, e.target.selectionStart); }}
        onClick={(e) => sync(text, e.currentTarget.selectionStart)}
        onKeyDown={onKey}
      />
      {open && matches.length > 0 && (
        <ul id="note-mentions" role="listbox" aria-label="People to mention" className="absolute left-2 top-full z-20 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-elevated py-1 shadow-card">
          {matches.map((p, i) => (
            <li key={p.userId} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(p); }} onMouseEnter={() => setActive(i)}
                className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm", i === active && "bg-hover")}>
                <Avatar label={initials(p.name)} className="h-6 w-6 text-[10px]" />
                <span className="truncate font-medium">{p.name}</span>
                {p.email && <span className="ml-auto truncate text-xs text-subtle">{p.email}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="hidden text-xs text-subtle sm:inline"><Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to {submitLabel.toLowerCase()}</span>
        <div className="ml-auto flex gap-2">
          {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
          <Button size="sm" onClick={submit} loading={busy} disabled={!text.trim()}>{submitLabel}</Button>
        </div>
      </div>
    </div>
  );
}

/** "Team notes" under a thread's messages. */
export function ThreadNotes({ threadId }: { threadId: string }) {
  const { confirm, dialogs } = useDialogs();
  const qc = useQueryClient();
  const key = ["thread-notes", threadId];
  const notes = useQuery({ queryKey: key, queryFn: () => api.get<NotesResponse>(`/threads/${encodeURIComponent(threadId)}/comments`), refetchInterval: 30_000 });
  const [editing, setEditing] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const refresh = () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ["thread-notes", "counts"] }); };
  const add = useMutation({
    mutationFn: (b: { body: string; mentions: string[] }) => api.post(`/threads/${encodeURIComponent(threadId)}/comments`, b),
    onSuccess: () => { setFormKey((k) => k + 1); refresh(); },
  });
  const edit = useMutation({
    mutationFn: (b: { id: string; body: string; mentions: string[] }) => api.patch(`/threads/${encodeURIComponent(threadId)}/comments/${b.id}`, { body: b.body, mentions: b.mentions }),
    onSuccess: () => { setEditing(null); refresh(); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/threads/${encodeURIComponent(threadId)}/comments/${id}`),
    onSuccess: refresh,
  });
  const people = notes.data?.mentionable ?? [];
  const error = add.error ?? edit.error ?? del.error;

  return (
    <Card className="border-warn/25 bg-warn-soft/60 p-4" aria-label="Team notes">
      {dialogs}
      <div className="flex items-center gap-2">
        <Lock className="h-4 w-4 text-warn" aria-hidden />
        <h3 className="text-sm font-semibold">Team notes</h3>
        <span className="text-xs text-warn">Only your team sees these</span>
      </div>
      {notes.isPending ? <SkeletonRows rows={2} rowHeight={56} avatar label="Loading notes" className="mt-3" />
        : notes.error ? <p className="mt-3 text-sm text-bad">{notes.error.message}</p>
        : notes.data.comments.length > 0 && (
          <ul className="mt-3 space-y-3">
            {notes.data.comments.map((n) => (
              <li key={n.id} className="group flex gap-2.5" data-testid="team-note">
                <Avatar label={initials(n.author.name)} className="h-7 w-7 text-[10px]" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium">{n.author.name}</span>
                    {n.author.type === "agent" && <span className="text-xs text-subtle">agent</span>}
                    <time className="text-xs text-subtle" dateTime={n.createdAt} title={fullDate(n.createdAt)}>{mailDate(n.createdAt)}</time>
                    {n.editedAt && <span className="text-xs text-subtle">edited</span>}
                    <span className="ml-auto flex gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                      {n.canEdit && <button type="button" onClick={() => setEditing(n.id)} className="rounded p-1 text-subtle hover:bg-hover hover:text-fg" aria-label="Edit note"><Pencil className="h-3.5 w-3.5" /></button>}
                      {n.canDelete && <button type="button" onClick={async () => { if (await confirm({ title: "Delete this team note?", description: n.body.length > 80 ? `"${n.body.slice(0, 80)}..."` : `"${n.body}"`, confirmLabel: "Delete note" })) del.mutate(n.id); }} className="rounded p-1 text-subtle hover:bg-hover hover:text-bad" aria-label="Delete note"><Trash2 className="h-3.5 w-3.5" /></button>}
                    </span>
                  </div>
                  {editing === n.id
                    ? <div className="mt-1"><NoteEditor people={people} initial={n.body} submitLabel="Save" busy={edit.isPending} autoFocus onCancel={() => setEditing(null)} onSubmit={(body, mentions) => edit.mutate({ id: n.id, body, mentions })} /></div>
                    : <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg/90"><NoteText note={n} /></p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      <div className="mt-3">
        <NoteEditor key={formKey} people={people} submitLabel="Add note" busy={add.isPending} onSubmit={(body, mentions) => add.mutate({ body, mentions })} />
      </div>
      {error && <p className="mt-2 text-sm text-bad" role="alert">{error.message}</p>}
    </Card>
  );
}

/** Team note counts for the threads on screen: one grouped read per page of the list. */
export function useNoteCounts(threadIds: string[]) {
  const ids = threadIds.slice(0, 100).join(",");
  const q = useQuery({
    queryKey: ["thread-notes", "counts", ids], enabled: ids.length > 0, staleTime: 30_000,
    queryFn: () => api.get<{ counts: Record<string, number> }>(`/threads/comment-counts?ids=${encodeURIComponent(ids)}`),
  });
  return q.data?.counts ?? {};
}

/** A small "has team notes" mark on a thread row. */
export function NoteCount({ n }: { n?: number }) {
  if (!n) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-warn-soft px-1.5 py-0.5 text-[11.5px] text-fg/80" title={n === 1 ? "1 team note" : `${n} team notes`} data-testid="note-count">
      <MessageSquareText className="h-3 w-3" aria-hidden />{n}<span className="sr-only">{n === 1 ? " team note" : " team notes"}</span>
    </span>
  );
}
