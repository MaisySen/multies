/**
 * TD3 (MEET_TD3): meetings to tasks on the meeting page. Suggested action items from a recording's transcript, the
 * notes, or pasted text, each with Accept (one real task) and Discard, Accept all with Undo, and a follow up email
 * that opens in the mail composer as a draft. Works without AI: pick lines in the text, or type, and make a task.
 * Nothing is created or sent without a click.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconCheck, IconCheckCircle, IconClose, IconListPlus, IconMailPlus, IconQuote, IconRefresh, IconSparkle, IconUndo } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Card, Skeleton } from "@/web/components/ui/misc";
import { attachToNewEmail } from "@/web/lib/compose-files";

interface Who { type: "member" | "agent"; id: string; name: string }
export interface Suggestion {
  id: string; source: "recording" | "notes" | "pasted" | "manual"; title: string; quote: string | null; due: string | null;
  status: "open" | "accepted" | "discarded"; assignee: Who | null; task: { id: string; ref: string; title: string } | null; canUndo: boolean;
}
interface View {
  suggestions: Suggestion[]; attendees: Who[]; people: Who[];
  sources: { recordings: { id: string; startedAt: string; status: string }[]; notes: boolean };
  ai: { state: "ready" | "off" | "no_key"; message: string | null };
}

const dayLabel = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function useOnline() {
  const [on, setOn] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return on;
}

export function MeetingSuggestions({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient();
  const key = ["meeting-td3", meetingId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<View>(`/meeting-td3/${meetingId}`), refetchOnWindowFocus: false });
  const online = useOnline();
  const navigate = useNavigate();
  const [src, setSrc] = useState<string>("");
  const [pasted, setPasted] = useState("");
  const [showText, setShowText] = useState(false);
  const [adding, setAdding] = useState<{ title: string; quote: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const pane = useRef<HTMLPreElement>(null);

  const v = q.data;
  const defaultSrc = v ? (v.sources.recordings[0] ? `rec:${v.sources.recordings[0].id}` : v.sources.notes ? "notes" : "pasted") : "";
  const source = src || defaultSrc;
  const textQ = useQuery({
    queryKey: [...key, "source", source], enabled: showText && !!source && source !== "pasted",
    queryFn: () => api.get<{ text: string }>(source === "notes" ? `/meeting-td3/${meetingId}/source?source=notes` : `/meeting-td3/${meetingId}/source?source=recording&recordingId=${encodeURIComponent(source.slice(4))}`),
  });
  const setList = (suggestions: Suggestion[]) => qc.setQueryData<View>(key, (x) => (x ? { ...x, suggestions } : x));
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try { await fn(); } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };

  if (q.isPending) return <Card className="mt-4 p-5" data-testid="meeting-suggest-loading"><Skeleton className="h-5 w-48" /><Skeleton className="mt-3 h-20" /></Card>;
  if (q.isError || !v) {
    return (
      <Card className="mt-4 flex items-center gap-3 p-5" data-testid="meeting-suggest-error" role="alert">
        <p className="min-w-0 flex-1 text-[13px] text-muted">Suggested action items didn't load. Check your connection and try again.</p>
        <Button size="sm" variant="secondary" onClick={() => void q.refetch()} data-testid="meeting-suggest-retry"><IconRefresh className="h-4 w-4" />Retry</Button>
      </Card>
    );
  }

  const open = v.suggestions.filter((s) => s.status === "open");
  const accepted = v.suggestions.filter((s) => s.status === "accepted");
  const discarded = v.suggestions.filter((s) => s.status === "discarded");
  const aiReady = v.ai.state === "ready";

  const doSuggest = () => run("suggest", async () => {
    const body = source === "notes" ? { source: "notes" } : source === "pasted" ? { source: "pasted", text: pasted } : { source: "recording", recordingId: source.slice(4) };
    const r = await api.post<{ suggestions: Suggestion[]; added: number }>(`/meeting-td3/${meetingId}/suggest`, body);
    setList(r.suggestions);
    toast.success(r.added ? `${r.added} ${r.added === 1 ? "suggestion" : "suggestions"} ready to review` : "No new action items found");
  });
  const accept = (s: Suggestion) => run(s.id, async () => {
    const r = await api.post<{ suggestion: Suggestion | null }>(`/meeting-td3/${meetingId}/suggestions/${s.id}/accept`, {});
    await refresh();
    if (r.suggestion?.task) toast.success("Task created", { action: { label: "Undo", onClick: () => void undo([s.id]) } });
  });
  const discard = (s: Suggestion) => run(s.id, async () => {
    await api.post(`/meeting-td3/${meetingId}/suggestions/${s.id}/discard`, {});
    await refresh();
    toast("Suggestion discarded", { action: { label: "Undo", onClick: () => void undo([s.id]) } });
  });
  const undo = async (ids: string[]) => {
    try { const r = await api.post<{ suggestions: Suggestion[]; undone: string[] }>(`/meeting-td3/${meetingId}/undo`, { ids }); setList(r.suggestions); toast.success(r.undone.length === 1 ? "Undone" : `${r.undone.length} undone`); }
    catch (e) { showError(e as Error); }
  };
  const acceptAll = () => run("all", async () => {
    const r = await api.post<{ accepted: string[]; suggestions: Suggestion[] }>(`/meeting-td3/${meetingId}/accept-all`, {});
    setList(r.suggestions);
    toast.success(`${r.accepted.length} ${r.accepted.length === 1 ? "task" : "tasks"} created`, { action: { label: "Undo", onClick: () => void undo(r.accepted) } });
  });
  const edit = (s: Suggestion, patch: { assigneeId?: string | null; due?: string | null }) => run(s.id, async () => {
    const r = await api.patch<{ suggestion: Suggestion }>(`/meeting-td3/${meetingId}/suggestions/${s.id}`, patch);
    qc.setQueryData<View>(key, (x) => (x ? { ...x, suggestions: x.suggestions.map((y) => (y.id === s.id ? r.suggestion : y)) } : x));
  });
  const followUp = () => run("email", async () => {
    const r = await api.get<{ to: string[]; subject: string; text: string }>(`/meeting-td3/${meetingId}/follow-up`);
    attachToNewEmail(navigate, {}, { to: r.to.join(", "), subject: r.subject, text: r.text });
  });
  const readSelection = () => {
    const sel = window.getSelection();
    const t = sel && pane.current && sel.anchorNode && pane.current.contains(sel.anchorNode) ? sel.toString().replace(/\s+/g, " ").trim() : "";
    setSelection(t.slice(0, 2000));
  };
  const off = !online;

  return (
    <Card className="mt-4 p-5" data-testid="meeting-suggest">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <IconSparkle className="h-4 w-4 text-muted" />
        <h2 className="text-[13px] font-semibold">Suggested action items</h2>
        <span className="text-[12px] text-subtle">{accepted.length ? `${accepted.length} made into tasks` : ""}</span>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void followUp()} loading={busy === "email"} disabled={off} data-testid="meeting-follow-up">
          <IconMailPlus className="h-4 w-4" />Follow up email
        </Button>
      </div>

      {off && <p role="status" className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-[12.5px]" data-testid="meeting-suggest-offline">You're offline. Suggestions and tasks will work again when you're back online.</p>}

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-[12px] text-muted">
          Read from
          <Select className="mt-1 h-9 w-full text-[13px]" value={source} onChange={(e) => { setSrc(e.target.value); setSelection(""); }} data-testid="meeting-suggest-source">
            {v.sources.recordings.map((r) => <option key={r.id} value={`rec:${r.id}`}>Transcript, {when(r.startedAt)}</option>)}
            {v.sources.notes && <option value="notes">Meeting notes</option>}
            <option value="pasted">Pasted text</option>
          </Select>
        </label>
        <Button size="sm" className="h-9" onClick={() => void doSuggest()} loading={busy === "suggest"} disabled={off || !aiReady || (source === "pasted" && !pasted.trim())} data-testid="meeting-suggest-run">
          <IconSparkle className="h-4 w-4" />{open.length || accepted.length ? "Suggest again" : "Suggest"}
        </Button>
        {source !== "pasted" && <Button size="sm" variant="ghost" className="h-9" onClick={() => setShowText((x) => !x)} aria-expanded={showText} data-testid="meeting-suggest-show-text">{showText ? "Hide text" : "Show text"}</Button>}
      </div>
      {!aiReady && v.ai.message && <p className="mt-2 text-[12.5px] text-muted" data-testid="meeting-suggest-ai-note">{v.ai.message}</p>}

      {source === "pasted" && (
        <Textarea className="mt-3 min-h-[120px] text-[13px]" aria-label="Paste the transcript or notes" placeholder="Paste the transcript or notes from another tool. It is read once and not kept."
          value={pasted} onChange={(e) => setPasted(e.target.value)} onMouseUp={() => { const el = document.activeElement as HTMLTextAreaElement | null; if (el?.selectionEnd && el.selectionEnd > el.selectionStart) setSelection(el.value.slice(el.selectionStart, el.selectionEnd).replace(/\s+/g, " ").trim().slice(0, 2000)); }} data-testid="meeting-suggest-paste" />
      )}
      {showText && source !== "pasted" && (
        textQ.isPending ? <Skeleton className="mt-3 h-32" />
          : textQ.isError ? <div className="mt-3 flex items-center gap-2 text-[13px] text-muted" role="alert">The text didn't load.<Button size="sm" variant="ghost" onClick={() => void textQ.refetch()}>Retry</Button></div>
          : <pre ref={pane} tabIndex={0} aria-label="Meeting text. Select words, then make a task from them." onMouseUp={readSelection} onKeyUp={readSelection}
              className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-fill p-3 font-sans text-[13px] leading-relaxed focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand" data-testid="meeting-suggest-text">{textQ.data?.text || "Nothing here yet."}</pre>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={off || !selection} onClick={() => setAdding({ title: selection.slice(0, 300), quote: selection })} data-testid="meeting-suggest-from-selection">
          <IconQuote className="h-4 w-4" />Make task from selection
        </Button>
        <Button size="sm" variant="ghost" disabled={off} onClick={() => setAdding({ title: "", quote: "" })} data-testid="meeting-suggest-add"><IconListPlus className="h-4 w-4" />Add action item</Button>
      </div>
      {adding && <AddForm people={v.people} initial={adding} busy={busy === "add"} onCancel={() => setAdding(null)} onSave={(x) => run("add", async () => {
        await api.post(`/meeting-td3/${meetingId}/suggestions`, { ...x, accept: true });
        setAdding(null); setSelection(""); await refresh(); toast.success("Task created");
      })} />}

      {!v.suggestions.length && <p className="mt-4 text-[13px] text-muted" data-testid="meeting-suggest-empty">No suggestions yet. Pick what to read from and press Suggest, or select lines and make tasks by hand.</p>}

      {open.length > 0 && (
        <ul className="mt-4 space-y-2" aria-label="Suggestions to review">
          {open.map((s) => (
            <li key={s.id} className="rounded-lg border border-line p-3 transition-colors duration-150 hover:bg-hover/40" data-testid="meeting-suggestion">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[13px] font-medium">{s.title}</span>
                <Button size="sm" onClick={() => void accept(s)} loading={busy === s.id} disabled={off || (!!busy && busy !== s.id)} aria-label={`Accept: ${s.title}`} data-testid="meeting-suggestion-accept"><IconCheck className="h-4 w-4" />Accept</Button>
                <Button size="sm" variant="ghost" onClick={() => void discard(s)} disabled={off || !!busy} aria-label={`Discard: ${s.title}`} data-testid="meeting-suggestion-discard"><IconClose className="h-4 w-4" />Discard</Button>
              </div>
              {s.quote && <blockquote className="mt-1.5 border-l-2 border-line pl-2 text-[12.5px] text-muted" data-testid="meeting-suggestion-quote">“{s.quote}”</blockquote>}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Select aria-label={`Owner for ${s.title}`} className="h-8 text-[12.5px]" value={s.assignee?.id ?? ""} disabled={off} onChange={(e) => void edit(s, { assigneeId: e.target.value || null })}>
                  <option value="">No owner</option>
                  {v.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Input type="date" aria-label={`Due date for ${s.title}`} className="h-8 text-[12.5px]" value={s.due ?? ""} disabled={off} onChange={(e) => void edit(s, { due: e.target.value || null })} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {open.length > 1 && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={() => void acceptAll()} loading={busy === "all"} disabled={off || !!busy} data-testid="meeting-suggest-accept-all">Accept all {open.length}</Button>
        </div>
      )}

      {accepted.length > 0 && (
        <ul className="mt-4 space-y-1" aria-label="Made into tasks">
          {accepted.map((s) => (
            <li key={s.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5" data-testid="meeting-suggestion-accepted">
              <IconCheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-good" />
              <div className="min-w-0 flex-1 text-[13px]">
                <span>{s.title}</span>
                {s.task && <Link to={`/app/tasks?view=list&task=${s.task.id}`} className="ml-2 text-[12px] text-brand-hover hover:underline">{s.task.ref || "Open task"}</Link>}
                {(s.assignee || s.due) && <div className="text-[12px] text-subtle">{[s.assignee?.name, s.due && `due ${dayLabel(s.due)}`].filter(Boolean).join(", ")}</div>}
              </div>
              {s.canUndo && <Button size="sm" variant="ghost" onClick={() => void undo([s.id])} disabled={off} aria-label={`Undo: ${s.title}`} data-testid="meeting-suggestion-undo"><IconUndo className="h-4 w-4" />Undo</Button>}
            </li>
          ))}
        </ul>
      )}
      {discarded.length > 0 && (
        <details className="mt-3 text-[13px]" data-testid="meeting-suggest-discarded">
          <summary className="cursor-pointer text-[12.5px] text-muted">{discarded.length} discarded</summary>
          <ul className="mt-2 space-y-1">
            {discarded.map((s) => (
              <li key={s.id} className="flex items-center gap-2 px-2 text-muted">
                <span className="min-w-0 flex-1 line-through">{s.title}</span>
                <Button size="sm" variant="ghost" onClick={() => void undo([s.id])} disabled={off} aria-label={`Bring back: ${s.title}`}><IconUndo className="h-4 w-4" />Bring back</Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function AddForm({ people, initial, busy, onCancel, onSave }: { people: Who[]; initial: { title: string; quote: string }; busy: boolean; onCancel: () => void; onSave: (x: { title: string; quote: string | null; assigneeId: string | null; due: string | null }) => void }) {
  const [title, setTitle] = useState(initial.title);
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  return (
    <form className="mt-3 rounded-lg border border-line p-3" data-testid="meeting-suggest-form" onSubmit={(e) => { e.preventDefault(); if (title.trim()) onSave({ title: title.trim(), quote: initial.quote || null, assigneeId: owner || null, due: due || null }); }}>
      <label className="block text-[12px] text-muted">Task
        <Input autoFocus className="mt-1 h-9 text-[13px]" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing" data-testid="meeting-suggest-form-title" />
      </label>
      {initial.quote && <blockquote className="mt-2 border-l-2 border-line pl-2 text-[12.5px] text-muted">“{initial.quote.slice(0, 400)}”</blockquote>}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Select aria-label="Owner" className="h-8 text-[12.5px]" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">No owner</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Input type="date" aria-label="Due date" className="h-8 text-[12.5px]" value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" loading={busy} disabled={!title.trim()} data-testid="meeting-suggest-form-save">Create task</Button>
      </div>
    </form>
  );
}
