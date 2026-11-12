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
import { IconCheck, IconCheckCircle, IconClose, IconListPlus, IconMailPlus, IconQuote, IconSparkle, IconUndo } from "@/web/components/ui/icon";
import { api, ApiError, errorMessage } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Card, Skeleton } from "@/web/components/ui/misc";
import { attachToNewEmail } from "@/web/lib/compose-files";
import { LoadErrorInline, LoadFailure } from "@/web/components/load-error-t1g";
import { tr } from "@/web/i18n"; // R104B
import { AI_KEY_FIX_PATH } from "@/shared/ai-connect-ai2"; // QUAL1
import "@/web/i18n/w2/en-meetings"; // R104B

interface Who { type: "member" | "agent"; id: string; name: string }
export interface Suggestion {
  id: string; source: "recording" | "notes" | "pasted" | "manual"; title: string; quote: string | null; due: string | null;
  status: "open" | "accepted" | "discarded"; assignee: Who | null; task: { id: string; ref: string; title: string } | null; canUndo: boolean;
}
interface View {
  suggestions: Suggestion[]; attendees: Who[]; people: Who[];
  sources: { recordings: { id: string; startedAt: string; status: string }[]; notes: boolean };
  ai: { state: "ready" | "off" | "no_key" | "key_problem"; message: string | null };
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
  // QUAL1 (audit row 12): a failed Suggest stays on the card in plain words with Retry, not only in a toast.
  const [suggestErr, setSuggestErr] = useState<string | null>(null);
  // After a run that found nothing, say so plainly (until the source or text changes).
  const [noneFound, setNoneFound] = useState(false);
  useEffect(() => { setNoneFound(false); }, [src, pasted]);
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
      <Card className="mt-4 p-5" data-testid="meeting-suggest-error">
        <h2 className="mb-2 text-[13px] font-semibold">{tr("meetings.suggested_action_items")}</h2>
        <LoadFailure error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }

  const open = v.suggestions.filter((s) => s.status === "open");
  const accepted = v.suggestions.filter((s) => s.status === "accepted");
  const discarded = v.suggestions.filter((s) => s.status === "discarded");
  const aiReady = v.ai.state === "ready";

  const doSuggest = () => { setSuggestErr(null); return run("suggest", async () => {
    const body = source === "notes" ? { source: "notes" } : source === "pasted" ? { source: "pasted", text: pasted } : { source: "recording", recordingId: source.slice(4) };
    let r: { suggestions: Suggestion[]; added: number; fallback?: { message: string } };
    try { r = await api.post<{ suggestions: Suggestion[]; added: number; fallback?: { message: string } }>(`/meeting-td3/${meetingId}/suggest`, body); }
    catch (e) { setSuggestErr(errorMessage(e)); if (e instanceof ApiError && e.code.startsWith("ai_")) void refresh(); return; }
    setList(r.suggestions);
    setNoneFound(!r.added);
    toast.success(r.added ? `${r.added} ${r.added === 1 ? "suggestion" : "suggestions"} ready to review` : tr("meetings.no_action_items_found_in_this_text"));
    // QUAL1 second review: built-in AI stood in for the workspace's key; say so now, not after a reload.
    if (r.fallback) { toast.message(r.fallback.message); void refresh(); }
  }); };
  const accept = (s: Suggestion) => run(s.id, async () => {
    const r = await api.post<{ suggestion: Suggestion | null }>(`/meeting-td3/${meetingId}/suggestions/${s.id}/accept`, {});
    await refresh();
    if (r.suggestion?.task) toast.success(tr("meetings.task_created"), { action: { label: tr("meetings.undo"), onClick: () => void undo([s.id]) } });
  });
  const discard = (s: Suggestion) => run(s.id, async () => {
    await api.post(`/meeting-td3/${meetingId}/suggestions/${s.id}/discard`, {});
    await refresh();
    toast(tr("meetings.suggestion_discarded"), { action: { label: tr("meetings.undo"), onClick: () => void undo([s.id]) } });
  });
  const undo = async (ids: string[]) => {
    try { const r = await api.post<{ suggestions: Suggestion[]; undone: string[] }>(`/meeting-td3/${meetingId}/undo`, { ids }); setList(r.suggestions); toast.success(r.undone.length === 1 ? tr("meetings.undone") : tr("meetings.length_undone", { length: r.undone.length })); }
    catch (e) { showError(e as Error); }
  };
  const acceptAll = () => run("all", async () => {
    const r = await api.post<{ accepted: string[]; suggestions: Suggestion[] }>(`/meeting-td3/${meetingId}/accept-all`, {});
    setList(r.suggestions);
    toast.success(`${r.accepted.length} ${r.accepted.length === 1 ? "task" : "tasks"} created`, { action: { label: tr("meetings.undo"), onClick: () => void undo(r.accepted) } });
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
        <h2 className="text-[13px] font-semibold">{tr("meetings.suggested_action_items")}</h2>
        <span className="text-[12px] text-subtle">{accepted.length ? tr("meetings.length_made_into_tasks", { length: accepted.length }) : ""}</span>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void followUp()} loading={busy === "email"} disabled={off} data-testid="meeting-follow-up">
          <IconMailPlus className="h-4 w-4" />{tr("meetings.follow_up_email")}
        </Button>
      </div>

      {off && <p role="status" className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-[12.5px]" data-testid="meeting-suggest-offline">{tr("meetings.you_re_offline_suggestions_and_tasks_will_work_a")}</p>}

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-[12px] text-muted">
          {tr("meetings.read_from")}
          <Select className="mt-1 h-9 w-full text-[13px]" value={source} onChange={(e) => { setSrc(e.target.value); setSelection(""); }} data-testid="meeting-suggest-source">
            {v.sources.recordings.map((r) => <option key={r.id} value={`rec:${r.id}`}>{tr("meetings.transcript_2")} {when(r.startedAt)}</option>)}
            {v.sources.notes && <option value="notes">{tr("meetings.meeting_notes")}</option>}
            <option value="pasted">{tr("meetings.pasted_text")}</option>
          </Select>
        </label>
        <Button size="sm" className="h-9" onClick={() => void doSuggest()} loading={busy === "suggest"} disabled={off || !(aiReady || v.ai.state === "key_problem") || (source === "pasted" && !pasted.trim())} data-testid="meeting-suggest-run">
          <IconSparkle className="h-4 w-4" />{open.length || accepted.length ? tr("meetings.suggest_again") : tr("meetings.suggest")}
        </Button>
        {source !== "pasted" && <Button size="sm" variant="ghost" className="h-9" onClick={() => setShowText((x) => !x)} aria-expanded={showText} data-testid="meeting-suggest-show-text">{showText ? tr("meetings.hide_text") : tr("meetings.show_text")}</Button>}
      </div>
      {/* QUAL1: a refused AI key shows its plain sentence even while built-in AI stands in, with the way to fix it. */}
      {suggestErr && (
        <div role="alert" data-testid="meeting-suggest-error" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">
          <span>{suggestErr}</span>
          <Button size="sm" variant="outline" onClick={() => void doSuggest()} loading={busy === "suggest"}>{tr("common.retry")}</Button>
        </div>
      )}
      {v.ai.message && <p className="mt-2 text-[12.5px] text-muted" data-testid="meeting-suggest-ai-note">{v.ai.message}{v.ai.state === "key_problem" || v.ai.state === "ready" ? <> <Link to={AI_KEY_FIX_PATH} className="font-medium text-brand-hover underline-offset-2 hover:underline">{tr("ai.fix_key")}</Link></> : null}</p>}

      {source === "pasted" && (
        <Textarea className="mt-3 min-h-[120px] text-[13px]" aria-label={tr("meetings.paste_the_transcript_or_notes")} placeholder={tr("meetings.paste_the_transcript_or_notes_from_another_tool")}
          value={pasted} onChange={(e) => setPasted(e.target.value)} onMouseUp={() => { const el = document.activeElement as HTMLTextAreaElement | null; if (el?.selectionEnd && el.selectionEnd > el.selectionStart) setSelection(el.value.slice(el.selectionStart, el.selectionEnd).replace(/\s+/g, " ").trim().slice(0, 2000)); }} data-testid="meeting-suggest-paste" />
      )}
      {showText && source !== "pasted" && (
        textQ.isPending ? <Skeleton className="mt-3 h-32" />
          : textQ.isError ? <LoadErrorInline className="mt-3" onRetry={() => textQ.refetch()} />
          : <pre ref={pane} tabIndex={0} aria-label="Meeting text. Select words, then make a task from them." onMouseUp={readSelection} onKeyUp={readSelection}
              className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-fill p-3 font-sans text-[13px] leading-relaxed focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand" data-testid="meeting-suggest-text">{textQ.data?.text || "Nothing here yet."}</pre>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={off || !selection} onClick={() => setAdding({ title: selection.slice(0, 300), quote: selection })} data-testid="meeting-suggest-from-selection">
          <IconQuote className="h-4 w-4" />{tr("meetings.make_task_from_selection")}
        </Button>
        <Button size="sm" variant="ghost" disabled={off} onClick={() => setAdding({ title: "", quote: "" })} data-testid="meeting-suggest-add"><IconListPlus className="h-4 w-4" />{tr("meetings.add_action_item")}</Button>
      </div>
      {adding && <AddForm people={v.people} initial={adding} busy={busy === "add"} onCancel={() => setAdding(null)} onSave={(x) => run("add", async () => {
        await api.post(`/meeting-td3/${meetingId}/suggestions`, { ...x, accept: true });
        setAdding(null); setSelection(""); await refresh(); toast.success(tr("meetings.task_created"));
      })} />}

      {!v.suggestions.length && (noneFound
        ? <p className="mt-4 text-[13px] text-muted" role="status" data-testid="meeting-suggest-none">{tr("meetings.no_action_items_found_in_this_text_try_another_s")}</p>
        : <p className="mt-4 text-[13px] text-muted" data-testid="meeting-suggest-empty">{tr("meetings.no_suggestions_yet_pick_what_to_read_from_and_pr")}</p>)}

      {open.length > 0 && (
        <ul className="mt-4 space-y-2" aria-label={tr("meetings.suggestions_to_review")}>
          {open.map((s) => (
            <li key={s.id} className="rounded-lg border border-line p-3 transition-colors duration-150 hover:bg-hover/40" data-testid="meeting-suggestion">
              <div className="flex flex-wrap items-start gap-2">
                <span className="min-w-0 flex-1 basis-full text-[13px] font-medium sm:basis-0">{s.title}</span>
                <span className="ml-auto flex shrink-0 gap-2">
                <Button size="sm" onClick={() => void accept(s)} loading={busy === s.id} disabled={off || (!!busy && busy !== s.id)} aria-label={tr("meetings.accept_title", { title: s.title })} data-testid="meeting-suggestion-accept"><IconCheck className="h-4 w-4" />{tr("meetings.accept")}</Button>
                <Button size="sm" variant="ghost" onClick={() => void discard(s)} disabled={off || !!busy} aria-label={tr("meetings.discard_title", { title: s.title })} data-testid="meeting-suggestion-discard"><IconClose className="h-4 w-4" />{tr("branding.discard")}</Button>
                </span>
              </div>
              {s.quote && <blockquote className="mt-1.5 border-l-2 border-line pl-2 text-[12.5px] text-muted" data-testid="meeting-suggestion-quote">“{s.quote}”</blockquote>}
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Select aria-label={tr("meetings.owner_for_title", { title: s.title })} className="h-8 text-[12.5px]" value={s.assignee?.id ?? ""} disabled={off} onChange={(e) => void edit(s, { assigneeId: e.target.value || null })}>
                  <option value="">{tr("meetings.no_owner")}</option>
                  {v.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Input type="date" aria-label={tr("meetings.due_date_for_title", { title: s.title })} className="h-8 text-[12.5px]" value={s.due ?? ""} disabled={off} onChange={(e) => void edit(s, { due: e.target.value || null })} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {open.length > 1 && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={() => void acceptAll()} loading={busy === "all"} disabled={off || !!busy} data-testid="meeting-suggest-accept-all">{tr("meetings.accept_all_length", { length: open.length })}</Button>
        </div>
      )}

      {accepted.length > 0 && (
        <ul className="mt-4 space-y-1" aria-label={tr("meetings.made_into_tasks")}>
          {accepted.map((s) => (
            <li key={s.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5" data-testid="meeting-suggestion-accepted">
              <IconCheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-good" />
              <div className="min-w-0 flex-1 text-[13px]">
                <span>{s.title}</span>
                {s.task && <Link to={`/app/tasks?view=list&task=${s.task.id}`} className="ml-2 text-[12px] text-brand-hover hover:underline">{s.task.ref || tr("meetings.open_task")}</Link>}
                {(s.assignee || s.due) && <div className="text-[12px] text-subtle">{[s.assignee?.name, s.due && `due ${dayLabel(s.due)}`].filter(Boolean).join(", ")}</div>}
              </div>
              {s.canUndo && <Button size="sm" variant="ghost" onClick={() => void undo([s.id])} disabled={off} aria-label={tr("meetings.undo_title", { title: s.title })} data-testid="meeting-suggestion-undo"><IconUndo className="h-4 w-4" />{tr("meetings.undo")}</Button>}
            </li>
          ))}
        </ul>
      )}
      {discarded.length > 0 && (
        <details className="mt-3 text-[13px]" data-testid="meeting-suggest-discarded">
          <summary className="cursor-pointer text-[12.5px] text-muted">{tr("meetings.length_discarded", { length: discarded.length })}</summary>
          <ul className="mt-2 space-y-1">
            {discarded.map((s) => (
              <li key={s.id} className="flex items-center gap-2 px-2 text-muted">
                <span className="min-w-0 flex-1 line-through">{s.title}</span>
                <Button size="sm" variant="ghost" onClick={() => void undo([s.id])} disabled={off} aria-label={tr("meetings.bring_back_title", { title: s.title })}><IconUndo className="h-4 w-4" />{tr("meetings.bring_back")}</Button>
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
      <label className="block text-[12px] text-muted">{tr("nav.task")}
        <Input autoFocus className="mt-1 h-9 text-[13px]" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder={tr("meetings.what_needs_doing")} data-testid="meeting-suggest-form-title" />
      </label>
      {initial.quote && <blockquote className="mt-2 border-l-2 border-line pl-2 text-[12.5px] text-muted">“{initial.quote.slice(0, 400)}”</blockquote>}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Select aria-label={tr("meetings.owner")} className="h-8 text-[12.5px]" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">{tr("meetings.no_owner")}</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Input type="date" aria-label={tr("taskgroup.due_date")} className="h-8 text-[12.5px]" value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{tr("common.cancel")}</Button>
        <Button type="submit" size="sm" loading={busy} disabled={!title.trim()} data-testid="meeting-suggest-form-save">{tr("meetings.create_task")}</Button>
      </div>
    </form>
  );
}
