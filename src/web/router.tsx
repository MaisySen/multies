import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter } from "react-router";
import { MarketingLayout } from "./layouts/marketing";
import { AuthLayout } from "./layouts/auth";
import { Landing } from "./pages/landing";
import { PricingPage } from "./pages/pricing";
import { LoginPage, SignupPage } from "./pages/auth";
import { NotFound } from "./pages/not-found";
import { AppSkeleton } from "./layouts/app-skeleton";

const AppLayout = lazy(() => import("./layouts/app").then((m) => ({ default: m.AppLayout })));
const DashboardPage = lazy(() => import("./pages/app/dashboard").then((m) => ({ default: m.DashboardPage })));
const DomainsPage = lazy(() => import("./pages/app/domains").then((m) => ({ default: m.DomainsPage })));
const DomainDetailPage = lazy(() => import("./pages/app/domain-detail").then((m) => ({ default: m.DomainDetailPage })));
const MailboxesPage = lazy(() => import("./pages/app/mailboxes").then((m) => ({ default: m.MailboxesPage })));
const WebmailPage = lazy(() => import("./pages/app/webmail").then((m) => ({ default: m.WebmailPage })));
const ActivityPage = lazy(() => import("./pages/app/activity").then((m) => ({ default: m.ActivityPage })));
const SettingsPage = lazy(() => import("./pages/app/settings").then((m) => ({ default: m.SettingsPage })));

const page = (node: ReactNode) => <Suspense fallback={null}>{node}</Suspense>;

export const router = createBrowserRouter([
  {
    element: <MarketingLayout />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/pricing", element: <PricingPage /> },
    ],
  },
  {
    element: <AuthLayout />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/signup", element: <SignupPage /> },
    ],
  },
  {
    path: "/app",
    element: <Suspense fallback={<AppSkeleton />}><AppLayout /></Suspense>,
    children: [
      { index: true, element: page(<DashboardPage />) },
      { path: "domains", element: page(<DomainsPage />) },
      { path: "domains/:id", element: page(<DomainDetailPage />) },
      { path: "mailboxes", element: page(<MailboxesPage />) },
      { path: "mail", element: page(<WebmailPage />) },
      { path: "activity", element: page(<ActivityPage />) },
      { path: "settings", element: page(<SettingsPage />) },
    ],
  },
  { path: "*", element: <NotFound /> },
]);
