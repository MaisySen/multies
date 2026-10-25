/**
 * Round 22 (R22.4b): saved replies in Compose and in Settings. The toolbar button opens a searchable
 * picker (type to filter by name or shortcut, arrow keys, Enter inserts at the cursor; the subject
 * fills only when empty). Typing "/shortcut" at the start of a line or after a space and pressing
 * Tab inserts that reply. Variables are filled by the server for the thread being answered.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Lock, MessageSquareQuote, Pencil, Plus, Search, Settings2, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useMe } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Textarea } from "@/web/components/ui/input";
import { applySnippet, renderSnippet, shortcutBeforeCursor, snippetDate, SNIPPET_BODY_MAX, SNIPPET_NAME_MAX, SNIPPET_VARIABLES, SNIPPET_VARIABLE_HELP, type SnippetVars } from "@/shared/snippets";

export interface SavedReply {
  id: string; name: string; shortcut: string | null; subject: string | null; body: string; shared: boolean;
  createdBy: { id: string; name: string }; createdAt: string; updatedAt: string; canEdit: boolean;
}
interface DraftLike { mailboxId: string; to: string; subject: string; text: string; threadId?: string }
type Apply = (next: { subject: string; text: string }, cursor: number) => void;

const KEY = ["mail-snippets"] as const;
export const useSavedReplies = () => useQuery({ queryKey: KEY, queryFn: () => api.get<{ snippets: SavedReply[] }>("/mail/snippets"), staleTime: 30_000 });

async function renderFor(id: string, d: DraftLike) {
  const body = { threadId: d.threadId || null, to: d.to || null, mailboxId: d.mailboxId || null };
  try {
    return await api.post<{ subject: string; body: string }>(`/mail/snippets/${encodeURIComponent(id)}/render`, body);
  } catch {
    // The thread or mailbox may be out of reach (moved, access changed): fill from the To field alone.
    return api.post<{ subject: string; body: string }>(`/mail/snippets/${encodeURIComponent(id)}/render`, { to: d.to || null });
  }
}

function matches(s: SavedReply, q: string) {
  const t = q.trim().toLowerCase().replace(/^\//, "");
  return !t || s.name.toLowerCase().includes(t) || (s.shortcut ?? "").includes(t);
}

/** Inserts a saved reply into the draft at the textarea's cursor (or over a typed "/shortcut"). */
async function insertInto(s: SavedReply, d: DraftLike, el: HTMLTextAreaElement | null, apply: Apply, range?: { from: number; to: number }) {
  const from = range?.from ?? el?.selectionStart ?? d.text.length;
  const to = range?.to ?? el?.selectionEnd ?? from;
  const rendered = await renderFor(s.id, d);
  const next = applySnippet(d, rendered, from, to);
  apply({ subject: next.subject, text: next.text }, next.cursor);
}

/** The "Saved replies" toolbar button and its picker. */
export function SavedRepliesButton({ draft, bodyRef, onApply }: { draft: DraftLike; bodyRef: React.RefObject<HTMLTextAreaElement | null>; onApply: Apply }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const list = useSavedReplies();
  const wrap = useRef<HTMLDivElement>(null);
  const items = useMemo(() => (list.data?.snippets ?? []).filter((s) => matches(s, q)), [list.data, q]);
  useEffect(() => { setActive(0); }, [q, open]);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);

  const pick = async (s: SavedReply | undefined) => {
    if (!s || busy) return;
    setBusy(true);
    try {
      await insertInto(s, draft, bodyRef.current, onApply);
      setOpen(false);
      setQ("");
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };

  return (
    <div ref={wrap} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox" aria-label="Saved replies" title="Saved replies"
        className={cn("flex items-center rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg", open && "bg-[#0071E3]/10 text-[#0071E3]")}>
        <MessageSquareQuote className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div role="dialog" aria-label="Saved replies" data-testid="saved-replies-picker"
          className="absolute bottom-full right-0 z-50 mb-2 w-[min(340px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line-strong bg-elevated shadow-pop animate-pop-in"
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); setOpen(false); bodyRef.current?.focus(); }
          }}>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved replies" aria-label="Search saved replies"
              className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-subtle"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(items.length - 1, 0))); }
                if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
                if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void pick(items[active]); }
              }} />
          </div>
          <ul role="listbox" aria-label="Saved replies" className="max-h-64 overflow-y-auto py-1">
            {list.isLoading && <li className="px-3 py-2 text-[13px] text-subtle">Loading</li>}
            {!list.isLoading && !items.length && (
              <li className="px-3 py-3 text-[13px] text-subtle">{(list.data?.snippets.length ?? 0) ? "No saved reply matches." : "No saved replies yet."}</li>
            )}
            {items.map((s, i) => (
              <li key={s.id} role="option" aria-selected={i === active}>
                <button type="button" onMouseEnter={() => setActive(i)} onClick={() => void pick(s)} disabled={busy}
                  className={cn("flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left", i === active && "bg-[#0071E3]/[0.08]")}>
                  <span className="flex w-full items-center gap-2 text-[13px] font-medium">
                    <span className="truncate">{s.name}</span>
                    {s.shortcut && <span className="shrink-0 rounded bg-fill px-1.5 py-px font-mono text-[11px] text-muted">/{s.shortcut}</span>}
                    {!s.shared && <Lock className="ml-auto h-3 w-3 shrink-0 text-subtle" aria-label="Only you" />}
                  </span>
                  <span className="line-clamp-1 text-[12px] text-subtle">{s.body}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[12px]">
            <span className="text-subtle">Type /shortcut then Tab</span>
            <Link to="/app/settings#saved-replies" className="flex items-center gap-1 font-medium text-[#0071E3] hover:underline"><Settings2 className="h-3.5 w-3.5" aria-hidden />Manage</Link>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tab after "/shortcut" in the message body inserts that saved reply. Returns the textarea's onKeyDown. */
export function useSnippetShortcut(draft: DraftLike, bodyRef: React.RefObject<HTMLTextAreaElement | null>, onApply: Apply) {
  const list = useSavedReplies();
  return (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) return;
    const hit = shortcutBeforeCursor(el.value, el.selectionStart);
    const s = hit && list.data?.snippets.find((x) => x.shortcut === hit.word);
    if (!hit || !s) return;
    e.preventDefault();
    insertInto(s, { ...draft, text: el.value }, bodyRef.current, onApply, { from: hit.start, to: el.selectionStart }).catch(showError);
  };
}

/* Settings > Saved replies ------------------------------------------------------------------- */

interface Form { id?: string; name: string; shortcut: string; subject: string; body: string; shared: boolean }
const EMPTY: Form = { name: "", shortcut: "", subject: "", body: "", shared: true };

function useSampleVars(): SnippetVars {
  const me = useMe();
  const myName = me.data?.user.name ?? "";
  return {
    first_name: "Grace", name: "Grace Hopper", email: "grace@example.com",
    my_name: myName, my_first_name: myName.split(/\s+/)[0] ?? "",
    company: me.data?.organization?.name ?? "", mailbox: "support@yourdomain.com",
    date: snippetDate(new Date(), me.data?.user.timezone ?? me.data?.organization?.timezone),
  };
}

export function SavedRepliesSection({ Section }: { Section: (p: { id?: string; title: string; description: React.ReactNode; children: React.ReactNode }) => React.ReactElement }) {
  const qc = useQueryClient();
  const list = useSavedReplies();
  const [form, setForm] = useState<Form | null>(null);
  const [deleting, setDeleting] = useState<SavedReply | null>(null);
  const vars = useSampleVars();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const save = useMutation({
    mutationFn: (f: Form) => {
      const payload = { name: f.name, shortcut: f.shortcut.trim() || null, subject: f.subject.trim() || null, body: f.body, shared: f.shared };
      return f.id ? api.patch(`/mail/snippets/${f.id}`, payload) : api.post("/mail/snippets", payload);
    },
    onSuccess: (_r, f) => { toast.success(f.id ? "Saved reply updated" : "Saved reply added"); setForm(null); void qc.invalidateQueries({ queryKey: KEY }); },
    onError: showError,
  });
  const del = useMutation({
    mutationFn: (s: SavedReply) => api.del(`/mail/snippets/${s.id}`),
    onSuccess: () => { toast.success("Saved reply deleted"); setDeleting(null); void qc.invalidateQueries({ queryKey: KEY }); },
    onError: showError,
  });
  const addVar = (v: string) => {
    if (!form) return;
    const el = bodyRef.current;
    const at = el?.selectionStart ?? form.body.length;
    const token = `{{${v}}}`;
    setForm({ ...form, body: form.body.slice(0, at) + token + form.body.slice(el?.selectionEnd ?? at) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + token.length, at + token.length); });
  };
  const items = list.data?.snippets ?? [];

  return (
    <Section id="saved-replies" title="Saved replies" description="Answers your team sends often. Insert one from Compose, or type /shortcut and press Tab. Variables like {{first_name}} fill in for each recipient.">
      <div className="space-y-3" data-testid="saved-replies-settings">
        {!items.length && !list.isLoading && <p className="text-sm text-subtle">No saved replies yet.</p>}
        {!!items.length && (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {items.map((s) => (
              <li key={s.id} className="flex items-start gap-3 px-4 py-3" data-testid="saved-reply-row">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#0071E3]/10 text-[#0071E3]"><MessageSquareQuote className="h-3.5 w-3.5" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="truncate">{s.name}</span>
                    {s.shortcut && <span className="rounded bg-fill px-1.5 py-px font-mono text-[11px] font-normal text-muted">/{s.shortcut}</span>}
                    <span className="flex items-center gap-1 text-[11px] font-normal text-subtle">{s.shared ? <><Users className="h-3 w-3" aria-hidden />Team</> : <><Lock className="h-3 w-3" aria-hidden />Only you</>}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-[13px] text-muted">{s.body}</p>
                  <p className="mt-0.5 text-[11px] text-subtle">By {s.createdBy.name}</p>
                </div>
                {s.canEdit && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="icon" aria-label={`Edit ${s.name}`} onClick={() => setForm({ id: s.id, name: s.name, shortcut: s.shortcut ?? "", subject: s.subject ?? "", body: s.body, shared: s.shared })}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="icon" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <Button variant="secondary" size="sm" onClick={() => setForm({ ...EMPTY })}><Plus className="h-3.5 w-3.5" />New saved reply</Button>
      </div>

      <Dialog open={!!form} onClose={() => setForm(null)} title={form?.id ? "Edit saved reply" : "New saved reply"} className="sm:max-w-2xl"
        footer={<>
          <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
          <Button loading={save.isPending} disabled={!form?.name.trim() || !form?.body.trim()} onClick={() => form && save.mutate(form)}>Save</Button>
        </>}>
        {form && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              <Field label="Name">{(p) => <Input {...p} value={form.name} maxLength={SNIPPET_NAME_MAX} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Thanks for your order" />}</Field>
              <Field label="Shortcut" hint="Optional. Type /shortcut in Compose, then Tab.">{(p) => <Input {...p} value={form.shortcut} maxLength={33} onChange={(e) => setForm({ ...form, shortcut: e.target.value })} placeholder="thanks" />}</Field>
              <Field label="Subject" hint="Optional. Fills the subject only when it's empty.">{(p) => <Input {...p} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />}</Field>
              <Field label="Reply">{(p) => <Textarea {...p} ref={bodyRef} rows={7} value={form.body} maxLength={SNIPPET_BODY_MAX} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder={"Hi {{first_name}},\n\nThanks for getting in touch."} />}</Field>
              <div className="flex flex-wrap gap-1">
                {SNIPPET_VARIABLES.map((v) => (
                  <button key={v} type="button" title={SNIPPET_VARIABLE_HELP[v]} onClick={() => addVar(v)} className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted hover:border-[#0071E3] hover:text-[#0071E3]">{`{{${v}}}`}</button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.shared} onChange={(e) => setForm({ ...form, shared: e.target.checked })} className="h-4 w-4 accent-[#0071E3]" />
                Share with the team
              </label>
            </div>
            <div className="min-w-0 rounded-xl border border-line bg-fill/40 p-4" aria-label="Preview">
              <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">Preview</p>
              {form.subject.trim() && <p className="mt-2 text-sm font-medium">{renderSnippet(form.subject, vars)}</p>}
              <p data-testid="saved-reply-preview" className="mt-2 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{renderSnippet(form.body, vars) || <span className="text-subtle">Your reply shows here, filled in for Grace Hopper.</span>}</p>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={!!deleting} onClose={() => setDeleting(null)} title={`Delete ${deleting?.name ?? "saved reply"}?`} description="It's removed for everyone in the workspace."
        footer={<>
          <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" loading={del.isPending} onClick={() => deleting && del.mutate(deleting)}>Delete</Button>
        </>} />
    </Section>
  );
}
