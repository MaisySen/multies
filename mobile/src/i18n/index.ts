/**
 * MPAR2: the app's words in English, Nepali and Hindi, reusing the web app's wording (src/web/i18n in the web repo).
 * English is the source and the fallback; a key a language has not translated reads in English and a key nobody wrote
 * reads as plain words, never as the raw key. The language is chosen once when the app starts: the person's choice in
 * Settings, else the phone's language (expo-localization, in the store builds), else English. Changing it restarts
 * the app (lib/app-reload.ts) so every screen, including words built when a file loads, follows at once.
 */
import { LANG_LOCALE, LANG_NAMES, UI_LANGS, isUiLang, slugKey, translate, uiLangOf, type Bundle, type UiLang, type Vars } from "./core";
import { en } from "./en";
import { ne } from "./ne";
import { hi } from "./hi";
import { mpar3En, mpar3Hi, mpar3Ne } from "./mpar3";
import { mfix1En, mfix1Hi, mfix1Ne } from "./mfix1";
import { readPref, writePref } from "@/lib/startup-prefs";

export { LANG_LOCALE, LANG_NAMES, UI_LANGS, isUiLang, uiLangOf, type UiLang };
export type LangChoice = "system" | UiLang;

const PREF = "language";
export const bundles: Record<UiLang, Bundle> = { en: { ...en, ...mpar3En, ...mfix1En }, ne: { ...ne, ...mpar3Ne, ...mfix1Ne }, hi: { ...hi, ...mpar3Hi, ...mfix1Hi } };

/** The phone's own language as an app language ("ne-NP" is Nepali, "fr-FR" is English). Fails soft to English. */
export function deviceLang(): UiLang {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const L = require("expo-localization") as { getLocales?: () => { languageTag?: string; languageCode?: string | null }[] };
    for (const loc of L?.getLocales?.() ?? []) {
      const l = uiLangOf(loc.languageCode ?? loc.languageTag);
      if (l !== "en" || /^en/i.test(String(loc.languageCode ?? loc.languageTag ?? ""))) return l;
    }
  } catch { /* module missing: English */ }
  return "en";
}

export function savedChoice(): LangChoice {
  const v = readPref(PREF);
  return isUiLang(v) ? v : "system";
}

/** The language for a choice: a picked language, or the phone's when following the phone. */
export const resolveLang = (choice: LangChoice, device: () => UiLang = deviceLang): UiLang => (choice === "system" ? device() : choice);

// Tests read English unless a test picks a language (setLangForTests).
let lang: UiLang = process.env.NODE_ENV === "test" ? "en" : resolveLang(savedChoice());

/** The language on screen now. */
export const currentLang = () => lang;
/** The locale dates and numbers use for the language on screen. */
export const currentLocale = () => LANG_LOCALE[lang];
/** True for Nepali and Hindi (Devanagari script), which need taller lines. */
export const isDevanagari = (l: UiLang = lang) => l === "ne" || l === "hi";

/** Saves a choice; the caller restarts the app so it applies everywhere. Returns the language it resolves to. */
export function saveLanguageChoice(choice: LangChoice): UiLang {
  writePref(PREF, choice === "system" ? null : choice);
  return resolveLang(choice);
}

/** Tests: switch the language without restarting. */
export function setLangForTests(l: UiLang) { lang = l; }

/** The text for a key in the language on screen. */
export function tr(key: string, vars?: Vars): string {
  return translate(key, vars, lang, bundles).text;
}

/** A label that comes from data (menu sections, server step titles): its web key from the English words, else as is. */
export function tl(ns: string, label: string): string {
  if (lang === "en" || !label) return label;
  return translate(`${ns}.${slugKey(label)}`, undefined, lang, bundles, label).text;
}
