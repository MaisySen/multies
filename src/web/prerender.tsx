import { Suspense, type ReactElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MarketingLayout } from "./layouts/marketing";
import { Landing } from "./pages/landing";
import { AuthLayout } from "./layouts/auth";
import { ForgotPasswordPage, LoginPage, SignupPage } from "./pages/auth";
import { authProvidersQuery } from "./lib/auth-providers";
import { qk } from "./lib/queries";
import { AUTH_CARD_ROUTES, type AuthCardPage, type LoginVariant } from "../shared/prerender-shell";
import { PricingPage } from "./pages/pricing";
import { StartupsPage } from "./pages/startups";
import { SwitchIndexPage } from "./pages/switch";
import { AgentsDevPage } from "./pages/agents";
import { DevelopersPage } from "./pages/developers-hub";
import { McpDocsPage } from "./pages/mcp-docs";
import { StatusPage } from "./pages/status";
import { ChangelogPage } from "./pages/changelog";
import { LegalPage } from "./pages/legal";
import { DeleteAccountPage, SupportPage } from "./pages/support";
import { ContactUsPage } from "./pages/contact";
import { CheckPage } from "./pages/check";
import { TrustPage } from "./pages/trust";

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
  return renderAuthCard("login", v);
}

/** R35: the password form pages read setup the build cannot know (forgot password reads whether mail delivery is
 * connected), so they are prerendered only where the identity provider owns passwords. */
export function prerendersAuthCard(page: AuthCardPage, v: LoginVariant): boolean {
  return page !== "forgot" || (v.idp && !v.password);
}

const AUTH_CARD_ELEMENTS: Record<AuthCardPage, () => ReactElement> = {
  login: () => <LoginPage />,
  signup: () => <SignupPage />,
  forgot: () => <ForgotPasswordPage />,
};

/**
 * R35: the card in the HTML is a picture of the form until the app takes over (about a second on a slow phone):
 * React draws its own form over it, so anything typed into the HTML form would be lost, and a native submit would
 * put the fields in the URL. So its fields are read only and its submit button submits nothing; links stay live.
 */
export function inertFormFields(markup: string): string {
  return markup
    .replace(/<input(?![^>]*\breadonly)(?![^>]*type="(?:hidden|checkbox|radio)")/g, '<input readonly=""')
    .replace(/<button type="submit"/g, '<button type="button" data-prerender-submit=""');
}

/** R35: the same card for sign up and forgot password, so those pages paint from the HTML too. */
export function renderAuthCard(page: AuthCardPage, v: LoginVariant): string {
  return inertFormFields(renderAuthMarkup(page, v));
}

function renderAuthMarkup(page: AuthCardPage, v: LoginVariant): string {
  const path = AUTH_CARD_ROUTES[page];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false, staleTime: Infinity } } });
  queryClient.setQueryData(authProvidersQuery.queryKey, { idp: v.idp, password: v.password, google: v.google, github: v.github });
  queryClient.setQueryData(qk.config, { demoEnabled: v.demo, socialConnections: v.social ? v.social.split("+") : [] });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path={path} element={AUTH_CARD_ELEMENTS[page]()} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * R76: the other public pages, rendered at build time the same way as the landing page, so a phone paints the page
 * from the HTML and its inline CSS instead of waiting for the app's code (Lighthouse mobile: 88% of LCP was render
 * delay on /pricing, /status, /privacy and /developers/mcp). main.tsx hydrates over it, so nothing is redrawn.
 * The page sits in the same Suspense boundary as in router.tsx (publicPage), so the client tree matches; until the
 * page's own code has loaded, React keeps this HTML on screen.
 */
const PUBLIC_ELEMENTS: Record<string, () => ReactElement> = {
  "/pricing": () => <PricingPage />,
  "/startups": () => <StartupsPage />,
  "/switch": () => <SwitchIndexPage />,
  "/agents": () => <AgentsDevPage />,
  "/developers": () => <DevelopersPage />,
  "/developers/mcp": () => <McpDocsPage />,
  "/status": () => <StatusPage />,
  "/changelog": () => <ChangelogPage />,
  "/privacy": () => <LegalPage slug="privacy" />,
  "/support": () => <SupportPage />,
  "/contact": () => <ContactUsPage />,
  "/check": () => <CheckPage />,
  "/trust": () => <TrustPage />,
  "/security": () => <TrustPage />,
  "/delete-account": () => <DeleteAccountPage />,
  "/terms": () => <LegalPage slug="terms" />,
  "/acceptable-use": () => <LegalPage slug="acceptable-use" />,
  "/dpa": () => <LegalPage slug="dpa" />,
};
export const PUBLIC_PRERENDER_PATHS = Object.keys(PUBLIC_ELEMENTS);

export function renderPublicPage(path: string): string {
  const el = PUBLIC_ELEMENTS[path];
  if (!el) throw new Error(`no prerender for ${path}`);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<MarketingLayout />}>
            <Route path={path} element={<Suspense fallback={<div className="min-h-dvh" aria-busy="true" />}>{el()}</Suspense>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
