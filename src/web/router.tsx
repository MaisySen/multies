import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter } from "react-router";
import { MarketingLayout } from "./layouts/marketing";
import { AuthLayout } from "./layouts/auth";
import { Landing } from "./pages/landing";
import { PricingPage } from "./pages/pricing";
import { AgentsDevPage } from "./pages/agents";
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
const agentPages = () => import("./pages/app/agents");
const AgentsPage = lazy(() => agentPages().then((m) => ({ default: m.AgentsPage })));
const AgentDetailPage = lazy(() => agentPages().then((m) => ({ default: m.AgentDetailPage })));
const ApprovalsPage = lazy(() => import("./pages/app/approvals").then((m) => ({ default: m.ApprovalsPage })));
const TeamInboxPage = lazy(() => import("./pages/app/inbox").then((m) => ({ default: m.TeamInboxPage })));
const work = () => import("./pages/app/work/tasks");
const TasksPage = lazy(() => work().then((m) => ({ default: m.TasksPage })));
const docsPages = () => import("./pages/app/work/docs");
const DocsPage = lazy(() => docsPages().then((m) => ({ default: m.DocsPage })));
const DocPage = lazy(() => docsPages().then((m) => ({ default: m.DocPage })));
const contactPages = () => import("./pages/app/work/contacts");
const ContactsPage = lazy(() => contactPages().then((m) => ({ default: m.ContactsPage })));
const ContactPage = lazy(() => contactPages().then((m) => ({ default: m.ContactPage })));
const DealsPage = lazy(() => import("./pages/app/work/deals").then((m) => ({ default: m.DealsPage })));
const AutomationsPage = lazy(() => import("./pages/app/work/automations").then((m) => ({ default: m.AutomationsPage })));
const TimesheetPage = lazy(() => import("./pages/app/work/time").then((m) => ({ default: m.TimesheetPage })));
const formPages = () => import("./pages/app/work/forms");
const FormsPage = lazy(() => formPages().then((m) => ({ default: m.FormsPage })));
const PublicFormPage = lazy(() => formPages().then((m) => ({ default: m.PublicFormPage })));
const ReportsPage = lazy(() => import("./pages/app/work/reports").then((m) => ({ default: m.ReportsPage })));
const meetingPages = () => import("./pages/app/work/meetings");
const MeetingsPage = lazy(() => meetingPages().then((m) => ({ default: m.MeetingsPage })));
const MeetingPage = lazy(() => meetingPages().then((m) => ({ default: m.MeetingPage })));
const GuestMeetingPage = lazy(() => meetingPages().then((m) => ({ default: m.GuestMeetingPage })));
const PortfolioPage = lazy(() => import("./pages/app/work/portfolio").then((m) => ({ default: m.PortfolioPage })));
const guestPages = () => import("./pages/app/work/guest");
const GuestAcceptPage = lazy(() => guestPages().then((m) => ({ default: m.GuestAcceptPage })));
const GuestProjectPage = lazy(() => guestPages().then((m) => ({ default: m.GuestProjectPage })));
const ChatPage = lazy(() => import("./pages/app/work/chat").then((m) => ({ default: m.ChatPage })));
const notificationPages = () => import("./pages/app/notifications");
const NotificationsPage = lazy(() => notificationPages().then((m) => ({ default: m.NotificationsPage })));
const NotificationSettings = lazy(() => notificationPages().then((m) => ({ default: m.NotificationSettings })));
const TemplatesPage = lazy(() => import("./pages/app/work/templates").then((m) => ({ default: m.TemplatesPage })));
const IntegrationsPage = lazy(() => import("./pages/app/work/integrations").then((m) => ({ default: m.IntegrationsPage })));
const GoalsPage = lazy(() => import("./pages/app/work/goals").then((m) => ({ default: m.GoalsPage })));
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
const ThanksPage = lazy(() => import("./pages/thanks").then((m) => ({ default: m.ThanksPage })));
const SupportPage = lazy(() => import("./pages/support").then((m) => ({ default: m.SupportPage })));
const DeleteAccountPage = lazy(() => import("./pages/support").then((m) => ({ default: m.DeleteAccountPage })));
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
      { path: "/agents", element: <AgentsDevPage /> },
      { path: "/status", element: publicPage(<StatusPage />) },
      { path: "/privacy", element: publicPage(<LegalPage slug="privacy" />) },
      { path: "/support", element: publicPage(<SupportPage />) },
      { path: "/delete-account", element: publicPage(<DeleteAccountPage />) },
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
      { path: "inbox", element: page(<TeamInboxPage />) },
      { path: "agents", element: page(<AgentsPage />) },
      { path: "agents/:id", element: page(<AgentDetailPage />) },
      { path: "approvals", element: page(<ApprovalsPage />) },
      { path: "activity", element: page(<ActivityPage />) },
      { path: "tasks", element: page(<TasksPage />) },
      { path: "docs", element: page(<DocsPage />) },
      { path: "docs/:id", element: page(<DocPage />) },
      { path: "contacts", element: page(<ContactsPage />) },
      { path: "contacts/:id", element: page(<ContactPage />) },
      { path: "deals", element: page(<DealsPage />) },
      { path: "automations", element: page(<AutomationsPage />) },
      { path: "integrations", element: page(<IntegrationsPage />) },
      { path: "time", element: page(<TimesheetPage />) },
      { path: "forms", element: page(<FormsPage />) },
      { path: "reports", element: page(<ReportsPage />) },
      { path: "portfolio", element: page(<PortfolioPage />) },
      { path: "chat", element: page(<ChatPage />) },
      { path: "chat/:id", element: page(<ChatPage />) },
      { path: "notifications", element: page(<NotificationsPage />) },
      { path: "templates", element: page(<TemplatesPage />) },
      { path: "goals", element: page(<GoalsPage />) },
      { path: "meetings", element: page(<MeetingsPage />) },
      { path: "meetings/:id", element: page(<MeetingPage />) },
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
          { path: "notifications", element: page(<NotificationSettings />) },
          { path: "mail", element: page(<MailSettings />) },
          { path: "mail-apps", element: page(<MailAppsSettings />) },
          { path: "developers", element: page(<DeveloperSettings />) },
        ],
      },
    ],
  },
  // Public pages with no site header: a form anyone can fill in, and a meeting guest link.
  { path: "/f/:slug", element: publicPage(<PublicFormPage />) },
  { path: "/m/:token", element: publicPage(<GuestMeetingPage />) },
  // A project guest (a client): the invite link, then the one project they can see.
  { path: "/g/:token", element: publicPage(<GuestAcceptPage />) },
  { path: "/guest", element: publicPage(<GuestProjectPage />) },
  { path: "/thanks", element: publicPage(<ThanksPage />) },
  { path: "*", element: <NotFound /> },
]);
