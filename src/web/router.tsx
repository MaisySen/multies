import { Suspense, useState, type ReactNode } from "react";
import { Navigate, createBrowserRouter, useLocation, useParams } from "react-router";
import { RouteError } from "./components/route-error";
import { MarketingLayout } from "./layouts/marketing";
import { AuthLayout } from "./layouts/auth";
import { Landing } from "./pages/landing";
import { NotFound } from "./pages/not-found";
import { ToolFeatureGate } from "./components/tools/feature-gate"; // R66 (MB-259)
import { movedPath } from "@/shared/nav-menu"; // R121
import { useConfig } from "./lib/queries"; // R121
import { SettingsEmbed } from "./components/ui/misc"; // R121

/** R82F (MB-279): an old address that moved; the query and hash ride along (a mailbox sign in comes back with ?connected=). */
function Moved({ to }: { to: string }) {
  const loc = useLocation();
  return <Navigate to={`${to}${loc.search}${loc.hash}`} replace />;
}

/**
 * R121 (NAV_P2_R121): an old Mail setup address (Mailboxes, Domains, Deliverability) opens its new home in Settings,
 * Mail setup, with the id, query and hash kept. With the switch off the old page shows, unchanged.
 */
function MovedWhenP2({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const config = useConfig();
  if (!config.data) return null; // a moment while the switches load (cached after the first page)
  const to = config.data.navP2 ? movedPath(loc.pathname) : null;
  return to ? <Navigate to={`${to}${loc.search}${loc.hash}`} replace /> : <>{children}</>;
}

/** P1 layout: the old Social posts tab of Connections. A sign in coming back lands on Accounts, the rest on New post. */
function MovedSocial() {
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  const back = ["connected", "error", "status", "connected_account_id", "app", "provider"].some((k) => q.has(k));
  return <Navigate to={`${back ? "/app/social/accounts" : "/app/social/new"}${loc.search}${loc.hash}`} replace />;
}

/** R87: go/name typed in the address bar lands in the app, which opens the go link (members only). */
function GoMoved() {
  const { "*": name } = useParams();
  return <Navigate to={`/app/go/${name ?? ""}`} replace />;
}

/** R66 (MB-259): the AI document pages show while any AI feature is on. */
const AI_FEATURES = ["ask", "translate", "extract", "expenses", "contracts"] as const;
import { AppSkeleton } from "./layouts/app-skeleton";
import { lazyPage } from "@/web/components/lazy-page";

// R25: sign-in and the other public pages load on their own, so the landing page carries none of the
// auth client and the app carries none of the marketing pages.
const StartupsPage = lazyPage(() => import("./pages/startups"), "StartupsPage"); // R58 (MB-237)
const switchPages = () => import("./pages/switch"); // R58 (MB-237)
const SwitchIndexPage = lazyPage(() => switchPages(), "SwitchIndexPage");
const SwitchPage = lazyPage(() => switchPages(), "SwitchPage");
const PricingPage = lazyPage(() => import("./pages/pricing"), "PricingPage");
const AgentsDevPage = lazyPage(() => import("./pages/agents"), "AgentsDevPage");
const McpDocsPage = lazyPage(() => import("./pages/mcp-docs"), "McpDocsPage"); // R36
const DevelopersPage = lazyPage(() => import("./pages/developers-hub"), "DevelopersPage"); // R76
// R34 (perf2): the sign in page's module, kept once loaded. On a prerendered /login main.tsx loads it before the first
// render, so the page renders straight away (no Suspense fallback over the card that is already on screen).
let authModule: typeof import("./pages/auth") | null = null;
const authPages = () => import("./pages/auth").then((m) => (authModule = m));
export const preloadAuthPages = () => authPages();
const LoginLazy = lazyPage(() => authPages(), "LoginPage");
function LoginPage() {
  // Chosen once per mount, so a module that arrives later never swaps the component (and loses what was typed).
  const [Loaded] = useState(() => authModule?.LoginPage ?? null);
  return Loaded ? <Loaded /> : <LoginLazy />;
}
// R35: sign up and forgot password are prerendered too, so they take the loaded module the same way.
const SignupLazy = lazyPage(() => authPages(), "SignupPage");
function SignupPage() {
  const [Loaded] = useState(() => authModule?.SignupPage ?? null);
  return Loaded ? <Loaded /> : <SignupLazy />;
}
const ForgotLazy = lazyPage(() => authPages(), "ForgotPasswordPage");
function ForgotPasswordPage() {
  const [Loaded] = useState(() => authModule?.ForgotPasswordPage ?? null);
  return Loaded ? <Loaded /> : <ForgotLazy />;
}
const ResetPasswordPage = lazyPage(() => authPages(), "ResetPasswordPage");
const EmailVerifiedPage = lazyPage(() => authPages(), "EmailVerifiedPage");
const OAuthAuthorizePage = lazyPage(() => import("./pages/oauth-authorize"), "OAuthAuthorizePage");
const AppLayout = lazyPage(() => import("./layouts/app"), "AppLayout");
const ModerationPage = lazyPage(() => import("./pages/app/admin-moderation-r35"), "ModerationPage"); // R35
const AdminPage = lazyPage(() => import("./pages/app/admin"), "AdminPage");
const DashboardPage = lazyPage(() => import("./pages/app/dashboard"), "DashboardPage");
const DomainsPage = lazyPage(() => import("./pages/app/domains"), "DomainsPage");
const DomainDetailPage = lazyPage(() => import("./pages/app/domain-detail"), "DomainDetailPage");
const MailboxesPage = lazyPage(() => import("./pages/app/mailboxes"), "MailboxesPage");
const WebmailPage = lazyPage(() => import("./pages/app/webmail"), "WebmailPage");
const MailRulesPage = lazyPage(() => import("./pages/app/mail/rules-r85"), "MailRulesPage"); // R85
const agentPages = () => import("./pages/app/agents");
const AgentsPage = lazyPage(() => agentPages(), "AgentsPage");
const AgentDetailPage = lazyPage(() => agentPages(), "AgentDetailPage");
const ApprovalsPage = lazyPage(() => import("./pages/app/approvals"), "ApprovalsPage");
const TeamInboxPage = lazyPage(() => import("./pages/app/inbox"), "TeamInboxPage");
const HelpdeskSettingsPage = lazyPage(() => import("./pages/app/helpdesk-settings"), "HelpdeskSettingsPage"); // R119
const HelpCenterPage = lazyPage(() => import("./pages/app/help-center"), "HelpCenterPage"); // R122
const SitesPage = lazyPage(() => import("./pages/app/sites"), "SitesPage"); // R123
const SiteEditorPage = lazyPage(() => import("./pages/app/sites"), "SiteEditorPage"); // R123
const PostEditorPage = lazyPage(() => import("./pages/app/blog-r124"), "PostEditorPage"); // R124
const DocsLinksPage = lazyPage(() => import("./pages/app/docs-links-r103"), "DocsLinksPage"); // R103
const work = () => import("./pages/app/work/tasks");
const TasksPage = lazyPage(() => work(), "TasksPage");
const TaskPageRoute = lazyPage(() => work(), "TaskPageRoute"); // R84: the full task page
const docsPages = () => import("./pages/app/work/docs");
const DocsPage = lazyPage(() => docsPages(), "DocsPage");
const DocPage = lazyPage(() => docsPages(), "DocPage");
const MyLearningPage = lazyPage(() => import("./pages/app/work/courses-r129"), "MyLearningPage"); // R129
const contactPages = () => import("./pages/app/work/contacts");
const ContactsPage = lazyPage(() => contactPages(), "ContactsPage");
const ContactPage = lazyPage(() => contactPages(), "ContactPage");
const PortalPage = lazyPage(() => import("./pages/app/work/portals"), "PortalPage"); // R120
const DealsPage = lazyPage(() => import("./pages/app/work/deals"), "DealsPage");
const InvoicesPage = lazyPage(() => import("./pages/app/work/invoices-r105"), "InvoicesPage"); // R105
const InvoiceDocPage = lazyPage(() => import("./pages/app/work/invoices-r105"), "InvoiceDocPage"); // R105
const InvoiceViewPage = lazyPage(() => import("./pages/invoice-view"), "InvoiceViewPage"); // R105
const CompanyPage = lazyPage(() => import("./pages/app/work/crm-contacts-r94"), "CompanyPage"); // R94
const AutomationsPage = lazyPage(() => import("./pages/app/work/automations"), "AutomationsPage");
// R90: one Automations home (flows, rules, runs), the flow editor and the run log.
const AutomationsHubPage = lazyPage(() => import("./pages/app/automations/hub"), "AutomationsHubPage");
const FlowEditorPage = lazyPage(() => import("./pages/app/automations/editor"), "FlowEditorPage");
const RunsPage = lazyPage(() => import("./pages/app/automations/runs"), "RunsPage");
const RunDetailPage = lazyPage(() => import("./pages/app/automations/runs"), "RunDetailPage");
const TimesheetPage = lazyPage(() => import("./pages/app/work/time"), "TimesheetPage");
const formPages = () => import("./pages/app/work/forms");
const FormsPage = lazyPage(() => formPages(), "FormsPage");
const PublicFormPage = lazyPage(() => formPages(), "PublicFormPage");
const PublicBoardPage = lazyPage(() => import("./pages/app/work/forms-plus/public-board"), "PublicBoardPage"); // R93
const ReportsPage = lazyPage(() => import("./pages/app/work/reports"), "ReportsPage");
const DashboardsPage = lazyPage(() => import("./pages/app/work/dashboards"), "DashboardsPage"); // R24.3
const meetingPages = () => import("./pages/app/work/meetings");
const MeetingsPage = lazyPage(() => meetingPages(), "MeetingsPage");
const MeetingPage = lazyPage(() => meetingPages(), "MeetingPage");
const GuestMeetingPage = lazyPage(() => meetingPages(), "GuestMeetingPage");
const webinarPages = () => import("./pages/app/work/webinar-r114"); // R114: webinar mode
const WebinarHostPage = lazyPage(() => webinarPages(), "WebinarHostPage");
const WebinarRegisterPage = lazyPage(() => webinarPages(), "WebinarRegisterPage");
const WebinarAttendeePage = lazyPage(() => webinarPages(), "WebinarAttendeePage");
const WebinarReplayPage = lazyPage(() => webinarPages(), "WebinarReplayPage");
const PortfolioPage = lazyPage(() => import("./pages/app/work/portfolio"), "PortfolioPage");
const guestPages = () => import("./pages/app/work/guest");
const GuestAcceptPage = lazyPage(() => guestPages(), "GuestAcceptPage");
const GuestProjectPage = lazyPage(() => guestPages(), "GuestProjectPage");
const ChatPage = lazyPage(() => import("./pages/app/work/chat"), "ChatPage");
const notificationPages = () => import("./pages/app/notifications");
const NotificationsPage = lazyPage(() => notificationPages(), "NotificationsPage");
const NotificationSettings = lazyPage(() => notificationPages(), "NotificationSettings");
const TemplatesPage = lazyPage(() => import("./pages/app/work/templates"), "TemplatesPage");
const ToolsPage = lazyPage(() => import("./pages/app/tools"), "ToolsPage");
const ToolsAiPage = lazyPage(() => import("./pages/app/tools-ai"), "ToolsAiPage"); // Tools P2: AI documents
const AskPage = lazyPage(() => import("./pages/app/tools-ask/ask"), "AskPage"); // R110: Ask across the workspace
const VaultPage = lazyPage(() => import("./pages/app/tools-vault/vault"), "VaultPage"); // R128: team password vault
const ToolsEditorRoute = lazyPage(() => import("./pages/app/tools-editors/route"), "ToolsEditorRoute"); // Tools P2: editors
const ConvertHubPage = lazyPage(() => import("./pages/app/tools-convert/convert-hub"), "ConvertHubPage");
const UtilitiesPage = lazyPage(() => import("./pages/app/tools-c/utilities"), "UtilitiesPage"); // R100
const PdfFixPage = lazyPage(() => import("./pages/app/tools-c/pdf-pages"), "PdfFixPage"); // R100
const ImageLinksPage = lazyPage(() => import("./pages/app/tools-c/image-links"), "ImageLinksPage"); // R100b
const PdfCodesPage = lazyPage(() => import("./pages/app/tools-c/pdf-pages"), "PdfCodesPage"); // R100
const PdfCommentsPage = lazyPage(() => import("./pages/app/tools-c/pdf-pages"), "PdfCommentsPage"); // R100
const EditPdfPage = lazyPage(() => import("./pages/app/tools-edit-pdf/edit-pdf"), "EditPdfPage"); // R86: Edit PDF on the device // R78: Convert hub
const FilesPage = lazyPage(() => import("./pages/app/files"), "FilesPage"); // Tools P2 (16)
const OfficeEditorPage = lazyPage(() => import("./pages/app/files-office-r113"), "OfficeEditorPage"); // R113
const ShareLinksPage = lazyPage(() => import("./pages/app/tools-share-sign/share-links"), "ShareLinksPage"); // Tools P2: share links
const LinksPage = lazyPage(() => import("./pages/app/tools-links/links-page"), "LinksPage"); // R87: Links
const GoOpenPage = lazyPage(() => import("./pages/app/tools-links/go-open"), "GoOpenPage"); // R87: go links
const SignPage = lazyPage(() => import("./pages/app/tools-share-sign/sign"), "SignPage"); // Tools P2: e-sign
// Tools P2: automation pages
const WorkflowsPage = lazyPage(() => import("./pages/app/tools-automation/workflows"), "WorkflowsPage");
const DocTemplatesPage = lazyPage(() => import("./pages/app/tools-automation/templates"), "TemplatesPage");
const MergePage = lazyPage(() => import("./pages/app/tools-automation/campaigns-r109"), "MergeEntry"); // R109: the merge page with newsletters, lists, journeys
const MergeListPage = lazyPage(() => import("./pages/app/tools-automation/campaigns-r109"), "ListPage");
const MergeNewsletterPage = lazyPage(() => import("./pages/app/tools-automation/campaigns-r109-editor"), "NewsletterPage");
const MergeJourneyPage = lazyPage(() => import("./pages/app/tools-automation/campaigns-r109-editor"), "JourneyPage");
const SchedulingPage = lazyPage(() => import("./pages/app/work/scheduling"), "SchedulingPage");
const bookPages = () => import("./pages/book");
const BookingPage = lazyPage(() => bookPages(), "BookingPage");
const PublicDashboardPage = lazyPage(() => import("./pages/public-dashboard"), "PublicDashboardPage"); // R91
const BookingCancelPage = lazyPage(() => bookPages(), "BookingCancelPage");
// R92: public time poll, event and ticket pages (logged out, phone first).
const bookPlusPages = () => import("./pages/book-plus");
const PollVotePage = lazyPage(() => bookPlusPages(), "PollVotePage");
const EventRsvpPage = lazyPage(() => bookPlusPages(), "EventRsvpPage");
const TicketPage = lazyPage(() => bookPlusPages(), "TicketPage");
const GoalsPage = lazyPage(() => import("./pages/app/work/goals"), "GoalsPage");
const ActivityPage = lazyPage(() => import("./pages/app/activity"), "ActivityPage");
const settings = () => import("./pages/app/settings");
const SettingsLayout = lazyPage(() => settings(), "SettingsLayout");
const GeneralSettings = lazyPage(() => settings(), "GeneralSettings");
const MailSettings = lazyPage(() => settings(), "MailSettings");
const AccountSettings = lazyPage(() => import("./pages/app/security"), "AccountSettings");
const TeamSettings = lazyPage(() => import("./pages/app/team"), "TeamSettings");
const BillingSettings = lazyPage(() => import("./pages/app/billing"), "BillingSettings");
const AuthEmailSettings = lazyPage(() => import("./pages/app/auth-email-settings"), "AuthEmailSettings"); // R27
const ChannelsSettings = lazyPage(() => import("./pages/app/channels-settings"), "ChannelsSettings"); // C1
const brandingSettings = () => import("./pages/app/branding-settings"); // R77
const BrandingSettings = lazyPage(() => brandingSettings(), "BrandingSettings");
const AppearanceSettings = lazyPage(() => brandingSettings(), "AppearanceSettings");
const MailArchiveSettings = lazyPage(() => import("./pages/app/mail-archive-settings"), "MailArchiveSettings"); // R111
const DataRequestsSettings = lazyPage(() => import("./pages/app/data-requests-r112"), "DataRequestsSettings"); // R112
const reportPages = () => import("./pages/app/work/reports-r112/public-pages"); // R112
const PublicReportPage = lazyPage(() => reportPages(), "PublicReportPage");
const PublicDataRequestPage = lazyPage(() => reportPages(), "PublicDataRequestPage");
const DataRequestVerifyPage = lazyPage(() => reportPages(), "DataRequestVerifyPage");
const DataRequestDownloadPage = lazyPage(() => reportPages(), "DataRequestDownloadPage");
const CalendarSettings = lazyPage(() => import("./pages/app/calendar-settings"), "CalendarSettings");
const AppsSettings = lazyPage(() => import("./pages/app/apps-settings"), "AppsSettings"); // R80C: Connections hub
const social = () => import("./pages/app/social"); // P1 layout: Social, out of Settings
const SocialPlannerPage = lazyPage(() => social(), "SocialPlannerPage");
const SocialPostsPage = lazyPage(() => social(), "SocialPostsPage");
const SocialNewPostPage = lazyPage(() => social(), "SocialNewPostPage");
const SocialAccountsPage = lazyPage(() => social(), "SocialAccountsPage");
const SocialLibraryPage = lazyPage(() => social(), "SocialLibraryPage"); // R117
const SocialInboxPage = lazyPage(() => import("./pages/app/social-inbox"), "SocialInboxPage"); // R118
const SocialAnalyticsPage = lazyPage(() => import("./pages/app/social-analytics"), "SocialAnalyticsPage"); // R118
const MailAppsSettings = lazyPage(() => import("./pages/app/mail-apps"), "MailAppsSettings");
const ImportSettings = lazyPage(() => import("./pages/app/data-move"), "ImportExportSettings"); // R38 move your data
const DeveloperSettings = lazyPage(() => import("./pages/app/developers"), "DeveloperSettings");
const DeliverabilityPage = lazyPage(() => import("./pages/app/deliverability"), "DeliverabilityPage");
const StatusPage = lazyPage(() => import("./pages/status"), "StatusPage");
const ChangelogPage = lazyPage(() => import("./pages/changelog"), "ChangelogPage"); // R53 MB-133
const FeaturesIndexPage = lazyPage(() => import("./pages/features"), "FeaturesIndexPage"); // W1
const FeatureAreaRoute = lazyPage(() => import("./pages/features"), "FeatureAreaRoute"); // W1
const ThanksPage = lazyPage(() => import("./pages/thanks"), "ThanksPage");
const CheckPage = lazyPage(() => import("./pages/check"), "CheckPage");
const TrustPage = lazyPage(() => import("./pages/trust"), "TrustPage");
const ContactUsPage = lazyPage(() => import("./pages/contact"), "ContactUsPage");
const SupportPage = lazyPage(() => import("./pages/support"), "SupportPage");
const DeleteAccountPage = lazyPage(() => import("./pages/support"), "DeleteAccountPage");
const LegalPage = lazyPage(() => import("./pages/legal"), "LegalPage");
const InvitePage = lazyPage(() => import("./pages/invite"), "InvitePage");
const MyWorkPage = lazyPage(() => import("./pages/app/my-work"), "MyWorkPage");
const TriagePage = lazyPage(() => import("./pages/app/work/triage"), "TriagePage");

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
      { path: "/developers", element: publicPage(<DevelopersPage />) }, // R76: the developer hub
      { path: "/developers/mcp", element: publicPage(<McpDocsPage />) }, // R36: MCP tool docs
      { path: "/status", element: publicPage(<StatusPage />) },
      { path: "/changelog", element: publicPage(<ChangelogPage />) }, // R53: What's new
      { path: "/whats-new", element: publicPage(<ChangelogPage />) }, // W1: the public What's new address
      { path: "/features", element: publicPage(<FeaturesIndexPage />) }, // W1
      { path: "/features/:area", element: publicPage(<FeatureAreaRoute />) }, // W1: one page per product area
      { path: "/privacy", element: publicPage(<LegalPage slug="privacy" />) },
      { path: "/support", element: publicPage(<SupportPage />) },
      { path: "/contact", element: publicPage(<ContactUsPage />) },
      { path: "/check", element: publicPage(<CheckPage />) },
      { path: "/trust", element: publicPage(<TrustPage />) },
      { path: "/security", element: publicPage(<TrustPage />) }, // R60: the address security reviews and assistants try first
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
      { path: "domains", element: <MovedWhenP2>{page(<DomainsPage />)}</MovedWhenP2> }, // R121: Settings, Mail setup when P2 is on
      { path: "domains/:id", element: <MovedWhenP2>{page(<DomainDetailPage />)}</MovedWhenP2> },
      { path: "mailboxes", element: <MovedWhenP2>{page(<MailboxesPage />)}</MovedWhenP2> },
      { path: "mail", element: page(<WebmailPage />) },
      { path: "mail/rules", element: page(<MailRulesPage />) }, // R85
      { path: "inbox", element: page(<TeamInboxPage />) },
      { path: "inbox/helpdesk", element: page(<HelpdeskSettingsPage />) }, // R119
      { path: "social", element: page(<SocialPlannerPage />) }, // P1 layout
      { path: "social/posts", element: page(<SocialPostsPage />) },
      { path: "social/new", element: page(<SocialNewPostPage />) },
      { path: "social/accounts", element: page(<SocialAccountsPage />) },
      { path: "social/library", element: page(<SocialLibraryPage />) },
      { path: "social/inbox", element: page(<SocialInboxPage />) }, // R118
      { path: "social/analytics", element: page(<SocialAnalyticsPage />) }, // R118
      { path: "social/planner", element: <Moved to="/app/social" /> },
      { path: "social/compose", element: <Moved to="/app/social/new" /> },
      { path: "agents", element: page(<AgentsPage />) },
      { path: "agents/:id", element: page(<AgentDetailPage />) },
      { path: "approvals", element: page(<ApprovalsPage />) },
      { path: "activity", element: page(<ActivityPage />) },
      { path: "tasks", element: page(<TasksPage />) },
      { path: "tasks/:ref", element: page(<TaskPageRoute />) }, // R84
      { path: "docs", element: page(<DocsPage />) },
      { path: "docs/help-center", element: page(<HelpCenterPage />) }, // R122
      { path: "docs/sites", element: page(<SitesPage />) }, // R123
      { path: "docs/sites/blog/:postId", element: page(<PostEditorPage />) }, // R124
      { path: "docs/sites/:pageId", element: page(<SiteEditorPage />) }, // R123
      { path: "docs/links", element: page(<DocsLinksPage />) }, // R103
      { path: "docs/learning", element: page(<MyLearningPage />) }, // R129: My learning
      { path: "docs/:id", element: page(<DocPage />) },
      { path: "contacts", element: page(<ContactsPage />) },
      { path: "contacts/portals/:id", element: page(<PortalPage />) }, // R120
      { path: "contacts/invoices", element: page(<InvoicesPage />) }, // R105
      { path: "contacts/invoices/:id", element: page(<InvoiceDocPage />) }, // R105
      { path: "contacts/:id", element: page(<ContactPage />) },
      { path: "contacts/companies/:id", element: page(<CompanyPage />) }, // R94
      { path: "deals", element: page(<DealsPage />) },
      { path: "automations", element: page(<AutomationsHubPage />) },
      { path: "automations/rules", element: page(<AutomationsPage />) },
      { path: "automations/flows/:id", element: page(<FlowEditorPage />) },
      { path: "automations/runs", element: page(<RunsPage />) },
      { path: "automations/runs/:id", element: page(<RunDetailPage />) },
      { path: "integrations", element: <Moved to="/app/settings/apps/webhooks" /> }, // R82F (MB-279): now a tab of Connections
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
      { path: "meetings/:id/webinar", element: page(<WebinarHostPage />) }, // R114
      { path: "scheduling", element: page(<SchedulingPage />) },
      { path: "tools", element: page(<ToolsPage />) }, // Tools P1
      { path: "tools/vault", element: page(<VaultPage />) }, // R128 (VAULT_R128; the page shows not found while it is off)
      { path: "tools/ask", element: page(<AskPage />) }, // R110 (ASK_R110; the page shows not found while it is off)
      { path: "tools/ai", element: page(<ToolFeatureGate features={AI_FEATURES}><ToolsAiPage /></ToolFeatureGate>) }, // Tools P2: AI documents
      { path: "tools/convert", element: page(<ConvertHubPage />) },
      { path: "tools/edit-pdf", element: page(<EditPdfPage />) }, // R86 // R78: Convert hub (before the editors' :editor)
      { path: "tools/links", element: page(<ToolFeatureGate features={["links"]}><LinksPage /></ToolFeatureGate>) }, // R87: Links (before :editor)
      { path: "go/:name", element: page(<ToolFeatureGate features={["links"]}><GoOpenPage /></ToolFeatureGate>) }, // R87: go links
      { path: "tools/utilities", element: page(<ToolFeatureGate features={["tools_c"]}><UtilitiesPage /></ToolFeatureGate>) }, // R100
      { path: "tools/utilities/:id", element: page(<ToolFeatureGate features={["tools_c"]}><UtilitiesPage /></ToolFeatureGate>) }, // R100
      { path: "tools/image-links", element: page(<ToolFeatureGate features={["tools_c2"]}><ImageLinksPage /></ToolFeatureGate>) }, // R100b
      { path: "tools/pdf-fix", element: page(<ToolFeatureGate features={["tools_c"]}><PdfFixPage /></ToolFeatureGate>) }, // R100
      { path: "tools/pdf-codes", element: page(<ToolFeatureGate features={["tools_c"]}><PdfCodesPage /></ToolFeatureGate>) }, // R100
      { path: "tools/pdf-comments", element: page(<ToolFeatureGate features={["tools_c"]}><PdfCommentsPage /></ToolFeatureGate>) }, // R100
      { path: "tools/:editor", element: page(<ToolsEditorRoute />) }, // Tools P2: editors (pages, forms, compare)
      { path: "files", element: page(<ToolFeatureGate features={["folders", "index"]} orFilesPlus><FilesPage /></ToolFeatureGate>) }, // Tools P2 (16): smart folders
      { path: "files/edit/:id", element: page(<ToolFeatureGate features={["folders", "index"]} orFilesPlus><OfficeEditorPage /></ToolFeatureGate>) }, // R113: office files in the browser
      { path: "tools/share", element: page(<ToolFeatureGate features={["share"]}><ShareLinksPage /></ToolFeatureGate>) }, // Tools P2: share links
      { path: "tools/sign", element: page(<ToolFeatureGate features={["esign"]}><SignPage /></ToolFeatureGate>) }, // Tools P2: e-sign
      { path: "tools/workflows", element: page(<ToolFeatureGate features={["workflows"]}><WorkflowsPage /></ToolFeatureGate>) }, // Tools P2: workflows
      { path: "tools/templates", element: page(<ToolFeatureGate features={["templates"]}><DocTemplatesPage /></ToolFeatureGate>) }, // Tools P2: templates
      { path: "tools/merge", element: page(<ToolFeatureGate features={["merge_mail", "merge_plus_r109"]}><MergePage /></ToolFeatureGate>) }, // Tools P2: mail merge (R109: plus newsletters, lists, journeys)
      { path: "tools/merge/lists/:id", element: page(<ToolFeatureGate features={["merge_plus_r109"]}><MergeListPage /></ToolFeatureGate>) }, // R109
      { path: "tools/merge/newsletters/:id", element: page(<ToolFeatureGate features={["merge_plus_r109"]}><MergeNewsletterPage /></ToolFeatureGate>) }, // R109
      { path: "tools/merge/journeys/:id", element: page(<ToolFeatureGate features={["merge_plus_r109"]}><MergeJourneyPage /></ToolFeatureGate>) }, // R109
      { path: "deliverability", element: <MovedWhenP2>{page(<DeliverabilityPage />)}</MovedWhenP2> },
      { path: "admin", element: page(<AdminPage />) },
      { path: "admin/reports", element: page(<ModerationPage />) }, // R35: moderation queue
      {
        path: "settings",
        element: page(<SettingsLayout />),
        children: [
          { index: true, element: page(<GeneralSettings />) },
          { path: "general", element: page(<GeneralSettings />) }, // R38: the phone settings hub opens General here
          { path: "branding", element: page(<BrandingSettings />) }, // R77
          { path: "appearance", element: page(<AppearanceSettings />) }, // R77
          { path: "team", element: page(<TeamSettings />) },
          { path: "channels", element: page(<ChannelsSettings />) }, // C1
          { path: "apps", element: page(<AppsSettings />) }, // R80C: Connections hub
          { path: "apps/social", element: <MovedSocial /> }, // P1 layout: Social posts moved to Social
          { path: "apps/mail", element: page(<AppsSettings />) }, // R82F (MB-279): mail accounts, was Connected accounts
          { path: "apps/webhooks", element: page(<AppsSettings />) }, // R82F (MB-279): webhooks, was Integrations
          { path: "billing", element: page(<BillingSettings />) },
          { path: "account", element: page(<AccountSettings />) },
          { path: "notifications", element: page(<NotificationSettings />) },
          { path: "calendar", element: page(<CalendarSettings />) },
          { path: "mail", element: page(<MailSettings />) },
          // R121: Settings, Mail setup (layout plan P2): the same pages, inside the one Settings sidebar.
          { path: "mailboxes", element: page(<SettingsEmbed><MailboxesPage /></SettingsEmbed>) },
          { path: "domains", element: page(<SettingsEmbed><DomainsPage /></SettingsEmbed>) },
          { path: "domains/:id", element: page(<SettingsEmbed><DomainDetailPage /></SettingsEmbed>) },
          { path: "deliverability", element: page(<SettingsEmbed><DeliverabilityPage /></SettingsEmbed>) },
          { path: "connections", element: <Moved to="/app/settings/apps/mail" /> }, // R82F (MB-279)
          { path: "mail-apps", element: page(<MailAppsSettings />) },
          { path: "mail-archive", element: page(<MailArchiveSettings />) }, // R111: archive and retention (MAIL_ARCHIVE_R111)
          { path: "data-requests", element: page(<DataRequestsSettings />) }, // R112: data requests (REPORTING_R112)
          { path: "developers", element: page(<DeveloperSettings />) },
          { path: "sign-up-emails", element: page(<AuthEmailSettings />) }, // R27
          { path: "import", element: page(<ImportSettings />) },
        ],
      },
    ],
  },
  // Public pages with no site header: a form anyone can fill in, and a meeting guest link.
  { path: "/f/:slug", element: publicPage(<PublicFormPage />), errorElement: <RouteError /> },
  { path: "/f/:slug/embed", element: publicPage(<PublicFormPage />), errorElement: <RouteError /> }, // R93: inside the website bubble
  { path: "/fb/:slug", element: publicPage(<PublicBoardPage />), errorElement: <RouteError /> }, // R93: public feedback board
  // R112: anonymous reports and data requests (the verify and download pages come before the page with a workspace id).
  { path: "/report/:slug", element: publicPage(<PublicReportPage />), errorElement: <RouteError /> },
  { path: "/data-request/verify/:token", element: publicPage(<DataRequestVerifyPage />), errorElement: <RouteError /> },
  { path: "/data-request/download/:token", element: publicPage(<DataRequestDownloadPage />), errorElement: <RouteError /> },
  { path: "/data-request/:slug", element: publicPage(<PublicDataRequestPage />), errorElement: <RouteError /> },
  { path: "/m/:token", element: publicPage(<GuestMeetingPage />), errorElement: <RouteError /> },
  { path: "/book/poll/:token", element: publicPage(<PollVotePage />), errorElement: <RouteError /> },
  { path: "/book/event/:slug", element: publicPage(<EventRsvpPage />), errorElement: <RouteError /> },
  { path: "/book/ticket/:id", element: publicPage(<TicketPage />), errorElement: <RouteError /> },
  { path: "/w/:slug", element: publicPage(<WebinarRegisterPage />), errorElement: <RouteError /> }, // R114
  { path: "/w/a/:token", element: publicPage(<WebinarAttendeePage />), errorElement: <RouteError /> }, // R114
  { path: "/w/a/:token/replay", element: publicPage(<WebinarReplayPage />), errorElement: <RouteError /> }, // R114
  { path: "/book/:slug", element: publicPage(<BookingPage />), errorElement: <RouteError /> },
  { path: "/i/:token", element: publicPage(<InvoiceViewPage />), errorElement: <RouteError /> }, // R105
  { path: "/dash/:token", element: publicPage(<PublicDashboardPage />), errorElement: <RouteError /> }, // R91: public dashboard link
  { path: "/book/:slug/cancel/:id", element: publicPage(<BookingCancelPage />), errorElement: <RouteError /> },
  // A project guest (a client): the invite link, then the one project they can see.
  { path: "/g/:token", element: publicPage(<GuestAcceptPage />), errorElement: <RouteError /> },
  { path: "/guest", element: publicPage(<GuestProjectPage />), errorElement: <RouteError /> },
  { path: "/go/*", element: <GoMoved />, errorElement: <RouteError /> }, // R87
  { path: "/thanks", element: publicPage(<ThanksPage />), errorElement: <RouteError /> },
  { path: "/thank-you", element: publicPage(<ThanksPage />), errorElement: <RouteError /> },
  { path: "*", element: <NotFound /> },
]);
