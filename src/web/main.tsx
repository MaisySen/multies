import "./lib/polyfills";
import "./lib/board-asset-path";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { preloadAuthPages, router } from "./router";
import { api } from "./lib/api";
import { queryRetry } from "./lib/load-errors-t1g"; // T1G
import { qk } from "./lib/queries";
import type { PublicConfig } from "./lib/types";
import { captureWarning, scheduleSentry } from "./lib/sentry";
import { ErrorBoundary } from "./components/error-boundary";
import { ThemedToaster } from "./components/theme";
import { applyMeta } from "./components/seo";
import { AnalyticsBeacon } from "./components/analytics-beacon";
import { ProductAnalytics } from "./components/product-analytics";
import "./index.css";
import { prefetchOnIntent, prefetchRoute } from "./lib/prefetch";
import { authProvidersQuery, isAuthLayoutPath } from "./lib/auth-providers";
import { PUSH_ON_PAGE_EVENT, registerServiceWorker } from "./lib/sw-client";
import { keepReferralCode } from "./lib/referral";

// R62: a referral link (?ref=CODE) is kept until sign up.
keepReferralCode();

// R25: start the opened page's code now, beside the app frame, instead of after the frame has loaded,
// and warm a page's code when a link to it is hovered, touched or focused.
// R73: a page file that fails to load is handled where it is used (components/lazy-page.tsx, lib/page-load.ts): no
// reload on every failure any more (R56b did that, and offline it landed on the update screen).
prefetchRoute(window.location.pathname);
prefetchOnIntent();
// R40 (MB-203): an /app page also needs the app frame's code; start it now beside the page's own, instead of
// after the router has run (one less round trip in a row on a slow phone network). Same module as the router's.
if (window.location.pathname.startsWith("/app")) void import("./layouts/app").catch(() => undefined);

// R112: the anonymous report and data request pages start no error tracking, no analytics and no offline worker,
// so nothing about the person's browser leaves the page (the server sends a policy that blocks those hosts too).
const privatePage = /^\/(report|data-request)(\/|$)/.test(window.location.pathname);

// R34: after the page has loaded and gone idle, so error tracking never delays it; earlier errors are queued.
if (!privatePage) scheduleSentry();

// R32: offline app shell and browser notifications (production builds only; see lib/sw-client.ts).
if (!privatePage) registerServiceWorker({ navigate: (url) => void router.navigate(url) });

// Per-page title, description and social tags, on first load and every navigation.
applyMeta(window.location.pathname);
router.subscribe((s) => applyMeta(s.location.pathname));

// R34: the analytics beacon follows navigation (it stays off on the sign in pages).
const beaconRoutes = (fn: (path: string) => void) => router.subscribe((s) => fn(s.location.pathname));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: queryRetry, // T1G (T1-8): a failed read shows its error in seconds, not after ten
    },
  },
});

// R33: the worker skipped a notification because this page is open; refresh what is on screen instead.
window.addEventListener(PUSH_ON_PAGE_EVENT, () => void queryClient.invalidateQueries({ type: "active" }));

// R30: sign in and sign up paint once the providers are known, so ask for them now, beside the page's code.
// R34: and the public config beside it (the demo button reads it), so the card and its last row paint together.
if (isAuthLayoutPath(window.location.pathname)) {
  void queryClient.prefetchQuery(authProvidersQuery);
  void queryClient.prefetchQuery({ queryKey: qk.config, queryFn: () => api.get<PublicConfig>("/config"), staleTime: Infinity });
}

// R34 (perf2): the server sent /login with the card already drawn (critical CSS inline, the main stylesheet as
// media="print"). Turn the stylesheet on, then render once the page's code and both reads are in, so React draws the
// same card over it in one step. A read that fails or a slow network (4 s) renders anyway, as before.
const rootEl = document.getElementById("root")!;
const prerenderedAuth = rootEl.dataset.prerendered === "auth";
// R76: the landing and the other public pages arrive drawn too (scripts/prerender-landing.ts), each with its own CSS
// inline. React hydrates that markup instead of drawing it again, so what painted first stays (it is the LCP), and
// the main stylesheet is turned on now, before anything the inline CSS does not cover can appear.
const prerenderedPage = rootEl.dataset.prerendered === "landing" || rootEl.dataset.prerendered === "public";
if (prerenderedAuth || prerenderedPage) document.querySelectorAll<HTMLLinkElement>("link[data-defer-css]").forEach((l) => { l.media = "all"; });
// R35: the page's own code is always waited for (rendering without it would put the loading fallback over the card,
// the one layout shift seen on a slow Lighthouse run); only the two reads give up after 4 s.
const beforeRender = prerenderedAuth
  ? Promise.all([
    preloadAuthPages().catch(() => undefined),
    Promise.race([
      Promise.all([
        queryClient.fetchQuery(authProvidersQuery),
        queryClient.fetchQuery({ queryKey: qk.config, queryFn: () => api.get<PublicConfig>("/config"), staleTime: Infinity }),
      ]),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]).catch(() => undefined),
  ])
  : null;

// The marker comes off as React takes over, so tests (and anyone reading the page) can tell the two apart.
const render = () => { if (prerenderedAuth) delete rootEl.dataset.prerendered; createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <RouterProvider router={router} />
      </ErrorBoundary>
      <ThemedToaster />
      {!privatePage && <AnalyticsBeacon subscribe={beaconRoutes} />}
      {!privatePage && <ProductAnalytics subscribe={beaconRoutes} />}
    </QueryClientProvider>
  </StrictMode>,
); };
// R76: hydration. The toaster and the beacon are not in the prerendered markup, so they get their own small root
// beside it. A page whose markup differs from the build's (a stale cache, say) is redrawn by React; that is reported
// as a warning, never an error screen.
const hydrate = () => {
  delete rootEl.dataset.prerendered;
  hydrateRoot(rootEl, (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <RouterProvider router={router} />
        </ErrorBoundary>
      </QueryClientProvider>
    </StrictMode>
  ), { onRecoverableError: (err) => captureWarning(err, { kind: "hydration" }) });
  const side = document.createElement("div");
  side.id = "root-side";
  document.body.appendChild(side);
  createRoot(side).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemedToaster />
        {!privatePage && <AnalyticsBeacon subscribe={beaconRoutes} />}
        {!privatePage && <ProductAnalytics subscribe={beaconRoutes} />}
      </QueryClientProvider>
    </StrictMode>,
  );
};
if (beforeRender) void beforeRender.then(render);
else if (prerenderedPage) hydrate();
else render();
