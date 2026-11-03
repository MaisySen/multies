/**
 * R104 (LANG_R104): which language the page shows, decided from the two reads every page already makes. /api/config says
 * whether languages are on; /api/me (signed in) carries the person's saved language. Signed in: the saved language,
 * else the one picked on this browser, else English, so nobody's app changes without their own choice. Public pages and
 * sign in: the one picked on this browser (the footer switch), else the browser's own language.
 */
import { createElement, Fragment, type ReactNode } from "react";
import { browserLang, enableI18n, preloadLang, setLanguage, storedLang, uiLangOf, useLang, type UiLang } from "./index";

let on = false;
let saved: string | null | undefined; // undefined: not known (signed out or not read yet)

const inApp = () => typeof location !== "undefined" && location.pathname.startsWith("/app");

/** The language for this page from what is known so far. */
export function pickLanguage(o: { saved: string | null | undefined; stored: UiLang | null; browser: UiLang; inApp: boolean }): UiLang {
  if (o.saved) return uiLangOf(o.saved);
  if (o.stored) return o.stored;
  return o.inApp ? "en" : o.browser;
}

function apply() {
  enableI18n(on);
  if (!on) return;
  void setLanguage(pickLanguage({ saved, stored: storedLang(), browser: browserLang(), inApp: saved !== undefined || inApp() }));
}

/** From the /api/config answer. */
export function syncConfig(cfg: { langR104?: boolean } | null | undefined) { const next = !!cfg?.langR104; if (next !== on) { on = next; apply(); } }
/** From the /api/me answer (null when signed out). */
export function syncMe(me: { user?: { locale?: string | null } | null } | null | undefined) {
  const next = me?.user ? me.user.locale ?? null : undefined;
  if (next !== saved) { saved = next; apply(); }
}

/** Starts fetching the language this browser picked before, so it is ready when the config says languages are on. */
export function warmStoredLanguage() { const s = storedLang(); if (s && s !== "en") void preloadLang(s); }

/** Draws the page again from the top when the language changes (no reload; the router and the data cache stay). */
export function LanguageRoot({ children }: { children: ReactNode }) {
  const lang = useLang();
  return createElement(Fragment, { key: lang }, children);
}
