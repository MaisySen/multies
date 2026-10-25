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
}

export interface PublicConfig {
  appName: string;
  mode: "production" | "development";
  demoEnabled: boolean;
  supportEmail?: string;
  outboundDriver: string;
  billingEnabled: boolean;
  /** Booking pages (SCHEDULING_ENABLED). */
  scheduling?: boolean;
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
  /** Set when one of your agents wrote it. */
  sentByAgentId?: string | null;
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
