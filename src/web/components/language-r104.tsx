/**
 * R104 (LANG_R104): Settings > Appearance, the app's language. A picker (English, नेपाली, हिन्दी) saved to the person's
 * own language (the same preference General's "Your language" sets) and applied at once, without a reload. Workspace
 * admins also get a short list to suggest a better wording for a translated string; suggestions are kept for review
 * in the workspace's activity log and never change the app on their own.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { qk, useMe } from "@/web/lib/queries";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { R116_LANGUAGES } from "@/shared/translate-r116";
import { englishEntries, LANG_NAMES, preloadLang, rawMessage, setLanguage, t, UI_LANGS, uiLangOf, useLang, type UiLang } from "@/web/i18n";

function Section({ title, description, children, testId }: { title: string; description?: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="@container/panel rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5" data-testid={testId}>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** The locale to save for a pick: English keeps an English locale the person already has ("en-GB" stays). */
export function localeForPick(pick: UiLang, saved: string | null | undefined): string {
  return pick === "en" ? (uiLangOf(saved) === "en" && saved ? saved : "en") : pick;
}

export function LanguagePanel() {
  const me = useMe();
  const qc = useQueryClient();
  const lang = useLang();
  const [busy, setBusy] = useState<UiLang | null>(null);
  const pick = async (next: UiLang) => {
    if (next === lang || busy) return;
    setBusy(next);
    try {
      await preloadLang(next);
      const saved = me.data?.user.locale ?? null;
      const locale = localeForPick(next, saved);
      if (locale !== saved) await api.patch("/account/preferences", { locale });
      await qc.invalidateQueries({ queryKey: qk.me });
      await setLanguage(next, { remember: true });
      toast.success(t("appearance.language_saved"));
    } catch (e) {
      showError(e as Error);
      setBusy(null);
    }
  };
  return (
    <Section title={t("appearance.language")} description={t("appearance.language_hint")} testId="language-r104">
      <div role="radiogroup" aria-label={t("appearance.language")} className="grid gap-2 @min-[420px]/panel:grid-cols-3" data-testid="language-picker">
        {UI_LANGS.map((l) => {
          const on = l === lang;
          return (
            <button key={l} type="button" role="radio" aria-checked={on} lang={l} disabled={!!busy && busy !== l} onClick={() => void pick(l)} data-testid={`language-${l}`}
              className={cn("flex min-h-11 flex-col items-start justify-center rounded-xl border px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                on ? "border-brand bg-brand-soft" : "border-line hover:bg-hover", busy === l && "opacity-70")}>
              <span className="text-[15px] font-medium leading-snug text-fg">{LANG_NAMES[l]}</span>
              {l !== "en" && <span className="text-[12.5px] leading-snug text-muted" lang="en">{R116_LANGUAGES[l]}</span>}
            </button>
          );
        })}
      </div>
      {lang !== "en" && <p className="mt-3 text-[12.5px] leading-relaxed text-muted" data-testid="language-draft-note">{t("appearance.language_draft_note")}</p>}
    </Section>
  );
}

interface Suggestion { id: string; key: string; lang: string; suggestion: string; current: string | null; english: string | null; by: string | null; at: string }

/** Admins: suggest a better wording for one string. Kept for review; nothing changes in the app by itself. */
export function WordingPanel() {
  const me = useMe();
  const qc = useQueryClient();
  const admin = me.data?.organization?.role === "owner" || me.data?.organization?.role === "admin";
  const [target, setTarget] = useState<Exclude<UiLang, "en">>("ne");
  const [find, setFind] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const loaded = useQuery({ queryKey: ["i18n-bundle", target], queryFn: () => preloadLang(target).then(() => true), staleTime: Infinity, enabled: admin });
  const list = useQuery({ queryKey: ["i18n-suggestions"], enabled: admin, queryFn: () => api.get<{ suggestions: Suggestion[] }>("/i18n/suggestions") });
  const ready = !!loaded.data; // the language's own file is in, so its current wording can be searched
  const entries = useMemo(() => englishEntries(), []);
  const matches = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (q.length < 2 || !ready) return [];
    return entries.filter(([k, en]) => en.toLowerCase().includes(q) || (rawMessage(target, k) ?? "").toLowerCase().includes(q)).slice(0, 8);
  }, [find, entries, target, ready]);
  if (!admin) return null;
  const english = key ? entries.find(([k]) => k === key)?.[1] ?? "" : "";
  const current = key ? rawMessage(target, key) : null;
  const send = async () => {
    if (!key || !text.trim()) return;
    setSending(true);
    try {
      await api.post("/i18n/suggestions", { key, lang: target, suggestion: text.trim(), current: current ?? undefined, english });
      toast.success(t("appearance.suggestion_sent"));
      setText(""); setKey(null); setFind("");
      await qc.invalidateQueries({ queryKey: ["i18n-suggestions"] });
    } catch (e) { showError(e as Error); } finally { setSending(false); }
  };
  const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-[14px] text-fg placeholder:text-subtle focus:border-brand focus:outline-none max-sm:min-h-11";
  return (
    <Section title={t("appearance.wording_title")} description={t("appearance.wording_hint")} testId="wording-r104">
      <div className="grid gap-3">
        <div role="radiogroup" aria-label={t("appearance.wording_language")} className="inline-flex w-full rounded-lg bg-fill p-0.5 sm:w-auto">
          {(["ne", "hi"] as const).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={target === l} lang={l} onClick={() => { setTarget(l); setKey(null); }}
              className={cn("min-h-11 flex-1 rounded-md px-4 text-[14px] sm:min-h-9", target === l ? "bg-surface font-medium text-fg shadow-[var(--shadow-e1)]" : "text-muted hover:text-fg")}>{LANG_NAMES[l]}</button>
          ))}
        </div>
        <label className="grid gap-1 text-[13px] font-medium text-fg">
          {t("appearance.wording_find")}
          <input className={field} value={find} onChange={(e) => { setFind(e.target.value); setKey(null); }} placeholder={t("appearance.wording_find_placeholder")} data-testid="wording-find" />
        </label>
        {!key && matches.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line" data-testid="wording-matches">
            {matches.map(([k, en]) => (
              <li key={k}>
                <button type="button" onClick={() => { setKey(k); setText(rawMessage(target, k) ?? ""); }} className="flex min-h-11 w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-hover">
                  <span className="text-[13.5px] text-fg" lang="en">{en}</span>
                  <span className="text-[12.5px] text-muted" lang={target}>{rawMessage(target, k) ?? t("appearance.wording_not_yet")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {!key && find.trim().length >= 2 && matches.length === 0 && <p className="text-[13px] text-muted">{t("appearance.wording_none")}</p>}
        {key && (
          <div className="grid gap-2 rounded-lg border border-line p-3" data-testid="wording-form">
            <p className="text-[12.5px] text-muted">{t("appearance.wording_english")}</p>
            <p className="text-[14px] text-fg" lang="en">{english}</p>
            <label className="grid gap-1 text-[13px] font-medium text-fg">
              {t("appearance.wording_yours")}
              <textarea className={cn(field, "min-h-[88px] leading-relaxed")} lang={target} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} data-testid="wording-text" />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void send()} loading={sending} disabled={!text.trim() || text.trim() === (current ?? "")} data-testid="wording-send">{t("appearance.wording_send")}</Button>
              <Button type="button" variant="secondary" onClick={() => setKey(null)}>{t("common.cancel")}</Button>
            </div>
          </div>
        )}
        <div>
          <h3 className="mb-1.5 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">{t("appearance.wording_recent")}</h3>
          {list.isPending ? <p className="text-[13px] text-muted">{t("appearance.wording_loading")}</p>
            : list.isError ? <p className="text-[13px] text-muted">{t("errors.couldnt_load_this")} <button type="button" className="min-h-11 font-medium text-brand-hover hover:underline" onClick={() => void list.refetch()}>{t("common.retry")}</button></p>
            : !list.data.suggestions.length ? <p className="text-[13px] text-muted" data-testid="wording-empty">{t("appearance.wording_empty")}</p>
            : (
              <ul className="divide-y divide-line" data-testid="wording-list">
                {list.data.suggestions.map((s) => (
                  <li key={s.id} className="py-2 text-[13px]">
                    <p className="text-fg" lang={s.lang}>{s.suggestion}</p>
                    <p className="text-muted"><span lang="en">{s.english ?? s.key}</span> · {LANG_NAMES[uiLangOf(s.lang)]}{s.by ? ` · ${s.by}` : ""}</p>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </Section>
  );
}
