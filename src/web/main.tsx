import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { Toaster } from "sonner";
import { router } from "./router";
import { ApiError } from "./lib/api";
import { startSentry } from "./lib/sentry";
import { ErrorBoundary } from "./components/error-boundary";
import "./index.css";

// After first paint, so error tracking never delays the page.
if ("requestIdleCallback" in window) requestIdleCallback(() => void startSentry(), { timeout: 3000 });
else setTimeout(() => void startSentry(), 1500);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <RouterProvider router={router} />
      </ErrorBoundary>
      <Toaster theme="dark" position="bottom-right" toastOptions={{ style: { background: "#16161a", border: "1px solid rgb(255 255 255 / 0.1)", color: "#f4f4f5" } }} />
    </QueryClientProvider>
  </StrictMode>,
);
