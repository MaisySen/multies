/**
 * R116 Translate and read aloud (TRANSLATE_R116): the mail reading pane's bar and body, a chat message's inline
 * translation, a doc's Translate and Read aloud menu with its side by side view, and the settings row. This whole
 * module is loaded on demand (lang-tools-r116-lazy.tsx), so the app's first load does not grow.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import DOMPurify from "dompurify";
import type { Editor } from "@tiptap/react";
import { toast } from "sonner";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { Dialog } from "@/web/components/ui/dialog";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { IconCircleStop, IconGlobe, IconPause, IconPlay, IconVolume } from "@/web/components/ui/icon";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { HtmlBody, MAIL_PURIFY, TextBody } from "@/web/pages/app/mail/html-body";
import {
  htmlText, pauseReading, resumeReading, setReadingRate, speechSupported, startReading, stopReading, translatePieces, useR116Prefs, useSpeech,
} from "@/web/lib/translate-r116";
import {
  detectLanguage, htmlPieces, joinHtml, joinPieces, languageLabel, R116_LANGUAGES, textPieces, translateOffer, type R116Language,
} from "@/shared/translate-r116";
import { tr } from "@/web/i18n"; // POL4 (HQ MB-356)
import "@/web/i18n/w2/en-docs"; // R104B

const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const LANGS = Object.entries(R116_LANGUAGES) as [R116Language, string][];
const RATES = [0.75, 1, 1.25, 1.5, 2];

/** The target language picker. Remembers the last choice for this person. */
function LangSelect({ value, onChange, className, label }: { value: R116Language; onChange: (v: R116Language) => void; className?: string; label?: string }) {
  const id = useId();
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <label htmlFor={id} className="shrink-0 text-[13px] text-muted">{label ?? tr("docs.into")}</label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as R116Language)} className="h-9 w-auto min-w-32 text-[13px]" aria-label={tr("translate.translate_into")}>
        {LANGS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
      </Select>
    </span>
  );
}

/** Play, pause, stop and speed for the reading `owner` started. Stops when the page changes or this closes. */
export function ReadAloudBar({ owner, className }: { owner: string; className?: string }) {
  const s = useSpeech();
  const { pathname } = useLocation();
  const speedId = useId();
  useEffect(() => () => stopReading(owner), [owner, pathname]);
  if (s.owner !== owner) return null;
  const live = s.status !== "idle";
  return (
    <div role="region" aria-label={tr("docs.read_aloud")} data-testid="read-aloud-bar" className={cn("flex flex-wrap items-center gap-2 rounded-lg border border-line bg-fill/60 px-2.5 py-2 text-[13px]", className)}>
      {live && (
        <>
          <span className="inline-flex items-center gap-1.5 font-medium text-fg" aria-live="polite"><IconVolume className="h-4 w-4 text-muted" aria-hidden />{s.status === "paused" ? tr("docs.paused") : tr("docs.reading_aloud")}</span>
          {s.status === "paused"
            ? <Button variant="outline" size="sm" onClick={resumeReading} aria-label={tr("docs.resume_reading")}><IconPlay className="h-4 w-4" aria-hidden />{tr("notifications.resume")}</Button>
            : <Button variant="outline" size="sm" onClick={pauseReading} aria-label={tr("docs.pause_reading")}><IconPause className="h-4 w-4" aria-hidden />{tr("notifications.pause")}</Button>}
          <Button variant="outline" size="sm" onClick={() => stopReading(owner)} aria-label={tr("docs.stop_reading")}><IconCircleStop className="h-4 w-4" aria-hidden />{tr("docs.stop")}</Button>
          <span className="inline-flex items-center gap-1.5">
            <label htmlFor={speedId} className="text-muted">{tr("docs.speed")}</label>
            <Select id={speedId} value={s.rate} onChange={(e) => setReadingRate(Number(e.target.value))} className="h-9 w-auto min-w-20 text-[13px]">
              {RATES.map((r) => <option key={r} value={r}>{r}x</option>)}
            </Select>
          </span>
        </>
      )}
      {s.note && (
        <p className="flex w-full items-center justify-between gap-2 text-muted" role="status" data-testid="read-aloud-note">
          <span>{s.note}</span>
          {!live && <Button variant="ghost" size="sm" onClick={() => stopReading(owner)}>{tr("docs.dismiss")}</Button>}
        </p>
      )}
    </div>
  );
}

type Translated = { body: string; source: R116Language | null; target: R116Language };

/** Shared translate state for one item: run, retry, progress, and a plain message for every failure. */
function useTranslate(key: string) {
  const [prefs, setPrefs] = useR116Prefs();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [result, setResult] = useState<Translated | null>(null);
  const [showing, setShowing] = useState(false);
  const run = async (make: () => { pieces: ReturnType<typeof textPieces>; join: (m: Map<string, string>) => string }, target: R116Language = prefs.target) => {
    setError(null); setInfo(null); setBusy("Translating");
    try {
      const { pieces, join } = make();
      const r = await translatePieces(key, pieces, target, (done, total) => setBusy(total > 1 ? `Translating, ${done} of ${total}` : "Translating"));
      if (r.same) { setInfo(`This is already in ${languageLabel(target)}.`); setShowing(false); return; }
      setResult({ body: join(r.map), source: r.source, target });
      setShowing(true);
    } catch (e) {
      setError(errorMessage(e, "The translation failed. Try again in a moment."));
    } finally { setBusy(null); }
  };
  const reset = () => { setResult(null); setShowing(false); setError(null); setInfo(null); };
  return { prefs, setPrefs, busy, error, info, result, showing, setShowing, run, setError, reset };
}

function StatusLine({ error, info, busy, onRetry }: { error: string | null; info: string | null; busy: string | null; onRetry: () => void }) {
  if (error) return (
    <div role="alert" data-testid="translate-error" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">
      <span>{error}</span><Button variant="outline" size="sm" onClick={onRetry}>{tr("common.retry")}</Button>
    </div>
  );
  return <p className="text-[13px] text-muted empty:hidden" aria-live="polite" data-testid="translate-status">{busy ? `${busy}…` : info ?? ""}</p>;
}

function TranslatedNote({ r, showing, onToggle, testid }: { r: Translated; showing: boolean; onToggle: () => void; testid: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted" data-testid={testid}>
      <IconGlobe className="h-3.5 w-3.5" aria-hidden />
      <span>{showing ? `Translated from ${languageLabel(r.source)} into ${languageLabel(r.target)}` : tr("docs.showing_the_original")}</span>
      <button type="button" onClick={onToggle} className={cn("inline-flex items-center font-medium text-brand-hover underline-offset-2 hover:underline max-sm:min-h-11", focus)}>
        {showing ? tr("docs.show_original") : tr("docs.show_translation")}
      </button>
    </p>
  );
}

// ------------------------------------------------------------------ mail

/** The mail reading pane's body with Translate and Read aloud above it. Flag off, webmail renders the body as before. */
export function MailBodyR116({ id, html, text }: { id: string; html?: string | null; text: string }) {
  const t = useTranslate(`mail:${id}`);
  const owner = `mail:${id}`;
  const clean = useMemo(() => (html ? String(DOMPurify.sanitize(html, MAIL_PURIFY)) : ""), [html]);
  const plain = useMemo(() => (html ? htmlText(clean) : text), [html, clean, text]);
  const detected = useMemo(() => detectLanguage(plain), [plain]);
  // QUAL1 (audit row 29): no "Translate to English" on mail that is already in English.
  const choice = translateOffer(detected, t.prefs.target, !!t.result);
  const offer = t.prefs.autoOffer && choice.note;
  const go = (target?: R116Language) => t.run(() => (html
    ? (() => { const pieces = htmlPieces(clean); return { pieces, join: (m) => joinHtml(pieces, m) }; })()
    : (() => { const pieces = textPieces(text); return { pieces, join: (m) => joinPieces(pieces, m) }; })()), target);
  const shown = t.result && t.showing ? t.result.body : null;
  const readText = shown ? (html ? htmlText(shown) : shown) : plain;
  return (
    <div className="space-y-2" data-testid="mail-lang-r116">
      <div className="flex flex-wrap items-center gap-2">
        {offer && <span className="text-[13px] text-muted" data-testid="translate-offer">{tr("docs.this_looks_like")} {languageLabel(detected)}.</span>}
        {choice.button && (
          <Button variant="outline" size="sm" loading={!!t.busy} onClick={() => void go()} data-testid="translate-mail">
            {!t.busy && <IconGlobe className="h-4 w-4" aria-hidden />}{t.result ? tr("docs.translate_again") : `Translate to ${languageLabel(t.prefs.target)}`}
          </Button>
        )}
        <LangSelect value={t.prefs.target} label={choice.button ? undefined : tr("translate.translate_into")}
          onChange={(v) => { t.setPrefs({ target: v }); if (t.result || (choice.pickTranslates && v !== detected)) void go(v); }} />
        {speechSupported() && (
          <Button variant="outline" size="sm" onClick={() => void startReading(owner, readText)} data-testid="read-mail">
            <IconVolume className="h-4 w-4" aria-hidden />{tr("docs.read_aloud")}
          </Button>
        )}
      </div>
      <StatusLine error={t.error} info={t.info} busy={t.busy} onRetry={() => void go()} />
      <ReadAloudBar owner={owner} />
      {t.result && <TranslatedNote r={t.result} showing={t.showing} onToggle={() => t.setShowing((s) => !s)} testid="mail-translated-note" />}
      {html ? <HtmlBody html={shown ?? html} /> : <TextBody text={shown ?? text} />}
    </div>
  );
}

// ------------------------------------------------------------------ chat

/**
 * Under one chat message: the translation ("Translated from Nepali" with Show original) after Translate, the read aloud
 * controls after Read aloud, and a small Translate offer when the message is in another language.
 */
export function ChatLangR116({ id, text, request, onHandled }: { id: string; text: string; request: { kind: "translate" | "read"; n: number } | null; onHandled: () => void }) {
  const t = useTranslate(`chat:${id}:${text.length}`);
  const owner = `chat:${id}`;
  const detected = useMemo(() => (text.trim().length >= 8 ? detectLanguage(text) : null), [text]);
  const go = () => t.run(() => { const pieces = textPieces(text); return { pieces, join: (m) => joinPieces(pieces, m) }; });
  useEffect(() => {
    if (!request) return;
    if (request.kind === "translate") { if (t.result) t.setShowing(true); else void go(); }
    else void startReading(owner, t.result && t.showing ? t.result.body : text);
    onHandled();
  }, [request?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const offer = t.prefs.autoOffer && !t.result && !t.busy && !t.error && !!detected && detected !== t.prefs.target;
  return (
    <>
      {offer && (
        <button type="button" onClick={() => void go()} data-testid="chat-translate-offer"
          className={cn("mt-0.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-hover underline-offset-2 hover:underline max-sm:min-h-11", focus)}>
          <IconGlobe className="h-3.5 w-3.5" aria-hidden />{tr("docs.translate_to")} {languageLabel(t.prefs.target)}
        </button>
      )}
      {(t.busy || t.error || t.info) && <div className="mt-1"><StatusLine error={t.error} info={t.info} busy={t.busy} onRetry={() => void go()} /></div>}
      {t.result && (
        <div className="mt-1 space-y-0.5" data-testid="chat-translation">
          {t.showing && <p className="whitespace-pre-wrap break-words rounded-md border-l-2 border-brand/50 pl-2 text-[14px] leading-relaxed text-fg">{t.result.body}</p>}
          <TranslatedNote r={t.result} showing={t.showing} onToggle={() => t.setShowing((s) => !s)} testid="chat-translated-note" />
        </div>
      )}
      <ReadAloudBar owner={owner} className="mt-1" />
    </>
  );
}

// ------------------------------------------------------------------ docs

/** A doc's Translate and Read aloud menu (the toolbar), with the side by side view. Never changes the doc itself. */
export function DocLangR116({ editor, title }: { editor: Editor | null; title: string }) {
  const navigate = useNavigate();
  const owner = "doc";
  const [open, setOpen] = useState<null | { scope: "doc" | "selection"; text: string }>(null);
  const t = useTranslate(`doc:${title}:${open?.scope ?? ""}:${open?.text.length ?? 0}`);
  const [saving, setSaving] = useState(false);
  const docText = () => editor?.getText({ blockSeparator: "\n\n" }).trim() ?? "";
  const selText = () => { if (!editor) return ""; const { from, to } = editor.state.selection; return from === to ? "" : editor.state.doc.textBetween(from, to, "\n\n").trim(); };
  const openTranslate = (scope: "doc" | "selection") => {
    const text = scope === "doc" ? docText() : selText();
    if (!text) { toast.message(scope === "doc" ? tr("docs.this_doc_has_no_text_to_translate_yet") : tr("docs.select_some_text_in_the_doc_first")); return; }
    t.reset();
    setOpen({ scope, text });
  };
  const go = (target?: R116Language) => { const text = open?.text ?? ""; return t.run(() => { const pieces = textPieces(text); return { pieces, join: (m) => joinPieces(pieces, m) }; }, target); };
  useEffect(() => { if (open && !t.result && !t.busy) void go(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const read = (scope: "doc" | "selection") => {
    const text = scope === "doc" ? docText() : selText();
    if (!text) { toast.message(scope === "doc" ? tr("docs.this_doc_has_no_text_to_read_yet") : tr("docs.select_some_text_in_the_doc_first")); return; }
    void startReading(owner, text);
  };
  const saveCopy = async () => {
    if (!t.result) return;
    setSaving(true);
    try {
      const r = await api.post<{ doc: { id: string } }>("/docs", { title: `${title.trim() || "Untitled"} (${languageLabel(t.result.target)})`.slice(0, 200), text: t.result.body });
      toast.success(tr("docs.saved_the_translation_as_a_new_doc"));
      setOpen(null);
      navigate(`/app/docs/${r.doc.id}`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  const copy = async () => {
    if (!t.result) return;
    try { await navigator.clipboard.writeText(t.result.body); toast.success(tr("docs.copied")); } catch { toast.error(tr("docs.couldn_t_copy_on_this_device")); }
  };
  return (
    <>
      <Menu sheet label={tr("docs.translate_or_read_aloud")} trigger={
        <button type="button" data-testid="doc-lang-button" title={tr("docs.translate_or_read_aloud")}
          className={cn("inline-flex shrink-0 items-center justify-center gap-1 rounded px-1.5 py-1 hover:bg-hover hover:text-fg max-sm:h-11 max-sm:min-w-11 max-sm:rounded-lg", focus)}>
          <IconGlobe className="h-4 w-4 max-sm:h-5 max-sm:w-5" aria-hidden /><span className="max-2xl:hidden">{tr("docs.translate")}</span>
        </button>
      }>
        <MenuItem onSelect={() => openTranslate("doc")} icon={<IconGlobe className="h-4 w-4" />}>{tr("docs.translate_doc")}</MenuItem>
        <MenuItem onSelect={() => openTranslate("selection")} icon={<IconGlobe className="h-4 w-4" />}>{tr("docs.translate_selection")}</MenuItem>
        {speechSupported() && <MenuItem onSelect={() => read("doc")} icon={<IconVolume className="h-4 w-4" />}>{tr("docs.read_doc_aloud")}</MenuItem>}
        {speechSupported() && <MenuItem onSelect={() => read("selection")} icon={<IconVolume className="h-4 w-4" />}>{tr("docs.read_selection_aloud")}</MenuItem>}
      </Menu>
      <div className="fixed inset-x-2 bottom-[max(12px,env(safe-area-inset-bottom))] z-40 mx-auto max-w-xl empty:hidden sm:bottom-4"><ReadAloudBar owner={owner} className="bg-elevated shadow-pop" /></div>
      <Dialog open={!!open} onClose={() => { setOpen(null); stopReading("doc-translation"); }} title={open?.scope === "selection" ? tr("docs.translate_selection") : tr("docs.translate_doc")}
        description={tr("docs.your_doc_stays_as_it_is_save_the_translation_as")} className="sm:max-w-4xl"
        footer={(
          <div className="flex w-full flex-wrap justify-end gap-2">
            {t.result && speechSupported() && <Button variant="ghost" onClick={() => void startReading("doc-translation", t.result!.body)}><IconVolume className="h-4 w-4" aria-hidden />{tr("docs.read_aloud")}</Button>}
            {t.result && <Button variant="secondary" onClick={() => void copy()}>{tr("docs.copy")}</Button>}
            {t.result && <Button onClick={() => void saveCopy()} loading={saving} data-testid="doc-save-copy">{tr("docs.save_as_copy")}</Button>}
          </div>
        )}>
        <div className="space-y-3" data-testid="doc-translate-dialog">
          <div className="flex flex-wrap items-center gap-2">
            <LangSelect value={t.prefs.target} onChange={(v) => { t.setPrefs({ target: v }); void go(v); }} />
            {t.result && <Button variant="outline" size="sm" onClick={() => void go()} loading={!!t.busy}>{tr("docs.translate_again")}</Button>}
          </div>
          <StatusLine error={t.error} info={t.info} busy={t.busy} onRetry={() => void go()} />
          <ReadAloudBar owner="doc-translation" />
          <div className="grid gap-3 sm:grid-cols-2">
            <section aria-label={tr("docs.original")} className="min-w-0 rounded-lg border border-line p-3">
              <h3 className="mb-1.5 text-[12.5px] font-semibold text-muted">{tr("docs.original")}{t.result?.source ? `, ${languageLabel(t.result.source)}` : ""}</h3>
              <div className="max-h-[40dvh] overflow-y-auto whitespace-pre-wrap break-words text-[14px] leading-relaxed text-fg sm:max-h-[55dvh]">{open?.text}</div>
            </section>
            <section aria-label={tr("docs.translation")} className="min-w-0 rounded-lg border border-line p-3" data-testid="doc-translation">
              <h3 className="mb-1.5 text-[12.5px] font-semibold text-muted">{languageLabel(t.result?.target ?? t.prefs.target)}</h3>
              <div className="max-h-[40dvh] overflow-y-auto whitespace-pre-wrap break-words text-[14px] leading-relaxed text-fg sm:max-h-[55dvh]">{t.result?.body ?? (t.busy ? "" : tr("docs.no_translation_yet"))}</div>
            </section>
          </div>
        </div>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ settings

/** Settings row: default language and whether to offer translation for messages in another language. */
export function TranslateSettingsR116() {
  const [prefs, setPrefs] = useR116Prefs();
  const id = useId();
  return (
    <div className="grid max-w-xl gap-4" data-testid="translate-settings">
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-lang`} className="text-sm font-medium text-fg">{tr("translate.translate_into")}</label>
        <Select id={`${id}-lang`} value={prefs.target} onChange={(e) => { setPrefs({ target: e.target.value as R116Language }); toast.success(tr("translate.saved")); }} className="max-w-xs">
          {LANGS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </Select>
        <p className="text-[13px] text-muted">{tr("translate.translate_into_hint")}</p>
      </div>
      <label className="flex min-h-11 items-start gap-3 text-sm text-fg">
        <input type="checkbox" checked={prefs.autoOffer} onChange={(e) => { setPrefs({ autoOffer: e.target.checked }); toast.success(tr("translate.saved")); }} className={cn("mt-0.5 h-5 w-5 shrink-0 accent-brand", focus)} />
        <span>{tr("translate.offer")}<span className="block text-[13px] text-muted">{tr("translate.offer_hint")}</span></span>
      </label>
      <p className="text-[13px] text-muted">{tr("translate.uses_ai_note")}</p>
    </div>
  );
}
