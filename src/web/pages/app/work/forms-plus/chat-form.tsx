/**
 * R93: the public form one question at a time (chat style), used on /f/<slug> when the form is set to Chat and inside
 * the website bubble (/f/<slug>/embed). Branches come from the form's Show if logic; {{name}} fills in earlier answers
 * and hidden values from the link. The rating scale is shared with the classic page.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Input, Textarea } from "@/web/components/ui/input";
import { IconArrowLeft, IconSend } from "@/web/components/ui/icon";
import { Honeypot, useShield } from "@/web/lib/use-shield";
import { answerText, fieldError, MULTI_SEPARATOR, ratingRange, visibleFieldIds, type LogicField } from "@/shared/form-logic";
import { fillVariables, pickHidden } from "@/shared/forms-plus";
import { td7Body } from "../forms-td7/public-td7"; // TD7: password access and resume token ride along

export type PublicField = LogicField & { placeholder?: string };
export interface PublicFormData { name: string; description: string; workspace: string; fields: PublicField[]; plus?: { mode: "classic" | "chat"; hiddenFields: string[]; bubbleLabel: string; review: boolean; deadline: string | null } }

/** A 0 to 10 or 1 to 5 scale as a row of buttons (a radio group for screen readers). */
export function RatingInput({ field, value, onChange, labelledBy }: { field: PublicField; value: string; onChange: (v: string) => void; labelledBy?: string }) {
  const { min, max } = ratingRange(field);
  const n = max - min + 1;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = Math.min(n - 1, Math.max(0, i + d));
    onChange(String(min + j));
    refs.current[j]?.focus();
  };
  return (
    <div>
      <div role="radiogroup" aria-labelledby={labelledBy} className={`grid gap-1.5 ${n > 6 ? "grid-cols-6 sm:grid-cols-11" : "grid-cols-5"}`} data-testid={`rating-${field.id}`}>
        {Array.from({ length: n }, (_, i) => {
          const v = String(min + i);
          const on = value === v;
          return (
            <button key={v} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={on} tabIndex={on || (!value && i === 0) ? 0 : -1}
              onClick={() => onChange(v)} onKeyDown={(e) => onKey(e, i)}
              className={`h-11 rounded-lg border text-[15px] font-medium tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${on ? "border-brand bg-brand text-brand-fg" : "border-line bg-surface hover:bg-hover"}`}>
              {v}
            </button>
          );
        })}
      </div>
      {(field.lowLabel || field.highLabel) && <div className="mt-1.5 flex justify-between text-[12px] text-muted"><span>{field.lowLabel}</span><span>{field.highLabel}</span></div>}
    </div>
  );
}

type Answers = Record<string, string | string[]>;

export function ChatForm({ slug, form, embed }: { slug: string; form: PublicFormData; embed?: boolean }) {
  const hidden = useMemo(() => pickHidden(form.plus?.hiddenFields ?? [], typeof window === "undefined" ? null : new URLSearchParams(window.location.search)), [form.plus?.hiddenFields]);
  const [answers, setAnswers] = useState<Answers>({});
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [draft, setDraft] = useState<string | string[]>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const opened = useRef(Date.now());
  const shield = useShield("fplus", "/pub/forms/shield");
  const fields = form.fields.map((f) => ({ ...f, required: !!f.required }));
  const shown = visibleFieldIds(fields, answers);
  const visible = fields.filter((f) => shown.has(f.id));
  // Answers to questions a branch now hides no longer count.
  const kept = confirmed.filter((id) => shown.has(id));
  const current = visible.find((f) => !kept.includes(f.id)) ?? null;
  const step = current ? visible.indexOf(current) + 1 : visible.length;
  const textOf = (f: PublicField) => answerText(f, answers[f.id]);
  const fill = (s: string) => fillVariables(s, Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? v.join(MULTI_SEPARATOR) : v])), hidden);

  useEffect(() => { setDraft(current && answers[current.id] !== undefined ? answers[current.id] : current?.type === "multiselect" ? [] : ""); setError(null); }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); inputRef.current?.focus({ preventScroll: true }); }, [current?.id, done]);

  const takeAnswer = (value: string | string[] = draft) => {
    if (!current) return;
    const text = answerText(current, value);
    const err = fieldError(current, text);
    if (err) { setError(err); inputRef.current?.focus(); return; }
    setAnswers((a) => ({ ...a, [current.id]: value }));
    setConfirmed((c) => [...c.filter((id) => shown.has(id) && id !== current.id), current.id]);
  };
  const back = () => {
    const last = kept[kept.length - 1];
    if (!last) return;
    setConfirmed(kept.slice(0, -1));
  };
  const send = async () => {
    setBusy(true);
    try {
      const sendable = Object.fromEntries(Object.entries(answers).filter(([k]) => shown.has(k)));
      const r = await shield.send((s) => api.post<{ ok: boolean; message: string }>(`/public/forms/${slug}`, { ...td7Body(slug), answers: sendable, hidden, website: shield.honeypot.value, elapsedMs: Date.now() - opened.current, shield: s }));
      setDone(r.message);
    } catch (e) {
      if (e instanceof ApiError && e.fields && Object.keys(e.fields).length) {
        const first = Object.keys(e.fields)[0];
        setConfirmed((c) => c.filter((id) => id !== first));
        setError(e.fields[first]);
      } else showError(e as Error);
    } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); takeAnswer(); }
  };

  const bubbleQ = "max-w-[85%] rounded-2xl rounded-bl-md bg-fill px-3.5 py-2.5 text-[14.5px] leading-snug";
  const bubbleA = "ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand px-3.5 py-2.5 text-[14.5px] leading-snug text-brand-fg";
  const qId = current ? `q-${current.id}` : undefined;
  return (
    <div className={`mx-auto flex h-dvh w-full max-w-lg flex-col bg-bg ${embed ? "" : "sm:border-x sm:border-line"}`} data-testid="chat-form">
      <header className={`border-b border-line px-4 py-3 ${embed ? "pr-14" : ""}`}>
        <p className="text-[12px] text-muted">{form.workspace}</p>
        <h1 className="text-[16px] font-semibold tracking-tight">{form.name}</h1>
        {!done && <p className="mt-0.5 text-[12px] text-muted" aria-live="polite">{current ? `Question ${step} of ${visible.length}` : "Ready to send"}</p>}
      </header>
      <div role="log" aria-live="polite" aria-label="Conversation" className="flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
        {form.description && <div className={bubbleQ}><span className="whitespace-pre-wrap">{fill(form.description)}</span></div>}
        {visible.filter((f) => kept.includes(f.id)).map((f) => (
          <div key={f.id} className="space-y-2.5">
            <div className={bubbleQ}>{fill(f.label)}</div>
            <div className={bubbleA}>{textOf(f) || "Skipped"}</div>
          </div>
        ))}
        {current && !done && <div className={`${bubbleQ} animate-pop-in motion-reduce:animate-none`} id={qId}>{fill(current.label)}{!current.required && <span className="text-muted"> (optional)</span>}</div>}
        {!current && !done && <div className={bubbleQ}>That's everything. Send your answers?</div>}
        {done && <div className={bubbleQ} data-testid="form-done">{done}</div>}
        <div ref={endRef} />
      </div>
      {!done && (
        <div className="border-t border-line bg-surface px-3 pb-[max(env(safe-area-inset-bottom),12px)] pt-3">
          <Honeypot {...shield.honeypot} />
          {error && <p role="alert" className="mb-2 text-[12.5px] text-bad">{error}</p>}
          {current ? (
            <div className="space-y-2">
              {current.type === "rating" ? (
                <RatingInput field={current} value={typeof draft === "string" ? draft : ""} labelledBy={qId} onChange={(v) => { setDraft(v); takeAnswer(v); }} />
              ) : current.type === "select" ? (
                <div className="flex flex-wrap gap-2" role="group" aria-labelledby={qId}>
                  {current.options?.map((o) => <Button key={o} variant={draft === o ? "primary" : "outline"} size="sm" onClick={() => { setDraft(o); takeAnswer(o); }}>{o}</Button>)}
                </div>
              ) : current.type === "multiselect" ? (
                <fieldset aria-labelledby={qId} className="flex flex-wrap gap-2">
                  {current.options?.map((o) => {
                    const picked = Array.isArray(draft) ? draft : [];
                    return (
                      <label key={o} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-[14px] ${picked.includes(o) ? "border-brand bg-brand/10" : "border-line"}`}>
                        <input type="checkbox" className="h-4 w-4 accent-brand" checked={picked.includes(o)} onChange={(e) => setDraft(e.target.checked ? [...picked, o] : picked.filter((p) => p !== o))} />{o}
                      </label>
                    );
                  })}
                </fieldset>
              ) : current.type === "textarea" ? (
                <Textarea ref={inputRef} aria-labelledby={qId} value={String(draft)} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} placeholder={current.placeholder ?? "Type your answer"} className="min-h-20" />
              ) : (
                <Input ref={inputRef} aria-labelledby={qId} value={String(draft)} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} placeholder={current.placeholder ?? "Type your answer"}
                  type={current.type === "email" ? "email" : current.type === "number" ? "number" : current.type === "date" ? "date" : current.type === "phone" ? "tel" : "text"}
                  inputMode={current.type === "phone" ? "tel" : current.type === "number" ? "decimal" : undefined} autoComplete={current.type === "email" ? "email" : current.type === "phone" ? "tel" : undefined} />
              )}
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={back} disabled={!kept.length} aria-label="Back to the last question"><IconArrowLeft className="h-4 w-4" />Back</Button>
                {!current.required && <Button variant="ghost" size="sm" onClick={() => { setDraft(""); takeAnswer(""); }}>Skip</Button>}
                {current.type !== "rating" && current.type !== "select" && <Button size="sm" className="ml-auto" onClick={() => takeAnswer()} data-testid="chat-next">Next<IconSend className="h-3.5 w-3.5" /></Button>}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={back} aria-label="Back to the last question"><IconArrowLeft className="h-4 w-4" />Back</Button>
              <Button className="ml-auto" loading={busy} onClick={() => void send()} data-testid="chat-send">Send answers</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
