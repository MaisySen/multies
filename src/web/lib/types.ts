import type { Plan, PlanId } from "@/shared/plans";
import type { DnsCheckReport, ExpectedRecord } from "@/shared/dns";
import type { Address, AuthResults, Folder } from "@/shared/mail";

export type { Plan, PlanId, DnsCheckReport, ExpectedRecord, Address, Folder };

export interface Me {
  user: { id: string; email: string; name: string; emailVerified: boolean; twoFactor: boolean; platformAdmin: boolean; timezone?: string | null; locale?: string | null };
  organization: { id: string; name: string; plan: PlanId; isDemo: boolean; role: "owner" | "admin" | "member"; timezone: string; country: string; requireSso?: boolean; onboarded?: boolean } | null;
  /** A short one time onboarding: the person's zone and language, and the workspace's name, country and zone for its admins. */
  onboarding?: { needed: boolean; workspace: boolean };
  session?: { loginMethod: string; ssoBlocked: boolean };
  /** The person has a Multies password (an email and password account); Auth0-only people do not. */
  hasPassword?: boolean;
  /** R39 (MB-202): invitations for this person's confirmed address, in workspaces they haven't joined yet. */
  pendingInvites?: { token: string; organization: { name: string }; role: "admin" | "member"; invitedBy: string | null }[];
}

export interface PublicConfig {
  /** R125: tables doc type. */
  tablesR125?: boolean;
  /** POL1: tables and courses to the trash with restore. */
  polishPol1?: boolean;
  /** ANALYTICS-PH: internal product usage analytics is on (the browser still honours Do Not Track). */
  analyticsPh?: boolean;
  /** R122: the help center in Docs. */
  helpCenter?: boolean;
  /** R123: Sites in Docs (SITES_R123). */
  sites?: boolean;
  /** R124: the blog in Sites (BLOG_R124). */
  blog?: boolean;
  /** R121: layout plan P2 navigation (NAV_P2_R121). */
  navP2?: boolean;
  /** R98: typo tolerant search with filters and instant results (SEARCH_R98). */
  searchR98?: boolean;
  /** R110: Ask across the workspace (ASK_R110). */
  askR110?: boolean;
  /** R126: staff directory, onboarding, assets (PEOPLE_R126). */
  peopleR126?: boolean;
  /** TD1: Ask v2 and AI trust controls (ASK_TD1). */
  askTd1?: boolean;
  /** TD5: record mentions and References panels (MENTIONS_TD5). */
  mentionsTd5?: boolean;
  /** R128: team password vault (VAULT_R128). */
  vaultR128?: boolean;
  /** R94: CRM timeline (notes are searchable with R98). */
  crmTimeline?: boolean;
  /** R99: calendar and contacts sync (CalDAV and CardDAV). */
  davSync?: boolean;
  /** R103: Docs plus (link library, web clipper, doc comments, spell check). */
  docsPlus?: boolean;
  /** R101: Files plus (FILES_PLUS_R101): the drive and brand library on the Files page. */
  filesPlus?: boolean;
  /** R102: Smart document inbox (DOC_INBOX_R102): Files > Documents. */
  docInbox?: boolean;
  appName: string;
  mode: "production" | "development";
  demoEnabled: boolean;
  /** R117: Social composer v2, planner views and slots, drafts and approvals, library. */
  socialP2?: boolean;
  /** R118: Social inbox, analytics and account health alerts. */
  socialP2b?: boolean;
  /** R118: the staging only test network is allowed here. */
  socialTestNetwork?: boolean;
  supportEmail?: string;
  outboundDriver: string;
  billingEnabled: boolean;
  /** Booking pages (SCHEDULING_ENABLED). */
  scheduling?: boolean;
  /** R91: dashboards plus (share by link, emailed reports, question builder, alerts, data sources). */
  dashboardsPlus?: boolean;
  /** R95: Tasks plus (My Day, smart repeat, timesheet approval, time tags and export, mind map). */
  tasksPlus?: boolean;
  /** R114: webinar mode for meetings. */
  webinar?: boolean;
  /** R108: contracts in Tools > Templates. */
  contractsR108?: boolean;
  /** R92: resources, time polls and events in Work > Booking page (BOOKING_PLUS). */
  bookingPlus?: boolean;
  officeEditR113?: boolean; // R113
  /** R93: chat style forms, webhook, embed bubble, feedback boards, calls for submissions (FORMS_PLUS_R93). */
  formsPlus?: boolean;
  /** TD2: Forms pro (FORMS_TD2). */
  formsTd2?: boolean;
  homeWidgetsR131?: boolean; // R131
  toursR130?: boolean; // R130
  aiConnectAi2?: boolean; // AI2: Settings, AI connect screen
  meetTd3?: boolean; // TD3: meetings to tasks
  /** R112: anonymous reporting channel (Forms > Reports) and data requests (Settings > Data requests) (REPORTING_R112). */
  reporting?: boolean;
  socialP3R132?: boolean; socialYoutubeUploadR132?: boolean; socialGbpR132?: boolean; // R132
  /** R59: chat channels (WhatsApp, Messenger, Instagram) in the shared inbox (CHAT_CHANNELS). Off unless set. */
  chatChannels?: boolean;
  /** R111: mail archive and retention (MAIL_ARCHIVE_R111): the Archive and retention pane and Audit log filters. */
  mailArchive?: boolean;
  /** Tools P1: document tools (TOOLS_ENABLED with an engine configured). */
  tools?: boolean;
  /** Tools P2: the advanced Tools features on for this deployment (empty when Tools is off). The lead adds it to /api/config. */
  toolFeatures?: string[];
  /** Round 25: identity provider connections shown as sign in buttons ("google-oauth2", "windowslive"). */
  socialConnections?: string[];
  /** R43: the import pages say a run carries on after the page closes (BACKGROUND_COPY, set once proven live). */
  backgroundCopy?: boolean;
  /** R89: whiteboards, diagrams, mind map mode and Present in Docs (DOCS_VISUAL, on unless "off"). */
  docsVisual?: boolean;
  /** R115: address cards, the Visits tab and the booking meeting place (MAPS_R115). */
  maps?: boolean;
  /** R105: invoices and quotes (INVOICES_ENABLED). */
  invoices?: boolean;
  /** R106: expenses and receipts. */
  expenses?: boolean;
  /** TD4: time to invoice (billing runs), owners and admins. */
  billTd4?: boolean;
  /** R129: courses doc type. */
  coursesR129?: boolean;
  mxHosts: { host: string; priority: number }[];
  plans: Plan[];
  sentry: { dsn: string; environment: string; release?: string; tracesSampleRate?: number } | null;
}

export interface Domain {
  id: string;
  name: string;
  status: "pending" | "verified" | "failed";
  createdAt: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  dkimSelector: string;
  catchAllMailboxId: string | null;
  records: ExpectedRecord[];
  lastCheck: DnsCheckReport | null;
  counts: { mailboxes: number; aliases: number } | null;
  sending?: { status: "verified" | "pending" | "error" | "queued"; detail: string | null } | null;
}

export interface Mailbox {
  id: string;
  domainId: string;
  localPart: string;
  address: string;
  displayName: string;
  quotaMb: number;
  usedBytes: number;
  status: "active" | "suspended";
  /** MB-61: the Reply-To sends from this mailbox carry when they name none. */
  replyTo?: string | null;
  createdAt: string;
}

export interface Alias {
  id: string;
  domainId: string;
  localPart: string;
  address: string;
  destinations: string[];
  enabled: boolean;
  createdAt: string;
}

export interface MessageListItem {
  id: string;
  mailboxId: string;
  folder: Folder;
  threadId: string;
  from: Address;
  to: Address[];
  subject: string;
  snippet: string;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  /** R33: when it arrived (the select all job leaves later mail alone). */
  receivedAt?: string;
  /** Set when one of your agents wrote it. */
  sentByAgentId?: string | null;
  /** R31: read status of a sent message (Sent and the thread), when the sender had it on. */
  readStatus?: { tracked: boolean; opens: number; firstOpenAt: string | null; lastOpenAt: string | null } | null;
  /** The provider folder of a connected mailbox's message (round 19), or null. */
  remoteBox?: string | null;
}

export interface Message extends MessageListItem {
  cc: Address[];
  bcc: Address[];
  replyTo: string | null;
  text: string;
  html: string | null;
  messageIdHeader: string | null;
  authResults: AuthResults | null;
  sizeBytes: number;
  attachments: { id: string; filename: string; contentType: string; sizeBytes: number; available: boolean }[];
}

export interface MailboxOverview {
  id: string;
  address: string;
  displayName: string;
  usedBytes: number;
  quotaMb: number;
  kind?: "person" | "agent";
  folders: Partial<Record<Folder, { total: number; unread: number }>>;
  /** A mailbox connected from another provider (round 18). */
  connected?: boolean;
  connectionId?: string | null;
}

export interface Delivery {
  id: string;
  direction: "inbound" | "outbound";
  fromAddress: string;
  toAddress: string;
  subject: string;
  status: "received" | "delivered" | "forwarded" | "queued" | "sent" | "failed" | "rejected" | "bounced" | "complained" | "delayed" | "suppressed";
  provider: string;
  detail: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface Dashboard {
  plan: Plan;
  usage: { domains: number; mailboxes: number; aliases: number };
  domains: { id: string; name: string; status: Domain["status"]; lastCheckedAt: string | null }[];
  storageBytes: number;
  sentToday: number;
  series: { day: string; inbound: number; outbound: number }[];
  recent: AuditEntry[];
  /** People in the workspace and AI agent members, counted apart (agents take no seat). */
  team: { members: number; agents: number };
  onboarding: {
    dismissed: boolean;
    steps: { domainAdded: boolean; domainVerified: boolean; mailboxCreated: boolean; inboundConnected: boolean; firstSend: boolean; teamInvited: boolean };
  };
}

export interface OrgInfo {
  organization: { id: string; name: string; plan: PlanId; isDemo: boolean; role: string; createdAt: string; timezone: string; country: string };
  plan: Plan;
  usage: { domains: number; mailboxes: number; aliases: number };
}

export type Role = "owner" | "admin" | "member";

export interface TeamMember {
  userId: string;
  /** Null for AI agent members, whose address is internal. */
  email: string | null;
  name: string;
  role: Role;
  kind: "human" | "agent";
  title: string | null;
  bio: string | null;
  joinedAt: string;
  lastActiveAt: string | null;
  /** Null for owners and admins, who can open every mailbox. */
  mailboxIds: string[] | null;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: "admin" | "member";
  mailboxIds: string[];
  invitedByName: string | null;
  /** R25 (DF-4): the title and bio the invite carries, copied to the member on accept. */
  title?: string | null;
  bio?: string | null;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
}

export interface TeamInfo {
  members: TeamMember[];
  invites: PendingInvite[];
  seats: { members: number; pendingInvites: number; limit: number };
  agentMembers: { used: number; limit: number };
}

export interface InviteCreated { id: string; link: string; emailed: boolean; emailDetail?: string }

export interface Workspace { id: string; name: string; plan: PlanId; role: Role; isDemo: boolean }
