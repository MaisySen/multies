/**
 * R30: puts prerendered markup inside the shell's empty root. The root keeps its id, so main.tsx renders
 * over it; data-prerendered marks it for tests. Throws when the shell has no empty root, so a changed
 * index.html can never ship a page with the markup in the wrong place.
 */
export const EMPTY_ROOT = '<div id="root"></div>';

export function injectLanding(shell: string, markup: string): string {
  if (!shell.includes(EMPTY_ROOT)) throw new Error("index.html has no empty #root");
  if (!markup.trim()) throw new Error("empty landing markup");
  return shell.replace(EMPTY_ROOT, `<div id="root" data-prerendered="landing">${markup}</div>`);
}

/**
 * On the prerendered page the HTML is the content, so the app's code is fetched at low priority: the
 * headline and styles go first on a slow phone connection, the code that makes buttons live right after.
 */
export function lowPriorityScripts(html: string): string {
  return html
    .replace(/<script type="module" crossorigin src=/g, '<script type="module" crossorigin fetchpriority="low" src=')
    .replace(/<link rel="modulepreload" crossorigin href=/g, '<link rel="modulepreload" crossorigin fetchpriority="low" href=');
}

/** The HTML to send for a page path: the prerendered landing for "/", the sign in shell (with its code
 * preloaded) for the auth pages, each when the build made one; else the plain shell. */
export function shellFor(pathname: string, shell: string, landing: string | null | undefined, auth?: string | null): string {
  if (pathname === "/" && landing) return landing;
  if (auth && AUTH_SHELL_PATHS.test(pathname)) return auth;
  return shell;
}

/**
 * R34: the sign in shell asks for the providers answer (which buttons and fields the page shows) beside its code,
 * instead of after the code has run. The app's own fetch (credentials same-origin) picks the preloaded copy up.
 */
export const AUTH_PROVIDERS_PRELOAD = '<link rel="preload" href="/api/account/providers" as="fetch" crossorigin>';
/** The public config too: the demo button on sign in reads it, and arriving late it moved the card (layout shift). */
export const AUTH_CONFIG_PRELOAD = '<link rel="preload" href="/api/config" as="fetch" crossorigin>';
export function withProvidersPreload(shell: string): string {
  if (shell.includes(AUTH_PROVIDERS_PRELOAD)) return shell;
  return shell.replace("</head>", `  ${AUTH_PROVIDERS_PRELOAD}\n    ${AUTH_CONFIG_PRELOAD}\n  </head>`);
}

/**
 * R34: preconnect and dns-prefetch hints for the error tracker's ingest host, read from the browser DSN at request
 * time (the DSN is per deployment). Only an https sentry.io host is accepted; anything else adds nothing.
 */
export function originHintsFor(dsn: string | null | undefined): string {
  if (!dsn) return "";
  try {
    const u = new URL(dsn);
    if (u.protocol !== "https:" || !/(^|\.)sentry\.io$/.test(u.hostname)) return "";
    const origin = `https://${u.hostname}`;
    return `<link rel="preconnect" href="${origin}" crossorigin><link rel="dns-prefetch" href="${origin}">`;
  } catch {
    return "";
  }
}
export function withOriginHints(html: string, hints: string): string {
  return hints && !html.includes(hints) ? html.replace("</head>", `${hints}</head>`) : html;
}

/** R34: cache rule for /brand/* (provider logos and marks, not hashed, but they do not change). */
export const BRAND_CACHE = "public, max-age=31536000, stale-while-revalidate=604800";

/** R34: HTML documents carry no-transform, so the edge never injects scripts of its own into them (CSP would block them and log a console error). */
export function htmlCacheControl(base = "no-cache"): string {
  return /\bno-transform\b/.test(base) ? base : `${base}, no-transform`;
}

/** Pages whose code (the auth chunk) the sign in shell preloads. Kept in step with lib/auth-providers.ts. */
export const AUTH_SHELL_PATHS = /^\/(?:login|signup|forgot-password|reset-password|email-verified)\/?$/;

type ManifestChunk = { file: string; imports?: string[] };

/** Every file a manifest entry needs: its own chunk and its static imports, recursively, in load order. */
export function chunkFiles(manifest: Record<string, ManifestChunk>, key: string, seen = new Set<string>()): string[] {
  const entry = manifest[key];
  if (!entry || seen.has(key)) return [];
  seen.add(key);
  return [entry.file, ...(entry.imports ?? []).flatMap((k) => chunkFiles(manifest, k, seen))];
}

/** The shell with modulepreload links for the given files, skipping any it already preloads or loads. */
export function withPreloads(shell: string, files: string[]): string {
  const links = [...new Set(files)].filter((f) => !shell.includes(`/${f}"`)).map((f) => `<link rel="modulepreload" crossorigin href="/${f}">`);
  if (!links.length) return shell;
  return shell.replace("</head>", `  ${links.join("\n    ")}\n  </head>`);
}

/** R31: the source module behind each page the app warms when idle (keep in step with LIKELY_NEXT in lib/prefetch.ts). */
export const ROUTE_MODULES: Record<string, string> = {
  "/app/my-work": "src/web/pages/app/my-work.tsx",
  "/app/tasks": "src/web/pages/app/work/tasks.tsx",
  "/app/mail": "src/web/pages/app/webmail.tsx",
};

/** R31: page path to the hashed files its code needs, from the Vite manifest; pages missing from the manifest are left out. */
export function routeChunkMap(manifest: Record<string, { file: string; imports?: string[] }>, modules: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [route, mod] of Object.entries(modules)) {
    const files = [...new Set(chunkFiles(manifest, mod))];
    if (files.length) out[route] = files;
  }
  return out;
}

/**
 * R34 (perf2): the sign in card, prerendered at build time for each way a deployment can be set up, so /login paints
 * from the HTML and its inline CSS before any of the app's code has run (Lighthouse mobile: the card waited on about
 * 210 KB of JS, 86% of LCP was render delay). The server picks the variant from its own config, the same config the
 * providers answer and the public config come from, so the card the HTML shows is the card React then renders.
 */
export interface LoginVariant { idp: boolean; password: boolean; google: boolean; github: boolean; demo: boolean; social?: string }

/** R35: the identity provider's direct social buttons (Continue with Google, Microsoft) are part of the card too: left
 * out, the card grew by a button when the app took over and everything under it moved (prod CLS 0.14 in one run of
 * two). `social` is the connections the page shows, in its fixed order, joined with "+"; "" for none. */
export const SOCIAL_ORDER = ["google-oauth2", "windowslive"] as const;
export const socialKey = (list: readonly string[] | null | undefined) => SOCIAL_ORDER.filter((c) => list?.includes(c)).join("+");

export const loginVariantKey = (v: LoginVariant) => `idp${+v.idp}-pw${+v.password}-g${+v.google}-gh${+v.github}-demo${+v.demo}${v.social ? `-s${v.social}` : ""}`;

/** Every setup the build prerenders: the identity provider (with or without the password form), or the app's own
 * form with any mix of Google and GitHub; each with and without the demo button. Anything else gets the plain shell. */
export const LOGIN_VARIANTS: LoginVariant[] = [true, false].flatMap((demo) => [
  ...["", "google-oauth2", "google-oauth2+windowslive"].flatMap((social) => [
    { idp: true, password: false, google: false, github: false, demo, social },
    { idp: true, password: true, google: false, github: false, demo, social },
  ]),
  ...[false, true].flatMap((google) => [false, true].map((github) => ({ idp: false, password: true, google, github, demo }))),
]);

/** The build output for it: the sign in shell (critical CSS inline, main stylesheet non-blocking) and one card per variant.
 * R35: `pages` carries the same for sign up and forgot password (one card per variant each, a variant can be missing:
 * that setup keeps the plain sign in shell). */
export interface LoginPrerender { shell: string; cards: Record<string, string>; pages?: Partial<Record<Exclude<AuthCardPage, "login">, Record<string, string>>> }

export const LOGIN_CARD_PATH = /^\/login\/?$/;
/** R35: the auth pages served with a prerendered card: sign in, sign up and forgot password. */
export type AuthCardPage = "login" | "signup" | "forgot";
export const AUTH_CARD_PATH = /^\/(?:login|signup|forgot-password)\/?$/;
export const AUTH_CARD_ROUTES: Record<AuthCardPage, string> = { login: "/login", signup: "/signup", forgot: "/forgot-password" };
export function authCardPage(pathname: string): AuthCardPage | null {
  const m = pathname.match(/^\/(login|signup|forgot-password)\/?$/);
  return m ? (m[1] === "forgot-password" ? "forgot" : (m[1] as AuthCardPage)) : null;
}

export function injectAuthCard(shell: string, markup: string): string {
  if (!shell.includes(EMPTY_ROOT)) throw new Error("sign in shell has no empty #root");
  if (!markup.trim()) throw new Error("empty sign in markup");
  return shell.replace(EMPTY_ROOT, `<div id="root" data-prerendered="auth">${markup}</div>`);
}

/**
 * The prerendered sign in page for this request, or null for the usual shell. Only /login with no query: an error,
 * sso, email or next parameter changes the card, so those keep the shell and the app draws the card as before.
 * R35: /signup and /forgot-password the same way (no query only: email, invited and next change those cards too).
 */
export function loginHtmlFor(pathname: string, search: string, prerender: LoginPrerender | null | undefined, variant: LoginVariant | null): string | null {
  const page = authCardPage(pathname);
  if (!prerender || !variant || !page || (search && search !== "?")) return null;
  const cards = page === "login" ? prerender.cards : prerender.pages?.[page];
  const card = cards?.[loginVariantKey(variant)];
  return card ? injectAuthCard(prerender.shell, card) : null;
}

/**
 * Inlines the critical CSS and turns the main stylesheet into a non-blocking one: media="print" until main.tsx flips
 * it to "all" (no inline script, so the CSP stays as it is), plus a noscript copy for browsers with JS off.
 */
export function withCriticalCss(shell: string, css: string): string {
  const re = /<link rel="stylesheet" crossorigin href="([^"]+)">/g;
  if (!re.test(shell)) throw new Error("shell has no stylesheet link");
  if (!css.trim()) throw new Error("empty critical CSS");
  let first = true;
  return shell.replace(re, (_m, href: string) => {
    const style = first ? `<style data-critical>${css.replace(/<\/style/gi, "<\\/style")}</style>\n    ` : "";
    first = false;
    return `${style}<link rel="stylesheet" crossorigin href="${href}" media="print" data-defer-css><noscript><link rel="stylesheet" crossorigin href="${href}"></noscript>`;
  });
}

/**
 * R34 (perf2): on the prerendered sign in page the app's code starts after the card has painted: the module script and
 * its modulepreload links move into data attributes of /login-boot.js (a deferred file, so no inline script), which adds
 * them back one frame after first paint. The card is HTML, so nothing waits on the code to be seen.
 */
export const LOGIN_BOOT = "/login-boot.js";
export function startCodeAfterPaint(html: string): string {
  const entry = html.match(/<script type="module" crossorigin(?: fetchpriority="low")? src="([^"]+)"><\/script>/);
  if (!entry) throw new Error("shell has no module script");
  const preloads: string[] = [];
  let out = html.replace(/\s*<link rel="modulepreload" crossorigin(?: fetchpriority="low")? href="([^"]+)">/g, (_m, href: string) => { preloads.push(href); return ""; });
  out = out.replace(entry[0], `<script src="${LOGIN_BOOT}" defer data-entry="${entry[1]}" data-preload="${preloads.join(" ")}"></script>`);
  return out;
}
