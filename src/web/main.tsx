import "./lib/polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { router } from "./router";
import { ApiError } from "./lib/api";
import { startSentry } from "./lib/sentry";
import { ErrorBoundary } from "./components/error-boundary";
import { ThemedToaster } from "./components/theme";
import { applyMeta } from "./components/seo";
import { AnalyticsBeacon } from "./components/analytics-beacon";
import "./index.css";
import { prefetchOnIntent, prefetchRoute } from "./lib/prefetch";
import { authProvidersQuery, isAuthLayoutPath } from "./lib/auth-providers";
import { registerServiceWorker } from "./lib/sw-client";

// R25: start the opened page's code now, beside the app frame, instead of after the frame has loaded,
// and warm a page's code when a link to it is hovered, touched or focused.
prefetchRoute(window.location.pathname);
prefetchOnIntent();

// After first paint, so error tracking never delays the page.
if ("requestIdleCallback" in window) requestIdleCallback(() => void startSentry(), { timeout: 3000 });
else setTimeout(() => void startSentry(), 1500);

// R32: offline app shell and browser notifications (production builds only; see lib/sw-client.ts).
registerServiceWorker({ navigate: (url) => void router.navigate(url) });

// Per-page title, description and social tags, on first load and every navigation.
applyMeta(window.location.pathname);
router.subscribe((s) => applyMeta(s.location.pathname));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

// R30: sign in and sign up paint once the providers are known, so ask for them now, beside the page's code.
if (isAuthLayoutPath(window.location.pathname)) void queryClient.prefetchQuery(authProvidersQuery);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <RouterProvider router={router} />
      </ErrorBoundary>
      <ThemedToaster />
      <AnalyticsBeacon />
    </QueryClientProvider>
  </StrictMode>,
);
