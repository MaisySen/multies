/**
 * OPS1: the feature flag registry. One entry per on/off switch the deployment reads from its environment
 * (src/server/config.ts). The operator console lists these, and services/console/flags.ts evaluates them:
 * env default (the config value) -> global override -> workspace override, where a locked global row wins.
 *
 * Fields:
 * - key: the stable id stored in feature_flag_overrides.key.
 * - env: the variable that sets the default. `features: true` means its name in the FEATURES list also turns it on.
 * - configPath: where loadConfig puts the value on AppConfig ("channels.enabled" walks into objects).
 * - onWhenUnset: call sites read the value as `!== false`, so a config without it counts as on.
 * - scope: "workspace" flags can differ per workspace; "global" flags are one value for the whole deployment. OPS1: a
 *   flag whose server checks can only read the platform wide value (public pages found by a link, cron passes, helpers
 *   with no workspace at hand) is "global", so the console never offers a per workspace value the server ignores.
 * - runtime: false when the value is read once at boot (routes mounted or not in createApp, the sign in card), so
 *   changing it needs a deploy. The console shows those as "set at deploy" and refuses overrides.
 * - clientKey: the name /api/config uses for it, when the web app reads it.
 * - requires: other flags that must also be on for the web app to show it (as /api/config computes today).
 * - needsConfig: config paths that must be set too for the web app value (for example the video service).
 *
 * Plain data only (no server imports), so the web console can import it.
 */

export type FlagScope = "global" | "workspace";

export type FlagGroup =
  | "Mail and inbox"
  | "Chat and meetings"
  | "Docs and files"
  | "Tasks and work"
  | "Contacts and CRM"
  | "Forms"
  | "Social"
  | "AI"
  | "Calendar and booking"
  | "Money"
  | "Sites and help"
  | "Tools"
  | "Look and navigation"
  | "Sign in and accounts";

export interface FlagDef {
  key: string;
  env: string;
  features?: boolean;
  configPath: string;
  onWhenUnset?: boolean;
  label: string;
  description: string;
  group: FlagGroup;
  scope: FlagScope;
  runtime: boolean;
  /** Why the flag is set at deploy (runtime false). */
  bootReason?: string;
  clientKey?: string;
  requires?: string[];
  needsConfig?: string[];
}

const BOOT_MOUNT = "Its routes are added when the server starts, so a change needs a deploy.";

export const FEATURE_FLAGS = [
  // Mail and inbox
  { key: "mailArchive", env: "MAIL_ARCHIVE_R111", configPath: "mailArchive", label: "Mail archive and retention", description: "Archive and retention settings for mail, and matching filters in the audit log.", group: "Mail and inbox", scope: "workspace", runtime: true, clientKey: "mailArchive" },
  { key: "inboxTd6", env: "INBOX_TD6", configPath: "inboxTd6", label: "One inbox", description: "Mail, chat, mentions, tasks and assistant replies in one list, sorted into Important and Noise.", group: "Mail and inbox", scope: "workspace", runtime: true, clientKey: "inboxTd6" },
  { key: "mailSplitCounts", env: "MAIL_SPLIT_COUNTS", configPath: "mailSplitCounts", onWhenUnset: true, label: "Unread counts on split inbox tabs", description: "Counts unread mail on the Important and Other tabs. Off shows 0 and saves database reads.", group: "Mail and inbox", scope: "global", runtime: true },
  { key: "mailConnect", env: "MAIL_CONNECT", configPath: "mailConnect.enabled", onWhenUnset: true, label: "Connect an existing mailbox", description: "People can connect another mailbox over IMAP and SMTP, and it syncs on a schedule.", group: "Mail and inbox", scope: "global", runtime: true },
  { key: "mailLive", env: "MAIL_LIVE", configPath: "mailConnect.live", onWhenUnset: true, label: "Live mail for connected mailboxes", description: "New mail in a connected mailbox shows up while Multies is open, without waiting for the next sync.", group: "Mail and inbox", scope: "global", runtime: true },
  { key: "backgroundCopy", env: "BACKGROUND_COPY", configPath: "backgroundCopy", label: "Imports keep running after the page closes", description: "The import pages tell people a run carries on in the background after they leave.", group: "Mail and inbox", scope: "global", runtime: true, clientKey: "backgroundCopy" },
  { key: "pushNotifications", env: "PUSH_ENABLED", configPath: "push.enabled", label: "Push notifications to phones", description: "Sends notifications to the phone app.", group: "Mail and inbox", scope: "global", runtime: true },
  { key: "notificationCentre", env: "NOTIFICATION_CENTRE", configPath: "notificationCentre", onWhenUnset: true, label: "Notification centre", description: "Notifications by mail, digests, quiet hours and pause.", group: "Mail and inbox", scope: "workspace", runtime: true },

  // Chat and meetings
  { key: "chatChannels", env: "CHAT_CHANNELS", configPath: "channels.enabled", label: "WhatsApp, Messenger and Instagram chats", description: "Chat channels in the shared inbox. Off hides the settings and chat rows and the webhook answers not found.", group: "Chat and meetings", scope: "global", runtime: true, clientKey: "chatChannels" },
  { key: "chatPlus", env: "CHAT_PLUS", configPath: "chatPlus", onWhenUnset: true, label: "Chat extras", description: "Topics, announcements, decision votes, polls and live questions in chat.", group: "Chat and meetings", scope: "workspace", runtime: false, bootReason: BOOT_MOUNT },
  { key: "webinar", env: "WEBINAR_R114", configPath: "webinar", label: "Webinar mode", description: "Run a meeting as a webinar with hosts and an audience.", group: "Chat and meetings", scope: "global", runtime: true, clientKey: "webinar" },
  { key: "meetTd3", env: "MEET_TD3", configPath: "meetTd3", label: "Meetings to tasks", description: "Suggested action items after a meeting, and a follow up email draft.", group: "Chat and meetings", scope: "global", runtime: true, clientKey: "meetTd3" },
  { key: "videoRecVid1", env: "VIDEO_REC_VID1", configPath: "videoRecVid1", label: "Record calls", description: "Owners and admins save a video of a call on their own device. Nothing is uploaded.", group: "Chat and meetings", scope: "workspace", runtime: true, clientKey: "videoRecVid1", needsConfig: ["meetings"] },
  { key: "videoRecVid2", env: "VIDEO_REC_VID2", features: true, configPath: "videoRecVid2", label: "Better call recording", description: "Pause and resume, speaker or gallery view, quality choice, and chat and transcript saved with the video.", group: "Chat and meetings", scope: "workspace", runtime: true, clientKey: "videoRecVid2", requires: ["videoRecVid1"], needsConfig: ["meetings"] },
  { key: "videoPhoneVid3", env: "VIDEO_PHONE_VID3", features: true, configPath: "videoPhoneVid3", label: "Record calls on phones", description: "Call recording in phone browsers, saved through the share sheet.", group: "Chat and meetings", scope: "workspace", runtime: true, clientKey: "videoPhoneVid3", requires: ["videoRecVid2", "videoRecVid1"], needsConfig: ["meetings"] },
  { key: "translateR116", env: "TRANSLATE_R116", features: true, configPath: "translateR116", label: "Translate and read aloud", description: "Translate and read aloud in mail, docs and chat.", group: "Chat and meetings", scope: "workspace", runtime: true, clientKey: "translateR116" },

  // Docs and files
  { key: "docsVisual", env: "DOCS_VISUAL", configPath: "docsVisual", onWhenUnset: true, label: "Whiteboards and diagrams", description: "Whiteboards, diagrams, mind maps and Present in Docs.", group: "Docs and files", scope: "workspace", runtime: true, clientKey: "docsVisual" },
  { key: "docsPlus", env: "DOCS_PLUS_R103", configPath: "docsPlus", label: "Docs extras", description: "Link library, web clipper, doc comments and spell check.", group: "Docs and files", scope: "workspace", runtime: false, bootReason: BOOT_MOUNT, clientKey: "docsPlus" },
  { key: "filesPlus", env: "FILES_PLUS_R101", configPath: "filesPlus", label: "Workspace drive", description: "The shared drive and brand library on the Files page.", group: "Docs and files", scope: "workspace", runtime: true, clientKey: "filesPlus" },
  { key: "docInbox", env: "DOC_INBOX_R102", configPath: "docInbox", label: "Smart document inbox", description: "Reads uploaded documents, finds fields, and sorts unpaid bills and tax documents. Needs the workspace drive.", group: "Docs and files", scope: "workspace", runtime: true, clientKey: "docInbox", requires: ["filesPlus"] },
  { key: "officeEditR113", env: "OFFICE_EDIT_R113", configPath: "officeEditR113", label: "Edit Office files in the browser", description: "Open Word, Excel, CSV and PowerPoint files in the browser. Saves become new file versions.", group: "Docs and files", scope: "workspace", runtime: true, clientKey: "officeEditR113" },
  { key: "tablesR125", env: "TABLES_R125", configPath: "tablesR125", label: "Tables", description: "Tables as a doc type.", group: "Docs and files", scope: "workspace", runtime: true, clientKey: "tablesR125" },
  { key: "coursesR129", env: "COURSES_R129", configPath: "coursesR129", label: "Courses", description: "Courses as a doc type, with reminders for learners.", group: "Docs and files", scope: "workspace", runtime: true, clientKey: "coursesR129" },
  { key: "polishPol1", env: "POLISH_POL1", configPath: "polishPol1", label: "Trash for tables and courses", description: "Deleted tables and courses go to the trash and can be restored.", group: "Docs and files", scope: "workspace", runtime: false, bootReason: "Off would make deleting a table or course permanent instead of keeping it in the trash, so it is set at deploy.", clientKey: "polishPol1" },
  { key: "mentionsTd5", env: "MENTIONS_TD5", configPath: "mentionsTd5", label: "Mentions and references", description: "Mention records anywhere and see where each one is referenced.", group: "Docs and files", scope: "workspace", runtime: true, clientKey: "mentionsTd5" },

  // Tasks and work
  { key: "tasksPlus", env: "TASKS_PLUS_R95", configPath: "tasksPlus", label: "Tasks extras", description: "My Day time blocks, smart repeat, timesheet approval, time tags and export, and mind map.", group: "Tasks and work", scope: "workspace", runtime: true, clientKey: "tasksPlus" },
  { key: "flows", env: "FLOWS", configPath: "flows", onWhenUnset: true, label: "Automations", description: "The automation builder: flows, runs, page and feed watches, and digests.", group: "Tasks and work", scope: "workspace", runtime: true, clientKey: "flows" },
  { key: "dashboardsPlus", env: "DASHBOARDS_PLUS", configPath: "dashboardsPlus", label: "Dashboard extras", description: "Public dashboard links, emailed reports, question builder, alerts and data sources.", group: "Tasks and work", scope: "global", runtime: true, clientKey: "dashboardsPlus" },
  { key: "homeWidgetsR131", env: "HOME_WIDGETS_R131", configPath: "homeWidgetsR131", label: "Home widgets", description: "Drag to arrange widgets on Home.", group: "Tasks and work", scope: "workspace", runtime: false, bootReason: BOOT_MOUNT, clientKey: "homeWidgetsR131" },
  { key: "searchR98", env: "SEARCH_R98", configPath: "searchR98", label: "Better search", description: "Search that allows typos, with filters, files and notes, and instant results.", group: "Tasks and work", scope: "workspace", runtime: true, clientKey: "searchR98" },

  // Contacts and CRM
  { key: "crmTimeline", env: "CRM_TIMELINE", configPath: "crmTimeline", label: "Contact timeline", description: "Contact and company timeline, logged calls and notes, segments, CSV import and deal forecast.", group: "Contacts and CRM", scope: "workspace", runtime: true, clientKey: "crmTimeline" },
  { key: "crmTd10", env: "CRM_TD10", configPath: "crmTd10", label: "CRM suggestions", description: "CRM suggestions from mail, a shortcut switch and saved analyses.", group: "Contacts and CRM", scope: "workspace", runtime: true, clientKey: "crmTd10" },
  { key: "clientPortal", env: "CLIENT_PORTAL", configPath: "clientPortal", label: "Client portals", description: "Client portals in Contacts and the public portal pages.", group: "Contacts and CRM", scope: "global", runtime: true },
  { key: "portalTd9", env: "PORTAL_TD9", configPath: "portalTd9", label: "Client portal access controls", description: "Portal access per area, a live project view and private comments. Needs client portals.", group: "Contacts and CRM", scope: "global", runtime: false, bootReason: "Off would drop the per area access levels clients have in a portal, an access control, so it is set at deploy.", clientKey: "portalTd9", requires: ["clientPortal"] },
  { key: "peopleR126", env: "PEOPLE_R126", configPath: "peopleR126", label: "Staff directory", description: "Staff directory, onboarding and assets in Contacts.", group: "Contacts and CRM", scope: "workspace", runtime: true, clientKey: "peopleR126" },
  { key: "mapsR115", env: "MAPS_R115", configPath: "mapsR115", label: "Maps", description: "Address lookup on contacts, companies and booking pages, map pins and visit routes.", group: "Contacts and CRM", scope: "workspace", runtime: true, clientKey: "maps" },
  { key: "contractsR108", env: "CONTRACTS_R108", configPath: "contractsR108", label: "Contracts", description: "Contract templates, a guided interview, a clause library and reminders.", group: "Contacts and CRM", scope: "workspace", runtime: false, bootReason: BOOT_MOUNT, clientKey: "contractsR108" },

  // Forms
  { key: "formsPlus", env: "FORMS_PLUS_R93", configPath: "formsPlus", label: "Forms extras", description: "Chat style forms, webhooks, embed bubble, feedback boards, calls for submissions, NPS and CSAT.", group: "Forms", scope: "workspace", runtime: true, clientKey: "formsPlus" },
  { key: "formsTd2", env: "FORMS_TD2", configPath: "formsTd2", label: "Forms pro", description: "More field types, layout blocks, file upload, signature, stronger logic, pages and one question at a time.", group: "Forms", scope: "workspace", runtime: true, clientKey: "formsTd2" },
  { key: "formsTd7", env: "FORMS_TD7", configPath: "formsTd7", label: "Forms pro extras", description: "Brand kit, close date, response cap, password, save and resume, analytics, AI draft and import.", group: "Forms", scope: "workspace", runtime: false, bootReason: "Off would open password protected, closed and capped forms, an access control, so it is set at deploy.", clientKey: "formsTd7" },
  { key: "reporting", env: "REPORTING_R112", configPath: "reporting", label: "Anonymous reports and data requests", description: "An anonymous reporting channel in Forms and data requests in Settings.", group: "Forms", scope: "global", runtime: false, bootReason: "Off would close the anonymous reporting channel and data requests, a compliance duty, so it is set at deploy.", clientKey: "reporting" },

  // Social
  { key: "socialP2", env: "SOCIAL_P2", configPath: "socialP2", onWhenUnset: true, label: "Social planner", description: "The social composer, planner views and slots, drafts and approvals, library and evergreen posts.", group: "Social", scope: "workspace", runtime: true, clientKey: "socialP2" },
  { key: "socialP2b", env: "SOCIAL_P2B", configPath: "socialP2b", onWhenUnset: true, label: "Social inbox and analytics", description: "Social inbox, account health alerts and analytics.", group: "Social", scope: "global", runtime: true, clientKey: "socialP2b" },
  { key: "socialP3R132", env: "SOCIAL_P3_R132", configPath: "socialP3R132", label: "More social networks", description: "Pinterest pin details, YouTube comments, Snapchat share, best times to post and writing help.", group: "Social", scope: "workspace", runtime: false, bootReason: "The Snapchat share pages are added when the server starts, so a change needs a deploy.", clientKey: "socialP3R132" },
  { key: "socialMultiSoc1", env: "SOCIAL_MULTI_SOC1", configPath: "socialMultiSoc1", label: "Several social accounts", description: "Several Facebook Pages and LinkedIn accounts per workspace, chosen per post.", group: "Social", scope: "global", runtime: true, clientKey: "socialMultiSoc1" },
  { key: "socialYoutubeUploadR132", env: "SOCIAL_YOUTUBE_UPLOAD_R132", configPath: "socialYoutubeUploadR132", label: "YouTube upload", description: "Upload videos to YouTube. Held: needs video storage first.", group: "Social", scope: "global", runtime: true, clientKey: "socialYoutubeUploadR132", requires: ["socialP3R132"] },
  { key: "socialGbpR132", env: "SOCIAL_GBP_R132", configPath: "socialGbpR132", label: "Google Business Profile", description: "Post to Google Business Profile. Held: needs API access first.", group: "Social", scope: "global", runtime: true, clientKey: "socialGbpR132", requires: ["socialP3R132"] },

  // AI
  { key: "aiConnectAi2", env: "AI_CONNECT_AI2", configPath: "aiConnectAi2", label: "Connect your own AI", description: "Model picker, connection test, one tap OpenRouter, key detection and more providers in Settings.", group: "AI", scope: "workspace", runtime: true, clientKey: "aiConnectAi2" },
  { key: "aiKeyFallback", env: "AI_KEY_FALLBACK", configPath: "aiKeyFallback", label: "Built in AI when a workspace key fails", description: "When a provider refuses a workspace's own key, the answer comes from built in AI and says so.", group: "AI", scope: "global", runtime: true, requires: ["aiConnectAi2"] },
  { key: "askR110", env: "ASK_R110", configPath: "askR110", label: "Ask", description: "Ask questions across the workspace from Tools and the command menu.", group: "AI", scope: "workspace", runtime: true, clientKey: "askR110" },
  { key: "askTd1", env: "ASK_TD1", configPath: "askTd1", label: "Ask with sources", description: "Answers with sources and coverage, meaning search, ask about this, and AI trust controls.", group: "AI", scope: "workspace", runtime: true, clientKey: "askTd1" },
  { key: "teamaiTd8", env: "TEAMAI_TD8", configPath: "teamaiTd8", label: "Team AI", description: "Workspace AI memory, instruction sets, routines and the assistant in chat.", group: "AI", scope: "workspace", runtime: true, clientKey: "teamaiTd8" },

  // Calendar and booking
  { key: "schedulingEnabled", env: "SCHEDULING_ENABLED", configPath: "schedulingEnabled", label: "Booking pages", description: "Public booking pages and the scheduling API.", group: "Calendar and booking", scope: "global", runtime: true, clientKey: "scheduling" },
  { key: "bookingPlus", env: "BOOKING_PLUS", configPath: "bookingPlus", label: "Booking extras", description: "Bookable resources, time polls and free events with QR tickets. Needs booking pages.", group: "Calendar and booking", scope: "global", runtime: true, clientKey: "bookingPlus", requires: ["schedulingEnabled"] },
  { key: "davSync", env: "DAV_SYNC_R99", configPath: "davSync", label: "Calendar and contacts sync", description: "Sync calendars and contacts with other apps using app passwords.", group: "Calendar and booking", scope: "global", runtime: true, clientKey: "davSync" },

  // Money
  { key: "invoicesEnabled", env: "INVOICES_ENABLED", configPath: "invoicesEnabled", label: "Invoices and quotes", description: "Create and send invoices and quotes.", group: "Money", scope: "workspace", runtime: true, clientKey: "invoices" },
  { key: "expensesR106", env: "EXPENSES_R106", configPath: "expensesR106", label: "Expenses and receipts", description: "Track expenses and read receipts. Needs invoices.", group: "Money", scope: "workspace", runtime: true, clientKey: "expenses", requires: ["invoicesEnabled"] },
  { key: "billTd4", env: "BILL_TD4", configPath: "billTd4", label: "Bill tracked time", description: "Turn tracked time into invoices with billing runs that lock billed time. Needs invoices.", group: "Money", scope: "workspace", runtime: true, clientKey: "billTd4", requires: ["invoicesEnabled"] },

  // Sites and help
  { key: "helpdesk", env: "HELPDESK", configPath: "helpdesk", onWhenUnset: true, label: "Helpdesk and website chat", description: "Helpdesk mode on the shared inbox, the website chat widget and the one tap survey.", group: "Sites and help", scope: "workspace", runtime: false, bootReason: BOOT_MOUNT },
  { key: "helpCenter", env: "HELP_CENTER", configPath: "helpCenter", label: "Help center", description: "A help center in Docs with public help pages.", group: "Sites and help", scope: "workspace", runtime: false, bootReason: BOOT_MOUNT, clientKey: "helpCenter" },
  { key: "sites", env: "SITES_R123", configPath: "sites", label: "Sites", description: "Websites built in Docs, with public pages.", group: "Sites and help", scope: "workspace", runtime: false, bootReason: BOOT_MOUNT, clientKey: "sites" },
  { key: "blogR124", env: "BLOG_R124", configPath: "blogR124", label: "Blog", description: "A blog inside Sites with a subscribe box and email to subscribers. Needs Sites.", group: "Sites and help", scope: "workspace", runtime: false, bootReason: BOOT_MOUNT, clientKey: "blog", requires: ["sites"] },

  // Tools
  { key: "vaultR128", env: "VAULT_R128", configPath: "vaultR128", label: "Password vault", description: "A shared team password vault in Tools.", group: "Tools", scope: "workspace", runtime: true, clientKey: "vaultR128" },
  { key: "esignV2", env: "ESIGN_V2", configPath: "esignV2", onWhenUnset: true, label: "E-sign with email codes", description: "Signers confirm with an email code, with a fuller signing record, seal, templates and bulk send.", group: "Tools", scope: "global", runtime: false, bootReason: "Off would drop the email code signers confirm with, a security check, so it is set at deploy." },

  // Look and navigation
  { key: "navP2R121", env: "NAV_P2_R121", configPath: "navP2R121", label: "New navigation", description: "The newer menu layout: a Contacts section, Mail setup in Settings and Files inside Docs.", group: "Look and navigation", scope: "global", runtime: true, clientKey: "navP2" },
  { key: "designDes1", env: "DESIGN_DES1", configPath: "designDes1", label: "Refreshed design", description: "The refined web app look: depth, sidebar, headers, rows and controls.", group: "Look and navigation", scope: "workspace", runtime: true, clientKey: "designDes1" },
  { key: "langR104", env: "LANG_R104", features: true, configPath: "langR104", label: "Nepali and Hindi", description: "The app in Nepali and Hindi, with a language picker.", group: "Look and navigation", scope: "workspace", runtime: true, clientKey: "langR104" },
  { key: "toursR130", env: "TOURS_R130", configPath: "toursR130", label: "Get started checklist and tours", description: "A Get started checklist, product tours and the tour builder.", group: "Look and navigation", scope: "workspace", runtime: false, bootReason: BOOT_MOUNT, clientKey: "toursR130" },

  // Sign in and accounts
  { key: "demoEnabled", env: "DEMO_MODE", configPath: "demoEnabled", label: "Demo workspaces", description: "Visitors can open a sample workspace filled with demo data.", group: "Sign in and accounts", scope: "global", runtime: false, bootReason: "The sign in page and its demo button are built when the server starts, so a change needs a deploy.", clientKey: "demoEnabled" },
  { key: "passkeyDes1", env: "PASSKEY_DES1", configPath: "passkeyDes1", label: "Passkeys", description: "Add, sign in with, rename and remove passkeys.", group: "Sign in and accounts", scope: "global", runtime: true, clientKey: "passkeyDes1" },
  { key: "mobileWebLink", env: "MOBILE_WEB_LINK", configPath: "mobileWebLink", label: "Open the web app from the phone app", description: "The phone app can sign people in to the web app without typing a password.", group: "Sign in and accounts", scope: "global", runtime: false, bootReason: "Its switch is read in the sign in code, which this console cannot change yet, so a change needs a deploy." },
] as const satisfies readonly FlagDef[];

export type FlagKey = (typeof FEATURE_FLAGS)[number]["key"];

const BY_KEY: ReadonlyMap<string, FlagDef> = new Map(FEATURE_FLAGS.map((f) => [f.key, f as FlagDef]));

export function flagDef(key: string): FlagDef | undefined {
  return BY_KEY.get(key);
}

export function isFlagKey(key: string): key is FlagKey {
  return BY_KEY.has(key);
}

/**
 * Booleans /api/config answers that are not switches an operator can flip: each follows from keys or services being
 * configured (or is a staging test hook), so it stays out of the registry.
 */
export const CONFIG_NON_FLAG_KEYS: Readonly<Record<string, string>> = {
  analyticsPh: "On when the analytics keys are set.",
  socialTestNetwork: "A staging only test network.",
  billingEnabled: "On when the Stripe key is set.",
  meetings: "On when the video service keys are set.",
  tools: "On when the document engine and its keys are set.",
};
