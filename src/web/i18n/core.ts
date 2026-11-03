/**
 * R104 (LANG_R104): the message format behind the app's languages. Small and pure (no React, no DOM) so it is unit
 * tested on its own. English is the source and the fallback: a key a language has not translated yet reads in English,
 * and a key nobody wrote reads as plain words made from the key, never as the raw key.
 *
 * A message is a string with {name} placeholders, or plural forms picked with Intl.PluralRules for the {count} value:
 *   "inbox.count": { one: "{count} message", other: "{count} messages" }
 */
export const UI_LANGS = ["en", "ne", "hi"] as const;
export type UiLang = (typeof UI_LANGS)[number];
export type Plural = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
export type Msg = string | Plural;
export type Bundle = Readonly<Record<string, Msg>>;
export type Vars = Readonly<Record<string, string | number | null | undefined>>;

/** The name each language is shown with, in its own script (the picker never translates these). */
export const LANG_NAMES: Record<UiLang, string> = { en: "English", ne: "नेपाली", hi: "हिन्दी" };
/** The locale dates and numbers use for each language (Nepali and Hindi follow their own default digits). */
export const LANG_LOCALE: Record<UiLang, string> = { en: "en-AU", ne: "ne-NP", hi: "hi-IN" };

export const isUiLang = (v: unknown): v is UiLang => typeof v === "string" && (UI_LANGS as readonly string[]).includes(v);

/** The app language for a saved locale or a browser language ("hi-IN" is Hindi, "en-AU" or "fr" is English). */
export function uiLangOf(tag: string | null | undefined): UiLang {
  const base = String(tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return isUiLang(base) ? base : "en";
}

const pluralCache = new Map<string, Intl.PluralRules>();
function pluralRules(lang: UiLang): Intl.PluralRules {
  let r = pluralCache.get(lang);
  if (!r) { try { r = new Intl.PluralRules(LANG_LOCALE[lang]); } catch { r = new Intl.PluralRules("en"); } pluralCache.set(lang, r); }
  return r;
}
const numCache = new Map<string, Intl.NumberFormat>();
function numberFormat(lang: UiLang): Intl.NumberFormat {
  let f = numCache.get(lang);
  if (!f) { try { f = new Intl.NumberFormat(LANG_LOCALE[lang]); } catch { f = new Intl.NumberFormat("en"); } numCache.set(lang, f); }
  return f;
}

/** A placeholder value as the language writes it: numbers through Intl in Nepali and Hindi, as given in English. */
function show(v: string | number | null | undefined, lang: UiLang): string {
  if (v == null) return "";
  if (typeof v === "number") return lang === "en" || !Number.isFinite(v) ? String(v) : numberFormat(lang).format(v);
  return v;
}

/** Fills one message for a language: picks the plural form for {count}, then fills {placeholders}. */
export function formatMessage(msg: Msg, vars: Vars | undefined, lang: UiLang): string {
  let text: string;
  if (typeof msg === "string") text = msg;
  else {
    const n = Number(vars?.count ?? 0);
    const cat = pluralRules(lang).select(Number.isFinite(n) ? n : 0) as keyof Plural;
    text = (n === 0 && msg.zero) || msg[cat] || msg.other;
  }
  if (!vars || text.indexOf("{") < 0) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? show(vars[name], lang) : all));
}

/** Plain words from a key nobody wrote ("inbox.empty_title" reads "Empty title"), so a raw key never shows. */
export function wordsFromKey(key: string): string {
  const last = key.split(".").pop() ?? key;
  const s = last.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

export interface Lookup { text: string; lang: UiLang; missing: boolean }

/**
 * The text for a key: the language's own message, else English, else the caller's English default, else words
 * from the key. missing is true when English itself has no such key (the dev check reports those).
 */
export function translate(key: string, vars: Vars | undefined, lang: UiLang, bundles: Partial<Record<UiLang, Bundle>>, fallback?: string): Lookup {
  const own = lang === "en" ? undefined : bundles[lang]?.[key];
  if (own !== undefined) return { text: formatMessage(own, vars, lang), lang, missing: false };
  const en = bundles.en?.[key];
  if (en !== undefined) return { text: formatMessage(en, vars, "en"), lang: "en", missing: false };
  const text = fallback !== undefined ? formatMessage(fallback, vars, "en") : wordsFromKey(key);
  return { text, lang: "en", missing: true };
}

/** "Plan and billing" reads as the key "plan_and_billing" (used for labels that come from data, like the rail). */
export const slugKey = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48).replace(/_+$/, "");

/** The placeholders a message uses, for the check that a translation keeps them all. */
export function placeholders(msg: Msg): string[] {
  const all = typeof msg === "string" ? [msg] : Object.values(msg).filter((v): v is string => typeof v === "string");
  const out = new Set<string>();
  for (const s of all) for (const m of s.matchAll(/\{(\w+)\}/g)) out.add(m[1]);
  return [...out].sort();
}
