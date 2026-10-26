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
