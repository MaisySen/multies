/**
 * OPS1: staff notes on a workspace or a person. Only operators see them; the workspace never does.
 *
 *   <NotesPanel targetType="workspace" targetId={org.id} />
 *   <NotesPanel targetType="user" targetId={user.id} />
 *
 * Pinned notes come first, then newest. Anyone with workspaces.notes can add and pin; the author or an owner can
 * delete (with a reason). The audit log records each change without the note's text.
 */
import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { consoleGet, listQuery, type Page } from "@/web/lib/console-api";
import { Badge, Card, EmptyState } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Field, Textarea } from "@/web/components/ui/input";
import { IconPin, IconPinOff, IconStickyNote, IconTrash } from "@/web/components/ui/icon";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { cn } from "@/web/lib/cn";
import { useOperatorAction } from "./components/reason-dialog";
import { LoadError, PersonLink, RelTime } from "./components/format";
import { PermissionGate, useConsoleMe } from "./guard";

export interface OperatorNote {
  id: string; targetType: "workspace" | "user"; targetId: string; body: string; pinned: boolean;
  authorUserId: string | null; authorEmail: string | null; createdAt: string; updatedAt: string;
}

const NOTE_MAX = 4000;
const notesKey = (targetType: string, targetId: string) => ["console", "notes", targetType, targetId] as const;

function AddNote({ targetType, targetId }: { targetType: "workspace" | "user"; targetId: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api.post<{ note: OperatorNote }>("/console/workspaces/notes", { targetType, targetId, body: body.trim(), pinned }),
    onSuccess: async () => {
      setBody(""); setPinned(false);
      toast.success("Note added");
      await qc.invalidateQueries({ queryKey: notesKey(targetType, targetId) });
    },
    onError: (e) => showError(e as Error),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = body.trim();
    if (!t) { setError("Write the note first."); return; }
    if (t.length > NOTE_MAX) { setError(`Keep the note under ${NOTE_MAX.toLocaleString()} characters.`); return; }
    setError(null);
    add.mutate();
  };
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="space-y-3" data-testid="console-notes-form">
        <Field label="Add a note" hint="Only operators see notes. Keep them factual." error={error ?? undefined}>
          {(p) => <Textarea {...p} rows={3} value={body} maxLength={NOTE_MAX + 100} placeholder="What other operators should know" onChange={(e) => setBody(e.target.value)} data-testid="console-notes-input" />}
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="inline-flex items-center gap-2 text-[13px] text-muted">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="h-4 w-4 accent-[var(--color-brand)]" />
            Pin to the top
          </label>
          <Button type="submit" loading={add.isPending} data-testid="console-notes-add">Add note</Button>
        </div>
      </form>
    </Card>
  );
}

function NoteItem({ note, targetType, targetId, onDelete }: { note: OperatorNote; targetType: string; targetId: string; onDelete: (n: OperatorNote) => void }) {
  const me = useConsoleMe();
  const qc = useQueryClient();
  const canDelete = note.authorUserId === me.user.id || me.role === "admin";
  const pin = useMutation({
    mutationFn: () => api.post(`/console/workspaces/notes/${encodeURIComponent(note.id)}/pin`, { pinned: !note.pinned }),
    onSuccess: async () => {
      toast.success(note.pinned ? "Note unpinned" : "Note pinned");
      await qc.invalidateQueries({ queryKey: notesKey(targetType, targetId) });
    },
    onError: (e) => showError(e as Error),
  });
  return (
    <li className={cn("rounded-xl border bg-surface p-4", note.pinned ? "border-brand/40" : "border-line")} data-testid="console-note">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-subtle">
        <span className="inline-flex flex-wrap items-center gap-2">
          {note.pinned && <Badge tone="brand">Pinned</Badge>}
          {note.authorEmail || note.authorUserId ? <PersonLink id={note.authorUserId} email={note.authorEmail} className="max-w-[16rem]" /> : <span>Unknown operator</span>}
          <RelTime at={note.createdAt} />
        </span>
        <PermissionGate permission="workspaces.notes">
          <span className="inline-flex items-center gap-1">
            <Button size="sm" variant="ghost" loading={pin.isPending} onClick={() => pin.mutate()} data-testid="console-note-pin">
              {note.pinned ? <IconPinOff className="h-4 w-4" aria-hidden /> : <IconPin className="h-4 w-4" aria-hidden />}
              {note.pinned ? "Unpin" : "Pin"}
            </Button>
            {canDelete && (
              <Button size="sm" variant="ghost" onClick={() => onDelete(note)} data-testid="console-note-delete">
                <IconTrash className="h-4 w-4" aria-hidden />Delete
              </Button>
            )}
          </span>
        </PermissionGate>
      </div>
      <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{note.body}</p>
    </li>
  );
}

export function NotesPanel({ targetType, targetId }: { targetType: "workspace" | "user"; targetId: string }) {
  const list = useInfiniteQuery({
    queryKey: notesKey(targetType, targetId),
    queryFn: ({ pageParam }) => consoleGet<Page<OperatorNote>>(`/console/workspaces/notes${listQuery({ targetType, targetId, cursor: pageParam })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const del = useOperatorAction<OperatorNote>({
    title: "Delete this note?",
    description: "Other operators will no longer see it. The audit log keeps a record that it was deleted, without its text.",
    confirmLabel: "Delete note", tone: "danger",
    run: (n, reason) => api.del(`/console/workspaces/notes/${encodeURIComponent(n.id)}`, { reason }),
    success: "Note deleted",
    invalidate: [notesKey(targetType, targetId)],
  });
  const notes = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-4" data-testid="console-notes">
      <PermissionGate permission="workspaces.notes"><AddNote targetType={targetType} targetId={targetId} /></PermissionGate>
      {list.isPending ? <SkeletonRows rows={3} label="Loading notes" /> : list.error ? (
        <LoadError error={list.error} retry={() => void list.refetch()} what="notes" />
      ) : !notes.length ? (
        <Card className="p-0">
          <EmptyState icon={<IconStickyNote />} title="No notes yet" body={`Notes help the next operator understand this ${targetType === "workspace" ? "workspace" : "person"}: past issues, promises made, who to contact.`} />
        </Card>
      ) : (
        <>
          <ul className="space-y-2">
            {notes.map((n) => <NoteItem key={n.id} note={n} targetType={targetType} targetId={targetId} onDelete={del.open} />)}
          </ul>
          {list.hasNextPage && (
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</Button>
            </div>
          )}
        </>
      )}
      {del.dialog}
    </div>
  );
}
