/**
 * R104 (LANG_R104): the app's language at run time. English ships in the main bundle as the source and fallback;
 * Nepali and Hindi load as their own small chunks the first time they are picked. While LANG_R104 is off nothing here
 * changes the page: every t() reads the English source, the html lang stays as served and no chunk loads.
 */
import { useSyncExternalStore } from "react";
import { en } from "./en";
import { isUiLang, LANG_LOCALE, slugKey, translate, uiLangOf, type Bundle, type UiLang, type Vars } from "./core";

export { LANG_NAMES, UI_LANGS, uiLangOf, isUiLang, type UiLang } from "./core";

const STORE = "multies.lang";
// R104B: English grows as pages load (each area's English rides in its own page chunk; see w2/en-*.ts).
const english: Record<string, Bundle[string]> = { ...en };
const bundles: Partial<Record<UiLang, Bundle>> = { en: english };
// R104B: each language is the first wave plus the second (w2), two small chunks fetched together.
const loaders: Record<Exclude<UiLang, "en">, () => Promise<Bundle>> = {
  ne: () => Promise.all([import("./ne"), import("./w2/ne")]).then(([a, b]) => ({ ...a.ne, ...b.ne })),
  hi: () => Promise.all([import("./hi"), import("./w2/hi")]).then(([a, b]) => ({ ...a.hi, ...b.hi })),
};
/** R104B: adds a page area's English (called once by each w2/en-*.ts module when its page loads). */
export function addEnglish(b: Bundle) { Object.assign(english, b); }
let enabled = false;
let lang: UiLang = "en";
let servedLang: string | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const missing = new Set<string>();
const DEV = (() => { try { return !!import.meta.env?.DEV; } catch { return false; } })();

/** Whether LANG_R104 is on for this page (set from /api/config before anything is translated). */
export const i18nEnabled = () => enabled;
export const currentLang = (): UiLang => lang;
/** The locale dates and numbers use while a language other than English is showing; null keeps today's formats. */
export const uiLocale = (): string | null => (enabled && lang !== "en" ? LANG_LOCALE[lang] : null);
/** A message as written in a language's bundle (plural forms joined), or null when that language has none yet. */
export function rawMessage(l: UiLang, key: string): string | null {
  const m = bundles[l]?.[key];
  return m === undefined ? null : typeof m === "string" ? m : Object.values(m).join(" / ");
}
/** Every English key with its text (the admin wording list). */
export const englishEntries = (): [string, string][] => Object.entries(english).map(([k, m]) => [k, typeof m === "string" ? m : m.other]);

/** Keys English itself does not have, seen on this page (the dev check; tests read it too). */
export const missingKeys = () => [...missing];

/** The language this browser picked before (the footer switch or the picker), if any. */
export function storedLang(): UiLang | null {
  try { const v = localStorage.getItem(STORE); return isUiLang(v) ? v : null; } catch { return null; }
}
/** The browser's own language when it is one we have (public pages before anyone picks). */
export function browserLang(): UiLang {
  try { for (const l of navigator.languages ?? [navigator.language]) { const u = uiLangOf(l); if (u !== "en") return u; if (/^en\b/i.test(l)) return "en"; } } catch { /* no navigator */ }
  return "en";
}

function applyDocument() {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  if (servedLang === null) servedLang = html.getAttribute("lang") ?? "en-AU";
  html.setAttribute("lang", lang === "en" ? servedLang : lang);
  html.setAttribute("dir", "ltr");
}

/** Turns languages on or off for this page. Off puts English and the served html lang back. */
export function enableI18n(on: boolean) {
  if (on === enabled) return;
  enabled = on;
  if (!on && lang !== "en") { lang = "en"; applyDocument(); emit(); }
}

/** Loads a language's chunk ahead of time (no change on screen). */
export function preloadLang(next: UiLang): Promise<void> {
  if (next === "en" || bundles[next]) return Promise.resolve();
  return loaders[next]().then((b) => { bundles[next] = b; }, () => undefined);
}

/**
 * Shows the page in a language, without a reload. remember keeps the choice on this browser for the public pages and
 * the next visit's first paint. A chunk that cannot load leaves English on screen.
 */
export async function setLanguage(next: UiLang, opts: { remember?: boolean } = {}): Promise<UiLang> {
  if (!enabled) return lang;
  if (opts.remember) { try { localStorage.setItem(STORE, next); } catch { /* private mode */ } }
  if (next !== "en" && !bundles[next]) await preloadLang(next);
  const resolved: UiLang = next === "en" || bundles[next] ? next : "en";
  if (resolved !== lang) { lang = resolved; applyDocument(); emit(); }
  else applyDocument();
  return lang;
}

/** The text for a key in the language on screen (English while off or not yet translated). */
export function t(key: string, vars?: Vars, fallback?: string): string {
  const r = translate(key, vars, enabled ? lang : "en", bundles, fallback);
  if (r.missing && fallback === undefined && !missing.has(key)) {
    missing.add(key);
    if (DEV) console.warn(`[i18n] missing English key "${key}"`);
  }
  return r.text;
}

/** The same as t, under the name the extracted pages import (t is a common local name in them). */
export const tr = t;

/** A label that comes from data (the rail, breadcrumbs, settings pages): its key under a namespace, else as written. */
export function tl(ns: string, label: string): string {
  if (!enabled || lang === "en") return label;
  return translate(`${ns}.${slugKey(label)}`, undefined, lang, bundles, label).text;
}

function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
const snapshot = () => (enabled ? lang : "en");

/** The language on screen; a component that calls this shows again when the language changes. */
export function useLang(): UiLang { return useSyncExternalStore(subscribe, snapshot, () => "en" as UiLang); }
/** t, tied to the language: the component shows again in the new language as soon as it is picked. */
export function useT(): typeof t { useLang(); return t; }
