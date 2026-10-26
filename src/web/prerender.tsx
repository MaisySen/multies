import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MarketingLayout } from "./layouts/marketing";
import { Landing } from "./pages/landing";

/**
 * R30: the landing page rendered to HTML at build time (scripts/prerender-landing.ts), so a phone sees
 * the headline as soon as the HTML and CSS arrive instead of after the app's JavaScript has loaded and
 * run. It renders the same first state the browser renders (no data loaded yet), and main.tsx then
 * renders the live page over it in one step, so nothing moves.
 */
export function renderLanding(): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<MarketingLayout />}>
            <Route path="/" element={<Landing />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
