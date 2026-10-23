import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter } from "react-router";
import { MarketingLayout } from "./layouts/marketing";
import { AuthLayout } from "./layouts/auth";
import { Landing } from "./pages/landing";
import { PricingPage } from "./pages/pricing";
import { EmailVerifiedPage, ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage } from "./pages/auth";
import { NotFound } from "./pages/not-found";
import { AppSkeleton } from "./layouts/app-skeleton";

const AppLayout = lazy(() => import("./layouts/app").then((m) => ({ default: m.AppLayout })));
const AdminPage = lazy(() => import("./pages/app/admin").then((m) => ({ default: m.AdminPage })));
const DashboardPage = lazy(() => import("./pages/app/dashboard").then((m) => ({ default: m.DashboardPage })));
const DomainsPage = lazy(() => import("./pages/app/domains").then((m) => ({ default: m.DomainsPage })));
const DomainDetailPage = lazy(() => import("./pages/app/domain-detail").then((m) => ({ default: m.DomainDetailPage })));
const MailboxesPage = lazy(() => import("./pages/app/mailboxes").then((m) => ({ default: m.MailboxesPage })));
const WebmailPage = lazy(() => import("./pages/app/webmail").then((m) => ({ default: m.WebmailPage })));
const ActivityPage = lazy(() => import("./pages/app/activity").then((m) => ({ default: m.ActivityPage })));
const settings = () => import("./pages/app/settings");
const SettingsLayout = lazy(() => settings().then((m) => ({ default: m.SettingsLayout })));
const GeneralSettings = lazy(() => settings().then((m) => ({ default: m.GeneralSettings })));
const MailSettings = lazy(() => settings().then((m) => ({ default: m.MailSettings })));
const AccountSettings = lazy(() => import("./pages/app/security").then((m) => ({ default: m.AccountSettings })));
const TeamSettings = lazy(() => import("./pages/app/team").then((m) => ({ default: m.TeamSettings })));
const BillingSettings = lazy(() => import("./pages/app/billing").then((m) => ({ default: m.BillingSettings })));
const MailAppsSettings = lazy(() => import("./pages/app/mail-apps").then((m) => ({ default: m.MailAppsSettings })));
const DeveloperSettings = lazy(() => import("./pages/app/developers").then((m) => ({ default: m.DeveloperSettings })));
const DeliverabilityPage = lazy(() => import("./pages/app/deliverability").then((m) => ({ default: m.DeliverabilityPage })));
const StatusPage = lazy(() => import("./pages/status").then((m) => ({ default: m.StatusPage })));
const LegalPage = lazy(() => import("./pages/legal").then((m) => ({ default: m.LegalPage })));
const InvitePage = lazy(() => import("./pages/invite").then((m) => ({ default: m.InvitePage })));

const page = (node: ReactNode) => <Suspense fallback={null}>{node}</Suspense>;
/** Public pages hold a full screen while their code loads, so the footer never jumps. */
const publicPage = (node: ReactNode) => <Suspense fallback={<div className="min-h-dvh" aria-busy="true" />}>{node}</Suspense>;

export const router = createBrowserRouter([
  {
    element: <MarketingLayout />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/pricing", element: <PricingPage /> },
      { path: "/status", element: publicPage(<StatusPage />) },
      { path: "/privacy", element: publicPage(<LegalPage slug="privacy" />) },
      { path: "/terms", element: publicPage(<LegalPage slug="terms" />) },
      { path: "/acceptable-use", element: publicPage(<LegalPage slug="acceptable-use" />) },
      { path: "/dpa", element: publicPage(<LegalPage slug="dpa" />) },
    ],
  },
  {
    element: <AuthLayout />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/signup", element: <SignupPage /> },
      { path: "/invite/:token", element: page(<InvitePage />) },
      { path: "/forgot-password", element: <ForgotPasswordPage /> },
      { path: "/reset-password", element: <ResetPasswordPage /> },
      { path: "/email-verified", element: <EmailVerifiedPage /> },
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
      { path: "deliverability", element: page(<DeliverabilityPage />) },
      { path: "admin", element: page(<AdminPage />) },
      {
        path: "settings",
        element: page(<SettingsLayout />),
        children: [
          { index: true, element: page(<GeneralSettings />) },
          { path: "team", element: page(<TeamSettings />) },
          { path: "billing", element: page(<BillingSettings />) },
          { path: "account", element: page(<AccountSettings />) },
          { path: "mail", element: page(<MailSettings />) },
          { path: "mail-apps", element: page(<MailAppsSettings />) },
          { path: "developers", element: page(<DeveloperSettings />) },
        ],
      },
    ],
  },
  { path: "*", element: <NotFound /> },
]);
