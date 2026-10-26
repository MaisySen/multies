/**
 * Route prefetch (R25): load a page's code before the click. Sidebar links warm their page on hover or
 * focus, the likely next pages load when the browser is idle after first paint, and the page being
 * opened starts loading beside the app frame instead of after it. Each import() here names the same
 * module the router lazy loads, so the browser fetches the same hashed chunk once.
 */

export type Loader = () => Promise<unknown>;

/** Longest prefix first, so /app/my-work is not taken for /app. */
export const ROUTE_LOADERS: [prefix: string, load: Loader][] = [
  ["/app/my-work", () => import("../pages/app/my-work")],
  ["/app/tasks", () => import("../pages/app/work/tasks")],
  ["/app/mail", () => import("../pages/app/webmail")],
  ["/app/inbox", () => import("../pages/app/inbox")],
  ["/app/chat", () => import("../pages/app/work/chat")],
  ["/app/docs", () => import("../pages/app/work/docs")],
  ["/app/meetings", () => import("../pages/app/work/meetings")],
  ["/app/dashboards", () => import("../pages/app/work/dashboards")],
  ["/app/goals", () => import("../pages/app/work/goals")],
  ["/app/contacts", () => import("../pages/app/work/contacts")],
  ["/app/notifications", () => import("../pages/app/notifications")],
  ["/app/triage", () => import("../pages/app/work/triage")],
  ["/app/settings", () => import("../pages/app/settings")],
  ["/app", () => import("../pages/app/dashboard")],
  ["/login", () => import("../pages/auth")],
  ["/signup", () => import("../pages/auth")],
  ["/pricing", () => import("../pages/pricing")],
];

/** The pages most people open next, warmed when the browser is idle after the first page shows. */
export const LIKELY_NEXT = ["/app/my-work", "/app/tasks", "/app/mail"];

/** The loader for a link's path, or null for anything we do not know (other sites, the API). */
export function loaderFor(href: string, table: [string, Loader][] = ROUTE_LOADERS): Loader | null {
  let path: string;
  try { path = new URL(href, "http://x").pathname; } catch { return null; }
  if (path.startsWith("/api/")) return null;
  for (const [prefix, load] of table) if (path === prefix || path.startsWith(`${prefix}/`)) return load;
  return null;
}

/** The connection says to hold back (Save-Data on, or 2G). */
export function shouldHoldBack(nav: { connection?: { saveData?: boolean; effectiveType?: string } } | undefined): boolean {
  const c = nav?.connection;
  return !!c && (c.saveData === true || /(^|-)2g$/.test(c.effectiveType ?? ""));
}

const started = new Set<Loader>();

/** Start loading the code for a path once; a failed fetch is forgotten so a later try can run. */
export function prefetchRoute(href: string, table: [string, Loader][] = ROUTE_LOADERS): boolean {
  const load = loaderFor(href, table);
  if (!load || started.has(load)) return false;
  started.add(load);
  load().catch(() => started.delete(load));
  return true;
}

/** For tests: forget what has been started. */
export function resetPrefetch(): void { started.clear(); }

type IdleWindow = { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; setTimeout: (cb: () => void, ms: number) => unknown };

/**
 * R31: download only. The idle warm up fetches the files behind the likely next pages with
 * <link rel="prefetch"> (lowest priority, into the HTTP cache, nothing runs) instead of import(), which would also
 * parse and run every module. The build writes the page to files map (route-chunks.json, scripts/prerender-landing.ts).
 */
export interface DownloadOnly {
  map: () => Promise<Record<string, string[]> | null>;
  add: (file: string) => void;
}
const linked = new Set<string>();
export const browserDownloadOnly: DownloadOnly = {
  map: async () => {
    try {
      const r = await fetch("/route-chunks.json", { credentials: "same-origin" });
      return r.ok ? ((await r.json()) as Record<string, string[]>) : null;
    } catch { return null; }
  },
  add: (file) => {
    if (linked.has(file) || document.querySelector(`script[src="/${file}"], link[href="/${file}"]`)) return;
    linked.add(file);
    const l = document.createElement("link");
    l.rel = "prefetch";
    l.as = "script";
    l.href = `/${file}`;
    l.crossOrigin = "anonymous";
    document.head.appendChild(l);
  },
};

/** The files to prefetch for these pages, each once, in page order. */
export function filesFor(paths: string[], map: Record<string, string[]>): string[] {
  return [...new Set(paths.flatMap((p) => map[p] ?? []))];
}

/**
 * Warm the likely next pages when the browser is idle, unless the connection says not to. With a build map the
 * files only download; without one (the dev server) the pages load as before.
 */
export function prefetchWhenIdle(paths: string[] = LIKELY_NEXT, win: IdleWindow = window, nav: Parameters<typeof shouldHoldBack>[0] = navigator as never, table: [string, Loader][] = ROUTE_LOADERS, dl: DownloadOnly | null = browserDownloadOnly): void {
  if (shouldHoldBack(nav)) return;
  const viaImport = () => { for (const p of paths) prefetchRoute(p, table); };
  const run = () => {
    if (!dl) { viaImport(); return; }
    void dl.map().then((map) => {
      if (!map) { viaImport(); return; }
      for (const f of filesFor(paths, map)) dl.add(f);
    });
  };
  if (typeof win.requestIdleCallback === "function") win.requestIdleCallback(run, { timeout: 4000 });
  else win.setTimeout(run, 2000);
}

/** Hover, touch or keyboard focus on a link to one of our pages: warm that page. One listener covers every link. */
export function prefetchOnIntent(doc: Pick<Document, "addEventListener" | "removeEventListener"> = document, table: [string, Loader][] = ROUTE_LOADERS): () => void {
  const onIntent = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    const href = a?.getAttribute("href");
    if (href && href.startsWith("/") && !href.startsWith("//")) prefetchRoute(href, table);
  };
  doc.addEventListener("pointerover", onIntent, { passive: true });
  doc.addEventListener("focusin", onIntent);
  doc.addEventListener("touchstart", onIntent, { passive: true });
  return () => {
    doc.removeEventListener("pointerover", onIntent);
    doc.removeEventListener("focusin", onIntent);
    doc.removeEventListener("touchstart", onIntent);
  };
}
