import "./lib/polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { router } from "./router";
import { api, ApiError } from "./lib/api";
import { qk } from "./lib/queries";
import type { PublicConfig } from "./lib/types";
import { scheduleSentry } from "./lib/sentry";
import { ErrorBoundary } from "./components/error-boundary";
import { ThemedToaster } from "./components/theme";
import { applyMeta } from "./components/seo";
import { AnalyticsBeacon } from "./components/analytics-beacon";
import "./index.css";
import { prefetchOnIntent, prefetchRoute } from "./lib/prefetch";
import { authProvidersQuery, isAuthLayoutPath } from "./lib/auth-providers";
import { PUSH_ON_PAGE_EVENT, registerServiceWorker } from "./lib/sw-client";

// R25: start the opened page's code now, beside the app frame, instead of after the frame has loaded,
// and warm a page's code when a link to it is hovered, touched or focused.
prefetchRoute(window.location.pathname);
prefetchOnIntent();

// R34: after the page has loaded and gone idle, so error tracking never delays it; earlier errors are queued.
scheduleSentry();

// R32: offline app shell and browser notifications (production builds only; see lib/sw-client.ts).
registerServiceWorker({ navigate: (url) => void router.navigate(url) });

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
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <RouterProvider router={router} />
      </ErrorBoundary>
      <ThemedToaster />
      <AnalyticsBeacon subscribe={beaconRoutes} />
    </QueryClientProvider>
  </StrictMode>,
);
