import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MarketingLayout } from "./layouts/marketing";
import { Landing } from "./pages/landing";
import { AuthLayout } from "./layouts/auth";
import { LoginPage } from "./pages/auth";
import { authProvidersQuery } from "./lib/auth-providers";
import { qk } from "./lib/queries";
import type { LoginVariant } from "../shared/prerender-shell";

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

/**
 * R34 (perf2): the sign in card for one deployment setup, rendered at build time (scripts/prerender-landing.ts) with
 * the providers answer and the demo flag already known, which is the state the browser renders once both reads
 * are back. main.tsx waits for the same two reads and the page's code before it renders, so React draws this same
 * card over the HTML in one step: nothing moves, and the card is on screen before any JS has run.
 */
export function renderLoginCard(v: LoginVariant): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false, staleTime: Infinity } } });
  queryClient.setQueryData(authProvidersQuery.queryKey, { idp: v.idp, password: v.password, google: v.google, github: v.github });
  queryClient.setQueryData(qk.config, { demoEnabled: v.demo });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<LoginPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
