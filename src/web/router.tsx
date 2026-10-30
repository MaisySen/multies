import { lazy, Suspense, useState, type ReactNode } from "react";
import { createBrowserRouter } from "react-router";
import { RouteError } from "./components/route-error";
import { MarketingLayout } from "./layouts/marketing";
import { AuthLayout } from "./layouts/auth";
import { Landing } from "./pages/landing";
import { NotFound } from "./pages/not-found";
import { AppSkeleton } from "./layouts/app-skeleton";

// R25: sign-in and the other public pages load on their own, so the landing page carries none of the
// auth client and the app carries none of the marketing pages.
const StartupsPage = lazy(() => import("./pages/startups").then((m) => ({ default: m.StartupsPage }))); // R58 (MB-237)
const switchPages = () => import("./pages/switch"); // R58 (MB-237)
const SwitchIndexPage = lazy(() => switchPages().then((m) => ({ default: m.SwitchIndexPage })));
const SwitchPage = lazy(() => switchPages().then((m) => ({ default: m.SwitchPage })));
const PricingPage = lazy(() => import("./pages/pricing").then((m) => ({ default: m.PricingPage })));
const AgentsDevPage = lazy(() => import("./pages/agents").then((m) => ({ default: m.AgentsDevPage })));
const McpDocsPage = lazy(() => import("./pages/mcp-docs").then((m) => ({ default: m.McpDocsPage }))); // R36
// R34 (perf2): the sign in page's module, kept once loaded. On a prerendered /login main.tsx loads it before the first
// render, so the page renders straight away (no Suspense fallback over the card that is already on screen).
let authModule: typeof import("./pages/auth") | null = null;
const authPages = () => import("./pages/auth").then((m) => (authModule = m));
export const preloadAuthPages = () => authPages();
const LoginLazy = lazy(() => authPages().then((m) => ({ default: m.LoginPage })));
function LoginPage() {
  // Chosen once per mount, so a module that arrives later never swaps the component (and loses what was typed).
  const [Loaded] = useState(() => authModule?.LoginPage ?? null);
  return Loaded ? <Loaded /> : <LoginLazy />;
}
// R35: sign up and forgot password are prerendered too, so they take the loaded module the same way.
const SignupLazy = lazy(() => authPages().then((m) => ({ default: m.SignupPage })));
function SignupPage() {
  const [Loaded] = useState(() => authModule?.SignupPage ?? null);
  return Loaded ? <Loaded /> : <SignupLazy />;
}
const ForgotLazy = lazy(() => authPages().then((m) => ({ default: m.ForgotPasswordPage })));
function ForgotPasswordPage() {
  const [Loaded] = useState(() => authModule?.ForgotPasswordPage ?? null);
  return Loaded ? <Loaded /> : <ForgotLazy />;
}
const ResetPasswordPage = lazy(() => authPages().then((m) => ({ default: m.ResetPasswordPage })));
const EmailVerifiedPage = lazy(() => authPages().then((m) => ({ default: m.EmailVerifiedPage })));
const OAuthAuthorizePage = lazy(() => import("./pages/oauth-authorize").then((m) => ({ default: m.OAuthAuthorizePage })));
const AppLayout = lazy(() => import("./layouts/app").then((m) => ({ default: m.AppLayout })));
const ModerationPage = lazy(() => import("./pages/app/admin-moderation-r35").then((m) => ({ default: m.ModerationPage }))); // R35
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
const DashboardsPage = lazy(() => import("./pages/app/work/dashboards").then((m) => ({ default: m.DashboardsPage }))); // R24.3
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
const SchedulingPage = lazy(() => import("./pages/app/work/scheduling").then((m) => ({ default: m.SchedulingPage })));
const bookPages = () => import("./pages/book");
const BookingPage = lazy(() => bookPages().then((m) => ({ default: m.BookingPage })));
const BookingCancelPage = lazy(() => bookPages().then((m) => ({ default: m.BookingCancelPage })));
const GoalsPage = lazy(() => import("./pages/app/work/goals").then((m) => ({ default: m.GoalsPage })));
const ActivityPage = lazy(() => import("./pages/app/activity").then((m) => ({ default: m.ActivityPage })));
const settings = () => import("./pages/app/settings");
const SettingsLayout = lazy(() => settings().then((m) => ({ default: m.SettingsLayout })));
const GeneralSettings = lazy(() => settings().then((m) => ({ default: m.GeneralSettings })));
const MailSettings = lazy(() => settings().then((m) => ({ default: m.MailSettings })));
const AccountSettings = lazy(() => import("./pages/app/security").then((m) => ({ default: m.AccountSettings })));
const TeamSettings = lazy(() => import("./pages/app/team").then((m) => ({ default: m.TeamSettings })));
const BillingSettings = lazy(() => import("./pages/app/billing").then((m) => ({ default: m.BillingSettings })));
const AuthEmailSettings = lazy(() => import("./pages/app/auth-email-settings").then((m) => ({ default: m.AuthEmailSettings }))); // R27
const ChannelsSettings = lazy(() => import("./pages/app/channels-settings").then((m) => ({ default: m.ChannelsSettings }))); // C1
const CalendarSettings = lazy(() => import("./pages/app/calendar-settings").then((m) => ({ default: m.CalendarSettings })));
const ConnectionsSettings = lazy(() => import("./pages/app/connections").then((m) => ({ default: m.ConnectionsSettings })));
const MailAppsSettings = lazy(() => import("./pages/app/mail-apps").then((m) => ({ default: m.MailAppsSettings })));
const ImportSettings = lazy(() => import("./pages/app/data-move").then((m) => ({ default: m.ImportExportSettings }))); // R38 move your data
const DeveloperSettings = lazy(() => import("./pages/app/developers").then((m) => ({ default: m.DeveloperSettings })));
const DeliverabilityPage = lazy(() => import("./pages/app/deliverability").then((m) => ({ default: m.DeliverabilityPage })));
const StatusPage = lazy(() => import("./pages/status").then((m) => ({ default: m.StatusPage })));
const ChangelogPage = lazy(() => import("./pages/changelog").then((m) => ({ default: m.ChangelogPage }))); // R53 MB-133
const ThanksPage = lazy(() => import("./pages/thanks").then((m) => ({ default: m.ThanksPage })));
const CheckPage = lazy(() => import("./pages/check").then((m) => ({ default: m.CheckPage })));
const TrustPage = lazy(() => import("./pages/trust").then((m) => ({ default: m.TrustPage })));
const ContactUsPage = lazy(() => import("./pages/contact").then((m) => ({ default: m.ContactUsPage })));
const SupportPage = lazy(() => import("./pages/support").then((m) => ({ default: m.SupportPage })));
const DeleteAccountPage = lazy(() => import("./pages/support").then((m) => ({ default: m.DeleteAccountPage })));
const LegalPage = lazy(() => import("./pages/legal").then((m) => ({ default: m.LegalPage })));
const InvitePage = lazy(() => import("./pages/invite").then((m) => ({ default: m.InvitePage })));
const MyWorkPage = lazy(() => import("./pages/app/my-work").then((m) => ({ default: m.MyWorkPage })));
const TriagePage = lazy(() => import("./pages/app/work/triage").then((m) => ({ default: m.TriagePage })));

const page = (node: ReactNode) => <Suspense fallback={null}>{node}</Suspense>;
/** Public pages hold a full screen while their code loads, so the footer never jumps. */
const publicPage = (node: ReactNode) => <Suspense fallback={<div className="min-h-dvh" aria-busy="true" />}>{node}</Suspense>;

export const router = createBrowserRouter([
  {
    element: <MarketingLayout />,
    errorElement: <RouteError />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/pricing", element: publicPage(<PricingPage />) },
      { path: "/startups", element: publicPage(<StartupsPage />) }, // R58 (MB-237): the free plan for small teams
      { path: "/switch", element: publicPage(<SwitchIndexPage />) }, // R58 (MB-237)
      { path: "/switch/:source", element: publicPage(<SwitchPage />) }, // R58 (MB-237): one page per import source
      { path: "/agents", element: publicPage(<AgentsDevPage />) },
      { path: "/developers/mcp", element: publicPage(<McpDocsPage />) }, // R36: MCP tool docs
      { path: "/status", element: publicPage(<StatusPage />) },
      { path: "/changelog", element: publicPage(<ChangelogPage />) }, // R53: What's new
      { path: "/privacy", element: publicPage(<LegalPage slug="privacy" />) },
      { path: "/support", element: publicPage(<SupportPage />) },
      { path: "/contact", element: publicPage(<ContactUsPage />) },
      { path: "/check", element: publicPage(<CheckPage />) },
      { path: "/trust", element: publicPage(<TrustPage />) },
      { path: "/delete-account", element: publicPage(<DeleteAccountPage />) },
      { path: "/terms", element: publicPage(<LegalPage slug="terms" />) },
      { path: "/acceptable-use", element: publicPage(<LegalPage slug="acceptable-use" />) },
      { path: "/dpa", element: publicPage(<LegalPage slug="dpa" />) },
    ],
  },
  {
    element: <AuthLayout />,
    errorElement: <RouteError />,
    // R30: the auth layout holds its own Suspense, so the logo and the card appear together.
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/signup", element: <SignupPage /> },
      { path: "/invite/:token", element: <InvitePage /> },
      { path: "/forgot-password", element: <ForgotPasswordPage /> },
      { path: "/reset-password", element: <ResetPasswordPage /> },
      { path: "/email-verified", element: <EmailVerifiedPage /> },
      { path: "/oauth/authorize", element: <OAuthAuthorizePage /> },
    ],
  },
  {
    path: "/app",
    element: <Suspense fallback={<AppSkeleton />}><AppLayout /></Suspense>,
    errorElement: <RouteError />,
    children: [
      { index: true, element: page(<DashboardPage />) },
      { path: "my-work", element: page(<MyWorkPage />) },
      { path: "triage", element: page(<TriagePage />) },
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
      { path: "dashboards", element: page(<DashboardsPage />) }, // R24.3
      { path: "dashboards/:id", element: page(<DashboardsPage />) },
      { path: "portfolio", element: page(<PortfolioPage />) },
      { path: "chat", element: page(<ChatPage />) },
      { path: "chat/:id", element: page(<ChatPage />) },
      { path: "notifications", element: page(<NotificationsPage />) },
      { path: "templates", element: page(<TemplatesPage />) },
      { path: "goals", element: page(<GoalsPage />) },
      { path: "meetings", element: page(<MeetingsPage />) },
      { path: "meetings/:id", element: page(<MeetingPage />) },
      { path: "scheduling", element: page(<SchedulingPage />) },
      { path: "deliverability", element: page(<DeliverabilityPage />) },
      { path: "admin", element: page(<AdminPage />) },
      { path: "admin/reports", element: page(<ModerationPage />) }, // R35: moderation queue
      {
        path: "settings",
        element: page(<SettingsLayout />),
        children: [
          { index: true, element: page(<GeneralSettings />) },
          { path: "general", element: page(<GeneralSettings />) }, // R38: the phone settings hub opens General here
          { path: "team", element: page(<TeamSettings />) },
          { path: "channels", element: page(<ChannelsSettings />) }, // C1
          { path: "billing", element: page(<BillingSettings />) },
          { path: "account", element: page(<AccountSettings />) },
          { path: "notifications", element: page(<NotificationSettings />) },
          { path: "calendar", element: page(<CalendarSettings />) },
          { path: "mail", element: page(<MailSettings />) },
          { path: "connections", element: page(<ConnectionsSettings />) },
          { path: "mail-apps", element: page(<MailAppsSettings />) },
          { path: "developers", element: page(<DeveloperSettings />) },
          { path: "sign-up-emails", element: page(<AuthEmailSettings />) }, // R27
          { path: "import", element: page(<ImportSettings />) },
        ],
      },
    ],
  },
  // Public pages with no site header: a form anyone can fill in, and a meeting guest link.
  { path: "/f/:slug", element: publicPage(<PublicFormPage />), errorElement: <RouteError /> },
  { path: "/m/:token", element: publicPage(<GuestMeetingPage />), errorElement: <RouteError /> },
  { path: "/book/:slug", element: publicPage(<BookingPage />), errorElement: <RouteError /> },
  { path: "/book/:slug/cancel/:id", element: publicPage(<BookingCancelPage />), errorElement: <RouteError /> },
  // A project guest (a client): the invite link, then the one project they can see.
  { path: "/g/:token", element: publicPage(<GuestAcceptPage />), errorElement: <RouteError /> },
  { path: "/guest", element: publicPage(<GuestProjectPage />), errorElement: <RouteError /> },
  { path: "/thanks", element: publicPage(<ThanksPage />), errorElement: <RouteError /> },
  { path: "/thank-you", element: publicPage(<ThanksPage />), errorElement: <RouteError /> },
  { path: "*", element: <NotFound /> },
]);
