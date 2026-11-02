import { productAnalyticsConfig, type ProductAnalyticsConfig } from "./services/product-analytics";
import { testNetworkAllowed } from "@/shared/social-p2b";
import { parseToolFeatures, type ToolFeature } from "@/shared/tool-features";
import { z } from "zod";
import { parseSocialConnections, type SocialConnection } from "./auth/social-connections";

/** Where a DNS lookup goes. `doh` works everywhere (incl. Workers); `node` uses the OS resolver. */
export type DnsResolverKind = "doh" | "node";

export interface AppConfig {
  /** `production` never seeds or fakes anything. `development` relaxes cookie security. */
  mode: "production" | "development";
  /** When true, visitors can open a sandbox workspace filled with sample data. */
  demoEnabled: boolean;
  /** R90: automation builder: flows, runs, page and feed watches, digests (FLOWS, on unless "off"). */
  flows?: boolean;
  /** R117: Social composer v2, planner views and slots, drafts and approvals, library, evergreen (SOCIAL_P2, on unless "off"). */
  socialP2?: boolean;
  /** R118: Social inbox, account health alerts and analytics (SOCIAL_P2B, on unless "off"). */
  socialP2b?: boolean;
  /** R109: on staging, bulk mail (newsletters, journeys, confirm emails) only to these addresses, @domains or name+*@domain (CAMPAIGN_SEND_ALLOW plus the CAMPAIGN_SEND_ALLOW_EXTRA secret). Empty = no limit. */
  campaignSendAllow?: string[];
  /** R118: the staging only test network (SOCIAL_TEST_NETWORK=on and a staging or local APP_URL; refused on multies.si). */
  socialTestNetwork?: boolean;
  /** R120: client portals in Contacts and the public /p pages (CLIENT_PORTAL=on). Off unless set. */
  clientPortal?: boolean;
  /** R111: mail archive and retention (MAIL_ARCHIVE_R111=on). Off unless set. Even on, nothing is deleted until a workspace admin turns a policy on. */
  mailArchive?: boolean;
  /** Public booking pages and the scheduling API (SCHEDULING_ENABLED=true). Off unless set. */
  schedulingEnabled: boolean;
  /** R94: CRM_TIMELINE (paged contact and company timeline, logged calls and notes, segments, CSV import, deal forecast). Off unless set. */
  crmTimeline?: boolean;
  /** R108: CONTRACTS_R108 (contract templates, guided interview, clause library, reminders). Off unless set. */
  contractsR108?: boolean;
  /** R113: OFFICE_EDIT_R113 (open DOCX, XLSX, CSV in the browser editors and PPTX as slides; saves are new Files versions). Off unless set. */
  officeEditR113?: boolean;
  /** R131: HOME_WIDGETS_R131 (drag to arrange widgets on Home, Overview). Off unless set: Overview unchanged. */
  homeWidgetsR131?: boolean;
  /** R132: SOCIAL_P3_R132 (Pinterest pin details, YouTube comments and health, Snapchat share, best times, writing help). Off unless set. */
  socialP3R132?: boolean;
  /** R132 held sub flags (stay off): YouTube upload needs video storage; Google Business Profile needs API access and our own sign in app. */
  socialYoutubeUploadR132?: boolean;
  socialGbpR132?: boolean;
  /** R91: DASHBOARDS_PLUS (public links, emailed reports, question builder, alerts, data sources). Off unless set. */
  dashboardsPlus?: boolean;
  dashboardsPlusTestHook?: boolean;
  /** R98: SEARCH_R98 (typo tolerant search with filters, files and notes, and the instant index). Off unless set. */
  searchR98?: boolean;
  /** R115: MAPS_R115 (address lookup on contacts, companies and booking pages, map pins, visit routes). Off unless set. */
  mapsR115?: boolean;
  /** R115: MAPS_GEO_MOCK=1 answers address lookups from a fixed local list (e2e and local runs only; never set on Workers). */
  mapsGeoMock?: boolean;
  /** R110: more workspaces (ids, slugs or names, comma separated) kept out of Ask; vv8k is always out. */
  askExclude?: string;
  /** R110: ASK_R110 (Ask across the workspace in Tools and the command menu). Off unless set. */
  askR110?: boolean;
  /** R125: tables, a doc type (TABLES_R125). Off unless set. */
  tablesR125?: boolean;
  /** POL1: P1 polish, new behaviour only (tables and courses to the trash with restore). POLISH_POL1, off unless set. */
  polishPol1?: boolean;
  /** R125: more workspaces kept out of tables (vv8k is always out). */
  tablesExclude?: string;
  /** R129: courses, a doc type (COURSES_R129). Off unless set. */
  coursesR129?: boolean;
  /** R129: more workspaces kept out of courses (vv8k is always out). */
  coursesExclude?: string;
  /** R128: VAULT_R128 (team password vault in Tools). Off unless set. */
  vaultR128?: boolean;
  /** R128: more workspaces kept out of the vault; vv8k is always out. */
  vaultExclude?: string;
  /** R105: invoices and quotes (INVOICES_ENABLED=true). Off unless set. */
  invoicesEnabled: boolean;
  /** R92 Booking plus: resources, time polls, free events with QR tickets (BOOKING_PLUS=true, needs scheduling). */
  bookingPlus: boolean;
  /** R93 Forms plus: chat style forms, webhook, embed bubble, feedback boards, calls for submissions, NPS and CSAT (FORMS_PLUS_R93=true). */
  formsPlus?: boolean;
  /** R112: anonymous reporting channel (Forms > Reports) and data requests (Settings > Data requests) (REPORTING_R112=on). Off unless set. */
  reporting?: boolean;
  /** R93: more workspaces (ids, slugs or names, comma separated) kept out of Forms plus; vv8k is always out. */
  formsPlusExclude?: string;
  /** R92 spam shield proof of work bits (SHIELD_DIFFICULTY, default 14; tests use less). */
  shieldDifficulty: number;
  /** R106: expenses and receipts (EXPENSES_R106=on). Off unless set. */
  expensesR106: boolean;
  /** R106 tests only: a receipt's own bytes are read as its text (never in production). */
  expensesFakeRead?: boolean;
  /**
   * Tools P1: document tools on the private document engine. On only when TOOLS_ENABLED=true and the
   * engine address and both keys are set (DOC_ENGINE_URL, DOC_ENGINE_KEY_ID, DOC_ENGINE_KEY, TOOLS_TOKEN_KEY).
   */
  /** R87: Links (short links, bio pages): how long an isolate gathers clicks before one batched write (LINK_CLICK_FLUSH_MS). */
  links?: { flushMs: number };
  tools: { enabled: boolean; engine: { url: string; keyId: string; key: string } | null; tokenKey: string | null; /** Tools P2: the advanced features switched on (TOOLS_FEATURES). */ features: ToolFeature[] };
  appName: string;
  /** Where people reach support (support page, store listings). SUPPORT_EMAIL. */
  supportEmail: string;
  /** Cloudflare Web Analytics beacon token (cookieless). Unset means no analytics. */
  cfBeaconToken: string | null;
  /** ANALYTICS-PH: internal product usage analytics (ANALYTICS_PH on plus POSTHOG_KEY and ANALYTICS_HASH_KEY). Null means off. */
  productAnalytics?: ProductAnalyticsConfig | null;
  appUrl: string;
  /** Root secret for at-rest encryption. Must be long and random in production. */
  appSecret: string;
  dnsResolver: DnsResolverKind;
  mail: {
    /** MX records customers must publish, e.g. Cloudflare Email Routing's hosts. */
    mxHosts: { host: string; priority: number }[];
    /** SPF `include:` mechanisms customers must publish. */
    spfIncludes: string[];
    dkimSelector: string;
    /** Optional mailbox for DMARC aggregate reports; defaults to dmarc@<domain>. */
    dmarcRua?: string;
  };
  /** `resendWebhookSecret` verifies delivery, bounce and complaint events from Resend. */
  outbound: { driver: "log" | "resend"; resendApiKey?: string; resendWebhookSecret?: string };
  /** Sign-in options beyond email + password. Each turns on when its keys are set. */
  auth: {
    social: { google?: { clientId: string; clientSecret: string }; github?: { clientId: string; clientSecret: string } };
    /** The identity provider for people (OIDC, Universal Login). `nativeClientId` is the mobile app's public client. */
    auth0?: {
      domain: string; clientId: string; clientSecret: string; nativeClientId?: string;
      /** A previous tenant: the mobile exchange still accepts its ID tokens (older app builds) until this is unset. */
      legacy?: { domain: string; audience: string[] };
    };
    /** Round 25: the provider connections shown as "Continue with Google / Microsoft" buttons (AUTH0_SOCIAL_CONNECTIONS). Empty without the identity provider. */
    socialConnections: SocialConnection[];
    /** A machine-to-machine Auth0 client for the Management API (delete a person, resend a verification email). Optional. */
    auth0Management?: { domain: string; clientId: string; clientSecret: string };
    /**
     * The app's own email and password form. Off by default once the identity provider is
     * configured (sign up, reset and verification then happen there); on for self host and
     * Node deployments without it. AUTH_LOCAL_PASSWORD=on|off overrides.
     */
    localPassword: boolean;
    /** Believe X-Forwarded-For and X-Real-IP for client addresses (self host behind a known proxy). */
    trustProxy: boolean;
    /**
     * R34: local E2E only (E2E_LOCAL_RATE_KEYS, set by playwright.config's web servers). A request with no
     * client address at all is not counted against one shared auth limit, so a long local run does not trip
     * it. Requests that carry an address are limited as always. Refused in production.
     */
    localAddresslessUnlimited?: boolean;
    /** Refuse passwords found in known breaches (Have I Been Pwned, k-anonymity). */
    breachCheck: boolean;
  };
  /** Error tracking and tracing. Each side turns on when its DSN is set. */
  sentry: { dsnApi?: string; dsnWeb?: string; environment: string; tracesSampleRate: number };
  /** Release id (the git commit) reported to Sentry and in logs and /api/health. */
  release: string;
  /** R32: when it equals release, open tabs reload on the next page change (web update prompt). */
  criticalRelease?: string;
  /**
   * R29b: the mobile app's remote config (GET /api/v1/app-config). `configToken` (APP_CONFIG_TOKEN) lets the
   * release scripts change it (PUT); `sentryDsn` is where phones send update health reports
   * (SENTRY_DSN_MOBILE, else the web DSN).
   */
  mobileApp: { configToken?: string; sentryDsn?: string };
  /** RFC 9116 contact for vulnerability reports (a mailto: or https: URI). */
  securityContact: string;
  /** Other deployments this one probes on its schedule (base URLs). */
  monitorUrls: string[];
  /** Days a workspace keeps its paid plan after a failed payment before it is restricted. */
  billingGraceDays: number;
  /** User ids or verified emails that get platform admin (operator console) on sign-in. */
  platformAdmins: string[];
  /** Demo workspaces the daily purge keeps (the fixed App Review account). KEEP_DEMO_ORG_IDS. */
  keepDemoOrgIds: string[];
  /** New demo workspaces allowed per rolling 24 hours, platform wide (DEMO_DAILY_LIMIT); 0 means no cap. */
  demoDailyLimit: number;
  /** New demo workspaces one IP address may open per 24 hours (DEMO_PER_IP_DAILY, default 10); 0 means no cap. */
  demoPerIpDaily: number;
  /**
   * R74 (MB-271): our own smoke and QA checks send this in the x-multies-check header (QA_CHECK_TOKEN, a secret). Their
   * demos are marked and kept out of the daily demo cap, so visitors still get the demo. Unset: no check is exempt.
   */
  qaCheckToken: string | null;
  /**
   * The account wide D1 daily write budget (services/write-budget.ts). Read from Cloudflare analytics
   * with CF_ANALYTICS_TOKEN (read only) and CF_ACCOUNT_ID; without both the guard is off.
   * D1_DAILY_WRITE_BUDGET (default 100000), WRITE_BUDGET_WARN_PCT (60), WRITE_BUDGET_SHED_PCT (85, R32).
   * `strict` (WRITE_BUDGET_GUARD=strict, staging) refuses API writes from the warn level on.
   * `alertTo` (OPS_ALERT_EMAIL, default security@ the support domain; "off" for none) gets the 60% and 85% mail.
   */
  /** R48 (MB-235): rows one workspace may write per UTC day before its writes pause (0 = off); admins hear from `nearAt`. */
  workspaceBudget: { daily: number; nearAt: number };
  writeBudget: {
    token?: string; accountId?: string; daily: number; warnAt: number; shedAt: number; strict: boolean; alertTo?: string;
    /** R61a: the account's daily D1 rows read budget for /api/health (D1_DAILY_READ_BUDGET; the Free plan's hard 5M by default, about 833M a day on Workers Paid) and its warn level (READ_BUDGET_WARN_PCT, 60). */
    readsDaily: number; readsWarnAt: number;
  };
  /** R61a: Important and Other unread counts (MAIL_SPLIT_COUNTS, default on; "off" makes them 0 and skips their rule). */
  mailSplitCounts: boolean;
  /** Stripe billing. `enabled` only when every key below is set. */
  billing: {
    enabled: boolean;
    testMode: boolean;
    publishableKey?: string;
    /** A Stripe Customer Portal configuration (bpc_...) for portal sessions; the account default when unset. */
    portalConfigId?: string;
    stripeSecretKey?: string;
    stripeWebhookSecret?: string;
    prices: { pro?: string; business?: string };
    /** Which settings are missing, for the "billing not connected" screen. */
    missing: string[];
  };
  /** Sender of account emails (invites, password resets, verification). */
  systemFrom: { address: string; name: string };
  /** Largest raw message accepted inbound, in bytes. */
  maxMessageBytes: number;
  /**
   * The mail server (Stalwart) that gives mail apps IMAP and SMTP access. `enabled`
   * when STALWART_URL and its provisioner login are set.
   */
  /** Agent inboxes. `sharedDomain` hosts inboxes for workspaces with no domain yet (AGENT_MAIL_DOMAIN). */
  agents: { sharedDomain?: string };
  /**
   * C1: chat channels (services/channels). `meta` is set only when every Meta app value is present (META_APP_ID,
   * META_APP_SECRET, META_VERIFY_TOKEN, META_ES_CONFIG_ID); without it Settings shows Coming soon. `mock`
   * (CHANNELS_MOCK=on) is the local test provider for unit and E2E runs and is refused in production.
   * `dailySoftCap` (CHANNELS_DAILY_SOFT_CAP, default 2000) is the inbound messages per workspace per UTC day
   * after which admins are warned and media is no longer copied (text still lands).
   * R59: `enabled` (CHAT_CHANNELS=on) is the master switch for the whole feature, off unless set. Off: /api/channels
   * and /api/webhooks/meta answer a plain 404 and do nothing, the MCP chat tools are not listed, and the web app shows
   * no Settings pane, command menu entry or chat rows (it reads chatChannels from /api/config).
   */
  /**
   * R80C: Connections (outside apps, social first). `composio` is set only when COMPOSIO_API_KEY is present; without it
   * Settings > Connections shows a calm "not switched on" card and every write answers 503. COMPOSIO_BASE_URL points
   * tests at a local stand in. `userPrefix` keeps each host's workspaces apart inside the one shared project.
   */
  integrations: { composio?: { apiKey: string; baseUrl: string; userPrefix: string } };
  /**
   * R83: our own sign in for TikTok and Threads, beside the platform route. `tiktok` is set when a client key and
   * secret are present (TIKTOK_MODE=sandbox picks the sandbox pair); `secrets` lists every client secret we hold, so
   * a webhook signed by either app verifies. `threads` needs THREADS_APP_ID and THREADS_APP_SECRET. The base URLs
   * point tests at a local stand in.
   */
  direct: {
    tiktok?: { clientKey: string; clientSecret: string; sandbox: boolean; secrets: string[]; apiBase: string; authUrl: string; /** TIKTOK_SCOPES: the scopes the app has (comma list); unset asks for all four. */ scopes?: string[] };
    threads?: { appId: string; appSecret: string; apiBase: string; authUrl: string };
  };
  /** R119: helpdesk mode on the shared inbox and the website chat (HELPDESK, on unless "off"; each workspace turns it on itself). */
  helpdesk?: boolean;
  /** R107: e-sign v2 (ESIGN_V2, on unless "off"): email code identity, richer signing record, seal, templates, bulk send. Stamped per request, so older links keep their flow. */
  esignV2?: boolean;
  /** R122: the help center in Docs and the public /help pages (HELP_CENTER=on). Off unless set; each workspace turns its own on. */
  helpCenter?: boolean;
  /** R123: Sites in Docs and the public /site pages (SITES_R123=on). Off unless set; nothing shows until an admin starts a site. */
  sites?: boolean;
  /** R123: more workspaces (ids, slugs or names, comma separated) kept out of Sites; vv8k is always out. */
  sitesExclude?: string;
  /** R124: the blog inside Sites with the subscribe box and email to subscribers through R109 (BLOG_R124=on, needs Sites). Off unless set. */
  blogR124?: boolean;
  /** R121: layout plan P2 navigation (Contacts section, Settings > Mail setup, Files in Docs, one menu model) (NAV_P2_R121=on). Off unless set. */
  navP2R121?: boolean;
  /** R99: calendar and contacts sync, CalDAV and CardDAV at /dav with app passwords (DAV_SYNC_R99=on). Off unless set. */
  davSync?: boolean;
  /** R103: Docs plus (link library, web clipper, doc comments, spell check), DOCS_PLUS_R103=on. */
  docsPlus?: boolean;
  /** R103: local end to end runs only: the clipper reads a pretend web (DOCS_PLUS_FAKE_WEB=1). */
  docsPlusFakeWeb?: boolean;
  /** R101: Files plus, the workspace drive and brand library on the Files page (FILES_PLUS_R101=on). Off unless set. */
  filesPlus?: boolean;
  /** R97: notification centre: mail channel, digests, quiet hours, pause (NOTIFICATION_CENTRE, on unless "off"). */
  notificationCentre?: boolean;
  /** R96: chat plus (topics, announcements, decision votes, polls, live Q&A; CHAT_PLUS, on unless "off"). */
  chatPlus?: boolean;
  /** R114: webinar mode for meetings (WEBINAR_R114=on). Off unless set. */
  webinar?: boolean;
  /** R95: Tasks plus: My Day time blocks, smart repeat, timesheet submit and approve, time tags and export, mind map (TASKS_PLUS_R95=on). Off unless set. */
  tasksPlus?: boolean;
  /** R102: Smart document inbox, Files > Documents: reading uploads, rules, detected fields, Unpaid bills and Tax documents (DOC_INBOX_R102=on). Off unless set. */
  docInbox?: boolean;
  channels: { enabled: boolean; meta?: { appId: string; appSecret: string; verifyToken: string; configId: string; graphVersion: string }; mock: boolean; dailySoftCap: number };
  /**
   * Free addresses (round 17): a Multies-owned domain that every workspace can take an address on
   * (name@FREE_MAIL_DOMAIN) with no domain of its own. One shared domain, already verified with the
   * outbound provider, so free users never spend the provider's per-account domain slots.
   * `dailySends` caps recipients a day from a free address, per workspace, to protect the shared domain.
   */
  freeMail: { domain?: string; dailySends: number; newAccountDailySends: number; dailyClaims: number };
  /** R34 (MB-166, MB-169): shared sender headroom and the new sender limit (services/mail/send-guard-r34.ts). */
  sendGuard?: { providerDailyCap: number; holdAt: number; newSenderDaily: number; newSenderDays: number };
  /** R26 (DF-18): the company domain, the workspace that receives its listed addresses, and the list. */
  operatorInbox: { orgId: string | null; domain: string | null; addresses: string[] };
  /** Push to phones through Expo (PUSH_ENABLED=1, optional EXPO_ACCESS_TOKEN). Off by default. */
  push: { enabled: boolean; expoAccessToken?: string };
  /** R32: web push to browsers (VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY, VAPID_SUBJECT). Off when either key is missing. */
  webPush?: { publicKey: string; privateKey: string; subject: string };
  /** An S3 compatible bucket for large message parts (BODY_STORE_ENDPOINT, _BUCKET, _REGION, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY). */
  bodyStore?: { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };
  /** R43: at most this many items per import step (staging sets it small so the background finish is exercised). */
  importStepMaxItems?: number;
  /** R43: workspaces whose import steps take one item each (a live check of the background finish). */
  importStepCapOrgs?: string[];
  /** R43: the import pages say a run carries on after the page closes. */
  backgroundCopy?: boolean;
  /** R89: whiteboards, diagrams, mind map mode and Present in Docs (DOCS_VISUAL, on unless "off"). */
  docsVisual?: boolean;
  /** Mail import runners authenticate with this (IMPORT_RUNNER_TOKEN). Import is off without it. */
  importRunnerToken?: string;
  /**
   * Connecting an existing mailbox over IMAP and SMTP (round 18). On unless MAIL_CONNECT=off.
   * allowSelfSigned and allowPrivateHosts are for the local test mail server and are refused in production.
   * OAuth for Google and Microsoft stays off until MAIL_OAUTH=on and the provider's client id and secret are set.
   */
  mailConnect: {
    enabled: boolean;
    allowSelfSigned: boolean;
    allowPrivateHosts: boolean;
    /** Messages fetched per sync pass, per connection. */
    batch: number;
    /** Messages stored per connection per day (UTC). */
    dailyCap: number;
    /** The first sync copies this many days back, at most `initialCap` messages per folder. */
    initialDays: number;
    initialCap: number;
    /** Minutes between scheduled syncs of one connection. */
    intervalMinutes: number;
    /** R57: full history backfill (header and snippet only; body on first open). */
    backfill: { enabled: boolean; batch: number; dailyCap: number; globalDaily: number; stopPct: number; readStopPct: number; readCeiling: number; peekBytes: number };
    /** R57: Node only, the wait before the next chained pass (0, the default, chains nothing: the cron picks it up). */
    chainMs: number;
    /** Live mail while Multies is open (IDLE on the Inbox). MAIL_LIVE=off turns it off. */
    live: boolean;
    /** Minutes of live windows a day for the whole account (Durable Object wall time on the free plan). */
    liveMinutesPerDay: number;
    oauth: { enabled: boolean; google?: { clientId: string; clientSecret: string }; microsoft?: { clientId: string; clientSecret: string; tenant: string } };
  };
  /** Xero, for invoice reminders (XERO_CLIENT_ID, XERO_CLIENT_SECRET). Off without both. */
  xero?: { clientId: string; clientSecret: string };
  /** Video meetings through LiveKit (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET). Off without all three. */
  meetings?: { url: string; apiKey: string; apiSecret: string };
  /** Round 23: local E2E fake of the video room list (CALLS_TEST_HOOK). Refused in production. */
  callsTestHook?: boolean;
  /** Cloudflare Turnstile on public forms (TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY). Without it, forms use a honeypot and rate limits. */
  turnstile?: { siteKey: string; secretKey: string };
  mailServer: {
    enabled: boolean;
    url?: string;
    adminUser?: string;
    adminSecret?: string;
    /** What people type into their mail app as the server name. */
    clientHost: string;
    imapPort: number;
    smtpPort: number;
    smtpSecurity: "ssl" | "starttls";
    missing: string[];
  };
}

const csv = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  APP_MODE: z.enum(["production", "development"]).optional(),
  APP_NAME: z.string().optional(),
  SUPPORT_EMAIL: z.string().email().optional(),
  APP_URL: z.string().url().optional(),
  APP_SECRET: z.string().optional(),
  DEMO_MODE: z.string().optional(),
  FLOWS: z.string().optional(),
  SCHEDULING_ENABLED: z.string().optional(),
  /** R91: dashboards plus (public links, emailed reports, question builder, alerts, data sources). */
  DASHBOARDS_PLUS: z.string().optional(),
  CONTRACTS_R108: z.string().optional(),
  OFFICE_EDIT_R113: z.string().optional(),
  HOME_WIDGETS_R131: z.string().optional(),
  SOCIAL_P3_R132: z.string().optional(),
  SOCIAL_YOUTUBE_UPLOAD_R132: z.string().optional(),
  SOCIAL_GBP_R132: z.string().optional(),
  CLIENT_PORTAL: z.string().optional(),
  MAIL_ARCHIVE_R111: z.string().optional(),
  INVOICES_ENABLED: z.string().optional(), // R105
  COURSES_R129: z.string().optional(), // R129
  COURSES_EXCLUDE: z.string().optional(), // R129
  BOOKING_PLUS: z.string().optional(),
  FORMS_PLUS_R93: z.string().optional(), // R93
  REPORTING_R112: z.string().optional(), // R112
  FORMS_PLUS_EXCLUDE: z.string().optional(), // R93
  SHIELD_DIFFICULTY: z.string().optional(),
  EXPENSES_R106: z.string().optional(), // R106
  EXPENSES_FAKE_READ: z.string().optional(), // R106 tests only
  COMPOSIO_API_KEY: z.string().optional(),
  // R83: own sign in for TikTok (Login Kit and Content Posting) and Threads.
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  TIKTOK_SANDBOX_CLIENT_KEY: z.string().optional(),
  TIKTOK_SANDBOX_CLIENT_SECRET: z.string().optional(),
  /** "sandbox" uses the sandbox keys even when production keys are set (until the network approves the app). */
  TIKTOK_MODE: z.enum(["production", "sandbox"]).optional(),
  TIKTOK_SCOPES: z.string().optional(),
  TIKTOK_API_BASE: z.string().optional(),
  TIKTOK_AUTH_URL: z.string().optional(),
  THREADS_APP_ID: z.string().optional(),
  THREADS_APP_SECRET: z.string().optional(),
  THREADS_API_BASE: z.string().optional(),
  THREADS_AUTH_URL: z.string().optional(),
  COMPOSIO_BASE_URL: z.string().url().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_ES_CONFIG_ID: z.string().optional(),
  META_GRAPH_VERSION: z.string().optional(),
  CHANNELS_MOCK: z.string().optional(),
  CHAT_CHANNELS: z.string().optional(),
  HELPDESK: z.string().optional(),
  ESIGN_V2: z.string().optional(),
  HELP_CENTER: z.string().optional(),
  SITES_R123: z.string().optional(),
  SITES_EXCLUDE: z.string().optional(),
  BLOG_R124: z.string().optional(), // R124
  NAV_P2_R121: z.string().optional(), // R121
  DAV_SYNC_R99: z.string().optional(),
  DOCS_PLUS_R103: z.string().optional(),
  DOCS_PLUS_FAKE_WEB: z.string().optional(),
  NOTIFICATION_CENTRE: z.string().optional(),
  CHAT_PLUS: z.string().optional(),
  FILES_PLUS_R101: z.string().optional(),
  TASKS_PLUS_R95: z.string().optional(),
  DOC_INBOX_R102: z.string().optional(),
  WEBINAR_R114: z.string().optional(),
  CHANNELS_DAILY_SOFT_CAP: z.string().optional(),
  TOOLS_ENABLED: z.string().optional(),
  CRM_TIMELINE: z.string().optional(),
  /** R98: typo tolerant, filtered search with files and notes, and the instant index in the command menu. Off unless set. */
  SEARCH_R98: z.string().optional(),
  MAPS_R115: z.string().optional(),
  MAPS_GEO_MOCK: z.string().optional(),
  ASK_EXCLUDE: z.string().optional(),
  ASK_R110: z.string().optional(),
  TABLES_R125: z.string().optional(), // R125
  POLISH_POL1: z.string().optional(), // POL1
  TABLES_EXCLUDE: z.string().optional(), // R125
  VAULT_R128: z.string().optional(),
  VAULT_EXCLUDE: z.string().optional(),
  TOOLS_FEATURES: z.string().optional(),
  LINK_CLICK_FLUSH_MS: z.string().optional(), // R87
  SOCIAL_P2: z.string().optional(),
  SOCIAL_P2B: z.string().optional(),
  ANALYTICS_PH: z.string().optional(), // ANALYTICS-PH (off unless on)
  POSTHOG_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().optional(),
  ANALYTICS_HASH_KEY: z.string().optional(),
  ANALYTICS_EXCLUDE: z.string().optional(),
  CAMPAIGN_SEND_ALLOW: z.string().optional(),
  CAMPAIGN_SEND_ALLOW_EXTRA: z.string().optional(), // R109: a secret on staging (the QA mailbox), added to CAMPAIGN_SEND_ALLOW
  SOCIAL_TEST_NETWORK: z.string().optional(),
  DOC_ENGINE_URL: z.string().optional(),
  DOC_ENGINE_KEY_ID: z.string().optional(),
  DOC_ENGINE_KEY: z.string().optional(),
  TOOLS_TOKEN_KEY: z.string().optional(),
  DNS_RESOLVER: z.enum(["doh", "node"]).optional(),
  MAIL_MX_HOSTS: z.string().optional(),
  MAIL_SPF_INCLUDES: z.string().optional(),
  MAIL_DKIM_SELECTOR: z.string().optional(),
  MAIL_DMARC_RUA: z.string().optional(),
  OUTBOUND_DRIVER: z.enum(["log", "resend"]).optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  MAX_MESSAGE_BYTES: z.string().optional(),
  SYSTEM_FROM: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  AUTH0_DOMAIN: z.string().optional(),
  AUTH0_CLIENT_ID: z.string().optional(),
  AUTH0_CLIENT_SECRET: z.string().optional(),
  AUTH0_NATIVE_CLIENT_ID: z.string().optional(),
  /** A previous tenant whose ID tokens the phone apps may still send while older builds are in use. */
  AUTH0_LEGACY_DOMAIN: z.string().optional(),
  AUTH0_LEGACY_NATIVE_CLIENT_ID: z.string().optional(),
  AUTH0_LEGACY_CLIENT_ID: z.string().optional(),
  AUTH0_MGMT_CLIENT_ID: z.string().optional(),
  AUTH0_MGMT_CLIENT_SECRET: z.string().optional(),
  /** Round 25: "google-oauth2,windowslive" shows those buttons on sign in and sign up. Unset: none. */
  AUTH0_SOCIAL_CONNECTIONS: z.string().optional(),
  AUTH_LOCAL_PASSWORD: z.enum(["on", "off", "true", "false"]).optional(),
  TRUST_PROXY: z.string().optional(),
  PASSWORD_BREACH_CHECK: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  SENTRY_DSN_API: z.string().optional(),
  SENTRY_DSN_WEB: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  PLATFORM_ADMIN_EMAILS: z.string().optional(),
  KEEP_DEMO_ORG_IDS: z.string().optional(),
  DEMO_DAILY_LIMIT: z.string().optional(),
  DEMO_PER_IP_DAILY: z.string().optional(),
  QA_CHECK_TOKEN: z.string().optional(),
  CF_ANALYTICS_TOKEN: z.string().optional(),
  CF_ACCOUNT_ID: z.string().optional(),
  D1_DAILY_WRITE_BUDGET: z.string().optional(),
  // R48 (MB-235): rows one workspace may write per UTC day (default 20000, 0 = off) and the notice level (80).
  WORKSPACE_DAILY_WRITES: z.string().regex(/^\d+$/).optional(),
  WORKSPACE_BUDGET_NEAR_PCT: z.string().optional(),
  WRITE_BUDGET_WARN_PCT: z.string().optional(),
  WRITE_BUDGET_SHED_PCT: z.string().optional(),
  WRITE_BUDGET_GUARD: z.string().optional(),
  D1_DAILY_READ_BUDGET: z.string().regex(/^\d+$/).optional(),
  READ_BUDGET_WARN_PCT: z.string().optional(),
  MAIL_SPLIT_COUNTS: z.string().optional(),
  OPS_ALERT_EMAIL: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_PORTAL_CONFIG: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  PUSH_ENABLED: z.string().optional(),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),
  SYSTEM_FROM_NAME: z.string().optional(),
  STALWART_URL: z.string().url().optional(),
  STALWART_ADMIN_USER: z.string().optional(),
  STALWART_ADMIN_SECRET: z.string().optional(),
  MAIL_CLIENT_HOST: z.string().optional(),
  MAIL_IMAP_PORT: z.string().optional(),
  MAIL_SMTP_PORT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.string().optional(),
  RELEASE: z.string().optional(),
  /** R32: set to the RELEASE id when that release must reload open tabs (the web update prompt). */
  CRITICAL_RELEASE: z.string().optional(),
  CF_BEACON_TOKEN: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  APP_CONFIG_TOKEN: z.string().min(32, "APP_CONFIG_TOKEN must be at least 32 characters").optional(),
  SENTRY_DSN_MOBILE: z.string().optional(),
  SECURITY_CONTACT: z.string().regex(/^(mailto:|https:\/\/)/, "SECURITY_CONTACT must be a mailto: or https: URI").optional(),
  BILLING_GRACE_DAYS: z.string().regex(/^\d+$/).optional(),
  MONITOR_URLS: z.string().optional(),
  BODY_STORE_ENDPOINT: z.string().url().optional(),
  BODY_STORE_BUCKET: z.string().optional(),
  BODY_STORE_REGION: z.string().optional(),
  BODY_STORE_ACCESS_KEY_ID: z.string().optional(),
  BODY_STORE_SECRET_ACCESS_KEY: z.string().optional(),
  IMPORT_RUNNER_TOKEN: z.string().min(24).optional(),
  IMPORT_STEP_MAX_ITEMS: z.string().regex(/^[1-9][0-9]{0,4}$/).optional(),
  /** R43: workspaces (comma separated ids) that take one item steps, for a live check of the background finish. */
  IMPORT_STEP_CAP_ORGS: z.string().regex(/^(org_[a-z0-9]{6,40})(,org_[a-z0-9]{6,40}){0,4}$/).optional(),
  /** R43: "true" once imports that finish after the page closes are proven live; the import pages then say so. */
  BACKGROUND_COPY: z.string().optional(),
  DOCS_VISUAL: z.string().optional(),
  MAIL_CONNECT: z.string().optional(),
  MAIL_CONNECT_ALLOW_SELF_SIGNED: z.string().optional(),
  MAIL_CONNECT_ALLOW_PRIVATE_HOSTS: z.string().optional(),
  MAIL_SYNC_BATCH: z.string().optional(),
  MAIL_SYNC_DAILY_CAP: z.string().optional(),
  MAIL_SYNC_INITIAL_DAYS: z.string().optional(),
  MAIL_SYNC_INITIAL_CAP: z.string().optional(),
  MAIL_SYNC_INTERVAL_MINUTES: z.string().optional(),
  MAIL_SYNC_BACKFILL: z.string().optional(),
  MAIL_SYNC_BACKFILL_BATCH: z.string().optional(),
  MAIL_SYNC_BACKFILL_DAILY_CAP: z.string().optional(),
  MAIL_SYNC_BACKFILL_GLOBAL_DAILY: z.string().optional(),
  MAIL_SYNC_BACKFILL_STOP_PCT: z.string().optional(),
  MAIL_SYNC_BACKFILL_READ_STOP_PCT: z.string().optional(),
  MAIL_SYNC_BACKFILL_READ_CEILING: z.string().regex(/^\d+$/).optional(),
  MAIL_SYNC_CHAIN_MS: z.string().optional(),
  MAIL_LIVE: z.string().optional(),
  MAIL_LIVE_MINUTES_PER_DAY: z.string().optional(),
  MAIL_OAUTH: z.string().optional(),
  GOOGLE_MAIL_CLIENT_ID: z.string().optional(),
  GOOGLE_MAIL_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_MAIL_CLIENT_ID: z.string().optional(),
  MICROSOFT_MAIL_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_MAIL_TENANT: z.string().optional(),
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  AGENT_MAIL_DOMAIN: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i).optional(),
  // R45: "" is allowed and means off (staging sets it empty on purpose; see wrangler.toml).
  FREE_MAIL_DOMAIN: z.union([z.literal(""), z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)]).optional(),
  FREE_MAIL_DAILY_SENDS: z.string().regex(/^\d+$/).optional(),
  FREE_MAIL_NEW_DAILY_SENDS: z.string().regex(/^\d+$/).optional(),
  // R34 (MB-166, MB-169): shared sender headroom and new sender limit (0 turns a check off).
  MAIL_PROVIDER_DAILY_CAP: z.string().regex(/^\d+$/).optional(),
  MAIL_PROVIDER_HOLD_AT: z.string().regex(/^\d+$/).optional(),
  NEW_SENDER_DAILY_SENDS: z.string().regex(/^\d+$/).optional(),
  NEW_SENDER_DAYS: z.string().regex(/^\d+$/).optional(),
  FREE_MAIL_DAILY_CLAIMS: z.string().regex(/^\d+$/).optional(),
  // R26 (DF-18): the workspace that receives the company's own addresses (support@, security@).
  OPERATOR_INBOX_ORG_ID: z.string().optional(),
  OPERATOR_INBOX_ADDRESSES: z.string().optional(),
  LIVEKIT_URL: z.string().regex(/^(wss|https):\/\//).optional(),
  CALLS_TEST_HOOK: z.string().optional(),
  E2E_LOCAL_RATE_KEYS: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
});

/** Cloudflare Email Routing's published MX hosts. */
export const CLOUDFLARE_MX = [
  { host: "route1.mx.cloudflare.net", priority: 10 },
  { host: "route2.mx.cloudflare.net", priority: 20 },
  { host: "route3.mx.cloudflare.net", priority: 30 },
];

export class ConfigError extends Error {}

function hostOf(url: string): string {
  try { return new URL(url).hostname || "localhost"; } catch { return "localhost"; }
}

/** Builds config from a plain env object (process.env on Node, bindings on Workers). */
/**
 * R26 (DF-18): the company domain (the domain of SUPPORT_EMAIL, multies.si) belongs to the deployment.
 * Only the operator workspace (OPERATOR_INBOX_ORG_ID) may hold it, and only the listed addresses
 * (OPERATOR_INBOX_ADDRESSES, default support@ and security@) are delivered there. Without an operator
 * workspace, inbound routing is unchanged and no workspace can add the domain.
 */
export function operatorInbox(supportEmail: string, orgId: string | undefined, addresses: string | undefined) {
  const domain = (supportEmail.split("@")[1] ?? "").trim().toLowerCase() || null;
  const list = (addresses?.trim() ? addresses.split(/[\s,]+/) : domain ? [`support@${domain}`, `security@${domain}`] : [])
    .map((a) => a.trim().toLowerCase()).filter((a) => !!domain && a.endsWith(`@${domain}`) && a.indexOf("@") > 0);
  return { orgId: orgId?.trim() || null, domain, addresses: [...new Set(list)] };
}

/**
 * The shared domain for free addresses. It must be a subdomain that is not the app's own host:
 * the app's domain (multies.si) carries the company's staff addresses and is never handed out.
 */
export function freeMailDomain(raw: string | undefined, appUrl: string | undefined): string | undefined {
  const d = raw?.trim().toLowerCase();
  if (!d) return undefined;
  let host = "";
  try { host = new URL(appUrl ?? "http://localhost").hostname.toLowerCase(); } catch { /* no app URL */ }
  const apex = host.replace(/^(www|app)\./, "");
  if (d === host || d === apex) return undefined;
  return d;
}

/** C1: the chat channel settings. The Meta app counts as configured only when all four values are set. */
function integrationsConfig(env: z.infer<typeof EnvSchema>): AppConfig["integrations"] {
  const apiKey = env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) return {};
  let host = "local";
  try { host = new URL(env.APP_URL ?? "http://localhost").hostname.toLowerCase(); } catch { /* no app URL */ }
  return { composio: { apiKey, baseUrl: (env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev").replace(/\/$/, ""), userPrefix: host } };
}

/** R83: TikTok and Threads sign in settings. Values are trimmed; a half set pair counts as not set. */
function directConfig(env: z.infer<typeof EnvSchema>): AppConfig["direct"] {
  const t = (v: string | undefined) => v?.trim() || undefined;
  const out: AppConfig["direct"] = {};
  const prod = t(env.TIKTOK_CLIENT_KEY) && t(env.TIKTOK_CLIENT_SECRET) ? { key: t(env.TIKTOK_CLIENT_KEY)!, secret: t(env.TIKTOK_CLIENT_SECRET)! } : undefined;
  const sand = t(env.TIKTOK_SANDBOX_CLIENT_KEY) && t(env.TIKTOK_SANDBOX_CLIENT_SECRET) ? { key: t(env.TIKTOK_SANDBOX_CLIENT_KEY)!, secret: t(env.TIKTOK_SANDBOX_CLIENT_SECRET)! } : undefined;
  const useSandbox = !prod || env.TIKTOK_MODE === "sandbox";
  const pick = useSandbox ? (sand ?? prod) : prod;
  if (pick) {
    out.tiktok = {
      clientKey: pick.key, clientSecret: pick.secret, sandbox: pick === sand,
      secrets: [prod?.secret, sand?.secret].filter((s): s is string => !!s),
      apiBase: (t(env.TIKTOK_API_BASE) ?? "https://open.tiktokapis.com").replace(/\/$/, ""),
      authUrl: t(env.TIKTOK_AUTH_URL) ?? "https://www.tiktok.com/v2/auth/authorize/",
      ...(t(env.TIKTOK_SCOPES) ? { scopes: t(env.TIKTOK_SCOPES)!.split(/[ ,]+/).filter(Boolean) } : {}),
    };
  }
  if (t(env.THREADS_APP_ID) && t(env.THREADS_APP_SECRET)) {
    out.threads = {
      appId: t(env.THREADS_APP_ID)!, appSecret: t(env.THREADS_APP_SECRET)!,
      apiBase: (t(env.THREADS_API_BASE) ?? "https://graph.threads.net").replace(/\/$/, ""),
      authUrl: t(env.THREADS_AUTH_URL) ?? "https://threads.net/oauth/authorize",
    };
  }
  return out;
}

function channelsConfig(env: z.infer<typeof EnvSchema>, mode: AppConfig["mode"]): AppConfig["channels"] {
  const id = env.META_APP_ID?.trim(), secret = env.META_APP_SECRET?.trim(), verify = env.META_VERIFY_TOKEN?.trim(), cfg = env.META_ES_CONFIG_ID?.trim();
  const version = /^v\d{1,3}\.\d$/.test(env.META_GRAPH_VERSION?.trim() ?? "") ? env.META_GRAPH_VERSION!.trim() : "v26.0";
  const mockAsked = env.CHANNELS_MOCK === "on" || env.CHANNELS_MOCK === "1" || env.CHANNELS_MOCK === "true";
  if (mockAsked && mode === "production") throw new ConfigError("CHANNELS_MOCK is for local tests only and cannot be on in production.");
  const cap = Number(env.CHANNELS_DAILY_SOFT_CAP);
  const enabled = env.CHAT_CHANNELS === "on" || env.CHAT_CHANNELS === "1" || env.CHAT_CHANNELS === "true";
  return {
    enabled,
    meta: id && secret && verify && cfg ? { appId: id, appSecret: secret, verifyToken: verify, configId: cfg, graphVersion: version } : undefined,
    mock: mockAsked,
    dailySoftCap: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 2000,
  };
}

/** Tools are on only with the switch, an https engine address (http for a local engine in development) and keys of 32+ characters. */
function toolsConfig(env: { TOOLS_FEATURES?: string; TOOLS_ENABLED?: string; DOC_ENGINE_URL?: string; DOC_ENGINE_KEY_ID?: string; DOC_ENGINE_KEY?: string; TOOLS_TOKEN_KEY?: string; APP_MODE?: string; NODE_ENV?: string }): AppConfig["tools"] {
  const url = env.DOC_ENGINE_URL?.trim() ?? "";
  const keyId = env.DOC_ENGINE_KEY_ID?.trim() ?? "";
  const key = env.DOC_ENGINE_KEY?.trim() ?? "";
  const tokenKey = env.TOOLS_TOKEN_KEY?.trim() ?? "";
  const urlOk = /^https:\/\/[^\s/]+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(url);
  const engine = urlOk && keyId && key.length >= 32 ? { url: url.replace(/\/+$/, ""), keyId, key } : null;
  const on = env.TOOLS_ENABLED === "true" || env.TOOLS_ENABLED === "1";
  const enabled = on && !!engine && tokenKey.length >= 32;
  return { enabled, engine, tokenKey: tokenKey.length >= 32 ? tokenKey : null, features: enabled ? parseToolFeatures(env.TOOLS_FEATURES) : [] };
}

export function loadConfig(raw: Record<string, string | undefined>): AppConfig {
  const env = EnvSchema.parse(raw);
  const mode = env.APP_MODE ?? (env.NODE_ENV === "production" ? "production" : "development");
  const secret = env.APP_SECRET ?? "";
  if (mode === "production" && secret.length < 32) {
    throw new ConfigError("APP_SECRET must be set to at least 32 random characters in production.");
  }
  const outboundDriver = env.OUTBOUND_DRIVER ?? (env.RESEND_API_KEY ? "resend" : "log");
  if (outboundDriver === "resend" && !env.RESEND_API_KEY) {
    throw new ConfigError("OUTBOUND_DRIVER=resend requires RESEND_API_KEY.");
  }
  const mxHosts = env.MAIL_MX_HOSTS
    ? csv(env.MAIL_MX_HOSTS).map((entry, i) => {
        const [host, prio] = entry.split(":");
        return { host: host.toLowerCase(), priority: prio ? Number(prio) : (i + 1) * 10 };
      })
    : CLOUDFLARE_MX;
  const spfIncludes = env.MAIL_SPF_INCLUDES
    ? csv(env.MAIL_SPF_INCLUDES)
    : ["_spf.mx.cloudflare.net", ...(outboundDriver === "resend" ? ["amazonses.com"] : [])];
  return {
    mode,
    demoEnabled: env.DEMO_MODE === "true" || env.DEMO_MODE === "1",
    flows: env.FLOWS !== "off",
    socialP2: env.SOCIAL_P2 !== "off",
    socialP2b: env.SOCIAL_P2B !== "off",
    campaignSendAllow: `${env.CAMPAIGN_SEND_ALLOW ?? ""},${env.CAMPAIGN_SEND_ALLOW_EXTRA ?? ""}`.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    socialTestNetwork: testNetworkAllowed(env),
    schedulingEnabled: env.SCHEDULING_ENABLED === "true" || env.SCHEDULING_ENABLED === "1",
    crmTimeline: ["1", "true", "on"].includes(String(env.CRM_TIMELINE ?? "").toLowerCase()),
    dashboardsPlus: ["1", "true", "on", "test"].includes(String(env.DASHBOARDS_PLUS ?? "").toLowerCase()),
    contractsR108: ["1", "true", "on"].includes(String(env.CONTRACTS_R108 ?? "").toLowerCase()),
    officeEditR113: ["1", "true", "on"].includes(String(env.OFFICE_EDIT_R113 ?? "").toLowerCase()),
    homeWidgetsR131: ["1", "true", "on"].includes(String(env.HOME_WIDGETS_R131 ?? "").toLowerCase()),
    socialP3R132: ["1", "true", "on"].includes(String(env.SOCIAL_P3_R132 ?? "").toLowerCase()),
    socialYoutubeUploadR132: ["1", "true", "on"].includes(String(env.SOCIAL_YOUTUBE_UPLOAD_R132 ?? "").toLowerCase()),
    socialGbpR132: ["1", "true", "on"].includes(String(env.SOCIAL_GBP_R132 ?? "").toLowerCase()),
    // R91: DASHBOARDS_PLUS=test (e2e only) also opens POST /api/dashboards-plus/test/run, which runs the due reports, alerts and refreshes now.
    dashboardsPlusTestHook: String(env.DASHBOARDS_PLUS ?? "").toLowerCase() === "test",
    clientPortal: ["on", "true", "1"].includes(String(env.CLIENT_PORTAL ?? "").toLowerCase()),
    searchR98: ["1", "true", "on"].includes(String(env.SEARCH_R98 ?? "").toLowerCase()), // R98
    mailArchive: ["on", "true", "1"].includes(String(env.MAIL_ARCHIVE_R111 ?? "").toLowerCase()),
    mapsR115: ["1", "true", "on"].includes(String(env.MAPS_R115 ?? "").toLowerCase()),
    mapsGeoMock: env.MAPS_GEO_MOCK === "1",
    askExclude: env.ASK_EXCLUDE ?? "", // R110
    askR110: ["1", "true", "on"].includes(String(env.ASK_R110 ?? "").toLowerCase()), // R110
    tablesR125: ["1", "true", "on"].includes(String(env.TABLES_R125 ?? "").toLowerCase()), // R125
    polishPol1: ["1", "true", "on"].includes(String(env.POLISH_POL1 ?? "").toLowerCase()), // POL1
    tablesExclude: env.TABLES_EXCLUDE ?? "", // R125
    vaultR128: ["1", "true", "on"].includes(String(env.VAULT_R128 ?? "").toLowerCase()), // R128
    vaultExclude: env.VAULT_EXCLUDE ?? "", // R128
    invoicesEnabled: env.INVOICES_ENABLED === "true" || env.INVOICES_ENABLED === "1", // R105
    coursesR129: ["1", "true", "on"].includes(String(env.COURSES_R129 ?? "").toLowerCase()), // R129
    coursesExclude: env.COURSES_EXCLUDE ?? "", // R129
    bookingPlus: (env.SCHEDULING_ENABLED === "true" || env.SCHEDULING_ENABLED === "1") && (env.BOOKING_PLUS === "true" || env.BOOKING_PLUS === "1"),
    formsPlus: env.FORMS_PLUS_R93 === "true" || env.FORMS_PLUS_R93 === "1", // R93
    reporting: ["1", "true", "on"].includes(String(env.REPORTING_R112 ?? "").toLowerCase()), // R112
    formsPlusExclude: env.FORMS_PLUS_EXCLUDE ?? "", // R93
    shieldDifficulty: env.SHIELD_DIFFICULTY && /^\d{1,2}$/.test(env.SHIELD_DIFFICULTY) ? Math.min(22, Number(env.SHIELD_DIFFICULTY)) : 14,
    expensesR106: ["on", "true", "1"].includes(env.EXPENSES_R106 ?? ""), // R106
    expensesFakeRead: env.EXPENSES_FAKE_READ === "1" && mode !== "production", // R106 tests only
    tools: toolsConfig(env),
    links: { flushMs: Math.max(0, Math.min(20_000, Number(env.LINK_CLICK_FLUSH_MS ?? 4000) || 0)) },
    appName: env.APP_NAME ?? "Multies",
    supportEmail: env.SUPPORT_EMAIL?.trim() || "support@multies.si",
    productAnalytics: productAnalyticsConfig(env),
    cfBeaconToken: /^[a-f0-9]{32}$/i.test(env.CF_BEACON_TOKEN?.trim() ?? "") ? env.CF_BEACON_TOKEN!.trim() : null,
    appUrl: (env.APP_URL ?? "http://localhost:5173").replace(/\/$/, ""),
    appSecret: secret || "dev-only-insecure-secret-change-me-0000000000",
    dnsResolver: env.DNS_RESOLVER ?? "doh",
    mail: {
      mxHosts,
      spfIncludes,
      dkimSelector: env.MAIL_DKIM_SELECTOR ?? "mymail",
      dmarcRua: env.MAIL_DMARC_RUA,
    },
    outbound: { driver: outboundDriver, resendApiKey: env.RESEND_API_KEY, resendWebhookSecret: env.RESEND_WEBHOOK_SECRET },
    auth: {
      social: {
        ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
        ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } } : {}),
      },
      ...(env.AUTH0_DOMAIN && env.AUTH0_CLIENT_ID && env.AUTH0_CLIENT_SECRET
        ? { auth0: { domain: env.AUTH0_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, ""), clientId: env.AUTH0_CLIENT_ID, clientSecret: env.AUTH0_CLIENT_SECRET, ...(env.AUTH0_NATIVE_CLIENT_ID ? { nativeClientId: env.AUTH0_NATIVE_CLIENT_ID } : {}), ...legacyIdp(env) } } : {}),
      ...(env.AUTH0_DOMAIN && env.AUTH0_MGMT_CLIENT_ID && env.AUTH0_MGMT_CLIENT_SECRET
        ? { auth0Management: { domain: env.AUTH0_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, ""), clientId: env.AUTH0_MGMT_CLIENT_ID, clientSecret: env.AUTH0_MGMT_CLIENT_SECRET } } : {}),
      socialConnections: env.AUTH0_DOMAIN && env.AUTH0_CLIENT_ID && env.AUTH0_CLIENT_SECRET ? parseSocialConnections(env.AUTH0_SOCIAL_CONNECTIONS) : [],
      trustProxy: env.TRUST_PROXY === "true" || env.TRUST_PROXY === "1",
      localAddresslessUnlimited: localRateKeys(env.E2E_LOCAL_RATE_KEYS, mode),
      localPassword: resolveLocalPassword(env.AUTH_LOCAL_PASSWORD, !!(env.AUTH0_DOMAIN && env.AUTH0_CLIENT_ID && env.AUTH0_CLIENT_SECRET)),
      breachCheck: env.PASSWORD_BREACH_CHECK ? env.PASSWORD_BREACH_CHECK === "true" : mode === "production",
    },
    sentry: {
      dsnApi: env.SENTRY_DSN_API, dsnWeb: env.SENTRY_DSN_WEB, environment: env.SENTRY_ENVIRONMENT ?? mode,
      tracesSampleRate: clampRate(env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
    },
    release: env.RELEASE ?? env.SENTRY_RELEASE ?? "dev",
    criticalRelease: env.CRITICAL_RELEASE?.trim() || undefined, // R32
    mobileApp: { configToken: env.APP_CONFIG_TOKEN?.trim() || undefined, sentryDsn: env.SENTRY_DSN_MOBILE || env.SENTRY_DSN_WEB || undefined },
    securityContact: env.SECURITY_CONTACT ?? `mailto:security@${hostOf(env.APP_URL ?? "http://localhost")}`,
    monitorUrls: csv(env.MONITOR_URLS).filter((u) => /^https?:\/\//.test(u)),
    billingGraceDays: Math.max(0, Math.min(60, Number(env.BILLING_GRACE_DAYS ?? 7) || 7)),
    platformAdmins: csv(env.PLATFORM_ADMIN_EMAILS).map((e) => e.toLowerCase()),
    keepDemoOrgIds: csv(env.KEEP_DEMO_ORG_IDS),
    demoDailyLimit: Math.max(0, Number.parseInt(env.DEMO_DAILY_LIMIT ?? "0", 10) || 0),
    demoPerIpDaily: Math.max(0, Number.parseInt(env.DEMO_PER_IP_DAILY ?? "10", 10) || 0),
    qaCheckToken: env.QA_CHECK_TOKEN && env.QA_CHECK_TOKEN.trim().length >= 24 ? env.QA_CHECK_TOKEN.trim() : null,
    workspaceBudget: {
      daily: Math.max(0, Number.parseInt(env.WORKSPACE_DAILY_WRITES ?? "20000", 10) || 0),
      nearAt: pct(env.WORKSPACE_BUDGET_NEAR_PCT, 80),
    },
    mailSplitCounts: !(["off", "0", "false"].includes(String(env.MAIL_SPLIT_COUNTS ?? "").trim().toLowerCase())),
    writeBudget: {
      token: env.CF_ANALYTICS_TOKEN?.trim() || undefined,
      accountId: env.CF_ACCOUNT_ID?.trim() || undefined,
      daily: Math.max(1000, Number.parseInt(env.D1_DAILY_WRITE_BUDGET ?? "100000", 10) || 100_000),
      warnAt: pct(env.WRITE_BUDGET_WARN_PCT, 60),
      shedAt: pct(env.WRITE_BUDGET_SHED_PCT, 85),
      strict: env.WRITE_BUDGET_GUARD === "strict",
      readsDaily: Math.max(1_000_000, Number.parseInt(env.D1_DAILY_READ_BUDGET ?? "5000000", 10) || 5_000_000),
      readsWarnAt: pct(env.READ_BUDGET_WARN_PCT, 60),
      alertTo: env.OPS_ALERT_EMAIL?.trim() === "off" ? undefined : env.OPS_ALERT_EMAIL?.trim() || `security@${(env.SUPPORT_EMAIL?.trim() || "support@multies.si").split("@")[1]}`,
    },
    billing: {
      // Only the secret key is required. Prices are found by lookup key (and created in
      // test mode); the webhook secret adds server-to-server sync on top of the
      // checkout return.
      enabled: !!env.STRIPE_SECRET_KEY,
      testMode: /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? ""),
      stripeSecretKey: env.STRIPE_SECRET_KEY, stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY,
      portalConfigId: env.STRIPE_PORTAL_CONFIG || undefined,
      prices: { pro: env.STRIPE_PRICE_PRO, business: env.STRIPE_PRICE_BUSINESS },
      missing: env.STRIPE_SECRET_KEY ? [] : ["STRIPE_SECRET_KEY"],
    },
    systemFrom: {
      address: (env.SYSTEM_FROM ?? `no-reply@${hostOf(env.APP_URL ?? "http://localhost")}`).toLowerCase(),
      name: env.SYSTEM_FROM_NAME ?? env.APP_NAME ?? "Multies",
    },
    // Agent inboxes for workspaces with no domain live on the same shared domain as free addresses
    // unless the deployment names a separate one.
    agents: { sharedDomain: (env.AGENT_MAIL_DOMAIN ?? env.FREE_MAIL_DOMAIN)?.toLowerCase() },
    integrations: integrationsConfig(env),
    direct: directConfig(env),
    channels: channelsConfig(env, mode),
    helpdesk: env.HELPDESK !== "off",
    esignV2: env.ESIGN_V2 !== "off",
    helpCenter: ["on", "true", "1"].includes(String(env.HELP_CENTER ?? "").toLowerCase()),
    sites: ["on", "true", "1"].includes(String(env.SITES_R123 ?? "").toLowerCase()),
    sitesExclude: env.SITES_EXCLUDE ?? "",
    blogR124: ["on", "true", "1"].includes(String(env.BLOG_R124 ?? "").toLowerCase()) && ["on", "true", "1"].includes(String(env.SITES_R123 ?? "").toLowerCase()), // R124
    navP2R121: ["on", "true", "1"].includes(String(env.NAV_P2_R121 ?? "").toLowerCase()), // R121
    davSync: ["on", "true", "1"].includes(String(env.DAV_SYNC_R99 ?? "").toLowerCase()),
    docsPlus: ["on", "true", "1"].includes(String(env.DOCS_PLUS_R103 ?? "").toLowerCase()),
    docsPlusFakeWeb: env.DOCS_PLUS_FAKE_WEB === "1" && !/multies\.si/.test(String(env.APP_URL ?? "")),
    notificationCentre: env.NOTIFICATION_CENTRE !== "off",
    chatPlus: env.CHAT_PLUS !== "off",
    filesPlus: ["on", "true", "1"].includes(String(env.FILES_PLUS_R101 ?? "").toLowerCase()),
    tasksPlus: ["1", "true", "on"].includes(String(env.TASKS_PLUS_R95 ?? "").toLowerCase()),
    docInbox: ["1", "true", "on"].includes(String(env.DOC_INBOX_R102 ?? "").toLowerCase()),
    webinar: ["1", "true", "on"].includes(String(env.WEBINAR_R114 ?? "").toLowerCase()),
    operatorInbox: operatorInbox(env.SUPPORT_EMAIL?.trim() || "support@multies.si", env.OPERATOR_INBOX_ORG_ID, env.OPERATOR_INBOX_ADDRESSES),
    freeMail: {
      domain: freeMailDomain(env.FREE_MAIL_DOMAIN, env.APP_URL),
      dailySends: Number(env.FREE_MAIL_DAILY_SENDS ?? 50),
      newAccountDailySends: Number(env.FREE_MAIL_NEW_DAILY_SENDS ?? 20),
      dailyClaims: Number(env.FREE_MAIL_DAILY_CLAIMS ?? 300),
    },
    sendGuard: {
      providerDailyCap: Number(env.MAIL_PROVIDER_DAILY_CAP ?? 100),
      holdAt: Number(env.MAIL_PROVIDER_HOLD_AT ?? 90),
      newSenderDaily: Number(env.NEW_SENDER_DAILY_SENDS ?? 20),
      newSenderDays: Number(env.NEW_SENDER_DAYS ?? 7),
    },
    push: { enabled: env.PUSH_ENABLED === "1" || env.PUSH_ENABLED === "true", expoAccessToken: env.EXPO_ACCESS_TOKEN || undefined },
    ...(env.VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim()
      ? { webPush: { publicKey: env.VAPID_PUBLIC_KEY.trim(), privateKey: env.VAPID_PRIVATE_KEY.trim(), subject: env.VAPID_SUBJECT?.trim() || "mailto:security@multies.si" } } : {}),
    importRunnerToken: env.IMPORT_RUNNER_TOKEN,
    importStepMaxItems: env.IMPORT_STEP_MAX_ITEMS ? Number(env.IMPORT_STEP_MAX_ITEMS) : undefined,
    importStepCapOrgs: env.IMPORT_STEP_CAP_ORGS ? env.IMPORT_STEP_CAP_ORGS.split(",") : undefined,
    backgroundCopy: env.BACKGROUND_COPY === "true",
    docsVisual: env.DOCS_VISUAL !== "off",
    mailConnect: (() => {
      const on = (v: string | undefined) => v === "1" || v === "true" || v === "on";
      const testOnly = (key: string, v: string | undefined) => {
        if (!on(v)) return false;
        if (mode === "production") throw new ConfigError(`${key} is for the local test mail server only and can't be on in production.`);
        return true;
      };
      const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
      return {
        enabled: env.MAIL_CONNECT !== "off" && env.MAIL_CONNECT !== "0" && env.MAIL_CONNECT !== "false",
        allowSelfSigned: testOnly("MAIL_CONNECT_ALLOW_SELF_SIGNED", env.MAIL_CONNECT_ALLOW_SELF_SIGNED),
        allowPrivateHosts: testOnly("MAIL_CONNECT_ALLOW_PRIVATE_HOSTS", env.MAIL_CONNECT_ALLOW_PRIVATE_HOSTS),
        batch: Math.min(num(env.MAIL_SYNC_BATCH, 25), 100),
        dailyCap: num(env.MAIL_SYNC_DAILY_CAP, 500),
        initialDays: num(env.MAIL_SYNC_INITIAL_DAYS, 30),
        initialCap: num(env.MAIL_SYNC_INITIAL_CAP, 200),
        intervalMinutes: num(env.MAIL_SYNC_INTERVAL_MINUTES, 10),
        /**
         * R57: full history backfill. Older mail is stored as header and snippet only (one messages row, no attachment
         * rows, about 6 D1 rows written with its indexes) and its body is fetched when it is first opened.
         * Per connection per UTC day `dailyCap` such messages, account wide `globalDaily`, and none at all once the
         * account's D1 writes reach `stopPct` percent of the daily budget (below the 60% warn level, so staging keeps
         * its writes and new mail is never held back). New mail keeps its own `batch` and `dailyCap` above.
         */
        backfill: {
          enabled: env.MAIL_SYNC_BACKFILL !== "off" && env.MAIL_SYNC_BACKFILL !== "0" && env.MAIL_SYNC_BACKFILL !== "false",
          batch: Math.min(num(env.MAIL_SYNC_BACKFILL_BATCH, 250), 500),
          dailyCap: num(env.MAIL_SYNC_BACKFILL_DAILY_CAP, 5000),
          globalDaily: num(env.MAIL_SYNC_BACKFILL_GLOBAL_DAILY, 7000),
          stopPct: Math.min(num(env.MAIL_SYNC_BACKFILL_STOP_PCT, 50), 85),
          // R61: and none once the account's D1 reads reach this percent of the daily read budget (Free plan: 5M, past it every read fails).
          readStopPct: Math.min(num(env.MAIL_SYNC_BACKFILL_READ_STOP_PCT, 40), 60),
          // R61a: the same stop as rows read today. MAIL_SYNC_BACKFILL_READ_CEILING sets it outright (Workers Paid has no daily
          // limit); otherwise readStopPct of D1_DAILY_READ_BUDGET.
          readCeiling: env.MAIL_SYNC_BACKFILL_READ_CEILING && Number(env.MAIL_SYNC_BACKFILL_READ_CEILING) > 0
            ? Math.floor(Number(env.MAIL_SYNC_BACKFILL_READ_CEILING))
            : Math.floor((Math.max(1_000_000, Number.parseInt(env.D1_DAILY_READ_BUDGET ?? "5000000", 10) || 5_000_000) * Math.min(num(env.MAIL_SYNC_BACKFILL_READ_STOP_PCT, 40), 60)) / 100),
          peekBytes: 6144,
        },
        /** R57: Node only (no Durable Object alarm): the wait before the next chained pass while more mail is waiting. */
        chainMs: env.MAIL_SYNC_CHAIN_MS ? num(env.MAIL_SYNC_CHAIN_MS, 0) : 0,
        live: env.MAIL_LIVE !== "off" && env.MAIL_LIVE !== "0" && env.MAIL_LIVE !== "false",
        liveMinutesPerDay: num(env.MAIL_LIVE_MINUTES_PER_DAY, 900),
        oauth: {
          enabled: on(env.MAIL_OAUTH),
          google: env.GOOGLE_MAIL_CLIENT_ID && env.GOOGLE_MAIL_CLIENT_SECRET ? { clientId: env.GOOGLE_MAIL_CLIENT_ID, clientSecret: env.GOOGLE_MAIL_CLIENT_SECRET } : undefined,
          microsoft: env.MICROSOFT_MAIL_CLIENT_ID && env.MICROSOFT_MAIL_CLIENT_SECRET
            ? { clientId: env.MICROSOFT_MAIL_CLIENT_ID, clientSecret: env.MICROSOFT_MAIL_CLIENT_SECRET, tenant: env.MICROSOFT_MAIL_TENANT || "common" }
            : undefined,
        },
      };
    })(),
    bodyStore: env.BODY_STORE_ENDPOINT && env.BODY_STORE_BUCKET && env.BODY_STORE_ACCESS_KEY_ID && env.BODY_STORE_SECRET_ACCESS_KEY
      ? { endpoint: env.BODY_STORE_ENDPOINT, bucket: env.BODY_STORE_BUCKET, region: env.BODY_STORE_REGION ?? "auto", accessKeyId: env.BODY_STORE_ACCESS_KEY_ID, secretAccessKey: env.BODY_STORE_SECRET_ACCESS_KEY }
      : undefined,
    meetings: env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET ? { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET } : undefined,
    callsTestHook: (() => {
      if (!["1", "true", "on", "yes"].includes(String(env.CALLS_TEST_HOOK ?? "").toLowerCase())) return false;
      if (mode === "production") throw new ConfigError("CALLS_TEST_HOOK fakes video rooms for local tests and can't be on in production.");
      return true;
    })(),
    // F13: the human check needs an outside script host in the page policy, so a configured key is ignored (spam is
    // stopped by the trap field, timing, limits and the Forms plus shield).
    turnstile: undefined,
    xero: env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET ? { clientId: env.XERO_CLIENT_ID, clientSecret: env.XERO_CLIENT_SECRET } : undefined,
    maxMessageBytes: env.MAX_MESSAGE_BYTES ? Number(env.MAX_MESSAGE_BYTES) : 10 * 1024 * 1024,
    mailServer: (() => {
      const missing = (["STALWART_URL", "STALWART_ADMIN_USER", "STALWART_ADMIN_SECRET"] as const).filter((k) => !env[k]);
      const smtpPort = env.MAIL_SMTP_PORT ? Number(env.MAIL_SMTP_PORT) : 465;
      return {
        enabled: missing.length === 0,
        url: env.STALWART_URL?.replace(/\/$/, ""),
        adminUser: env.STALWART_ADMIN_USER,
        adminSecret: env.STALWART_ADMIN_SECRET,
        clientHost: env.MAIL_CLIENT_HOST ?? (env.STALWART_URL ? hostOf(env.STALWART_URL) : `mail.${hostOf(env.APP_URL ?? "http://localhost")}`),
        imapPort: env.MAIL_IMAP_PORT ? Number(env.MAIL_IMAP_PORT) : 993,
        smtpPort,
        smtpSecurity: smtpPort === 465 ? "ssl" as const : "starttls" as const,
        missing,
      };
    })(),
  };
}

/** A percentage from the environment (1 to 100) as a fraction, or the default. */
function pct(v: string | undefined, def: number) {
  const n = Number.parseInt(v ?? "", 10);
  return (Number.isFinite(n) && n >= 1 && n <= 100 ? n : def) / 100;
}

function clampRate(v: string | undefined, fallback: number): number {
  const n = v === undefined ? fallback : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/**
 * The previous identity provider tenant, kept only so phone app builds that still sign in there
 * keep working. Needs the domain and at least one client id; otherwise nothing is added.
 */
export function legacyIdp(env: { AUTH0_LEGACY_DOMAIN?: string; AUTH0_LEGACY_NATIVE_CLIENT_ID?: string; AUTH0_LEGACY_CLIENT_ID?: string }): { legacy?: { domain: string; audience: string[] } } {
  const domain = env.AUTH0_LEGACY_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const audience = [env.AUTH0_LEGACY_NATIVE_CLIENT_ID, env.AUTH0_LEGACY_CLIENT_ID].map((x) => x?.trim()).filter((x): x is string => !!x);
  return domain && audience.length ? { legacy: { domain, audience } } : {};
}

/** AUTH_LOCAL_PASSWORD wins; otherwise the password form is on only when there is no identity provider. */
/**
 * R34: E2E_LOCAL_RATE_KEYS=1 (local Playwright servers only). On anywhere APP_MODE or NODE_ENV says
 * production, the app refuses to start, so a deployed Multies always limits addressless requests too.
 */
export function localRateKeys(flag: string | undefined, mode: string): boolean {
  if (!["1", "true", "on", "yes"].includes(String(flag ?? "").toLowerCase())) return false;
  if (mode === "production") throw new ConfigError("E2E_LOCAL_RATE_KEYS is for local end to end tests and can't be on in production.");
  return true;
}

export function resolveLocalPassword(flag: string | undefined, idpConfigured: boolean): boolean {
  if (flag === "on" || flag === "true") return true;
  if (flag === "off" || flag === "false") return false;
  return !idpConfigured;
}
