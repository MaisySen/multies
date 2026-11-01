/**
 * R110 Ask (/app/tools/ask, Tools feature ask_r110): ask a question across the workspace; the AI answers only from
 * items you can open, with the sources listed. Prompt library, history (private to you, searchable), save an answer
 * to a doc, and change cards the AI proposes that change nothing until you click Apply.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorMessage } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { IconChatQuote, IconClose, IconHistory, IconSparkle } from "@/web/components/ui/icon";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { useConfig } from "@/web/lib/queries";
import { LoadFailure } from "@/web/components/load-error-t1g";

type SourceType = "mail" | "tasks" | "docs" | "contacts" | "deals" | "files" | "chat" | "notes";
interface Source { n: number; type: SourceType; id: string; title: string; subtitle: string; url: string; cited: boolean }
interface ChangeCard { id: string; kind: "task_status" | "deal_stage" | "task_create"; status: "pending" | "applied" | "dismissed"; label: string; detail: string; targetUrl: string | null }
export interface AskMessage { id: string; question: string; answer: string; status: "answered" | "no_sources" | "limit" | "restricted"; sources: Source[]; cards: ChangeCard[]; createdAt: string }
interface Usage { used: number; cap: number; left: number; reached: boolean }
interface Prompt { id: string; title: string; text: string }
interface State { available: boolean; reason?: string; usage?: Usage; prompts?: { builtIn: Prompt[]; mine: Prompt[] } }
interface ThreadRow { id: string; title: string; updatedAt: string }

export const ASK_NOTE = "AI answers can be wrong. Check the sources.";
export const TYPE_LABEL: Record<SourceType, string> = { mail: "Email", tasks: "Task", docs: "Doc", contacts: "Contact", deals: "Deal", files: "File", chat: "Chat", notes: "Note" };
const ring = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

/** Splits an answer into text and [n] citations that link to their source. */
export function answerParts(answer: string, sources: Source[]): ({ text: string } | { source: Source })[] {
  const out: ({ text: string } | { source: Source })[] = [];
  for (const piece of answer.split(/(\[\d+\])/)) {
    const m = /^\[(\d+)\]$/.exec(piece);
    const s = m ? sources.find((x) => x.n === Number(m[1])) : undefined;
    if (s) out.push({ source: s });
    else if (piece && !m) out.push({ text: piece });
  }
  return out;
}

export function usageLine(u?: Usage): string {
  if (!u) return "";
  if (u.reached) return "Daily limit reached, try again tomorrow.";
  return `${u.left} of ${u.cap} questions left today`;
}

function Answer({ m, onSaved }: { m: AskMessage; onSaved: (docId: string) => void }) {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const projects = useQuery({ queryKey: ["projects-list-ask"], enabled: m.cards.some((c) => c.kind === "task_create" && c.status === "pending"),
    queryFn: async () => (await api.get<{ projects: { id: string; name: string }[] }>("/projects")).projects });
  const decide = useMutation({
    mutationFn: ({ id, how }: { id: string; how: "apply" | "dismiss" }) => api.post(`/ask/cards/${encodeURIComponent(id)}/${how}`, how === "apply" ? { projectId: projectId || projects.data?.[0]?.id } : {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["ask-thread"] }),
  });
  // A saved doc is open to the whole workspace: when the answer used items some people cannot open, the server answers
  // 409 private_sources and the person decides in a confirm that says so plainly (verifier v13, privacy).
  const [privateAsk, setPrivateAsk] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (share: boolean) => api.post<{ docId: string }>(`/ask/messages/${encodeURIComponent(m.id)}/doc`, share ? { share: true } : {}),
    onSuccess: (r) => { setPrivateAsk(null); onSaved(r.docId); },
    onError: (e) => { if (e instanceof ApiError && e.code === "private_sources") setPrivateAsk(e.message); },
  });
  const cited = m.sources.filter((s) => s.cited);
  const listed = cited.length ? cited : m.sources;
  return (
    <Card className="space-y-3 p-4 sm:p-5" data-testid="ask-answer" data-status={m.status}>
      {m.status === "restricted" ? (
        <p className="text-[14px] text-muted" data-testid="ask-restricted">{m.answer}</p>
      ) : (
        <p className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-fg" data-testid="ask-answer-text">
          {answerParts(m.answer, m.sources).map((p, i) => "text" in p ? <Fragment key={i}>{p.text}</Fragment> : (
            <Link key={i} to={p.source.url} className={`mx-0.5 inline-flex min-w-5 items-center justify-center rounded bg-brand/10 px-1 text-[12px] font-semibold text-brand-hover no-underline hover:bg-brand/20 ${ring}`}
              aria-label={`Source ${p.source.n}: ${p.source.title}`} data-testid="ask-cite">{p.source.n}</Link>
          ))}
        </p>
      )}
      {m.status === "answered" && listed.length > 0 && (
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Sources</h3>
          <ol className="mt-1.5 space-y-1" data-testid="ask-sources">
            {listed.map((s) => (
              <li key={`${s.type}:${s.id}`}>
                <Link to={s.url} className={`flex min-h-10 items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-hover ${ring}`} data-testid="ask-source">
                  <span className="w-5 shrink-0 text-center text-[12px] font-semibold text-subtle">{s.n}</span>
                  <Badge>{TYPE_LABEL[s.type] ?? s.type}</Badge>
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">{s.title}</span>
                  {s.subtitle && s.subtitle !== TYPE_LABEL[s.type] && <span className="hidden min-w-0 max-w-[40%] truncate text-xs text-subtle sm:block">{s.subtitle}</span>}
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
      {m.cards.length > 0 && (
        <div className="space-y-2" data-testid="ask-cards">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Suggested changes</h3>
          {m.cards.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-elevated px-3 py-2.5" data-testid="ask-card" data-state={c.status}>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-fg">{c.label}</p>
                {c.detail && <p className="truncate text-xs text-muted">{c.targetUrl ? <Link to={c.targetUrl} className="hover:underline">{c.detail}</Link> : c.detail}</p>}
              </div>
              {c.status === "pending" ? (
                <div className="flex items-center gap-2">
                  {c.kind === "task_create" && (
                    <Select aria-label="Project for the new task" value={projectId || projects.data?.[0]?.id || ""} onChange={(e) => setProjectId(e.target.value)} className="max-w-[11rem]" data-testid="ask-card-project">
                      {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => decide.mutate({ id: c.id, how: "dismiss" })} disabled={decide.isPending} data-testid="ask-card-dismiss">Dismiss</Button>
                  <Button size="sm" onClick={() => decide.mutate({ id: c.id, how: "apply" })} disabled={decide.isPending || (c.kind === "task_create" && !projects.data?.length)} data-testid="ask-card-apply">Apply</Button>
                </div>
              ) : (
                <Badge tone={c.status === "applied" ? "ok" : "neutral"}>{c.status === "applied" ? "Applied" : "Dismissed"}</Badge>
              )}
            </div>
          ))}
          {decide.isError && <p role="alert" className="text-xs text-danger" data-testid="ask-card-error">{errorMessage(decide.error)}</p>}
          <p className="text-xs text-subtle">Nothing changes until you click Apply.</p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <p className="text-xs text-subtle" data-testid="ask-note">{ASK_NOTE}</p>
        {m.status === "answered" && (
          <Button size="sm" variant="secondary" onClick={() => save.mutate(false)} disabled={save.isPending || save.isSuccess} data-testid="ask-save-doc">
            {save.isSuccess ? "Saved to a doc" : save.isPending ? "Saving" : "Save to a doc"}
          </Button>
        )}
      </div>
      <ConfirmDialog open={!!privateAsk} onClose={() => setPrivateAsk(null)} onConfirm={() => save.mutate(true)} busy={save.isPending}
        title="Share this answer with everyone?" description={privateAsk ?? undefined} confirmLabel="Save for everyone" tone="primary" />
      {save.isError && !privateAsk && !(save.error instanceof ApiError && save.error.code === "private_sources") && <p role="alert" className="text-xs text-danger">{errorMessage(save.error)}</p>}
    </Card>
  );
}

function History({ q, setQ, rows, loading, active, onOpen, onNew, onDelete }: {
  q: string; setQ: (v: string) => void; rows: ThreadRow[]; loading: boolean; active: string | null; onOpen: (id: string) => void; onNew: () => void; onDelete: (id: string) => void;
}) {
  return (
    <div className="space-y-2" data-testid="ask-history">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-fg">History</h2>
        <Button size="sm" variant="secondary" onClick={onNew} data-testid="ask-new">New question</Button>
      </div>
      <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your questions" aria-label="Search your questions" data-testid="ask-history-search" />
      {loading ? <Skeleton className="h-24 rounded-lg" /> : rows.length === 0 ? (
        <p className="px-1 py-3 text-xs text-subtle" data-testid="ask-history-empty">{q ? "No questions match." : "Your questions show here. Only you can see them."}</p>
      ) : (
        <ul className="max-h-[60vh] space-y-0.5 overflow-y-auto">
          {rows.map((t) => (
            <li key={t.id} className={`group flex items-center rounded-lg ${t.id === active ? "bg-hover" : "hover:bg-hover"}`}>
              <button type="button" onClick={() => onOpen(t.id)} className={`min-h-10 min-w-0 flex-1 truncate rounded-lg px-2.5 py-2 text-left text-[13px] text-fg ${ring}`} aria-current={t.id === active ? "true" : undefined} data-testid="ask-history-item">{t.title}</button>
              <button type="button" onClick={() => onDelete(t.id)} className={`mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-md text-subtle hover:text-fg ${ring}`} aria-label={`Delete “${t.title}”`}><IconClose className="h-3.5 w-3.5" aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AskPage() {
  const config = useConfig();
  if (config.data && !config.data.askR110) return <ToolsFrame entryKey="ask-workspace" title="Ask your workspace" description="Not switched on here." usage={false}><EmptyState title="Page not found" body="Ask is not switched on for this workspace." /></ToolsFrame>;
  return <AskInner />;
}

function AskInner() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["ask-state"], queryFn: () => api.get<State>("/ask/state") });
  const threadId = params.get("thread");
  const thread = useQuery({ queryKey: ["ask-thread", threadId], enabled: !!threadId, queryFn: () => api.get<{ thread: { id: string; title: string }; messages: AskMessage[] }>(`/ask/threads/${encodeURIComponent(threadId!)}`) });
  const [hq, setHq] = useState("");
  const threads = useQuery({ queryKey: ["ask-threads", hq], queryFn: () => api.get<{ threads: ThreadRow[] }>(`/ask/threads${hq.trim() ? `?q=${encodeURIComponent(hq.trim())}` : ""}`) });
  const [question, setQuestion] = useState(() => params.get("q") ?? "");
  // The command menu opens this page with ?q= (also while it is already open): take the words into the box.
  const typedQ = params.get("q");
  useEffect(() => { if (typedQ) setQuestion(typedQ); }, [typedQ]);
  const [notice, setNotice] = useState<{ kind: "limit" | "saved"; docId?: string } | null>(null);
  const [sheet, setSheet] = useState(false);
  const historyBtn = useRef<HTMLButtonElement>(null);
  /** Close the history sheet and give focus back to the History button (verifier v13 low: Esc dropped focus to the page). */
  const closeSheet = () => { setSheet(false); requestAnimationFrame(() => historyBtn.current?.focus()); };
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, [threadId]);
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") closeSheet(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);

  const ask = useMutation({
    mutationFn: (q: string) => api.post<{ thread: { id: string }; message: AskMessage; usage: Usage }>("/ask", { question: q, threadId: threadId ?? undefined }),
    onSuccess: (r) => {
      qc.setQueryData(["ask-state"], (s: State | undefined) => (s ? { ...s, usage: r.usage } : s));
      if (r.message.status === "limit") { setNotice({ kind: "limit" }); return; }
      setQuestion("");
      setNotice(null);
      if (r.thread.id !== threadId) setParams({ thread: r.thread.id }, { replace: !threadId });
      void qc.invalidateQueries({ queryKey: ["ask-thread", r.thread.id] });
      void qc.invalidateQueries({ queryKey: ["ask-threads"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/ask/threads/${encodeURIComponent(id)}`),
    onSuccess: (_r, id) => { if (id === threadId) setParams({}); void qc.invalidateQueries({ queryKey: ["ask-threads"] }); },
  });
  const savePrompt = useMutation({ mutationFn: (text: string) => api.post("/ask/prompts", { text }), onSuccess: () => void qc.invalidateQueries({ queryKey: ["ask-state"] }) });
  const dropPrompt = useMutation({ mutationFn: (id: string) => api.del(`/ask/prompts/${encodeURIComponent(id)}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["ask-state"] }) });

  const submit = () => { const q = question.trim(); if (q.length >= 3 && !ask.isPending) ask.mutate(q); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } };
  const usage = state.data?.usage;
  const messages = thread.data?.messages ?? [];
  const prompts = useMemo(() => [...(state.data?.prompts?.mine ?? []).map((p) => ({ ...p, mine: true })), ...(state.data?.prompts?.builtIn ?? []).map((p) => ({ ...p, mine: false }))], [state.data]);
  const newQuestion = () => { setParams({}); setQuestion(""); setNotice(null); setSheet(false); };
  const openThread = (id: string) => { setParams({ thread: id }); setNotice(null); setSheet(false); };
  const history = <History q={hq} setQ={setHq} rows={threads.data?.threads ?? []} loading={threads.isPending} active={threadId} onOpen={openThread} onNew={newQuestion} onDelete={(id) => remove.mutate(id)} />;

  const frame = (children: React.ReactNode) => (
    <ToolsFrame entryKey="ask-workspace" title="Ask your workspace" description="Answers from your mail, docs, tasks, contacts, deals, files and chat, with the sources. Only items you can open are used." usage={false} testId="ask-page" wide>
      {children}
    </ToolsFrame>
  );
  if (state.isPending) return frame(<div className="space-y-3"><Skeleton className="h-28 rounded-xl" /><Skeleton className="h-40 rounded-xl" /></div>);
  if (state.isError) return frame(<LoadFailure block error={state.error} onRetry={() => state.refetch()} />);
  if (!state.data?.available) return frame(<EmptyState icon={<IconChatQuote className="h-6 w-6" />} title="Ask is not available here" body={state.data?.reason ?? "AI is not available right now. Try again later."} />);

  return frame(
    <div className="2xl:grid 2xl:grid-cols-[minmax(0,1fr)_260px] 2xl:gap-5">
      <div className="min-w-0 space-y-4">
        <div className="flex items-center justify-between gap-2 2xl:hidden">
          <span className="text-xs text-subtle sm:hidden" data-testid="ask-usage-phone">{usageLine(usage)}</span>
          <Button ref={historyBtn} size="sm" variant="secondary" onClick={() => setSheet(true)} aria-haspopup="dialog" data-testid="ask-history-open"><IconHistory className="mr-1.5 h-4 w-4" aria-hidden />History</Button>
        </div>

        {messages.length === 0 && !threadId && !ask.isPending && (
          <Card className="p-5" data-testid="ask-empty">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand"><IconSparkle className="h-5 w-5" aria-hidden /></span>
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold text-fg">Ask anything about your work</h2>
                <p className="mt-1 text-[13.5px] text-muted">Ask in plain words. The answer lists the items it used, and only items you can open are ever read. You can ask it to change a task or a deal: it suggests the change and nothing happens until you click Apply.</p>
              </div>
            </div>
          </Card>
        )}
        {threadId && thread.isPending && <Skeleton className="h-40 rounded-xl" />}
        {thread.isError && <EmptyState title="That conversation could not open" body={errorMessage(thread.error)} action={<Button onClick={newQuestion}>New question</Button>} />}

        <div className="space-y-4" aria-live="polite" data-testid="ask-thread">
          {messages.map((m) => (
            <div key={m.id} className="space-y-2">
              <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-elevated px-3.5 py-2 text-[14px] text-fg" data-testid="ask-question">{m.question}</p>
              <Answer m={m} onSaved={(docId) => setNotice({ kind: "saved", docId })} />
            </div>
          ))}
          {ask.isPending && (
            <div className="space-y-2" data-testid="ask-loading">
              <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-elevated px-3.5 py-2 text-[14px] text-fg">{ask.variables}</p>
              <Card className="space-y-2 p-4"><p className="text-xs text-subtle">Reading the items you can open</p><Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-3/4" /></Card>
            </div>
          )}
        </div>

        {notice?.kind === "limit" && (
          <Card role="status" className="p-4 text-[14px] text-fg" data-testid="ask-limit">Daily limit reached, try again tomorrow. <span className="text-muted">Search still works for everything you can open.</span></Card>
        )}
        {notice?.kind === "saved" && notice.docId && (
          <p role="status" className="text-[13px] text-muted" data-testid="ask-saved">Saved to a doc. <Link to={`/app/docs/${encodeURIComponent(notice.docId)}`} className="font-medium text-brand-hover hover:underline">Open the doc</Link></p>
        )}
        {ask.isError && (
          <p role="alert" className="text-[13px] text-danger" data-testid="ask-error">{ask.error instanceof ApiError && ask.error.status === 403 ? ask.error.message : errorMessage(ask.error, "The answer failed. Try again in a moment.")}</p>
        )}

        <Card className="space-y-2.5 p-3 sm:p-4">
          <label htmlFor="ask-box" className="sr-only">Your question</label>
          <Textarea id="ask-box" ref={box} rows={2} value={question} maxLength={1000} onChange={(e) => setQuestion(e.target.value)} onKeyDown={onKey}
            placeholder={threadId ? "Ask a follow up question" : "For example: what did the client say about the launch date?"} data-testid="ask-box" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="hidden text-xs text-subtle sm:inline" data-testid="ask-usage">{usageLine(usage)}</span>
            <span className="flex-1" />
            {question.trim().length >= 3 && !prompts.some((p) => p.text === question.trim()) && (
              <Button size="sm" variant="ghost" onClick={() => savePrompt.mutate(question.trim())} disabled={savePrompt.isPending} data-testid="ask-save-prompt">Save as a prompt</Button>
            )}
            <Button onClick={submit} disabled={question.trim().length < 3 || ask.isPending || !!usage?.reached} data-testid="ask-submit">{ask.isPending ? "Asking" : "Ask"}</Button>
          </div>
          {savePrompt.isError && <p role="alert" className="text-xs text-danger">{errorMessage(savePrompt.error)}</p>}
        </Card>

        {prompts.length > 0 && (
          <div data-testid="ask-prompts">
            <h2 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle">Prompts</h2>
            <div className="flex flex-wrap gap-1.5">
              {prompts.map((p) => (
                <span key={p.id} className="inline-flex items-center rounded-full border border-line bg-surface">
                  <button type="button" onClick={() => { setQuestion(p.text); box.current?.focus(); }} className={`min-h-9 rounded-full px-3 text-[13px] text-fg hover:bg-hover ${ring}`} data-testid="ask-prompt">{p.title}</button>
                  {p.mine && <button type="button" onClick={() => dropPrompt.mutate(p.id)} className={`mr-1 grid h-7 w-7 place-items-center rounded-full text-subtle hover:text-fg ${ring}`} aria-label={`Remove the prompt “${p.title}”`}><IconClose className="h-3 w-3" aria-hidden /></button>}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {!sheet && <aside className="hidden 2xl:block" aria-label="Your questions">{history}</aside>}
      {sheet && (
        <div className="fixed inset-0 z-50 2xl:hidden" role="dialog" aria-modal="true" aria-label="History">
          <button type="button" className="absolute inset-0 bg-black/40" aria-label="Close history" onClick={closeSheet} />
          <div className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-surface p-4 shadow-pop sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[360px] sm:rounded-none sm:rounded-l-2xl">
            <div className="mb-2 flex justify-end"><button type="button" onClick={closeSheet} className={`grid h-10 w-10 place-items-center rounded-lg text-subtle hover:text-fg ${ring}`} aria-label="Close history"><IconClose className="h-4 w-4" aria-hidden /></button></div>
            {history}
          </div>
        </div>
      )}
    </div>,
  );
}
