/**
 * R103: comments on a doc. A side panel at 1280 (a full sheet on a phone) with two tabs: Team (everyone who can open
 * the doc, project guests included) and Shared link (people with a share link; their comments wait for review, and
 * owners, admins and the doc's maker approve, hide or answer them). @Name mentions notify through the notification centre.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Textarea } from "@/web/components/ui/input";
import { CommentText, useEditableTokens, useMentionPicker, useMentionsOn } from "@/web/components/mentions-td5"; // TD5
import { labelsToTokens } from "@/shared/mentions-td5"; // TD5
import { Badge, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { IconChat, IconClose, IconEye, IconEyeOff, IconTrash, IconEdit } from "@/web/components/ui/icon";
import { COMMENT_MAX } from "@/shared/docs-plus";
import { LoadErrorInline } from "@/web/components/load-error-t1g";

export interface DocComment {
  id: string; thread: "team" | "public"; body: string; status: "visible" | "pending" | "hidden";
  author: { type: "member" | "guest" | "visitor"; name: string; email?: string };
  createdAt: string; editedAt: string | null; mine: boolean; canEdit: boolean; canRemove: boolean;
}
interface CommentsResponse { team: DocComment[]; public: DocComment[]; pending: number; canModerate: boolean; publicOn: boolean }

export const commentsKey = (docId: string) => ["doc-comments-r103", docId];

export function DocCommentsButton({ docId, open, onToggle }: { docId: string; open: boolean; onToggle: () => void }) {
  const q = useQuery({ queryKey: commentsKey(docId), queryFn: () => api.get<CommentsResponse>(`/docs-plus/docs/${docId}/comments`), staleTime: 30_000 });
  const n = (q.data?.team.length ?? 0) + (q.data?.public.filter((c) => c.status === "visible").length ?? 0);
  const waiting = q.data?.canModerate ? q.data.pending : 0;
  return (
    <button type="button" onClick={onToggle} aria-label={`Comments${n ? `, ${n}` : ""}${waiting ? `, ${waiting} waiting for review` : ""}`} aria-expanded={open} title="Comments" data-testid="doc-comments-button"
      className={cn("relative inline-flex shrink-0 items-center justify-center gap-1 rounded px-1.5 py-1 hover:bg-hover hover:text-fg max-sm:h-11 max-sm:min-w-11 max-sm:rounded-lg", open && "bg-fill/60 text-fg")}>
      <IconChat className="h-4 w-4 max-sm:h-5 max-sm:w-5" /><span className="max-xl:hidden">Comments</span>
      {n > 0 && <span className="text-[12px] tabular-nums text-subtle">{n}</span>}
      {waiting > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[color:var(--warning,#b76e00)]" aria-hidden />}
    </button>
  );
}

function Composer({ placeholder, onSend, people, busy, testId }: { placeholder: string; onSend: (body: string) => Promise<boolean>; people: { id: string; name: string }[]; busy: boolean; testId: string }) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  // TD5: with MENTIONS_TD5 on, one keyboard picker offers people and records (team comments only).
  const on = useMentionsOn() && testId === "doc-comment-input";
  const picker = useMentionPicker(ref, body, setBody, people.map((p) => ({ key: p.id, name: p.name, insert: `@${p.name} ` })), { enabled: on });
  const token = on ? undefined : /(?:^|\s)@([^\s@]{0,30})$/.exec(body)?.[1];
  const matches = token !== undefined ? people.filter((p) => p.name.toLowerCase().includes(token.toLowerCase())).slice(0, 5) : [];
  const pick = (name: string) => { setBody((b) => b.replace(/@([^\s@]{0,30})$/, `@${name} `)); ref.current?.focus(); };
  const send = async () => { const out = on ? picker.toTokens(body) : body; if (out.trim() && (await onSend(out))) { setBody(""); picker.reset(); } };
  return (
    <div className="relative border-t border-line p-3">
      {on && picker.list}
      {matches.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1" aria-label="Mention someone">
          {matches.map((p) => <li key={p.id}><button type="button" onClick={() => pick(p.name)} className="min-h-9 rounded-md border border-line px-2 text-[13px] hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">@{p.name}</button></li>)}
        </ul>
      )}
      <Textarea ref={ref} value={body} onChange={(e) => { setBody(e.target.value); if (on) requestAnimationFrame(picker.sync); }} placeholder={placeholder} rows={3} maxLength={COMMENT_MAX} aria-label="Comment" data-testid={testId}
        onClick={on ? picker.sync : undefined} aria-activedescendant={on ? picker.activeId : undefined} aria-autocomplete={on ? "list" : undefined}
        onKeyDown={(e) => { if (on && picker.onKeyDown(e)) return; if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[12px] text-subtle max-sm:hidden">Ctrl Enter to send</span>
        <Button size="sm" disabled={!body.trim() || busy} onClick={() => void send()}>Comment</Button>
      </div>
    </div>
  );
}

function Item({ c, onEdit, onStatus, onRemove, moderator }: { c: DocComment; onEdit: (c: DocComment) => void; onStatus: (c: DocComment, s: "visible" | "hidden") => void; onRemove: (c: DocComment) => void; moderator: boolean }) {
  return (
    <li className="group px-4 py-3" data-testid="doc-comment">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <strong className="font-semibold">{c.author.name}</strong>
        {c.author.type === "guest" && <Badge>Guest</Badge>}
        {c.author.type === "visitor" && <Badge>Visitor</Badge>}
        {c.status === "pending" && <Badge tone="warn">Waiting for review</Badge>}
        {c.status === "hidden" && <Badge>Hidden</Badge>}
        <span className="text-subtle">{timeAgo(c.createdAt)}{c.editedAt ? ", edited" : ""}</span>
      </div>
      {moderator && c.author.email && <p className="text-[12px] text-subtle">{c.author.email}</p>}
      <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed"><CommentText text={c.body} /></p>
      <div className="mt-2 flex flex-wrap gap-1">
        {moderator && c.status !== "visible" && <Button size="sm" variant="secondary" onClick={() => onStatus(c, "visible")}><IconEye className="h-3.5 w-3.5" />{c.status === "pending" ? "Approve" : "Show"}</Button>}
        {moderator && c.status === "visible" && <Button size="sm" variant="ghost" onClick={() => onStatus(c, "hidden")}><IconEyeOff className="h-3.5 w-3.5" />Hide</Button>}
        {c.canEdit && <Button size="sm" variant="ghost" onClick={() => onEdit(c)}><IconEdit className="h-3.5 w-3.5" />Edit</Button>}
        {c.canRemove && <Button size="sm" variant="ghost" onClick={() => onRemove(c)}><IconTrash className="h-3.5 w-3.5" />Remove</Button>}
      </div>
    </li>
  );
}

export function DocCommentsPanel({ docId, open, onClose }: { docId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: commentsKey(docId), queryFn: () => api.get<CommentsResponse>(`/docs-plus/docs/${docId}/comments`), enabled: open, refetchOnMount: "always", refetchInterval: open ? 60_000 : false });
  const refetch = q.refetch;
  useEffect(() => { if (open) void refetch(); }, [open, refetch]);
  const team = useQuery({ queryKey: ["team"], queryFn: () => api.get<{ members?: { userId?: string; id?: string; name: string }[] }>("/team"), enabled: open, staleTime: 300_000 });
  const people = useMemo(() => (team.data?.members ?? []).map((m) => ({ id: m.userId ?? m.id ?? m.name, name: m.name })).filter((p) => p.name), [team.data]);
  const [tab, setTab] = useState<"team" | "public">("team");
  const [editing, setEditing] = useState<DocComment | null>(null);
  const [editBody, setEditBody] = useState("");
  const mentionsOn = useMentionsOn(); // TD5: record tokens show as @[Title] while editing
  const editable = useEditableTokens(editing?.body ?? "", mentionsOn);
  useEffect(() => { if (editing) setEditBody(editable.text); }, [editing, editable.text]);
  const [removing, setRemoving] = useState<DocComment | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !editing && !removing) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, editing, removing]);
  const refresh = () => qc.invalidateQueries({ queryKey: commentsKey(docId) });
  const add = useMutation({
    mutationFn: (v: { body: string; thread: "team" | "public" }) => api.post(`/docs-plus/docs/${docId}/comments`, v),
    onSuccess: () => { void refresh(); }, onError: (e) => showError(e as Error),
  });
  const send = (thread: "team" | "public") => async (body: string) => { try { await add.mutateAsync({ body, thread }); return true; } catch { return false; } };
  const setStatus = async (c: DocComment, status: "visible" | "hidden") => {
    try { await api.patch(`/docs-plus/comments/${c.id}`, { status }); toast.success(status === "visible" ? (c.status === "pending" ? "Approved. It shows on the shared link now." : "Comment shown") : "Comment hidden"); void refresh(); } catch (e) { showError(e as Error); }
  };
  const saveEdit = async () => {
    if (!editing) return;
    try { await api.patch(`/docs-plus/comments/${editing.id}`, { body: mentionsOn ? labelsToTokens(editBody, editable.map) : editBody }); setEditing(null); void refresh(); } catch (e) { showError(e as Error); }
  };
  const remove = async () => {
    if (!removing) return;
    try { await api.del(`/docs-plus/comments/${removing.id}`); setRemoving(null); toast.success("Comment removed"); void refresh(); } catch (e) { showError(e as Error); }
  };
  if (!open) return null;
  const d = q.data;
  const showPublic = !!d && (d.publicOn || d.public.length > 0) ;
  const list = !d ? [] : tab === "public" && showPublic ? d.public : d.team;
  return (
    <aside role="complementary" aria-label="Comments" data-testid="doc-comments-panel"
      className="fixed inset-y-0 right-0 z-40 flex w-[380px] max-w-full flex-col border-l border-line bg-surface shadow-card motion-safe:animate-[fadeIn_150ms_ease-out] max-sm:inset-0 max-sm:w-full max-sm:border-l-0">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3 max-sm:pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h2 className="flex-1 text-[15px] font-semibold">Comments</h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close comments" className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-11 max-sm:w-11"><IconClose className="h-4 w-4" /></button>
      </header>
      {showPublic && (
        <div role="tablist" aria-label="Comment threads" className="flex gap-1 border-b border-line px-3">
          {(["team", "public"] as const).map((t) => (
            <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`comments-tab-${t}`}
              className={cn("-mb-px inline-flex min-h-11 items-center gap-1.5 border-b-2 px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand", tab === t ? "border-brand font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>
              {t === "team" ? "Team" : "Shared link"}{t === "public" && d!.canModerate && d!.pending > 0 && <Badge tone="warn">{d!.pending}</Badge>}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto" role={showPublic ? "tabpanel" : undefined}>
        {q.isPending ? <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading comments"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
          : q.error ? <LoadErrorInline className="p-4" onRetry={() => q.refetch()} />
            : !list.length ? <EmptyState className="py-10" icon={<IconChat className="h-5 w-5" />} title={tab === "public" && showPublic ? "No comments on the shared link" : "No comments yet"}
              body={tab === "public" && showPublic ? "Comments people leave on the shared link show here for review first." : "Ask a question or leave a note for the team. Type @ and a name to mention someone."} />
              : <ul className="divide-y divide-line" aria-label={tab === "public" ? "Shared link comments" : "Team comments"}>{list.map((c) => <Item key={c.id} c={c} moderator={!!d?.canModerate} onEdit={(x) => { setEditing(x); setEditBody(x.body); }} onStatus={setStatus} onRemove={setRemoving} />)}</ul>}
      </div>
      {d && (tab === "team" || !showPublic) && <Composer placeholder="Add a comment" onSend={send("team")} people={people} busy={add.isPending} testId="doc-comment-input" />}
      {d && tab === "public" && showPublic && (d.canModerate
        ? <Composer placeholder="Answer on the shared link (everyone with the link sees it)" onSend={send("public")} people={[]} busy={add.isPending} testId="doc-public-comment-input" />
        : <p className="border-t border-line p-3 text-[13px] text-muted">Owners, admins and the person who made this doc answer here.</p>)}
      <Dialog open={!!editing} onClose={() => setEditing(null)} title="Edit comment" footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={() => void saveEdit()} disabled={!editBody.trim()}>Save</Button></>}>
        <Textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={4} maxLength={COMMENT_MAX} aria-label="Comment" />
      </Dialog>
      <Dialog open={!!removing} onClose={() => setRemoving(null)} title="Remove this comment?" description="It disappears for everyone. This cannot be undone."
        footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button><Button onClick={() => void remove()} data-testid="confirm-remove-comment">Remove</Button></>} />
    </aside>
  );
}

/** A project guest's view: the team thread for a doc of their project. */
export function GuestDocComments({ docId }: { docId: string }) {
  const qc = useQueryClient();
  const key = ["guest-doc-comments-r103", docId];
  const q = useQuery({ queryKey: key, retry: false, queryFn: () => api.get<{ team: DocComment[] }>(`/guest/r103/docs/${docId}/comments`) });
  const [busy, setBusy] = useState(false);
  if (q.isError) return null; // off for this workspace
  const send = async (body: string) => {
    setBusy(true);
    try { await api.post(`/guest/r103/docs/${docId}/comments`, { body }); void qc.invalidateQueries({ queryKey: key }); return true; } catch (e) { showError(e as Error); return false; } finally { setBusy(false); }
  };
  return (
    <section className="mt-6 rounded-xl border border-line" aria-label="Comments" data-testid="guest-doc-comments">
      <h3 className="flex items-center gap-1.5 border-b border-line px-4 py-3 text-[13px] font-semibold"><IconChat className="h-4 w-4" />Comments</h3>
      {q.isPending ? <div className="p-4"><Skeleton className="h-12" /></div>
        : !q.data?.team.length ? <p className="px-4 py-3 text-[13px] text-muted">No comments yet. Ask the team a question here.</p>
          : <ul className="divide-y divide-line">{q.data.team.map((c) => (
            <li key={c.id} className="px-4 py-3"><p className="text-[13px]"><strong>{c.author.name}</strong> <span className="text-subtle">{timeAgo(c.createdAt)}</span></p><p className="mt-1 whitespace-pre-wrap break-words text-[14px]">{c.body}</p></li>
          ))}</ul>}
      <Composer placeholder="Add a comment" onSend={send} people={[]} busy={busy} testId="guest-comment-input" />
    </section>
  );
}
