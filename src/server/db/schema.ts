import { sql } from "drizzle-orm";
import { sqliteTable, sqliteView, text, integer, real, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const createdAt = () => ts("created_at").notNull().$defaultFn(() => new Date());

/** People who can sign in. Managed by Better Auth (model "user"). */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).default(false),
  /** Platform role from Better Auth's admin plugin: "admin" for operators, else "user". */
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("ban_reason"),
  banExpires: ts("ban_expires"),
  /** How the person last signed in ("email", "auth0", "google", ...), from Better Auth's lastLoginMethod plugin. */
  lastLoginMethod: text("last_login_method"),
  /** The person's own IANA time zone (onboarding, from the browser); times they see use it. Null until set. */
  timezone: text("timezone"),
  /** The person's language as a BCP 47 tag ("pt-BR"); formats dates and numbers. Null until set. */
  locale: text("locale"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().default(new Date(0)).$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (t) => [uniqueIndex("users_email_uq").on(t.email)]);

/** A tenant. Every resource below belongs to exactly one organization. */
export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug"),
  logo: text("logo"),
  metadata: text("metadata"),
  plan: text("plan", { enum: ["starter", "pro", "business"] }).notNull().default("starter"),
  /** IANA zone used to show dates to the team. */
  // The column default stays as first made (changing it rebuilds the table); every insert sets the zone.
  timezone: text("timezone").notNull().default("Australia/Sydney"),
  /** ISO 3166-1 alpha-2; used as the billing country default. */
  country: text("country").notNull().default("AU"),
  isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  /** PRIV1a (0164): an internal complimentary plan (set by an operator, never from the app). Billing, webhooks and limits leave it as it is. */
  compPlan: integer("comp_plan", { mode: "boolean" }).notNull().default(false),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  /** Stripe's subscription status, mirrored by webhooks (active, trialing, past_due, canceled, ...). */
  subscriptionStatus: text("subscription_status"),
  currentPeriodEnd: ts("current_period_end"),
  cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
  /** Dunning: when the first failed payment of the current run happened, and when the grace period ends. */
  pastDueSince: ts("past_due_since"),
  graceEndsAt: ts("grace_ends_at"),
  /** Usage alert thresholds already emailed this day, e.g. "2026-10-23:sends:80". */
  usageAlerts: text("usage_alerts"),
  /** Members must sign in with single sign-on (SSO) to open this workspace. */
  requireSso: integer("require_sso", { mode: "boolean" }).notNull().default(false),
  /** Abuse controls (operator console). A suspended workspace cannot send or use the API. */
  suspendedAt: ts("suspended_at"),
  suspendedReason: text("suspended_reason"),
  /** Operator override for outbound sends per day; null means the plan's limit. */
  sendCapDaily: integer("send_cap_daily"),
  /** R34 (0077, MB-171): operator override for call participant-minutes a month; null means the plan's rule (free 1,000, paid none). */
  meetingMinutesCap: integer("meeting_minutes_cap"),
  /** C1 (0089): chat channels (WhatsApp, Messenger, Instagram) in the shared inbox. Off until an admin turns it on. */
  channelsEnabled: integer("channels_enabled", { mode: "boolean" }).notNull().default(false),
  /** C1: agents (MCP) may send chat replies without a person approving each one. Off: their replies wait as drafts. */
  channelsAgentAutosend: integer("channels_agent_autosend", { mode: "boolean" }).notNull().default(false),
  /** How the Stripe subscription bills: "month", or "year" when add-ons total under A$5 a month. */
  billingInterval: text("billing_interval", { enum: ["month", "year"] }),
  /** R62 (0094): shared storage a Business workspace from before the 1,000 GB limit keeps, in MB. Counts only on Business. */
  legacyStorageMb: integer("legacy_storage_mb"),
  /** R62 (0094): the workspace's referral code, made the first time an owner opens the referral link. */
  referralCode: text("referral_code"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("organizations_slug_uq").on(t.slug), uniqueIndex("organizations_referral_code_uq").on(t.referralCode).where(sql`${t.referralCode} IS NOT NULL`)]);

/**
 * Paid add-ons on a workspace (extra domains, storage, mailbox packs, the AI assistant,
 * agent inboxes). Mirrored from the items on the workspace's one Stripe subscription.
 */
export const orgAddons = sqliteTable("org_addons", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  addonId: text("addon_id").notNull(),
  quantity: integer("quantity").notNull(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.orgId, t.addonId] })]);

/** Metered usage per workspace per period, e.g. AI actions in "2026-10". */
export const usageCounters = sqliteTable("usage_counters", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  period: text("period").notNull(),
  metric: text("metric").notNull(),
  count: integer("count").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.orgId, t.period, t.metric] })]);

/** Workspace membership (Better Auth organization plugin, model "member"). */
export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "admin", "member"] }).notNull().default("member"),
  /** `agent`: an AI agent member. Its user row has no password or sign-in; it acts only through its own API keys. */
  kind: text("kind", { enum: ["human", "agent"] }).notNull().default("human"),
  /** Shown in People and on the member card, e.g. "Head of Product". */
  title: text("title"),
  bio: text("bio"),
  createdAt: createdAt(),
  /** R26 (DF-3): set when an admin pauses an agent member. Its keys are refused until it is resumed. */
  disabledAt: ts("disabled_at"),
  /** R26 (DF-3): an agent member's avatar colour, a #rrggbb hex. Initials come from the name. */
  avatarColor: text("avatar_color"),
  /** R26 (DF-3): an optional agent inbox (agents.id) shown with this agent member. Mailbox stays optional. */
  linkedAgentId: text("linked_agent_id"),
}, (t) => [uniqueIndex("members_org_user_uq").on(t.organizationId, t.userId), index("members_user_idx").on(t.userId)]);

/** Better Auth sessions. The cookie carries the token, signed with the app secret. */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  token: text("token").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  activeOrganizationId: text("active_organization_id"),
  impersonatedBy: text("impersonated_by"),
  /** How this session signed in: "email", or the SSO provider id (auth0, google, github). */
  loginMethod: text("login_method"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("sessions_token_uq").on(t.token), index("sessions_user_idx").on(t.userId)]);

/** Sign-in methods: a password ("credential") or a linked OAuth/OIDC identity. */
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  /** PBKDF2-SHA256 hash for the credential provider. */
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("accounts_user_idx").on(t.userId)]);

/** Email verification and password reset tokens (Better Auth). */
export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("verifications_identifier_idx").on(t.identifier)]);

/** TOTP secrets and backup codes (Better Auth two-factor plugin), encrypted by Better Auth. */
export const twoFactors = sqliteTable("two_factors", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  verified: integer("verified", { mode: "boolean" }).default(true),
  failedVerificationCount: integer("failed_verification_count").default(0),
  lockedUntil: ts("locked_until"),
}, (t) => [index("two_factors_user_idx").on(t.userId)]);

/** Rate limit counters shared by every instance (Better Auth). */
export const rateLimits = sqliteTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
}, (t) => [uniqueIndex("rate_limits_key_uq").on(t.key)]);

export const domains = sqliteTable("domains", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status", { enum: ["pending", "verified", "failed"] }).notNull().default("pending"),
  verificationToken: text("verification_token").notNull(),
  dkimSelector: text("dkim_selector").notNull(),
  dkimPublicKey: text("dkim_public_key").notNull(),
  /** PKCS#8 private key, AES-GCM encrypted with the app secret. */
  dkimPrivateKeyEnc: text("dkim_private_key_enc").notNull(),
  /** JSON: last DnsCheckReport. */
  lastCheck: text("last_check"),
  lastCheckedAt: ts("last_checked_at"),
  /** Wave 1 review V7 (0178): when a person last asked for a check (Add domain, Verify); the scheduled re-check doesn't set it. */
  verifyAttemptedAt: ts("verify_attempted_at"),
  verifiedAt: ts("verified_at"),
  catchAllMailboxId: text("catch_all_mailbox_id"),
  /** The outbound provider's id for this domain (Resend), once registered for sending and receiving. */
  providerDomainId: text("provider_domain_id"),
  /** JSON: the DNS records the provider asks for (DKIM, return path, receiving MX). */
  providerRecords: text("provider_records"),
  /** The provider's last word: its status ("verified", "pending"), or why registering failed. */
  providerStatus: text("provider_status"),
  /** Wave 3 review Y1 (0183): a claim released at the 45 day cap while it held mail keeps its row under a .invalid name; this is the name it held. */
  releasedName: text("released_name"),
  releasedAt: ts("released_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("domains_name_uq").on(t.name), index("domains_org_idx").on(t.orgId)]);

export const mailboxes = sqliteTable("mailboxes", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  domainId: text("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  localPart: text("local_part").notNull(),
  address: text("address").notNull(),
  displayName: text("display_name").notNull(),
  quotaMb: integer("quota_mb").notNull(),
  usedBytes: integer("used_bytes").notNull().default(0),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  /** `agent` inboxes belong to an AI agent (see `agents`) and count against the agent inbox allowance, not mailboxes. */
  kind: text("kind", { enum: ["person", "agent"] }).notNull().default("person"),
  /** MB-61 (R25): the Reply-To a send from this mailbox carries when the send names none. Null: no Reply-To. */
  replyTo: text("reply_to"),
  /**
   * PRIV1a (0164, MB-366): a personal mailbox (a connected Gmail or IMAP inbox, or a free address someone claimed) is
   * private to `ownerUserId` plus the people that person shares it with (mailbox_delegations). Owners and admins manage
   * it but can't open it. Not personal: a team mailbox, open to admins and the members they grant, as before.
   */
  personal: integer("personal", { mode: "boolean" }).notNull().default(false),
  /** PRIV1a: who a personal mailbox belongs to. Null on a personal mailbox: unresolved, only workspace owners see it. */
  ownerUserId: text("owner_user_id"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("mailboxes_address_uq").on(t.address), index("mailboxes_org_idx").on(t.orgId), index("mailboxes_personal_idx").on(t.orgId, t.ownerUserId).where(sql`${t.personal} = 1`)]);

/** An address that forwards to one or more destinations (internal mailboxes or external addresses). */

/**
 * A customer app's auth emails sent through Multies (round 13): Supabase's Send Email Hook posts
 * here, signed with the secret Supabase generated, and Multies sends from one of the workspace's
 * mailboxes. No SMTP involved.
 */
export const authEmailHooks = sqliteTable("auth_email_hooks", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  /** "supabase" today. */
  kind: text("kind").notNull().default("supabase"),
  /** The hook secret ("whsec_..."), AES-GCM encrypted with the app secret. */
  secretEnc: text("secret_enc").notNull(),
  /** The Supabase project URL that verification links point at (https://<ref>.supabase.co). */
  supabaseUrl: text("supabase_url").notNull(),
  /** The product name used in subjects and bodies. */
  appName: text("app_name").notNull(),
  /** R25 (MB-60): logo, colour, reply-to, footer, per type text, second language. JSON; NULL is the default email. */
  branding: text("branding"),
  /** R27: the Sign-up emails settings page. Off: the hook answers 503 and sends nothing. */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** R27: the From name on auth emails; NULL uses the mailbox's display name. */
  senderName: text("sender_name"),
  /** R27: JSON number[] of recent "Send test email" times (ms), for its rate limit. */
  testSends: text("test_sends"),
  lastUsedAt: ts("last_used_at"),
  createdAt: createdAt(),
}, (t) => [index("auth_email_hooks_org_idx").on(t.orgId)]);
export const aliases = sqliteTable("aliases", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  domainId: text("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  localPart: text("local_part").notNull(),
  address: text("address").notNull(),
  /** JSON string[] of destination addresses. */
  destinations: text("destinations").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("aliases_address_uq").on(t.address), index("aliases_org_idx").on(t.orgId)]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  folder: text("folder", { enum: ["inbox", "sent", "drafts", "archive", "spam", "trash"] }).notNull(),
  messageIdHeader: text("message_id_header"),
  /** The Message-ID the sending provider gave a sent message, when it replaces ours (Resend does): outside replies point at it. */
  providerMessageIdHeader: text("provider_message_id_header"),
  inReplyTo: text("in_reply_to"),
  references: text("references_header"),
  threadId: text("thread_id").notNull(),
  fromAddress: text("from_address").notNull(),
  fromName: text("from_name").notNull().default(""),
  /** JSON Address[] */
  to: text("to_json").notNull().default("[]"),
  cc: text("cc_json").notNull().default("[]"),
  bcc: text("bcc_json").notNull().default("[]"),
  replyTo: text("reply_to"),
  subject: text("subject").notNull().default(""),
  text: text("text_body").notNull().default(""),
  html: text("html_body"),
  snippet: text("snippet").notNull().default(""),
  sizeBytes: integer("size_bytes").notNull().default(0),
  isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
  isStarred: integer("is_starred", { mode: "boolean" }).notNull().default(false),
  isAnswered: integer("is_answered", { mode: "boolean" }).notNull().default(false),
  hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull().default(false),
  /** JSON: { spf, dkim, dmarc } as reported upstream. */
  authResults: text("auth_results"),
  /** Who wrote an outgoing message: an AI agent (agents.id) or a person (users.id). */
  sentByAgentId: text("sent_by_agent_id"),
  sentByUserId: text("sent_by_user_id"),
  /**
   * Wave 2 review X11: on a draft, the id of the first copy of this draft. Each save stores a new copy and deletes the
   * old one; this ties the copies together, so a save that lost a race finds the copy that won it, not another draft
   * the same person keeps in the thread. Null on mail and on a draft's first copy.
   */
  draftOf: text("draft_of"),
  /** For a connected mailbox (mail_connections): which remote folder (a folder key: "inbox", "sent", "archive", "drafts", "spam", "trash" or "f:<path>") and IMAP UID the copy came from. A null UID means the copy is not tied to a provider folder right now (moved, or sent from Multies). */
  remoteBox: text("remote_box"),
  remoteUid: integer("remote_uid"),
  /** R31 (0066): bulk mail (List-Unsubscribe, List-Id, Precedence bulk, Auto-Submitted), set on inbound ingest. Null on older rows. */
  isBulk: integer("is_bulk", { mode: "boolean" }),
  date: ts("date").notNull(),
  createdAt: createdAt(),
  /**
   * MPLAT-108 (0171): 1 on the earliest message (by date, then id) of its mailbox and lower(from_address), among
   * messages not in Sent or Drafts; the "first time sender" part of the Important rule. Kept by triggers (0171), never
   * written by the app (rows stored before 0171 are filled by services/mail/first-sender.ts).
   * F6: never write messages with INSERT OR REPLACE: the rows it replaces are deleted without firing delete triggers
   * (SQLite runs them only with recursive_triggers on), so a group could be left with no first message. Use an upsert
   * (ON CONFLICT DO UPDATE) or delete and insert. A migration that rebuilds the messages table must create the seven
   * messages_first_sender_* triggers again; tests/first-sender-triggers.test.ts fails if they are missing.
   */
  firstOfSender: integer("first_of_sender", { mode: "boolean" }).notNull().default(false),
}, (t) => [
  index("messages_mailbox_folder_idx").on(t.mailboxId, t.folder, t.date),
  // MPLAT-108 (0171): the trigger lookups for first_of_sender.
  index("messages_sender_first_idx").on(t.mailboxId, sql`lower(${t.fromAddress})`, t.date, t.id).where(sql`${t.folder} <> 'sent' AND ${t.folder} <> 'drafts'`),
  index("messages_first_of_sender_idx").on(t.mailboxId, sql`lower(${t.fromAddress})`).where(sql`${t.firstOfSender} = 1`),
  index("messages_thread_idx").on(t.threadId),
  // R25 (0052): replaces messages_org_idx (org_id); the org prefix still serves org only lookups.
  index("messages_org_folder_date_idx").on(t.orgId, t.folder, t.date),
  index("messages_org_date_idx").on(t.orgId, t.date), // T1F: search reads newest first
  // Dedupe by Message-ID (connected mailbox sync, imports) and thread lookups by In-Reply-To.
  index("messages_mailbox_msgid_idx").on(t.mailboxId, t.messageIdHeader),
  index("messages_mailbox_provider_msgid_idx").on(t.mailboxId, t.providerMessageIdHeader).where(sql`${t.providerMessageIdHeader} IS NOT NULL`),
  // R61 (0093): connected mailbox sync reads (flag window, oldest stored UID) and the header repair sweep.
  index("messages_mailbox_remote_idx").on(t.mailboxId, t.remoteBox, t.remoteUid).where(sql`${t.remoteBox} IS NOT NULL`),
  index("messages_mailbox_repair_idx").on(t.mailboxId, t.id).where(sql`${t.remoteUid} IS NOT NULL AND (${t.fromAddress} = 'unknown@invalid' OR (${t.sizeBytes} < 0 AND ${t.snippet} = ''))`),
]);

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  /** Base64 content; null when the part exceeded the inline storage limit. */
  contentB64: text("content_b64"),
  /** Where a large part lives in the body store (S3 compatible), when one is configured. */
  storageKey: text("storage_key"),
  createdAt: createdAt(),
}, (t) => [index("attachments_message_idx").on(t.messageId)]);

/** One row per delivery attempt, inbound or outbound. */
export const deliveries = sqliteTable("deliveries", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  messageId: text("message_id"),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  fromAddress: text("from_address").notNull(),
  toAddress: text("to_address").notNull(),
  subject: text("subject").notNull().default(""),
  status: text("status", { enum: ["received", "delivered", "forwarded", "queued", "sent", "failed", "rejected", "bounced", "complained", "delayed", "suppressed"] }).notNull(),
  provider: text("provider").notNull(),
  providerMessageId: text("provider_message_id"),
  detail: text("detail"),
  createdAt: createdAt(),
}, (t) => [index("deliveries_org_idx").on(t.orgId, t.createdAt), index("deliveries_provider_msg_idx").on(t.providerMessageId).where(sql`${t.providerMessageId} IS NOT NULL`)]);

/** Signing keys the Cloudflare Email Worker uses to deliver inbound mail. */
export const inboundKeys = sqliteTable("inbound_keys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  secretEnc: text("secret_enc").notNull(),
  lastUsedAt: ts("last_used_at"),
  createdAt: createdAt(),
}, (t) => [index("inbound_keys_org_idx").on(t.orgId)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id"),
  actorEmail: text("actor_email"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  /** JSON metadata */
  metadata: text("metadata"),
  ip: text("ip"),
  /** Set when an AI agent did this (through its API key or MCP), or when a person acted on an agent. */
  agentId: text("agent_id"),
  createdAt: createdAt(),
}, (t) => [index("audit_org_idx").on(t.orgId, t.createdAt), index("audit_agent_idx").on(t.agentId, t.createdAt), index("audit_target_idx").on(t.targetId, t.createdAt).where(sql`${t.targetType} = 'agent_trigger'`)]);

/** Key/value settings owned by the platform (e.g. a generated secret in demo deployments). */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Workspace invitations (Better Auth organization plugin, model "invitation"). */
export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: ts("expires_at").notNull(),
  inviterId: text("inviter_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** JSON string[] of mailbox ids a member will be able to open once they join. */
  mailboxIds: text("mailbox_ids"),
  /** R25 (DF-4): the title and bio the new member starts with; copied to their member row on accept. */
  title: text("title"),
  bio: text("bio"),
  createdAt: createdAt(),
}, (t) => [index("invitations_org_idx").on(t.organizationId), index("invitations_email_idx").on(t.email)]);

/**
 * Which mailboxes a `member` can open. Owners and admins can open every mailbox
 * in the workspace, so they have no rows here.
 */
export const mailboxAccess = sqliteTable("mailbox_access", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.mailboxId] }), index("mailbox_access_org_idx").on(t.orgId)]);

/** PRIV1a (0164): who a personal mailbox's owner shared it with, and how far. Only the owner grants or revokes. */
export const mailboxDelegations = sqliteTable("mailbox_delegations", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** read: open and search. reply: also reply in its threads and organize them. send_as: also write new mail from it. */
  level: text("level", { enum: ["read", "reply", "send_as"] }).notNull(),
  grantedByUserId: text("granted_by_user_id"),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.mailboxId, t.userId] }), index("mailbox_delegations_user_idx").on(t.orgId, t.userId)]);

/**
 * PRIV1a (0164): "Who opened my mailbox". One row when someone other than the owner opens a personal mailbox or one of
 * its threads (at most one a quarter hour per person and thread), and one per share granted or taken back. Never content.
 */
export const mailboxAccessLog = sqliteTable("mailbox_access_log", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id"),
  actorEmail: text("actor_email"),
  /** opened_mailbox, opened_thread, share_granted, share_changed, share_revoked */
  action: text("action").notNull(),
  /** The thread or message opened, or the person a share names. Ids only. */
  targetId: text("target_id"),
  /** web, phone, api */
  device: text("device"),
  createdAt: createdAt(),
  // PRIV1b (P32, 0165): org_id for the workspace delete cascade and the retention prune.
}, (t) => [index("mailbox_access_log_mailbox_idx").on(t.mailboxId, t.createdAt), index("mailbox_access_log_org_idx").on(t.orgId, t.createdAt)]);

/** Processed billing webhooks, keyed by the provider's event id so retries are no-ops. */
export const billingEvents = sqliteTable("billing_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  orgId: text("org_id"),
  createdAt: createdAt(),
});

/**
 * R62 (0094): a workspace that signed up through another workspace's referral link. Both get a Stripe balance credit
 * once the new workspace's first payment has stood for 14 days. No foreign keys: the row is the record of a credit
 * given, and it stays when either workspace is deleted.
 */
export const referrals = sqliteTable("referrals", {
  id: text("id").primaryKey(),
  referrerOrgId: text("referrer_org_id").notNull(),
  referredOrgId: text("referred_org_id").notNull(),
  code: text("code").notNull(),
  status: text("status", { enum: ["signed_up", "pending", "credited", "blocked", "void"] }).notNull().default("signed_up"),
  /** Why a referral was blocked or voided (self_referral_email, self_referral_domain, same_card, member, cap, refunded, ...). */
  reason: text("reason"),
  invoiceId: text("invoice_id"),
  paidAt: ts("paid_at"),
  eligibleAt: ts("eligible_at"),
  creditedAt: ts("credited_at"),
  referrerCreditCents: integer("referrer_credit_cents").notNull().default(0),
  referredCreditCents: integer("referred_credit_cents").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("referrals_referred_uq").on(t.referredOrgId), index("referrals_referrer_idx").on(t.referrerOrgId, t.status, t.creditedAt)]);

/**
 * A mailbox's account on the mail server (Stalwart) that serves IMAP and SMTP for
 * desktop and phone mail apps. The account's own password is random, encrypted with
 * APP_SECRET and never shown: people sign in to mail apps with app passwords.
 */
export const mailServerAccounts = sqliteTable("mail_server_accounts", {
  mailboxId: text("mailbox_id").primaryKey().references(() => mailboxes.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  serverAccountId: text("server_account_id").notNull(),
  secretEnc: text("secret_enc").notNull(),
  createdAt: createdAt(),
}, (t) => [index("mail_server_accounts_org_idx").on(t.orgId)]);

/** App passwords for mail apps. The secret lives only on the mail server (hashed); we keep a label and a hint. */
export const appPasswords = sqliteTable("app_passwords", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  serverCredentialId: text("server_credential_id").notNull(),
  hint: text("hint").notNull(),
  createdAt: createdAt(),
}, (t) => [index("app_passwords_mailbox_idx").on(t.mailboxId), index("app_passwords_org_idx").on(t.orgId)]);

/** API keys for the public REST API (/api/v1). Only a SHA-256 hash of the key is stored. */
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  /** Shown in lists so people can tell keys apart, e.g. `mm_live_3kf9`. */
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  /** `full`, `read`, or (R36) a space separated list of per area scopes (src/server/lib/api-scopes.ts). */
  scope: text("scope").notNull().default("full"),
  /** An agent key acts only as this agent: its own inbox and the mailboxes it was given. */
  agentId: text("agent_id"),
  lastUsedAt: ts("last_used_at"),
  /** Round 2: the key stops working at this moment (401 api_key_expired). Null: it never ends (the default). */
  expiresAt: ts("expires_at"),
  /**
   * Wave 2 review X1: on an agent key, the person who minted it in their own app session. The key reaches a personal
   * mailbox only when this person owns it. Null for a key minted by a workspace key, a connected AI app or anything else
   * that is not a person session (and for older keys the audit log can't prove), so it reaches no personal mailbox.
   */
  mintedByUserId: text("minted_by_user_id"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash), index("api_keys_org_idx").on(t.orgId)]);

/** Outbound webhook endpoints, signed per the Standard Webhooks spec. */
export const webhookEndpoints = sqliteTable("webhook_endpoints", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  description: text("description"),
  /** JSON string[] of event types, or ["*"]. */
  events: text("events").notNull(),
  /** `whsec_...`, encrypted with APP_SECRET. */
  secretEnc: text("secret_enc").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Deliveries in a row that ran out of retries. At the threshold the endpoint is disabled. */
  consecutiveDead: integer("consecutive_dead").notNull().default(0),
  disabledReason: text("disabled_reason"),
  /** How each event is written: our signed JSON, or a chat message body for Slack, Discord or Teams. */
  format: text("format", { enum: ["json", "slack", "discord", "teams"] }).notNull().default("json"),
  /** The integrations catalogue entry this endpoint was connected from, if any. */
  connector: text("connector"),
  createdAt: createdAt(),
}, (t) => [index("webhook_endpoints_org_idx").on(t.orgId)]);

/** One attempt series per event per endpoint. Failed deliveries retry with backoff. */
export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  endpointId: text("endpoint_id").notNull().references(() => webhookEndpoints.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  payload: text("payload").notNull(),
  /** `failed` means retries ran out (the dead-letter state); it can be replayed. */
  status: text("status", { enum: ["pending", "delivered", "failed"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  responseStatus: integer("response_status"),
  lastError: text("last_error"),
  nextAttemptAt: ts("next_attempt_at"),
  deliveredAt: ts("delivered_at"),
  createdAt: createdAt(),
}, (t) => [index("webhook_deliveries_endpoint_idx").on(t.endpointId, t.createdAt), index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt)]);

/** Addresses we will not send to again: hard bounces, spam complaints and manual blocks. */
export const suppressions = sqliteTable("suppressions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  address: text("address").notNull(),
  reason: text("reason", { enum: ["hard_bounce", "complaint", "manual"] }).notNull(),
  detail: text("detail"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("suppressions_org_address_uq").on(t.orgId, t.address)]);

/** DMARC aggregate (RUA) reports received for a workspace's domains (RFC 7489, appendix C). */
export const dmarcReports = sqliteTable("dmarc_reports", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  domainId: text("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  reporter: text("reporter").notNull(),
  reportId: text("report_id").notNull(),
  beginAt: ts("begin_at").notNull(),
  endAt: ts("end_at").notNull(),
  /** JSON of policy_published (p, sp, pct, adkim, aspf). */
  policy: text("policy").notNull(),
  messages: integer("messages").notNull(),
  passed: integer("passed").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("dmarc_reports_uq").on(t.orgId, t.reporter, t.reportId), index("dmarc_reports_domain_idx").on(t.domainId, t.endAt)]);

export const dmarcRecords = sqliteTable("dmarc_records", {
  id: text("id").primaryKey(),
  reportId: text("report_id").notNull().references(() => dmarcReports.id, { onDelete: "cascade" }),
  sourceIp: text("source_ip").notNull(),
  count: integer("count").notNull(),
  disposition: text("disposition").notNull(),
  headerFrom: text("header_from"),
  dkim: text("dkim").notNull(),
  spf: text("spf").notNull(),
}, (t) => [index("dmarc_records_report_idx").on(t.reportId)]);

/** Fixed-window request counters for the API rate limiter (when no edge binding exists). */
export const apiRateLimits = sqliteTable("api_rate_limits", {
  key: text("key").primaryKey(),
  hits: integer("hits").notNull(),
  resetAt: integer("reset_at").notNull(),
}, (t) => [index("api_rate_limits_reset_idx").on(t.resetAt)]);

/** Failed sign-ins per account, for lockout across IPs (credential stuffing). */
export const loginThrottle = sqliteTable("login_throttle", {
  email: text("email").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStart: ts("window_start").notNull(),
  lockedUntil: ts("locked_until"),
});

/**
 * Round 2: signed webhook deliveries already handled, so a replay inside the signature window is answered without
 * running again (lib/webhook-receipts.ts). `source` names the provider, `receipt_id` its delivery id. WITHOUT ROWID
 * (migration 0173): one row written per receipt, no separate key index. Swept after about 10 minutes.
 */
export const webhookReceipts = sqliteTable("webhook_receipts", {
  source: text("source").notNull(),
  receiptId: text("receipt_id").notNull(),
  at: ts("at").notNull(),
}, (t) => [primaryKey({ columns: [t.source, t.receiptId] })]);

/**
 * Idempotency keys for mutating API calls (Stripe semantics): the first response is
 * stored for 24 hours and replayed for retries with the same key and body.
 */
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  requestHash: text("request_hash").notNull(),
  state: text("state", { enum: ["running", "done"] }).notNull().default("running"),
  responseStatus: integer("response_status"),
  responseBody: text("response_body"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("idempotency_scope_key_uq").on(t.scope, t.key), index("idempotency_created_idx").on(t.createdAt)]);

/**
 * Durable background jobs: outbound mail retries and other work that must survive a
 * provider outage. Retries with exponential backoff, then a dead-letter state an
 * operator can replay.
 */
export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  orgId: text("org_id"),
  payload: text("payload").notNull(),
  status: text("status", { enum: ["pending", "running", "done", "dead"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(8),
  runAt: ts("run_at").notNull(),
  lockedUntil: ts("locked_until"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at"),
}, (t) => [index("jobs_due_idx").on(t.status, t.runAt), index("jobs_org_idx").on(t.orgId)]);

/** Results of the scheduled self check, for the status page's uptime history. */
export const uptimeChecks = sqliteTable("uptime_checks", {
  id: text("id").primaryKey(),
  at: ts("at").notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  latencyMs: integer("latency_ms").notNull(),
  components: text("components").notNull(),
}, (t) => [index("uptime_checks_at_idx").on(t.at)]);

/** Signals from outbound spam heuristics and operator actions, for the abuse queue. */
export const abuseEvents = sqliteTable("abuse_events", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  score: integer("score").notNull().default(0),
  detail: text("detail"),
  resolvedAt: ts("resolved_at"),
  createdAt: createdAt(),
}, (t) => [index("abuse_events_org_idx").on(t.orgId, t.createdAt), index("abuse_events_open_idx").on(t.resolvedAt)]);

/**
 * An AI agent with its own inbox (a mailbox of kind `agent`). It works through
 * agent-scoped API keys and the MCP server, within its send cap, recipient rules and
 * approval mode. Every action it takes is in the audit log with its id.
 */
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  /** `always`: a person approves every send. `external`: only mail leaving Multies. `never`: sends go straight out. */
  approvalMode: text("approval_mode", { enum: ["always", "external", "never"] }).notNull().default("always"),
  sendCapDaily: integer("send_cap_daily").notNull().default(100),
  /** JSON string[] of addresses or "@domain" entries the agent may send to; null means anyone. */
  allowedRecipients: text("allowed_recipients"),
  status: text("status", { enum: ["active", "paused"] }).notNull().default("active"),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("agents_mailbox_uq").on(t.mailboxId), index("agents_org_idx").on(t.orgId)]);

/** Extra mailboxes an agent can read and send from (a shared support@ inbox, say), beside its own. */
export const agentMailboxAccess = sqliteTable("agent_mailbox_access", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.agentId, t.mailboxId] }), index("agent_mailbox_access_mailbox_idx").on(t.mailboxId)]);

/** Messages an agent asked to send that wait for a person to approve or reject them. */
export const sendApprovals = sqliteTable("send_approvals", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  /** The thread a reply belongs to, so the shared inbox can show it in place. */
  threadId: text("thread_id"),
  /** JSON: the send request (to, cc, bcc, subject, text, html, inReplyToId). */
  payload: text("payload").notNull(),
  status: text("status", { enum: ["pending", "sent", "rejected", "failed", "expired"] }).notNull().default("pending"),
  apiKeyId: text("api_key_id"),
  decidedByUserId: text("decided_by_user_id"),
  decidedByEmail: text("decided_by_email"),
  decidedAt: ts("decided_at"),
  note: text("note"),
  messageId: text("message_id"),
  error: text("error"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
}, (t) => [index("send_approvals_org_status_idx").on(t.orgId, t.status, t.createdAt), index("send_approvals_agent_idx").on(t.agentId, t.createdAt)]);

/** An ordered event log per workspace: what agents stream (SSE) and poll for. */
export const agentEvents = sqliteTable("agent_events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  agentId: text("agent_id"),
  type: text("type").notNull(),
  data: text("data").notNull(),
  createdAt: createdAt(),
}, (t) => [index("agent_events_org_seq_idx").on(t.orgId, t.seq), index("agent_events_agent_seq_idx").on(t.agentId, t.seq)]);

/** Connected business apps (Xero today). Tokens are encrypted with APP_SECRET. */
export const integrations = sqliteTable("integrations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["xero"] }).notNull(),
  tenantId: text("tenant_id"),
  tenantName: text("tenant_name"),
  tokensEnc: text("tokens_enc").notNull(),
  expiresAt: ts("expires_at"),
  connectedByUserId: text("connected_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("integrations_org_provider_uq").on(t.orgId, t.provider)]);

/**
 * The workspace's own AI provider key ("bring your own AI"). Multies never pays for model
 * calls: the assistant runs only with this key. The key is encrypted with APP_SECRET.
 */
export const aiKeys = sqliteTable("ai_keys", {
  orgId: text("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["openai", "anthropic", "openrouter", "groq", "gemini", "mistral", "deepseek", "custom"] }).notNull(),
  model: text("model").notNull(),
  keyEnc: text("key_enc").notNull(),
  /** AI2 (migration 0150): the https base address of a custom OpenAI compatible server; null for the named providers. */
  baseUrl: text("base_url"),
  /** The last 4 characters, to show which key is saved. */
  keyHint: text("key_hint").notNull(),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
  /**
   * QUAL1 (migration 0170): what the provider said the last time it refused this key or its model (key_refused,
   * no_credit, model_unavailable) and when. Null while it works; a call that works or a passed test clears it.
   */
  problem: text("problem", { enum: ["key_refused", "no_credit", "model_unavailable"] }),
  problemAt: ts("problem_at"),
});

/** AI2 (migration 0150): a workspace's live model list, read with its own key, kept 10 minutes. */
export const aiModelCache = sqliteTable("ai_model_cache", {
  orgId: text("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  /** Which saved key the list belongs to (provider, base address and key hint, hashed); a new key misses the cache. */
  fingerprint: text("fingerprint").notNull(),
  modelsJson: text("models_json").notNull(),
  live: integer("live", { mode: "boolean" }).notNull().default(true),
  fetchedAt: ts("fetched_at").notNull(),
});

/** AI2 (migration 0150): one tap OpenRouter sign in. The PKCE verifier stays here (encrypted), never in the browser. */
export const aiOauthStates = sqliteTable("ai_oauth_states", {
  /** SHA-256 of the state sent to OpenRouter (the raw state is never stored). */
  stateHash: text("state_hash").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** SHA-256 of the httpOnly browser nonce, so the return must come back to the same browser. */
  nonceHash: text("nonce_hash").notNull(),
  verifierEnc: text("verifier_enc").notNull(),
  createdAt: ts("created_at").notNull(),
});

/**
 * Tools P2: the AI meter (migration 0095). One row per UTC day per workspace, plus org_id "*" for the
 * whole account. Written only by services/tools/ai-meter.ts (raw SQL upserts guarded by the caps).
 */
export const aiUsageDaily = sqliteTable("ai_usage_daily", {
  day: text("day").notNull(),
  orgId: text("org_id").notNull(),
  units: integer("units").notNull().default(0),
  calls: integer("calls").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.day, t.orgId] })]);

/**
 * Mail imports from Gmail, Outlook or any IMAP server. A runner (deploy/import-runner,
 * imapsync in Docker) claims queued jobs with IMPORT_RUNNER_TOKEN and copies the mail into
 * the mailbox over IMAP. The source app password is encrypted and wiped when the job ends.
 */
export const importJobs = sqliteTable("import_jobs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["gmail", "outlook", "imap"] }).notNull(),
  sourceHost: text("source_host").notNull(),
  sourcePort: integer("source_port").notNull().default(993),
  sourceUser: text("source_user").notNull(),
  secretEnc: text("secret_enc"),
  status: text("status", { enum: ["queued", "running", "done", "failed", "cancelled"] }).notNull().default("queued"),
  messagesDone: integer("messages_done").notNull().default(0),
  messagesTotal: integer("messages_total"),
  error: text("error"),
  createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  claimedAt: ts("claimed_at"),
  heartbeatAt: ts("heartbeat_at"),
  finishedAt: ts("finished_at"),
  createdAt: createdAt(),
}, (t) => [index("import_jobs_org_idx").on(t.orgId), index("import_jobs_status_idx").on(t.status)]);

/**
 * A person's existing mailbox at another provider (round 18), connected over IMAP and SMTP.
 * The mail shows in a Multies mailbox (mailbox_id) on the shared "connected" domain row, synced
 * on a schedule; replies go out through the provider's own SMTP. The app password (or the OAuth
 * refresh token) is AES-GCM encrypted with the app secret and deleted with the row.
 */
export const mailConnections = sqliteTable("mail_connections", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  email: text("email").notNull(),
  username: text("username").notNull(),
  imapHost: text("imap_host").notNull(),
  imapPort: integer("imap_port").notNull(),
  imapSecurity: text("imap_security", { enum: ["tls", "starttls"] }).notNull(),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull(),
  smtpSecurity: text("smtp_security", { enum: ["tls", "starttls"] }).notNull(),
  authKind: text("auth_kind", { enum: ["password", "oauth"] }).notNull().default("password"),
  secretEnc: text("secret_enc").notNull(),
  savesSent: integer("saves_sent", { mode: "boolean" }).notNull().default(false),
  /** PRIV1b (P60): "verifying" waits for the code emailed to the address (an unrecognised server); nothing syncs or sends. */
  status: text("status", { enum: ["active", "syncing", "auth_failed", "error", "paused", "verifying"] }).notNull().default("active"),
  lastError: text("last_error"),
  lastSyncAt: ts("last_sync_at"),
  /** PRIV1b (P60, 0175): the emailed code's HMAC, when it ends, wrong tries and when it was sent. Null once verified. */
  verifyCodeHash: text("verify_code_hash"),
  verifyExpiresAt: ts("verify_expires_at"),
  verifyTries: integer("verify_tries").notNull().default(0),
  verifySentAt: ts("verify_sent_at"),
  /**
   * Wave 2 review X5: the wait for the code suspended the mailbox (it was on before), so entering the code turns it back
   * on. Cleared when someone suspends the mailbox while the code is pending, so the code never undoes their suspend.
   */
  verifySuspendedMailbox: integer("verify_suspended_mailbox", { mode: "boolean" }).notNull().default(false),
  /** Wave 1 review V4 (0177): this connection made its mailbox; false when it took over a kept (legal hold) copy. */
  madeMailbox: integer("made_mailbox", { mode: "boolean" }).notNull().default(false),
  nextSyncAt: ts("next_sync_at"),
  initialDone: integer("initial_done", { mode: "boolean" }).notNull().default(false),
  /** JSON: per folder UIDVALIDITY and last UID seen, plus the Sent, Archive and Trash paths. */
  syncState: text("sync_state").notNull().default("{}"),
  messagesSynced: integer("messages_synced").notNull().default(0),
  /** Messages stored today (UTC, `day`), for the per connection daily cap. */
  messagesToday: integer("messages_today").notNull().default(0),
  day: text("day"),
  createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("mail_connections_mailbox_uq").on(t.mailboxId), index("mail_connections_org_idx").on(t.orgId), index("mail_connections_due_idx").on(t.status, t.nextSyncAt)]);

/** Read, star and move changes made in Multies on synced mail, waiting to be applied at the provider. */
export const mailSyncOutbox = sqliteTable("mail_sync_outbox", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull().references(() => mailConnections.id, { onDelete: "cascade" }),
  remoteBox: text("remote_box").notNull(),
  remoteUid: integer("remote_uid").notNull(),
  action: text("action", { enum: ["seen", "unseen", "flag", "unflag", "archive", "trash", "inbox", "spam", "move"] }).notNull(),
  /** Round 19: for "move", the folder key it goes to (services/connect/sync.ts, BoxKey). */
  dest: text("dest"),
  /** Round 19: the Multies message, so its new UID can be recorded after a move. */
  messageId: text("message_id"),
  createdAt: createdAt(),
}, (t) => [index("mail_sync_outbox_conn_idx").on(t.connectionId)]);


// ---------------------------------------------------------------- suite: work management, docs, contacts
// Every suite table follows the same rules: a sortable id, org_id, who created it (a member,
// an agent or the system), updated_at, a version number and a deleted_at tombstone. Writes go
// through services/suite/write.ts, which also records an activity entry and a change entry.

const suiteCols = () => ({
  createdByType: text("created_by_type", { enum: ["member", "agent", "system"] }).notNull().default("member"),
  createdById: text("created_by_id"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
  version: integer("version").notNull().default(1),
  deletedAt: ts("deleted_at"),
});

/** A project holds tasks on a board with its own ordered statuses. */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** A short key shown before task numbers, e.g. OPS. */
  key: text("key").notNull(),
  color: text("color").notNull().default("#ff5a36"),
  /** Next task number in this project. R33: no longer written; the live counter is project_counters (claimNumbers). Kept for rollback. */
  nextNumber: integer("next_number").notNull().default(1),
  archivedAt: ts("archived_at"),
  /** Health set by hand on the portfolio: on track, at risk or off track. */
  health: text("health", { enum: ["on_track", "at_risk", "off_track"] }),
  healthNote: text("health_note").notNull().default(""),
  /** The person who owns the project (a user id), shown on the portfolio. */
  ownerUserId: text("owner_user_id"),
  /** Round 21: what a task's estimate counts in this project. */
  estimateUnit: text("estimate_unit", { enum: ["points", "hours"] }).notNull().default("points"),
  /** R21: new mail and form tasks for this project wait in Triage until someone accepts them. */
  triage: integer("triage", { mode: "boolean" }).notNull().default(false),
  ...suiteCols(),
}, (t) => [index("projects_org_idx").on(t.orgId)]);

/**
 * R33 (0073): the next task number per project, off the wide projects row (1 row written per claim instead of 3).
 * WITHOUT ROWID in the migration, so the primary key is the row and there is no second index entry. Filled on first
 * claim from projects.next_number, which is kept (no longer written) so a rollback still works.
 */
export const projectCounters = sqliteTable("project_counters", {
  projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  nextNumber: integer("next_number").notNull(),
});

/** R33 (0073): keys a project used before a key edit, so old refs (OPS-12) still open the task. WITHOUT ROWID. */
export const projectKeyAliases = sqliteTable("project_key_aliases", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.key] })]);

/** Custom statuses per project, in board order. `category` maps each to to do, doing or done. */
export const projectStatuses = sqliteTable("project_statuses", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category", { enum: ["todo", "doing", "done"] }).notNull(),
  color: text("color").notNull().default("#8a8f98"),
  position: integer("position").notNull(),
  ...suiteCols(),
}, (t) => [index("project_statuses_project_idx").on(t.projectId, t.position), index("project_statuses_org_idx").on(t.orgId)]);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  statusId: text("status_id").notNull(),
  /** Mirrors the status's category so lists and agents can filter without a join. */
  status: text("status", { enum: ["todo", "doing", "done"] }).notNull().default("todo"),
  title: text("title").notNull(),
  notes: text("notes").notNull().default(""),
  assigneeType: text("assignee_type", { enum: ["member", "agent"] }),
  assigneeId: text("assignee_id"),
  priority: text("priority", { enum: ["none", "low", "medium", "high", "urgent"] }).notNull().default("none"),
  startAt: ts("start_at"),
  dueAt: ts("due_at"),
  /** JSON string[] */
  labels: text("labels").notNull().default("[]"),
  /** R84 (0104): people beside the main assignee, JSON ["member:<id>", "agent:<id>"]; lists read no other table. */
  coAssignees: text("co_assignees").notNull().default("[]"),
  parentId: text("parent_id"),
  /** Order inside a status column (fractional, so a move writes one row). */
  position: real("position").notNull().default(0),
  /** The email thread the task came from; replies on it show on the task. */
  threadId: text("thread_id"),
  messageId: text("message_id"),
  sourceFrom: text("source_from"),
  sourceSubject: text("source_subject"),
  completedAt: ts("completed_at"),
  /** Due date reminders already sent, e.g. "due:2026-10-24". */
  reminderSentFor: text("reminder_sent_for"),
  /** JSON repeat rule ({ freq, interval, weekdays?, monthDay?, until? }); finishing the task makes the next one. */
  repeatRule: text("repeat_rule"),
  /** Set on tasks brought in from another work tool: a hash of the source and its own id, so a re-run skips them. */
  importKey: text("import_key"),
  /** R21: task, story, bug or epic. An item whose parent is an epic is in that epic (no index of its own). */
  type: text("type", { enum: ["task", "story", "bug", "epic"] }).notNull().default("task"),
  /** Round 21: the sprint this task is in (null: the project's backlog) and its estimate (points or hours, per project). */
  sprintId: text("sprint_id"),
  points: real("points"),
  /** R21: "pending" while the task waits in Triage (hidden from lists); null for normal tasks. */
  triageState: text("triage_state", { enum: ["pending"] }),
  /** R21: where a triage item came from: mail, form, api or chat. */
  triageSource: text("triage_source", { enum: ["mail", "form", "api", "chat", "agent"] }),
  /** R32 (0069): a pending item snoozed until this time is out of the queue and its count until then. */
  triageSnoozedUntil: ts("triage_snoozed_until"),
  /** R32 (0069): why a Triage item was declined, and the task it was marked a duplicate of. */
  triageReason: text("triage_reason"),
  duplicateOf: text("duplicate_of"),
  /**
   * R48 (0087): what the task lists show, kept on the row by triggers that recount from the source rows (comments,
   * checklist items, subtasks, field values), so a list reads no other table for them. fieldCount > 0 only says the
   * task has field values to read. Never set these from code.
   */
  commentCount: integer("comment_count").notNull().default(0),
  checklistTotal: integer("checklist_total").notNull().default(0),
  checklistDone: integer("checklist_done").notNull().default(0),
  subtaskTotal: integer("subtask_total").notNull().default(0),
  subtaskDone: integer("subtask_done").notNull().default(0),
  fieldCount: integer("field_count").notNull().default(0),
  ...suiteCols(),
}, (t) => [
  // R25 (0052): replaces tasks_org_project_idx with the same leading columns plus three, so counts read the index only.
  index("tasks_org_project_cover_idx").on(t.orgId, t.projectId, t.statusId, t.position, t.status, t.deletedAt, t.triageState),
  index("tasks_org_thread_idx").on(t.orgId, t.threadId).where(sql`${t.threadId} IS NOT NULL`),
  index("tasks_org_due_idx").on(t.orgId, t.dueAt).where(sql`${t.dueAt} IS NOT NULL`), // R32 (0072): partial
  index("tasks_parent_idx").on(t.parentId).where(sql`${t.parentId} IS NOT NULL`),
  uniqueIndex("tasks_project_number_uq").on(t.projectId, t.number),
  uniqueIndex("tasks_org_import_key_uq").on(t.orgId, t.importKey).where(sql`${t.importKey} IS NOT NULL`),
  index("tasks_sprint_idx").on(t.sprintId).where(sql`${t.sprintId} IS NOT NULL`),
  index("tasks_org_triage_idx").on(t.orgId, t.createdAt).where(sql`${t.triageState} IS NOT NULL`),
  // R40 (0082): task lists in their default order (position, newest first) walk these and stop at the page size,
  // instead of reading and sorting every task of the workspace or project (927 rows for a page of 50 on HQ).
  index("tasks_org_live_pos_idx").on(t.orgId, t.position, sql`${t.createdAt} desc`).where(sql`${t.deletedAt} IS NULL AND ${t.triageState} IS NULL`),
  index("tasks_org_project_live_pos_idx").on(t.orgId, t.projectId, t.position, sql`${t.createdAt} desc`).where(sql`${t.deletedAt} IS NULL AND ${t.triageState} IS NULL`),
  index("tasks_org_updated_live_idx").on(t.orgId, t.updatedAt).where(sql`${t.deletedAt} IS NULL AND ${t.triageState} IS NULL`), // T1F: search reads newest first
]);

/**
 * R48 (0088): live task counts per project and status category, kept by triggers on tasks (see the migration), so the
 * project list reads a few summary rows instead of every live task of the workspace.
 */
export const projectStatusCounts = sqliteTable("project_status_counts", {
  orgId: text("org_id").notNull(),
  projectId: text("project_id").notNull(),
  status: text("status", { enum: ["todo", "doing", "done"] }).notNull(),
  n: integer("n").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.orgId, t.projectId, t.status] })]);

export const taskComments = sqliteTable("task_comments", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  ...suiteCols(),
}, (t) => [index("task_comments_task_idx").on(t.taskId, t.createdAt)]);

/** A saved filter on a project (or across projects): which view, and which filters. */
export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id"),
  userId: text("user_id"),
  name: text("name").notNull(),
  view: text("view", { enum: ["board", "list", "calendar", "timeline", "sprints", "workload"] }).notNull().default("list"),
  /** JSON: { assignee?, status?, priority?, label?, due?, q? } plus R84 sort, dir and group. */
  filters: text("filters").notNull().default("{}"),
  /** R84 (0104): shown as a tab on Tasks (a shared view for everyone, a private one for its owner), in `position` order. */
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  position: real("position").notNull().default(0),
  ...suiteCols(),
}, (t) => [index("saved_views_org_idx").on(t.orgId, t.projectId)]);

/** R84 (0104): the workspace's tags and their colours. tasks.labels keeps the names; a name with no row here shows grey. */
export const workspaceTags = sqliteTable("workspace_tags", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("#64748b"),
  position: real("position").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("workspace_tags_org_name_uq").on(t.orgId, t.name)]);

/** Rich text docs (Tiptap JSON), linked to projects, tasks, threads or contacts. */
export const docs = sqliteTable("docs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /** Tiptap (ProseMirror) JSON. */
  content: text("content").notNull().default("{\"type\":\"doc\",\"content\":[]}"),
  /** Plain text of the content, for search and for agents. */
  plainText: text("plain_text").notNull().default(""),
  projectId: text("project_id"),
  /** R24: the page above this one in the docs tree (null at the top). Read with docs_org_idx, no index of its own. */
  parentId: text("parent_id"),
  /** R24: order among siblings, fractional so a move writes one row. */
  position: real("position").notNull().default(0),
  /** R89: "doc", or "whiteboard" for a doc that is one board (set by the server from the content, never sent). R125: "table" for a table doc (set at create, never changed). R129: "course" for a course doc. */
  kind: text("kind", { enum: ["doc", "whiteboard", "table", "course"] }).notNull().default("doc"), // R129: course
  ...suiteCols(),
}, (t) => [index("docs_org_idx").on(t.orgId, t.updatedAt)]);

/**
 * R39: page history. A saved state of a doc (title and Tiptap JSON) from before an editing session, a named version, or the
 * safety copy taken before a restore. At most one new row per doc per 10 minute editing session (deferrable: a failed
 * snapshot never fails the edit); the 50 newest unnamed rows per doc are kept, named rows always.
 */
export const docVersions = sqliteTable("doc_versions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  docId: text("doc_id").notNull().references(() => docs.id, { onDelete: "cascade" }),
  /** The doc's version number when this state was current. */
  docVersion: integer("doc_version").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  plainText: text("plain_text").notNull().default(""),
  /** Who saved this state, read from the doc's change feed when the snapshot was taken. */
  authorType: text("author_type", { enum: ["member", "agent", "system"] }).notNull().default("member"),
  authorId: text("author_id"),
  authorName: text("author_name").notNull().default(""),
  /** "edit": before someone else's editing session; "restore": the page as it was just before a restore. */
  reason: text("reason", { enum: ["edit", "restore"] }).notNull().default("edit"),
  /** A person's label; a named version is never pruned. */
  name: text("name"),
  /** When this state was saved (the doc's updated_at then). */
  savedAt: ts("saved_at").notNull(),
  createdAt: createdAt(),
}, (t) => [index("doc_versions_doc_idx").on(t.docId, t.createdAt)]);

export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  domain: text("domain"),
  notes: text("notes").notNull().default(""),
  ...suiteCols(),
  // No separate org_id index: companies_org_domain_uq starts with org_id and serves the same lookups (one index write fewer per row).
}, (t) => [uniqueIndex("companies_org_domain_uq").on(t.orgId, t.domain)]);

/** People the workspace corresponds with. Created from mail automatically, or by hand. */
export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  companyId: text("company_id"),
  name: text("name").notNull().default(""),
  email: text("email").notNull(),
  phone: text("phone"),
  title: text("title"),
  notes: text("notes").notNull().default(""),
  source: text("source", { enum: ["mail", "manual", "import", "agent"] }).notNull().default("mail"),
  ownerUserId: text("owner_user_id"),
  messageCount: integer("message_count").notNull().default(0),
  firstContactAt: ts("first_contact_at"),
  lastContactAt: ts("last_contact_at"),
  ...suiteCols(),
}, (t) => [uniqueIndex("contacts_org_email_uq").on(t.orgId, t.email), index("contacts_org_last_idx").on(t.orgId, t.lastContactAt), index("contacts_org_recent_live_idx").on(t.orgId, sql`coalesce(${t.lastContactAt}, ${t.updatedAt})`).where(sql`${t.deletedAt} IS NULL`), index("contacts_company_idx").on(t.companyId).where(sql`${t.companyId} IS NOT NULL`),
  // MPLAT-108 (0171): saved contacts for the Important rule, without reading the automatic "mail" contacts.
  index("contacts_org_kept_email_idx").on(t.orgId, sql`lower(${t.email})`).where(sql`${t.source} <> 'mail'`)]);

/** A simple sales pipeline. Values are in cents, AUD. */
export const deals = sqliteTable("deals", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  stage: text("stage", { enum: ["lead", "qualified", "proposal", "won", "lost"] }).notNull().default("lead"),
  valueCents: integer("value_cents").notNull().default(0),
  contactId: text("contact_id"),
  companyId: text("company_id"),
  ownerUserId: text("owner_user_id"),
  expectedCloseAt: ts("expected_close_at"),
  position: real("position").notNull().default(0),
  /** R94 (0115): win chance 0 to 100; null means the stage's default (see DEAL_PROBABILITY). */
  probability: integer("probability"),
  /** R94 (0115): why it was won or lost, asked when the deal lands in Won or Lost. */
  closeReason: text("close_reason"),
  /** R94 (0115): when it moved into Won or Lost; cleared when reopened. */
  closedAt: ts("closed_at"),
  ...suiteCols(),
}, (t) => [index("deals_org_stage_idx").on(t.orgId, t.stage, t.position), index("deals_contact_idx").on(t.contactId).where(sql`${t.contactId} IS NOT NULL`), index("deals_company_idx").on(t.companyId).where(sql`${t.companyId} IS NOT NULL`)]);

/** R94 (0115): a note, call or meeting summary logged on a contact, company or deal. Private ones show only to their author. */
export const crmEntries = sqliteTable("crm_entries", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  entityType: text("entity_type", { enum: ["contact", "company", "deal"] }).notNull(),
  entityId: text("entity_id").notNull(),
  kind: text("kind", { enum: ["note", "call", "meeting"] }).notNull().default("note"),
  body: text("body").notNull().default(""),
  /** Calls only: connected, no_answer, voicemail, busy, wrong_number. */
  outcome: text("outcome"),
  durationMin: integer("duration_min"),
  occurredAt: ts("occurred_at").notNull(),
  private: integer("private", { mode: "boolean" }).notNull().default(false),
  authorName: text("author_name"),
  ...suiteCols(),
}, (t) => [index("crm_entries_entity_idx").on(t.orgId, t.entityType, t.entityId, t.occurredAt)]);

/** R94 (0115): a saved filter on the contacts list. user_id null = shared with the team. */
export const crmSegments = sqliteTable("crm_segments", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id"),
  name: text("name").notNull(),
  filters: text("filters").notNull().default("{}"),
  position: real("position").notNull().default(0),
  ...suiteCols(),
}, (t) => [index("crm_segments_org_idx").on(t.orgId)]);

/** The glue: any item linked to any item (a doc to a task, a contact to a thread). */
export const entityLinks = sqliteTable("entity_links", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  fromType: text("from_type").notNull(),
  fromId: text("from_id").notNull(),
  toType: text("to_type").notNull(),
  toId: text("to_id").notNull(),
  relation: text("relation").notNull().default("related"),
  /** R38: lead (negative) or lag (positive) in days on a task "blocks" link. 0 elsewhere. */
  lagDays: integer("lag_days").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.fromType, t.fromId, t.toType, t.toId] }), index("entity_links_to_idx").on(t.orgId, t.toType, t.toId)]);

/** Who did what to which item: the timeline on tasks and contacts, and the source of webhooks. */
export const activity = sqliteTable("activity", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  actorType: text("actor_type", { enum: ["member", "agent", "system"] }).notNull(),
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  verb: text("verb").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  data: text("data").notNull().default("{}"),
  createdAt: createdAt(),
}, (t) => [index("activity_entity_idx").on(t.entityType, t.entityId, t.createdAt), index("activity_org_idx").on(t.orgId, t.createdAt)]);

/** An ordered change feed per workspace: the sync cursor for web, mobile and agents. */
export const changes = sqliteTable("changes", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  op: text("op", { enum: ["create", "update", "delete"] }).notNull(),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  /** R33 (0073): the activity fields ride the change row, so one write serves the timeline and the sync feed. Null on rows that are feed only (bulk per task rows). */
  actorType: text("actor_type", { enum: ["member", "agent", "system"] }),
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  verb: text("verb"),
  data: text("data"),
}, (t) => [index("changes_org_seq_idx").on(t.orgId, t.seq), index("changes_entity_idx").on(t.entityType, t.entityId, t.seq).where(sql`${t.verb} IS NOT NULL`)]);

/**
 * R33 (0073): the timeline as one read: old `activity` rows and change rows that carry a verb. A SQL view (see the
 * migration); every timeline reader selects from this, so rows written before and after 0073 read the same way.
 */
export const activityFeed = sqliteView("activity_feed", {
  id: text("id").notNull(),
  orgId: text("org_id").notNull(),
  actorType: text("actor_type", { enum: ["member", "agent", "system"] }).notNull(),
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  verb: text("verb").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  data: text("data").notNull(),
  createdAt: ts("created_at").notNull(),
}).existing();

/** Simple rules: when this happens, do that. No AI and no outside sends without approval. */
export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  trigger: text("trigger", { enum: ["email_received", "status_changed", "due_soon", "task_created", "assignee_changed", "due_passed", "meeting_ended", "chat_message_posted"] }).notNull(),
  /** JSON: email_received { from?, subjectContains?, mailboxId? }; status_changed { projectId?, toCategory? }; due_soon { hoursBefore } */
  conditions: text("conditions").notNull().default("{}"),
  action: text("action", { enum: ["create_task", "notify", "assign_thread", "post_to_channel", "assign_task", "set_status", "add_label", "set_priority", "create_subtask_checklist"] }).notNull(),
  /** JSON: create_task { projectId, assigneeType?, assigneeId?, priority?, dueInDays? }; notify { to: "assignee" | "creator" | userId } */
  actionConfig: text("action_config").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  runCount: integer("run_count").notNull().default(0),
  lastRunAt: ts("last_run_at"),
  lastError: text("last_error"),
  ...suiteCols(),
}, (t) => [index("automations_org_trigger_idx").on(t.orgId, t.trigger)]);

/** In-app notifications (automations, assignments, reminders). Pushed to phones when registered. */
export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  title: text("title").notNull(),
  actorName: text("actor_name"),
  readAt: ts("read_at"),
  /** R31 triage: done (out of the inbox) and snoozed until a time (back in the inbox, unread, once it passes). */
  doneAt: ts("done_at"),
  snoozedUntil: ts("snoozed_until"),
  createdAt: createdAt(),
}, (t) => [index("notifications_user_idx").on(t.userId, t.orgId, t.createdAt)]);

/** R31 catch-up: when a person last caught up on a chat channel, task or doc. Written at most once a minute per item. */
export const itemVisits = sqliteTable("item_visits", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  itemType: text("item_type", { enum: ["channel", "task", "doc"] }).notNull(),
  itemId: text("item_id").notNull(),
  lastVisitAt: ts("last_visit_at").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.itemType, t.itemId] })]);

/** Phones registered for push (Expo push tokens). Payloads carry only an event type and an id. */
export const pushDevices = sqliteTable("push_devices", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  platform: text("platform", { enum: ["ios", "android"] }).notNull(),
  createdAt: createdAt(),
  lastSeenAt: ts("last_seen_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("push_devices_org_idx").on(t.orgId), index("push_devices_user_idx").on(t.userId)]);

/** R32: browsers subscribed to web push (VAPID). The endpoint is the browser's push service address. */
export const webPushSubscriptions = sqliteTable("web_push_subscriptions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  lastOkAt: ts("last_ok_at"),
  failures: integer("failures").notNull().default(0),
}, (t) => [index("web_push_subscriptions_user_idx").on(t.userId)]);


// ---------------------------------------------------------------- suite round 7: time, forms, meetings

/** Time on tasks: a running timer (endedAt null) or a manual entry. Seconds are stored when it stops. */
export const timeEntries = sqliteTable("time_entries", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
  projectId: text("project_id"),
  /** Who the time belongs to: a member (user id) or an agent. */
  personType: text("person_type", { enum: ["member", "agent"] }).notNull().default("member"),
  personId: text("person_id").notNull(),
  startedAt: ts("started_at").notNull(),
  endedAt: ts("ended_at"),
  seconds: integer("seconds").notNull().default(0),
  note: text("note").notNull().default(""),
  billable: integer("billable", { mode: "boolean" }).notNull().default(true),
  source: text("source", { enum: ["timer", "manual"] }).notNull().default("timer"),
  /** R95 (0126): JSON string[] of short lower case tags. */
  tags: text("tags").notNull().default("[]"),
  /** TD4 (0155): the invoice (draft or issued) this time is billed on; set only by a billing run, cleared when that invoice is deleted or voided. */
  billedDocId: text("billed_doc_id"),
  billedAt: ts("billed_at"),
  ...suiteCols(),
}, (t) => [
  index("time_entries_billed_idx").on(t.orgId, t.billedDocId).where(sql`${t.billedDocId} IS NOT NULL`),
  index("time_entries_org_person_idx").on(t.orgId, t.personId, t.startedAt),
  index("time_entries_org_project_idx").on(t.orgId, t.projectId, t.startedAt),
  index("time_entries_task_idx").on(t.taskId),
]);

/** R95 (0126): My Day. A task on a person's plan for a day, with a time block (start minute of the day) or none. */
export const dayPlanItems = sqliteTable("day_plan_items", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  taskId: text("task_id").notNull(),
  /** YYYY-MM-DD on the person's own calendar. */
  day: text("day").notNull(),
  /** Minutes after midnight the block starts; null = on the day's list without a time. */
  startMin: integer("start_min"),
  minutes: integer("minutes").notNull().default(30),
  position: real("position").notNull().default(0),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
}, (t) => [uniqueIndex("day_plan_items_person_day_task").on(t.orgId, t.userId, t.day, t.taskId)]);

/** R95 (0126): a person's week of time: submitted by them, approved or returned by an admin. */
export const timesheets = sqliteTable("timesheets", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  /** The member's user id. */
  personId: text("person_id").notNull(),
  /** Monday of the week, YYYY-MM-DD in the workspace time zone. */
  weekStart: text("week_start").notNull(),
  status: text("status", { enum: ["open", "submitted", "approved", "returned"] }).notNull().default("open"),
  note: text("note").notNull().default(""),
  submittedAt: ts("submitted_at"),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("timesheets_person_week").on(t.orgId, t.personId, t.weekStart),
  index("timesheets_org_status_idx").on(t.orgId, t.status, t.weekStart),
]);

/** A public form: each submission makes a task or a contact. */
export const forms = sqliteTable("forms", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** The public address: /f/<slug>. Random, so forms can't be guessed. */
  slug: text("slug").notNull(),
  /** R93: "review" collects entries for a call for submissions (no task or contact is made). */
  target: text("target", { enum: ["task", "contact", "review"] }).notNull().default("task"),
  projectId: text("project_id"),
  assigneeType: text("assignee_type", { enum: ["member", "agent"] }),
  assigneeId: text("assignee_id"),
  /** JSON: [{ id, label, type: text|email|textarea|phone|select, required, options? }] */
  fields: text("fields").notNull().default("[]"),
  successMessage: text("success_message").notNull().default("Thanks, we got it."),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  submitCount: integer("submit_count").notNull().default(0),
  lastSubmitAt: ts("last_submit_at"),
  /** R21: submissions wait in Triage instead of becoming tasks at once. */
  triage: integer("triage", { mode: "boolean" }).notNull().default(false),
  /** R31 (0067): JSON [{ when: { field, op, value }, projectId, assigneeId }]; the first match routes the task. */
  routing: text("routing").notNull().default("[]"),
  /** R93 (0142): "classic" (all questions on one page) or "chat" (one question at a time). */
  mode: text("mode", { enum: ["classic", "chat"] }).notNull().default("classic"),
  /** R93: JSON FormPlus (hidden fields, bubble label, review setup, template); see src/shared/forms-plus.ts. */
  plus: text("plus").notNull().default("{}"),
  /** R93: the form's own signed webhook. The secret is encrypted with the app secret. */
  webhookUrl: text("webhook_url"),
  webhookSecret: text("webhook_secret"),
  webhookFailures: integer("webhook_failures").notNull().default(0),
  /** TD2 (0153): JSON { progress, oneAtATime } (src/shared/forms-td2.ts); null = defaults. */
  td2: text("td2"),
  ...suiteCols(),
}, (t) => [index("forms_org_idx").on(t.orgId), uniqueIndex("forms_slug_uq").on(t.slug)]);

export const formSubmissions = sqliteTable("form_submissions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  formId: text("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }),
  /** JSON: { fieldId: value } */
  data: text("data").notNull().default("{}"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  /** A salted hash of the sender's IP, for rate limits. Never the IP itself. */
  ipHash: text("ip_hash"),
  /** R93: JSON { hidden: { name: value } } from the form link. */
  meta: text("meta"),
  /** R93: the NPS (0 to 10) or CSAT (1 to 5) answer, for the score summary. */
  score: real("score"),
  /** R93: calls for submissions: new, shortlisted or declined. */
  reviewState: text("review_state", { enum: ["new", "shortlisted", "declined"] }).notNull().default("new"),
  createdAt: createdAt(),
}, (t) => [index("form_submissions_form_idx").on(t.formId, t.createdAt)]);

/**
 * TD2 (0153): a file or signature sent with a public form. The bytes live in the existing file storage
 * (key "fu/<org>/<id>"); submission_id stays null until the answer is sent, and unsent ones go after a day.
 */
export const formUploads = sqliteTable("form_uploads", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  formId: text("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }),
  fieldId: text("field_id").notNull(),
  submissionId: text("submission_id"),
  kind: text("kind", { enum: ["file", "signature"] }).notNull().default("file"),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  parts: integer("parts").notNull().default(1),
  ipHash: text("ip_hash"),
  createdAt: createdAt(),
}, (t) => [index("form_uploads_sender_idx").on(t.formId, t.ipHash, t.createdAt), index("form_uploads_submission_idx").on(t.submissionId), index("form_uploads_org_idx").on(t.orgId, t.createdAt)]);

/** A video meeting (LiveKit room) with a guest link, started from a thread, task or contact. */
export const meetings = sqliteTable("meetings", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /** The LiveKit room name. */
  room: text("room").notNull(),
  /** The guest link: /m/<guestToken>. */
  guestToken: text("guest_token").notNull(),
  startsAt: ts("starts_at").notNull(),
  durationMin: integer("duration_min").notNull().default(30),
  status: text("status", { enum: ["scheduled", "ended", "cancelled"] }).notNull().default("scheduled"),
  sourceType: text("source_type", { enum: ["thread", "task", "contact"] }),
  sourceId: text("source_id"),
  /** JSON string[] of guest email addresses. */
  invitees: text("invitees").notNull().default("[]"),
  /** The mailbox the invites went from. */
  mailboxId: text("mailbox_id"),
  invitesSentAt: ts("invites_sent_at"),
  endedAt: ts("ended_at"),
  /** Wave 3 review Y4 (0184): when the room first read empty after people were in it; cleared by a read that sees people. */
  emptySince: ts("empty_since"),
  /** A weekly RRULE without the "RRULE:" prefix (FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=10). Occurrences are expanded on read. */
  recurrence: text("recurrence"),
  /** The IANA zone the series keeps its wall clock time in. */
  recurrenceTz: text("recurrence_tz"),
  /** Round 23: the chat channel or DM a call was started from (its summary is posted there). */
  channelId: text("channel_id"),
  /** Round 23: the meeting's agenda and notes doc. */
  docId: text("doc_id"),
  /** Round 32: "Guests wait to be let in" (the waiting room). On by default. */
  guestLobby: integer("guest_lobby", { mode: "boolean" }).notNull().default(true),
  ...suiteCols(),
}, (t) => [index("meetings_org_idx").on(t.orgId, t.startsAt), uniqueIndex("meetings_guest_token_uq").on(t.guestToken), index("meetings_source_idx").on(t.orgId, t.sourceType, t.sourceId)]);

/** Round 32: a guest asking to join a meeting from its link, waiting for a member to admit or deny them. */
export const meetingLobby = sqliteTable("meeting_lobby", {
  id: text("id").primaryKey(),
  meetingId: text("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  guestName: text("guest_name").notNull(),
  status: text("status", { enum: ["pending", "admitted", "denied"] }).notNull().default("pending"),
  createdAt: ts("created_at").notNull(),
  /** The member (or agent) who decided, as "member:<id>" or "agent:<id>". */
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
}, (t) => [index("meeting_lobby_meeting_idx").on(t.meetingId, t.status)]);

/**
 * Custom fields per project. `options` holds the choices for single and multi select
 * fields as JSON [{ id, label, color }].
 */
export const customFields = sqliteTable("custom_fields", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type", { enum: ["text", "number", "currency", "date", "select", "multiselect", "person", "checkbox", "url", "formula", "rollup"] }).notNull(),
  options: text("options").notNull().default("[]"),
  /** R24.1: formula ({ expression }) and rollup ({ source, field, fn }) settings as JSON. */
  config: text("config"),
  position: integer("position").notNull().default(0),
  /** R84 (0104): set on a workspace field: one row per project with the same key and option ids. */
  workspaceKey: text("workspace_key"),
  ...suiteCols(),
}, (t) => [
  index("custom_fields_project_idx").on(t.projectId, t.position),
  index("custom_fields_workspace_key_idx").on(t.orgId, t.workspaceKey).where(sql`${t.workspaceKey} IS NOT NULL`),
]);

/**
 * One value per task and field. Numbers, currency (AUD) and checkboxes use `value_num`;
 * text, URLs, dates (YYYY-MM-DD), people ("member:<id>") and select option ids use
 * `value_text`; multi select keeps a JSON array of option ids in `value_text`.
 */
export const taskFieldValues = sqliteTable("task_field_values", {
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  fieldId: text("field_id").notNull().references(() => customFields.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  valueText: text("value_text"),
  valueNum: real("value_num"),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
  primaryKey({ columns: [t.taskId, t.fieldId] }),
  index("task_field_values_field_text_idx").on(t.fieldId, t.valueText),
  index("task_field_values_field_num_idx").on(t.fieldId, t.valueNum),
]);

/**
 * Guests: an outside person (a client) invited to one project by email. A guest is not a
 * workspace member and takes no paid seat. They see that project's tasks, comments and
 * docs, and can comment and upload files, nothing else. The invite link is exchanged once
 * for a guest session; only hashes of both secrets are stored.
 */
export const projectGuests = sqliteTable("project_guests", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  status: text("status", { enum: ["pending", "active", "revoked"] }).notNull().default("pending"),
  inviteHash: text("invite_hash"),
  inviteExpiresAt: ts("invite_expires_at"),
  sessionHash: text("session_hash"),
  lastSeenAt: ts("last_seen_at"),
  invitedByType: text("invited_by_type", { enum: ["member", "agent"] }).notNull().default("member"),
  invitedById: text("invited_by_id"),
  /** When an agent invited the guest: the send approval that holds the invite email. */
  approvalId: text("approval_id"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("project_guests_project_email_uq").on(t.projectId, t.email),
  index("project_guests_org_idx").on(t.orgId),
  index("project_guests_invite_idx").on(t.inviteHash),
  index("project_guests_session_idx").on(t.sessionHash),
]);

/** Files on a task, uploaded by members or guests. Small files stay in the database. */
export const taskFiles = sqliteTable("task_files", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  contentB64: text("content_b64"),
  storageKey: text("storage_key"),
  uploadedByType: text("uploaded_by_type", { enum: ["member", "agent", "guest"] }).notNull(),
  uploadedById: text("uploaded_by_id"),
  uploadedByName: text("uploaded_by_name").notNull().default(""),
  createdAt: createdAt(),
}, (t) => [index("task_files_task_idx").on(t.taskId, t.createdAt)]);

// ---------------------------------------------------------------- round 10: chat, inbox settings, templates, goals

/** A chat channel or a direct message conversation in a workspace. */
export const chatChannels = sqliteTable("chat_channels", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["channel", "dm"] }).notNull().default("channel"),
  name: text("name").notNull().default(""),
  topic: text("topic").notNull().default(""),
  /** Private channels are seen only by their members. */
  isPrivate: integer("is_private", { mode: "boolean" }).notNull().default(false),
  /** A channel can belong to a project; with guestAccess the project's guests can read and post in it. */
  projectId: text("project_id"),
  guestAccess: integer("guest_access", { mode: "boolean" }).notNull().default(false),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  /** For a DM: the sorted user ids joined by commas, so the same people always get the same DM. */
  dmKey: text("dm_key"),
  lastMessageAt: ts("last_message_at"),
  /** Round 21: the last call started here, so two people pressing Call at once join one meeting. */
  callStartedAt: ts("call_started_at"),
  ...suiteCols(),
}, (t) => [index("chat_channels_org_idx").on(t.orgId, t.kind), uniqueIndex("chat_channels_dm_uq").on(t.orgId, t.dmKey)]);

export const chatMembers = sqliteTable("chat_members", {
  channelId: text("channel_id").notNull().references(() => chatChannels.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  lastReadAt: ts("last_read_at"),
  joinedAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.channelId, t.userId] }), index("chat_members_user_idx").on(t.userId, t.orgId)]);

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull().references(() => chatChannels.id, { onDelete: "cascade" }),
  /** Set on a reply in a thread: the top level message it answers. */
  parentId: text("parent_id"),
  authorType: text("author_type", { enum: ["member", "agent", "guest", "system"] }).notNull(),
  authorId: text("author_id"),
  authorName: text("author_name").notNull().default(""),
  body: text("body").notNull().default(""),
  /** JSON [{ type, id, name }] resolved at send time. */
  mentions: text("mentions").notNull().default("[]"),
  /** Space separated "member:<id>" keys of the people mentioned (with "channel" for everyone), for unread counts. */
  mentionKeys: text("mention_keys").notNull().default(""),
  /** JSON [{ type, id, ref, title }] */
  links: text("links").notNull().default("[]"),
  replyCount: integer("reply_count").notNull().default(0),
  lastReplyAt: ts("last_reply_at"),
  editedAt: ts("edited_at"),
  /** Pinned to the top of its channel (top level messages only), and the name of who pinned it. */
  pinnedAt: ts("pinned_at"),
  pinnedBy: text("pinned_by"),
  /** R96: the topic inside the channel (null = no topic). */
  topicId: text("topic_id"),
  deletedAt: ts("deleted_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("chat_messages_channel_idx").on(t.channelId, t.parentId, t.createdAt), index("chat_messages_updated_idx").on(t.channelId, t.updatedAt), index("chat_messages_parent_idx").on(t.parentId).where(sql`${t.parentId} IS NOT NULL`), index("chat_messages_topic_idx").on(t.topicId, t.createdAt).where(sql`${t.topicId} IS NOT NULL`)]);

export const chatFiles = sqliteTable("chat_files", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull().references(() => chatChannels.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  contentB64: text("content_b64"),
  storageKey: text("storage_key"),
  createdAt: createdAt(),
}, (t) => [index("chat_files_message_idx").on(t.messageId)]);

/** Per person, per workspace: which notification categories show in the inbox and which buzz the phone. */
export const notificationPrefs = sqliteTable("notification_prefs", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  /** JSON { [category]: { inApp, push } } */
  settings: text("settings").notNull().default("{}"),
  /** R97: JSON delivery settings (time zone, quiet hours, digest, pause). See src/shared/notification-centre.ts. */
  delivery: text("delivery").notNull().default("{}"),
  /** R97: when this person's next digest mail is due (null when digests are off). */
  digestDueAt: ts("digest_due_at"),
  /** R97: when the last digest went out; the next lists items newer than this. */
  digestLastAt: ts("digest_last_at"),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.userId, t.orgId] }), index("notification_prefs_digest_idx").on(t.digestDueAt)]);

/** A saved project, task or doc template. The starter gallery lives in code and is not stored. */
export const templates = sqliteTable("templates", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["project", "task", "doc"] }).notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default("Custom"),
  /** JSON template body (see services/suite/templates.ts). */
  data: text("data").notNull(),
  ...suiteCols(),
}, (t) => [index("templates_org_idx").on(t.orgId, t.kind)]);

/** Goals (objectives) with key results; progress is worked out when read. */
export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  ownerId: text("owner_id"),
  /** A goal can sit under a bigger goal; progress rolls up. */
  parentId: text("parent_id"),
  startAt: ts("start_at"),
  dueAt: ts("due_at"),
  health: text("health", { enum: ["on_track", "at_risk", "off_track"] }),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  ...suiteCols(),
}, (t) => [index("goals_org_idx").on(t.orgId, t.parentId)]);

export const keyResults = sqliteTable("key_results", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  goalId: text("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** number, currency (AUD), percent, or tasks (progress from linked tasks or a whole project). */
  kind: text("kind", { enum: ["number", "currency", "percent", "tasks"] }).notNull().default("number"),
  startValue: real("start_value").notNull().default(0),
  targetValue: real("target_value").notNull().default(100),
  currentValue: real("current_value").notNull().default(0),
  unit: text("unit").notNull().default(""),
  projectId: text("project_id"),
  position: real("position").notNull().default(0),
  ...suiteCols(),
}, (t) => [index("key_results_goal_idx").on(t.goalId)]);

/**
 * Incoming webhooks (round 11): a secret URL /api/hooks/in/<token> that turns a JSON or form
 * post into a task, a chat message or a contact. Only the token's SHA-256 is stored. The last
 * calls live in `recent` (JSON, newest first, at most 20), so a call costs one bookkeeping write.
 */
export const incomingHooks = sqliteTable("incoming_hooks", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  action: text("action", { enum: ["task", "chat", "contact"] }).notNull(),
  /** JSON: { projectId?, channelId?, mapping?: Record<target, sourceField> }. */
  config: text("config").notNull().default("{}"),
  tokenHash: text("token_hash").notNull(),
  /** The first characters of the token, so people can tell hooks apart. */
  tokenHint: text("token_hint").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  callCount: integer("call_count").notNull().default(0),
  lastCalledAt: ts("last_called_at"),
  /** JSON [{ at, status, ok, result?, error? }], newest first, at most 20. */
  recent: text("recent").notNull().default("[]"),
  createdById: text("created_by_id"),
  createdAt: createdAt(),
}, (t) => [index("incoming_hooks_org_idx").on(t.orgId), uniqueIndex("incoming_hooks_token_uq").on(t.tokenHash)]);

/** A member's public booking page (round 11, SCHEDULING_ENABLED): weekly hours and slot rules. */
export const schedulingPages = sqliteTable("scheduling_pages", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  timezone: text("timezone").notNull(),
  /** JSON { mon: [["09:00","17:00"]], tue: [...], ... }; a missing or empty day is closed. */
  hours: text("hours").notNull(),
  slotMin: integer("slot_min").notNull().default(30),
  bufferMin: integer("buffer_min").notNull().default(0),
  maxDaysAhead: integer("max_days_ahead").notNull().default(30),
  minNoticeMin: integer("min_notice_min").notNull().default(120),
  video: integer("video", { mode: "boolean" }).notNull().default(true),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("scheduling_pages_slug_uq").on(t.slug), uniqueIndex("scheduling_pages_user_uq").on(t.orgId, t.userId)]);

/** A guest's booking on a scheduling page. `slotKey` is set while confirmed, so a slot books once. */
export const bookings = sqliteTable("bookings", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull().references(() => schedulingPages.id, { onDelete: "cascade" }),
  meetingId: text("meeting_id"),
  startsAt: ts("starts_at").notNull(),
  durationMin: integer("duration_min").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  note: text("note").notNull().default(""),
  status: text("status", { enum: ["confirmed", "cancelled"] }).notNull().default("confirmed"),
  slotKey: integer("slot_key"),
  cancelTokenHash: text("cancel_token_hash").notNull(),
  cancelledBy: text("cancelled_by"),
  cancelledAt: ts("cancelled_at"),
  createdAt: createdAt(),
}, (t) => [index("bookings_page_idx").on(t.pageId, t.startsAt), index("bookings_org_idx").on(t.orgId, t.startsAt), uniqueIndex("bookings_slot_uq").on(t.pageId, t.slotKey)]);

/**
 * OAuth clients for the MCP endpoint (round 20): AI apps such as Claude, ChatGPT and Cursor register
 * themselves (dynamic client registration) and people sign them in to one workspace.
 */
export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** JSON array of the redirect URIs the client registered. */
  redirectUris: text("redirect_uris").notNull(),
  clientUri: text("client_uri"),
  createdAt: createdAt(),
});

/**
 * One person's sign in of an OAuth client to one workspace. The authorisation code and the refresh
 * token are kept only as hashes; access tokens are signed and never stored. The row id rides inside
 * the code and the refresh token, so lookups use the primary key and the table needs one index.
 */
export const oauthGrants = sqliteTable("oauth_grants", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** `read` or `full`. */
  scope: text("scope", { enum: ["full", "read"] }).notNull().default("read"),
  redirectUri: text("redirect_uri").notNull(),
  codeHash: text("code_hash"),
  codeChallenge: text("code_challenge"),
  codeExpiresAt: ts("code_expires_at"),
  codeUsedAt: ts("code_used_at"),
  refreshHash: text("refresh_hash"),
  refreshExpiresAt: ts("refresh_expires_at"),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
}, (t) => [index("oauth_grants_org_idx").on(t.orgId, t.userId)]);

// ---------------------------------------------------------------- round 20: chat reactions

/**
 * One emoji reaction by one person, agent or guest on a chat message or thread reply. Counts are
 * worked out on read: there is no counter on chat_messages. The primary key leads with
 * message_id, so it is also the lookup index (2 row writes per add or remove).
 */
export const chatReactions = sqliteTable("chat_reactions", {
  messageId: text("message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
  /** "member:<userId>", "agent:<agentId>" or "guest:<guestId>". */
  reactor: text("reactor").notNull(),
  emoji: text("emoji").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  /** The reactor's name when they reacted, for "who reacted" without a join. */
  name: text("name").notNull().default(""),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.messageId, t.reactor, t.emoji] })]);

/**
 * Round 20: snoozed threads, scheduled sends and "remind me if no reply" (services/mail/schedules.ts).
 * Live items only: a send is deleted as it is claimed, a returned snooze or reminder is deleted when
 * the person opens it. One index (status, due_at) serves the cron pass, and the table is WITHOUT ROWID
 * (drizzle/0032), so the text primary key needs no second index: a row costs 2 writes.
 */
export const mailSchedules = sqliteTable("mail_schedules", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  /** Who asked (a person, or the agent member behind a key). */
  userId: text("user_id"),
  kind: text("kind", { enum: ["snooze", "send", "remind"] }).notNull(),
  /** pending: waiting for due_at. returned: a snooze or reminder that came back (top of Inbox). failed: a scheduled send that could not go. */
  status: text("status", { enum: ["pending", "returned", "failed"] }).notNull().default("pending"),
  threadId: text("thread_id"),
  messageId: text("message_id"),
  dueAt: ts("due_at").notNull(),
  /** JSON: what a scheduled send sends, and as whom. */
  payload: text("payload"),
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [index("mail_schedules_due_idx").on(t.status, t.dueAt), index("mail_schedules_thread_idx").on(t.mailboxId, t.threadId)]);

/**
 * Round 21: sprints (cycles) per project. One active sprint per project at a time. The burndown is
 * worked out on read from tasks and the activity rows task writes already make; the snapshot holds
 * the scope at start ({ start: { taskId: points } }) and the frozen chart at complete, so a task
 * change costs no extra write here. WITHOUT ROWID (drizzle/0034): a row costs 2 writes.
 */
export const sprints = sqliteTable("sprints", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  goal: text("goal").notNull().default(""),
  startAt: ts("start_at").notNull(),
  endAt: ts("end_at").notNull(),
  status: text("status", { enum: ["planned", "active", "completed"] }).notNull().default("planned"),
  startedAt: ts("started_at"),
  completedAt: ts("completed_at"),
  /** How many unfinished tasks moved on when the sprint was completed. */
  carriedOver: integer("carried_over").notNull().default(0),
  /** JSON, see above. */
  snapshot: text("snapshot").notNull().default("{}"),
  ...suiteCols(),
}, (t) => [index("sprints_org_project_idx").on(t.orgId, t.projectId)]);

/** Round 22 (R22.2): internal notes on a mail thread. Team only: never part of any outgoing mail. */
export const threadComments = sqliteTable("thread_comments", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull(),
  /** The mailbox the thread lives in, for scoping. */
  mailboxId: text("mailbox_id").notNull(),
  authorType: text("author_type", { enum: ["member", "agent"] }).notNull().default("member"),
  authorId: text("author_id").notNull(),
  body: text("body").notNull(),
  /** JSON array of mentioned user ids. */
  mentions: text("mentions").notNull().default("[]"),
  editedAt: ts("edited_at"),
  createdAt: createdAt(),
}, (t) => [index("thread_comments_thread_idx").on(t.orgId, t.threadId, t.createdAt)]);
/**
 * Round 22 (R22.1): who owns a shared inbox thread and whether it is done (services/mail/thread-state.ts).
 * Only threads someone has touched get a row, keyed by (org_id, thread_id). WITHOUT ROWID (drizzle/0039),
 * so the composite primary key needs no second index; the one partial index serves "assigned to X" and
 * holds only assigned rows. Assign: 1 row + 1 index entry. Status change: 1 row.
 */
export const mailThreadState = sqliteTable("mail_thread_state", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull(),
  /** The thread's mailbox when the row was written (the newest message's). */
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
  /** users.id of who assigned, or "agent:<agentId>" for an agent key. */
  assignedBy: text("assigned_by"),
  assignedAt: ts("assigned_at"),
  status: text("status", { enum: ["open", "waiting", "done"] }).notNull().default("open"),
  doneAt: ts("done_at"),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.threadId] }),
  index("mail_thread_state_assignee_idx").on(t.orgId, t.assigneeUserId).where(sql`${t.assigneeUserId} IS NOT NULL`),
]);

/** Round 22 (R22.4b): saved replies (snippets) with {{variables}}, shared per workspace or kept private by the author. */
export const mailSnippets = sqliteTable("mail_snippets", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Optional "/shortcut" word, unique in the workspace when set (checked by the service, no extra index). */
  shortcut: text("shortcut"),
  subject: text("subject"),
  body: text("body").notNull(),
  /** False: only the author sees it. */
  shared: integer("shared", { mode: "boolean" }).notNull().default(true),
  /** A user id, or an agent id when an agent key made it. */
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("mail_snippets_org_name_idx").on(t.orgId, t.name)]);

/**
 * Round 23 (R23.1): which action items of a meeting's notes doc already became tasks, so "Create tasks"
 * never makes the same one twice. item_key is a hash of the item's normalised text. One row per item and
 * no secondary index (the primary key serves every lookup): 1 write per converted item.
 */
export const meetingActionItems = sqliteTable("meeting_action_items", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  meetingId: text("meeting_id").notNull(),
  itemKey: text("item_key").notNull(),
  taskId: text("task_id").notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.meetingId, t.itemKey] })]);

/**
 * TD3: suggested action items from a meeting's transcript, notes or pasted text. Each one is accepted (one real
 * task, task_id set by a conditional update so a double click makes one task) or discarded by a person; nothing
 * is created without a click. Keyed by (org_id, meeting_id, id) WITHOUT ROWID: a meeting's list reads the key prefix.
 */
export const meetingSuggestions = sqliteTable("meeting_suggestions", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  meetingId: text("meeting_id").notNull(),
  id: text("id").notNull(),
  source: text("source", { enum: ["recording", "notes", "pasted", "manual"] }).notNull(),
  sourceId: text("source_id"),
  title: text("title").notNull(),
  quote: text("quote"),
  assigneeType: text("assignee_type", { enum: ["member", "agent"] }),
  assigneeId: text("assignee_id"),
  due: text("due"),
  status: text("status", { enum: ["open", "accepted", "discarded"] }).notNull().default("open"),
  taskId: text("task_id"),
  createdBy: text("created_by").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.orgId, t.meetingId, t.id] })]);

/**
 * Round 23 (R23.2): a call recorded in the browser and transcribed with the workspace's own AI key.
 * Only the text is kept (no audio). Keyed by (org_id, meeting_id, id) WITHOUT ROWID, so the meeting's
 * list reads the primary key and there is no secondary index: a chunk's text appended is 1 row write.
 */
export const meetingRecordings = sqliteTable("meeting_recordings", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  meetingId: text("meeting_id").notNull(),
  id: text("id").notNull(),
  /** users.id of the member who pressed Record. */
  startedBy: text("started_by").notNull(),
  status: text("status", { enum: ["recording", "processing", "done", "failed"] }).notNull().default("recording"),
  startedAt: ts("started_at").notNull(),
  endedAt: ts("ended_at"),
  durationSec: integer("duration_sec").notNull().default(0),
  /** How many audio chunks were transcribed; the next chunk's sequence number. */
  chunkCount: integer("chunk_count").notNull().default(0),
  /** Plain text, capped at 200 KB (a note at the end says when it was cut). */
  transcript: text("transcript").notNull().default(""),
  summary: text("summary"),
  /** JSON [{ text, assignee, due }]. */
  actionItems: text("action_items").notNull().default("[]"),
  /** The AI provider that transcribed it (openai or groq). */
  provider: text("provider"),
  error: text("error"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.orgId, t.meetingId, t.id] })]);

/**
 * Round 23 (R23.4): a person's calendar feed (/cal/<token>.ics). Only a SHA-256 hash of the token is
 * kept, with a short hint; resetting replaces the hash so the old address stops at once.
 */
export const calendarFeeds = sqliteTable("calendar_feeds", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  /** The token's last four characters, to tell two addresses apart. */
  hint: text("hint").notNull(),
  includeTasks: integer("include_tasks", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  resetAt: ts("reset_at"),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] }), uniqueIndex("calendar_feeds_token_uq").on(t.tokenHash)]);

/**
 * Round 23 (R23.4): other calendars a person reads in Multies (read only, never stored): a connected
 * mailbox's CalDAV account, or a secret ICS link (encrypted with APP_SECRET, like mail passwords).
 * Seen only by the person who added it.
 */
export const calendarSources = sqliteTable("calendar_sources", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  kind: text("kind", { enum: ["caldav", "ics"] }).notNull(),
  connectionId: text("connection_id").references(() => mailConnections.id, { onDelete: "cascade" }),
  urlEnc: text("url_enc"),
  /** CalDAV: JSON [{ url, name, color }] found at discovery, so a view needs no discovery requests. */
  calendars: text("calendars").notNull().default("[]"),
  name: text("name").notNull(),
  color: text("color").notNull().default("#8E8E93"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId, t.id] })]);

/**
 * Round 24: a stored weekly capacity per person for the workload view. `person` is the assignee
 * key ("member:<userId>" or "agent:<id>"). Keyed (org_id, person) WITHOUT ROWID with no secondary
 * index: setting a capacity is 1 row write, and the workload read takes the whole org in one
 * primary key range read.
 */
export const workloadCapacity = sqliteTable("workload_capacity", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  person: text("person").notNull(),
  points: real("points"),
  hours: real("hours"),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.orgId, t.person] })]);

/**
 * R24: links found inside a doc's body (links to /app/docs/<id> or a task, and page links), one row per
 * distinct target, rewritten only when the set changes. Backlinks read doc_links_target_idx. WITHOUT ROWID.
 */
export const docLinks = sqliteTable("doc_links", {
  orgId: text("org_id").notNull(),
  sourceDocId: text("source_doc_id").notNull(),
  targetType: text("target_type", { enum: ["doc", "task", "project"] }).notNull(),
  targetId: text("target_id").notNull(),
}, (t) => [primaryKey({ columns: [t.sourceDocId, t.targetType, t.targetId] }), index("doc_links_target_idx").on(t.targetType, t.targetId)]);

/**
 * Round 24 (R24.3): dashboards. The widgets live in `layout` (JSON), so saving a dashboard is one row
 * write; widget data is computed on read and never stored. Private to the owner unless shared.
 */
export const dashboards = sqliteTable("dashboards", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id"),
  shared: integer("shared", { mode: "boolean" }).notNull().default(false),
  /** JSON: { widgets: DashboardWidget[] } (see services/suite/dashboards.ts). */
  layout: text("layout").notNull().default('{"widgets":[]}'),
  createdByType: text("created_by_type", { enum: ["member", "agent", "system"] }).notNull().default("member"),
  createdById: text("created_by_id"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
  version: integer("version").notNull().default(1),
}, (t) => [index("dashboards_org_idx").on(t.orgId)]);

/**
 * R26 (MB-87): read only share links for a doc or a project board. Only the SHA-256 of the token is stored;
 * the public page /s/<token> looks it up by share_links_token_uq, the one index. Views are not counted, so
 * opening a link writes nothing. WITHOUT ROWID.
 */
export const shareLinks = sqliteTable("share_links", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["doc", "project_board"] }).notNull(),
  targetId: text("target_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  /** Show the workspace name on the public page (on by default). */
  showWorkspace: integer("show_workspace", { mode: "boolean" }).notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  expiresAt: ts("expires_at"),
  revokedAt: ts("revoked_at"),
  /** R103: "on" lets people with the link read approved comments and post comments that wait for review. */
  comments: text("comments", { enum: ["off", "on"] }).notNull().default("off"),
}, (t) => [uniqueIndex("share_links_token_uq").on(t.tokenHash)]);

/**
 * R26 (MB-85): checklist items inside a task. Permissions follow the task. One index (task_id): a tick, a
 * rename or a move writes one row plus that index. `assignee` is "member:<id>" or "agent:<id>".
 */
export const taskChecklistItems = sqliteTable("task_checklist_items", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  position: real("position").notNull().default(0),
  assignee: text("assignee"),
  due: ts("due"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("task_checklist_items_task_idx").on(t.taskId)]);

/**
 * R27 (DF-3 slice 2): an AI agent member's run on a task. `steps` is a JSON array of { at, kind, text }, appended in
 * place (one row write per step, no index touched). One run that is queued or running per agent and task, held by a
 * partial unique index. ADR 0008, "Slice 2: agent runs".
 */
export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  agentUserId: text("agent_user_id").notNull(),
  status: text("status", { enum: ["queued", "running", "succeeded", "failed", "cancelled"] }).notNull(),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  result: text("result"),
  steps: text("steps").notNull().default("[]"),
  stepCount: integer("step_count").notNull().default(0),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
  /** R28 (DF-3 slice 3): the trigger that queued this run, and its input (instructions plus a webhook's body). */
  triggerId: text("trigger_id"),
  input: text("input"),
}, (t) => [
  index("agent_runs_task_idx").on(t.taskId),
  uniqueIndex("agent_runs_active_uq").on(t.taskId, t.agentUserId).where(sql`${t.status} IN ('queued', 'running')`),
  index("agent_runs_queued_idx").on(t.agentUserId).where(sql`${t.status} = 'queued'`),
  index("agent_runs_creator_td6_idx").on(t.orgId, t.createdByUserId, t.finishedAt), // TD6 assistant replies
]);

/**
 * R28 (DF-3 slice 3): a trigger queues a run for an AI agent member on a schedule (every N hours, or daily at HH:MM
 * in the trigger's zone, optionally on some weekdays) or when a signed webhook arrives. It names an existing task, or
 * a project and a title template for a new task each time. The webhook secret is stored encrypted and shown once.
 */
export const agentTriggers = sqliteTable("agent_triggers", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  agentUserId: text("agent_user_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["schedule", "webhook"] }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  taskId: text("task_id"),
  projectId: text("project_id"),
  titleTemplate: text("title_template"),
  instructions: text("instructions"),
  everyHours: integer("every_hours"),
  dailyAt: text("daily_at"),
  days: text("days"),
  timezone: text("timezone").notNull(),
  nextRunAt: ts("next_run_at"),
  secretEnc: text("secret_enc"),
  secretHint: text("secret_hint"),
  lastHookTs: integer("last_hook_ts"),
  lastFiredAt: ts("last_fired_at"),
  fireCount: integer("fire_count").notNull().default(0),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("agent_triggers_org_idx").on(t.orgId),
  index("agent_triggers_due_idx").on(t.nextRunAt).where(sql`${t.enabled} = 1 AND ${t.kind} = 'schedule'`),
]);

/**
 * R27: people watching a task (Jira watchers, Asana followers, ClickUp watchers). A watcher hears about new
 * comments and status changes on the task. The creator, the assignee and anyone who comments start watching on
 * their own (source "auto"); anyone can watch or stop watching by hand. WITHOUT ROWID, keyed (task_id, user_id).
 */
export const taskWatchers = sqliteTable("task_watchers", {
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  source: text("source", { enum: ["manual", "auto"] }).notNull().default("manual"),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.taskId, t.userId] })]);

/** R31 (0066): a person's own inbox splits, in order. rules: [{ field, value }] (services/mail/splits.ts). */
export const mailSplits = sqliteTable("mail_splits", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  rules: text("rules_json").notNull().default("[]"),
  match: text("match", { enum: ["all", "any"] }).notNull().default("all"),
  position: integer("position").notNull().default(0),
  leavesImportant: integer("leaves_important", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("mail_splits_user_idx").on(t.orgId, t.userId, t.position)]);

/** R31 (0066): read status. One row per sent message that carried the open image; the token is random. */
export const mailOpens = sqliteTable("mail_opens", {
  token: text("token").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  userId: text("user_id"),
  opens: integer("opens").notNull().default(0),
  firstOpenAt: ts("first_open_at"),
  lastOpenAt: ts("last_open_at"),
  createdAt: createdAt(),
}, (t) => [index("mail_opens_message_idx").on(t.messageId)]);

/** R31 (0066): per person mail preferences. readStatus: "Show when people open my mail", off by default. */
export const mailPrefs = sqliteTable("mail_prefs", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  readStatus: integer("read_status", { mode: "boolean" }).notNull().default(false),
  /** R85 (0103): the person's Inbox tabs: "classic" (Important, Other), "categories" (Primary, Updates, Promotions) or "off". Null: the default for their account. */
  inboxTabs: text("inbox_tabs", { enum: ["classic", "categories", "off"] }),
  /** R85 (0103): JSON { s: { sender: tab }, t: { threadId: tab } }: senders and threads the person moved to a tab. */
  tabPins: text("tab_pins"),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] })]);

/** R85 (0103): a person's mail rules: conditions on new mail and several actions run in order. */
export const mailRules = sqliteTable("mail_rules", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  match: text("match", { enum: ["all", "any"] }).notNull().default("all"),
  /** JSON MailRuleCondition[] (shared/mail-rules-r85.ts). */
  conditions: text("conditions").notNull().default("[]"),
  /** JSON MailRuleAction[], run in order. */
  actions: text("actions").notNull().default("[]"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  position: integer("position").notNull().default(0),
  runCount: integer("run_count").notNull().default(0),
  lastRunAt: ts("last_run_at"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("mail_rules_mailbox_idx").on(t.mailboxId, t.enabled), index("mail_rules_user_idx").on(t.orgId, t.userId, t.position)]);

/** R85 (0103): what each mail rule did, newest first (kept 30 days). */
export const mailRuleRuns = sqliteTable("mail_rule_runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull().references(() => mailRules.id, { onDelete: "cascade" }),
  messageId: text("message_id"),
  fromAddress: text("from_address"),
  subject: text("subject"),
  status: text("status", { enum: ["ok", "partial", "failed", "skipped"] }).notNull(),
  /** JSON { action, ok, detail }[] */
  steps: text("steps").notNull().default("[]"),
  createdAt: createdAt(),
}, (t) => [index("mail_rule_runs_rule_idx").on(t.ruleId, t.createdAt)]);

/** R85 (0103): labels on mail threads, shared by everyone who can open the thread. WITHOUT ROWID (see the migration). */
export const mailThreadLabels = sqliteTable("mail_thread_labels", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull(),
  label: text("label").notNull(),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.threadId, t.label] }), index("mail_thread_labels_label_idx").on(t.orgId, t.label)]);

/** R33 (0074): "select all" in mail as one server job (services/mail/bulk-job-r33.ts). */
export const mailBulkJobs = sqliteTable("mail_bulk_jobs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id"),
  /** The client's own id for the job: a repeated request with it continues the same job. */
  clientJobId: text("client_job_id").notNull(),
  action: text("action").notNull(),
  /** JSON: the scope (mailboxId, folder, remote, q, split), exclude ids and action options. */
  params: text("params").notNull(),
  /** Mail that arrived after this moment (created_at) is left alone. */
  maxReceivedAt: ts("max_received_at").notNull(),
  /** running, done, reverting, reverted, failed */
  status: text("status").notNull().default("running"),
  total: integer("total").notNull().default(0),
  done: integer("done").notNull().default(0),
  /** Keyset position "<date ms>.<id>" of the last message the job reached. */
  cursor: text("cursor"),
  /** JSON BulkCall-like list [{ action, ids }]: what puts back exactly what the job changed. */
  undoPlan: text("undo_plan").notNull().default("[]"),
  undoDone: integer("undo_done").notNull().default(0),
  error: text("error"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("mail_bulk_jobs_client_idx").on(t.orgId, t.clientJobId)]);

/** R34 (0075, MB-186): board swimlanes and WIP limits per project (services/suite/board-settings.ts). WITHOUT ROWID. */
export const boardSettings = sqliteTable("board_settings", {
  projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  swimlanes: text("swimlanes", { enum: ["none", "assignee", "epic", "priority", "project"] }).notNull().default("none"),
  /** JSON: { [columnId]: { max?: number, min?: number } }. */
  limits: text("limits").notNull().default("{}"),
  /** R38: JSON { workingDaysOnly?, daysOff?: number[], strict? } for dependency dates on the timeline. */
  schedule: text("schedule").notNull().default("{}"),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull(),
});

// ---------------------------------------------------------------- R35: reports and blocks (Apple 1.2, user generated content)

/** A report of a chat message or a person. The message text and author are copied at report time. Essential write. */
export const contentReports = sqliteTable("content_reports", {
  id: text("id").primaryKey(),
  reporterUserId: text("reporter_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id"),
  targetType: text("target_type", { enum: ["message", "user"] }).notNull(),
  messageId: text("message_id"),
  targetUserId: text("target_user_id"),
  context: text("context", { enum: ["chat", "meeting", "dm"] }),
  reason: text("reason", { enum: ["spam", "harassment", "hate", "sexual", "violence", "self_harm", "other"] }).notNull(),
  note: text("note"),
  snapshotText: text("snapshot_text"),
  snapshotAuthorId: text("snapshot_author_id"),
  status: text("status", { enum: ["open", "resolved", "dismissed"] }).notNull().default("open"),
  action: text("action", { enum: ["none", "message_removed", "user_suspended", "warned"] }).notNull().default("none"),
  resolutionNote: text("resolution_note"),
  resolvedBy: text("resolved_by"),
  resolvedAt: ts("resolved_at"),
  createdAt: createdAt(),
}, (t) => [index("content_reports_status_idx").on(t.status, t.createdAt), index("content_reports_reporter_idx").on(t.reporterUserId, t.createdAt)]);

/** A blocks B: B's chat messages are left out of everything A reads, and B cannot DM A. Across all shared workspaces. */
export const userBlocks = sqliteTable("user_blocks", {
  blockerUserId: text("blocker_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  blockedUserId: text("blocked_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.blockerUserId, t.blockedUserId] }), index("user_blocks_blocked_idx").on(t.blockedUserId)]);

/**
 * R38 move your data: one row per import or export run. `created` is JSON listing what an import made
 * ({ tasks: [ids], statuses: [ids], projectCreated, meetings: [ids], contacts: [ids], docs: [ids] }) so Undo
 * removes exactly that. An export keeps a hash of its download token and when the link stops working.
 * Writes: one insert per run, one update per chunk (essential: the person started it).
 */
export const dataMoves = sqliteTable("data_moves", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["import", "export"] }).notNull(),
  source: text("source").notNull(),
  fileName: text("file_name"),
  status: text("status", { enum: ["running", "stopped", "done", "undone", "failed", "ready", "expired"] }).notNull().default("running"),
  projectId: text("project_id"),
  total: integer("total").notNull().default(0),
  done: integer("done").notNull().default(0),
  created: text("created").notNull().default("{}"),
  counts: text("counts").notNull().default("{}"),
  tokenHash: text("token_hash"),
  expiresAt: ts("expires_at"),
  error: text("error"),
  createdByUserId: text("created_by_user_id"),
  createdByEmail: text("created_by_email"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull(),
  finishedAt: ts("finished_at"),
  undoneAt: ts("undone_at"),
  /** R41: when the last step of an import ran (page or scheduled pass); finds runs left behind. */
  lastStepAt: ts("last_step_at"),
  /** R41: when the one "finished" or "paused" email for this run was sent (never twice). */
  notifiedAt: ts("notified_at"),
  /** R43: the kept upload (Workers KV key, or key prefix for a mail archive's parts) the scheduled pass finishes the run from; null when nothing is kept. */
  fileKey: text("file_key"),
  /** R43: how many parts are kept (1 for a one-file import). */
  fileParts: integer("file_parts"),
  /** R43: what the pass needs besides the file (mail: mailbox, folder and the first message index of each part), JSON. */
  fileMeta: text("file_meta"),
  /** R43: the kept file is deleted by this time at the latest (7 days after it was kept). */
  fileExpiresAt: ts("file_expires_at"),
}, (t) => [index("data_moves_org_idx").on(t.orgId, t.createdAt), index("data_moves_status_step_idx").on(t.status, t.lastStepAt)]);


/**
 * C1 (0089): a WhatsApp number, Facebook Page or Instagram account connected to a workspace (services/channels).
 * The access token is encrypted at rest (lib/crypto encryptSecret, AES-GCM from APP_SECRET) and never leaves
 * the server. A disconnect keeps the row and its conversations (history stays); the token is wiped.
 * The webhook finds the channel by (provider, external_id): the phone number id, page id or Instagram id.
 */
export const msgChannels = sqliteTable("msg_channels", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["whatsapp", "messenger", "instagram", "mock"] }).notNull(),
  /** WhatsApp phone_number_id, Page id or Instagram account id. */
  externalId: text("external_id").notNull(),
  /** WhatsApp Business Account id (WABA) or the Page an Instagram account belongs to. */
  externalAccountId: text("external_account_id"),
  name: text("name").notNull(),
  /** Display phone number or handle. */
  handle: text("handle"),
  tokenEnc: text("token_enc"),
  status: text("status", { enum: ["active", "disconnected", "error"] }).notNull().default("active"),
  lastError: text("last_error"),
  connectedBy: text("connected_by"),
  connectedAt: ts("connected_at").notNull(),
  disconnectedAt: ts("disconnected_at"),
  createdAt: createdAt(),
}, (t) => [
  index("msg_channels_org_idx").on(t.orgId),
  index("msg_channels_external_idx").on(t.provider, t.externalId),
]);

/**
 * C1 (0089): one customer on one channel: the chat equivalent of a mail thread, listed in the shared inbox beside
 * mail. Assignment, status and labels live on the row (no separate state table, so an inbound message touches one
 * conversation row). last_inbound_at drives Meta's 24 hour reply window.
 */
export const msgConversations = sqliteTable("msg_conversations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull().references(() => msgChannels.id, { onDelete: "cascade" }),
  /** WhatsApp wa_id (the customer's number) or the page scoped id. */
  contactExternalId: text("contact_external_id").notNull(),
  contactName: text("contact_name").notNull().default(""),
  snippet: text("snippet").notNull().default(""),
  lastMessageAt: ts("last_message_at").notNull(),
  lastInboundAt: ts("last_inbound_at"),
  unreadCount: integer("unread_count").notNull().default(0),
  status: text("status", { enum: ["open", "waiting", "done"] }).notNull().default("open"),
  assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
  /** JSON string[] */
  labels: text("labels").notNull().default("[]"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("msg_conversations_contact_uq").on(t.channelId, t.contactExternalId),
  index("msg_conversations_org_last_idx").on(t.orgId, t.lastMessageAt),
]);

/**
 * C1 (0089): one chat message in or out. (channel_id, external_id) is unique, so Meta's retried webhook deliveries
 * (it resends for up to 7 days) insert nothing the second time. A message carries at most one file; small files
 * stay on the row (base64, like mail attachments), larger ones go to the body store when one is configured.
 */
export const msgMessages = sqliteTable("msg_messages", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull(),
  conversationId: text("conversation_id").notNull().references(() => msgConversations.id, { onDelete: "cascade" }),
  direction: text("direction", { enum: ["in", "out"] }).notNull(),
  /** Meta's message id (wamid or mid); null on an outbound message until Meta accepts it. */
  externalId: text("external_id"),
  kind: text("kind").notNull().default("text"),
  text: text("text").notNull().default(""),
  /** "draft": an agent's reply waiting for a person to approve it (the workspace has agent auto send off). */
  delivery: text("delivery", { enum: ["draft", "pending", "sent", "delivered", "read", "failed", "received"] }).notNull(),
  error: text("error"),
  mediaName: text("media_name"),
  mediaType: text("media_type"),
  mediaSize: integer("media_size"),
  mediaB64: text("media_b64"),
  mediaKey: text("media_key"),
  templateName: text("template_name"),
  /** A draft's send payload (JSON: template language and values) until it is approved; cleared then. */
  draftPayload: text("draft_payload"),
  sentByUserId: text("sent_by_user_id"),
  /** The agent inbox an MCP key replied as, when that is how the reply was written. */
  sentByAgentId: text("sent_by_agent_id"),
  date: ts("date").notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("msg_messages_conv_idx").on(t.conversationId, t.date),
  uniqueIndex("msg_messages_external_uq").on(t.channelId, t.externalId),
]);


// Tools P2 (H5, migration 0097): secure share links and e-sign. The files live in KV (deps.toolFiles) with their
// own expiry; these rows are the ledger of live bytes, the links with their download log and the signing record.
export const toolFiles = sqliteTable("tool_files", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  kind: text("kind").notNull(),
  bytes: integer("bytes").notNull(),
  expiresAt: integer("expires_at").notNull(),
  deletedAt: integer("deleted_at"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("tool_files_org_live_idx").on(t.orgId, t.expiresAt), index("tool_files_expiry_idx").on(t.expiresAt)]);

export const toolShares = sqliteTable("tool_shares", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  createdBy: text("created_by").notNull(),
  tokenHash: text("token_hash").notNull(),
  fileId: text("file_id").notNull(),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  bytes: integer("bytes").notNull(),
  source: text("source").notNull(),
  passwordHash: text("password_hash"),
  maxDownloads: integer("max_downloads"),
  downloads: integer("downloads").notNull().default(0),
  wrongTries: integer("wrong_tries").notNull().default(0),
  lockedUntil: integer("locked_until"),
  notifyFirst: integer("notify_first").notNull().default(0),
  notifiedAt: integer("notified_at"),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
  createdAt: integer("created_at").notNull(),
  views: integer("views").notNull().default(0), // R88: page opens
  reports: integer("reports").notNull().default(0), // R88: reports from the public page
}, (t) => [uniqueIndex("tool_shares_token_idx").on(t.tokenHash), index("tool_shares_org_idx").on(t.orgId, t.createdAt)]);

export const toolShareDownloads = sqliteTable("tool_share_downloads", {
  id: text("id").primaryKey(),
  shareId: text("share_id").notNull(),
  orgId: text("org_id").notNull(),
  at: integer("at").notNull(),
  country: text("country"),
  agent: text("agent"),
  kind: text("kind").notNull().default("download"), // R88: "download" | "view"
  region: text("region"), // R88: the edge's region guess, never the address
}, (t) => [index("tool_share_downloads_share_idx").on(t.shareId, t.at), index("tool_share_downloads_org_idx").on(t.orgId)]);

// R88 (migration 0107): secure share. File requests with their received files (KV kept files, chunked), secret links
// (ciphertext only; the key never reaches the server), the secret open log and link reports from public pages.
export const toolFileRequests = sqliteTable("tool_file_requests", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  createdBy: text("created_by").notNull(),
  tokenHash: text("token_hash").notNull(),
  title: text("title").notNull(),
  message: text("message"),
  folder: text("folder"),
  passwordHash: text("password_hash"),
  maxFileBytes: integer("max_file_bytes").notNull(),
  maxTotalBytes: integer("max_total_bytes").notNull(),
  allowed: text("allowed").notNull().default("any"),
  maxUploads: integer("max_uploads"),
  uploads: integer("uploads").notNull().default(0),
  bytesReceived: integer("bytes_received").notNull().default(0),
  keepDays: integer("keep_days").notNull().default(30),
  showBrand: integer("show_brand").notNull().default(1),
  notify: integer("notify").notNull().default(1),
  notifiedAt: integer("notified_at"),
  wrongTries: integer("wrong_tries").notNull().default(0),
  lockedUntil: integer("locked_until"),
  reports: integer("reports").notNull().default(0),
  lastUploadAt: integer("last_upload_at"),
  expiresAt: integer("expires_at").notNull(),
  closedAt: integer("closed_at"),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("tool_file_requests_token_idx").on(t.tokenHash), index("tool_file_requests_org_idx").on(t.orgId, t.createdAt)]);

export const toolRequestFiles = sqliteTable("tool_request_files", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  orgId: text("org_id").notNull(),
  fileId: text("file_id").notNull(),
  uploadKeyHash: text("upload_key_hash").notNull(),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  bytes: integer("bytes").notNull(),
  chunkBytes: integer("chunk_bytes").notNull(),
  chunks: integer("chunks").notNull(),
  received: text("received").notNull(),
  status: text("status").notNull().default("uploading"),
  uploaderName: text("uploader_name"),
  uploaderEmail: text("uploader_email"),
  note: text("note"),
  country: text("country"),
  expiresAt: integer("expires_at").notNull(),
  deletedAt: integer("deleted_at"),
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
}, (t) => [index("tool_request_files_request_idx").on(t.requestId, t.createdAt), index("tool_request_files_org_idx").on(t.orgId)]);

export const toolSecrets = sqliteTable("tool_secrets", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  createdBy: text("created_by").notNull(),
  tokenHash: text("token_hash").notNull(),
  kind: text("kind").notNull(),
  label: text("label"),
  ciphertext: text("ciphertext"),
  fileId: text("file_id"),
  bytes: integer("bytes").notNull(),
  passphrase: integer("passphrase").notNull().default(0),
  maxViews: integer("max_views").notNull().default(1),
  views: integer("views").notNull().default(0),
  notify: integer("notify").notNull().default(1),
  reports: integer("reports").notNull().default(0),
  expiresAt: integer("expires_at").notNull(),
  burnedAt: integer("burned_at"),
  revokedAt: integer("revoked_at"),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("tool_secrets_token_idx").on(t.tokenHash), index("tool_secrets_org_idx").on(t.orgId, t.createdAt)]);

export const toolSecretOpens = sqliteTable("tool_secret_opens", {
  id: text("id").primaryKey(),
  secretId: text("secret_id").notNull(),
  orgId: text("org_id").notNull(),
  at: integer("at").notNull(),
  country: text("country"),
  region: text("region"),
  agent: text("agent"),
}, (t) => [index("tool_secret_opens_secret_idx").on(t.secretId, t.at)]);

export const toolLinkReports = sqliteTable("tool_link_reports", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  targetId: text("target_id").notNull(),
  orgId: text("org_id").notNull(),
  reason: text("reason").notNull(),
  detail: text("detail"),
  country: text("country"),
  at: integer("at").notNull(),
}, (t) => [index("tool_link_reports_target_idx").on(t.targetId, t.at)]);

export const signRequests = sqliteTable("sign_requests", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  createdBy: text("created_by").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  title: text("title").notNull(),
  subject: text("subject"),
  message: text("message"),
  mailboxId: text("mailbox_id"),
  inReplyToId: text("in_reply_to_id"),
  orderMode: text("order_mode").notNull().default("any"),
  fields: text("fields"),
  pages: text("pages"),
  sourceFileId: text("source_file_id").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  finalFileId: text("final_file_id"),
  finalSha256: text("final_sha256"),
  engineJob: text("engine_job"),
  engineKind: text("engine_kind"),
  remindDays: integer("remind_days").notNull().default(0),
  error: text("error"),
  expiresAt: integer("expires_at").notNull(),
  sentAt: integer("sent_at"),
  completedAt: integer("completed_at"),
  createdAt: integer("created_at").notNull(),
  /** R107 (0119): e-sign v2 stamp, seal, template and bulk send. */
  v2: integer("v2").notNull().default(0),
  seal: text("seal"),
  sealKeyId: text("seal_key_id"),
  templateId: text("template_id"),
  bulkId: text("bulk_id"),
  pendingSend: integer("pending_send").notNull().default(0),
}, (t) => [index("sign_requests_org_idx").on(t.orgId, t.createdAt), index("sign_requests_status_idx").on(t.status, t.expiresAt),
  index("sign_requests_pending_idx").on(t.pendingSend, t.createdAt), index("sign_requests_final_sha_idx").on(t.finalSha256), index("sign_requests_template_idx").on(t.templateId)]);

export const signSigners = sqliteTable("sign_signers", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  orgId: text("org_id").notNull(),
  position: integer("position").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  tokenHash: text("token_hash"),
  status: text("status").notNull(),
  sentAt: integer("sent_at"),
  remindedAt: integer("reminded_at"),
  viewedAt: integer("viewed_at"),
  signedAt: integer("signed_at"),
  declinedAt: integer("declined_at"),
  declineReason: text("decline_reason"),
  signatureFileIds: text("signature_file_ids"),
  /** R107 (0119): the email code that identifies the signer. */
  codeHash: text("code_hash"),
  codeExpiresAt: integer("code_expires_at"),
  codeTries: integer("code_tries").notNull().default(0),
  codeSentAt: integer("code_sent_at"),
  codeSends: text("code_sends"),
  verifiedAt: integer("verified_at"),
  verifiedToken: text("verified_token"),
}, (t) => [uniqueIndex("sign_signers_token_idx").on(t.tokenHash), index("sign_signers_request_idx").on(t.requestId, t.position)]);

export const signEvents = sqliteTable("sign_events", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  orgId: text("org_id").notNull(),
  seq: integer("seq").notNull(),
  at: integer("at").notNull(),
  signerId: text("signer_id"),
  name: text("name").notNull(),
  email: text("email").notNull(),
  action: text("action").notNull(),
  ipCountry: text("ip_country"),
  detail: text("detail"),
  /** R107 (0119): append only (trigger); never the IP itself. */
  ipHash: text("ip_hash"),
  userAgent: text("user_agent"),
  tz: text("tz"),
  docSha256: text("doc_sha256"),
}, (t) => [index("sign_events_request_idx").on(t.requestId, t.seq)]);
/** R107 (0119): one seal key per workspace; the private half is encrypted with the app secret. */
export const esignKeys = sqliteTable("esign_keys", {
  orgId: text("org_id").primaryKey(),
  keyId: text("key_id").notNull(),
  publicJwk: text("public_jwk").notNull(),
  privateEnc: text("private_enc").notNull(),
  createdAt: integer("created_at").notNull(),
});
/** R107 (0119): a placed document with roles instead of people. */
export const signTemplates = sqliteTable("sign_templates", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  createdBy: text("created_by").notNull(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  message: text("message"),
  orderMode: text("order_mode").notNull().default("any"),
  remindDays: integer("remind_days").notNull().default(0),
  expiresDays: integer("expires_days").notNull().default(14),
  roles: text("roles").notNull(),
  fields: text("fields").notNull(),
  pages: text("pages").notNull(),
  sourceFileId: text("source_file_id").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  uses: integer("uses").notNull().default(0),
  deletedAt: integer("deleted_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("sign_templates_org_idx").on(t.orgId, t.deletedAt, t.updatedAt)]);


/**
 * Tools P2 (0096): text extracted from mail attachments for search (17) and the smart folder each one is filed in (16).
 * The extracted text and its full text index live in the separate index database (binding INDEX_DB,
 * drizzle-index/), never here: the main database holds no virtual table so `wrangler d1 export` works.
 */
export const attachmentText = sqliteTable("attachment_text", {
  id: integer("id").primaryKey(),
  attachmentId: text("attachment_id").notNull(),
  orgId: text("org_id").notNull(),
  mailboxId: text("mailbox_id").notNull(),
  messageId: text("message_id").notNull(),
  msgDate: ts("msg_date").notNull(),
  filename: text("filename").notNull().default(""),
  sizeBytes: integer("size_bytes").notNull().default(0),
  /** queued (waiting), pending (engine job running), done (text and folder written), failed, skipped (nothing to read). */
  status: text("status", { enum: ["queued", "pending", "done", "failed", "skipped"] }).notNull().default("queued"),
  jobId: text("job_id"),
  tries: integer("tries").notNull().default(0),
  chars: integer("chars").notNull().default(0),
  pagesOcr: integer("pages_ocr").notNull().default(0),
  class: text("class"),
  /** 1 when a person moved it to another folder (the rules then leave it alone). */
  classManual: integer("class_manual", { mode: "boolean" }).notNull().default(false),
  indexedAt: ts("indexed_at"),
  updatedAt: ts("updated_at").notNull(),
}, (t) => [
  uniqueIndex("attachment_text_attachment_idx").on(t.attachmentId),
  index("attachment_text_queue_idx").on(t.status, t.msgDate),
  index("attachment_text_org_idx").on(t.orgId, t.status, t.mailboxId, t.class),
  index("attachment_text_folder_idx").on(t.orgId, t.class, t.msgDate),
]);

/** Tools P2 (0096): the attachment indexer's switch, OCR language and daily count per workspace, plus its cursors in row "*". */
export const attachmentIndexState = sqliteTable("attachment_index_state", {
  orgId: text("org_id").primaryKey(),
  mode: text("mode", { enum: ["on", "off"] }),
  lang: text("lang").notNull().default("eng"),
  day: text("day").notNull().default(""),
  n: integer("n").notNull().default(0),
  hi: integer("hi").notNull().default(0),
  lo: integer("lo").notNull().default(0),
  sw: integer("sw").notNull().default(0),
  updatedAt: ts("updated_at").notNull(),
});

// ---------------------------------------------------------------- R77: workspace branding and personal themes

/** A workspace's brand (shared/branding.ts Brand, without logos) as JSON. No row is Multies' own look. */
export const workspaceBranding = sqliteTable("workspace_branding", {
  orgId: text("org_id").primaryKey(),
  brand: text("brand").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull(),
});

/** Workspace logos: light and dark, square mark and wide logo. PNG, JPEG or WebP up to 512 KB, kept as base64. */
export const workspaceBrandLogos = sqliteTable("workspace_brand_logos", {
  orgId: text("org_id").notNull(),
  kind: text("kind", { enum: ["mark_light", "mark_dark", "wide_light", "wide_dark"] }).notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  /** A short hash of the bytes; the logo URL carries it so caches can keep the image for good. */
  version: text("version").notNull(),
  contentB64: text("content_b64").notNull(),
  updatedAt: ts("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.orgId, t.kind] })]);

/** A person's own theme in one workspace: follow the brand (default) or their own accent. */
export const userThemes = sqliteTable("user_themes", {
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull(),
  followBrand: integer("follow_brand", { mode: "boolean" }).notNull().default(true),
  accent: text("accent"),
  updatedAt: ts("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.orgId] })]);

/**
 * R80C: social posts from Connections (drizzle/0101). The connected accounts themselves live with the integration
 * platform; a target row names one by its platform id and keeps that account's result.
 */
export const socialPosts = sqliteTable("social_posts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdBy: text("created_by"),
  text: text("text").notNull(),
  mediaId: text("media_id"),
  status: text("status", { enum: ["scheduled", "sending", "done", "partial", "failed", "canceled", "draft", "review", "changes", "rejected"] }).notNull().default("scheduled"),
  runAt: ts("run_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
  /** R117 (0109): format, per network text (JSON), extras (JSON: first comment, poll, link card), carousel images (JSON ids). */
  format: text("format"),
  texts: text("texts"),
  extras: text("extras"),
  mediaIds: text("media_ids"),
  campaign: text("campaign"),
  /** R117: evergreen posts come back into free slots; a recycled copy names its source. */
  evergreen: integer("evergreen", { mode: "boolean" }).notNull().default(false),
  evergreenOf: text("evergreen_of"),
  /** R117: drafts and approvals. */
  submittedBy: text("submitted_by"),
  reviewNote: text("review_note"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: ts("reviewed_at"),
}, (t) => [index("social_posts_due_idx").on(t.status, t.runAt), index("social_posts_org_idx").on(t.orgId, t.runAt),
  index("social_posts_org_status_idx").on(t.orgId, t.status), index("social_posts_evergreen_idx").on(t.evergreen, t.orgId)]);

export const socialPostTargets = sqliteTable("social_post_targets", {
  postId: text("post_id").notNull().references(() => socialPosts.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  app: text("app").notNull(),
  label: text("label"),
  target: text("target"),
  targetName: text("target_name"),
  status: text("status", { enum: ["pending", "sent", "failed", "skipped"] }).notNull().default("pending"),
  url: text("url"),
  error: text("error"),
  sentAt: ts("sent_at"),
  /** Oct 31 (0106): the network's own id for the post, what it said when last asked, and when that was. */
  remoteId: text("remote_id"),
  networkState: text("network_state", { enum: ["live", "removed"] }),
  checkedAt: ts("checked_at"),
  /** R117: a note on this account's result (the first comment did not go). */
  note: text("note"),
}, (t) => [primaryKey({ columns: [t.postId, t.accountId] })]);

export const socialMedia = sqliteTable("social_media", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  contentB64: text("content_b64").notNull(),
  createdAt: createdAt(),
  /** R117: kept for the library or an evergreen post, so the cleanup pass leaves it. */
  kept: integer("kept", { mode: "boolean" }).notNull().default(false),
});

/** R117 (0109): weekly time slots, for one account or all (account_id null), in the zone they were set in. */
export const socialSlots = sqliteTable("social_slots", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  accountId: text("account_id"),
  weekday: integer("weekday").notNull(),
  minute: integer("minute").notNull(),
  tz: text("tz").notNull(),
  createdAt: createdAt(),
}, (t) => [index("social_slots_org_idx").on(t.orgId)]);

/** R117 (0109): the Social library: images (a kept social_media row), saved captions and hashtag sets. */
export const socialLibrary = sqliteTable("social_library", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["image", "caption", "hashtags"] }).notNull(),
  name: text("name").notNull(),
  body: text("body"),
  mediaId: text("media_id"),
  campaign: text("campaign"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdBy: text("created_by"),
  createdAt: createdAt(),
}, (t) => [index("social_library_org_idx").on(t.orgId, t.createdAt)]);

/**
 * R83: own sign in for TikTok and Threads (0102). One linked account per network per workspace; the tokens are
 * encrypted with APP_SECRET. Publishes track each TikTok video until the network reports it is up.
 */
export const directSocialLinks = sqliteTable("direct_social_links", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["tiktok", "threads"] }).notNull(),
  providerUserId: text("provider_user_id").notNull(),
  username: text("username"),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc"),
  accessExpiresAt: ts("access_expires_at"),
  refreshExpiresAt: ts("refresh_expires_at"),
  scopes: text("scopes"),
  status: text("status", { enum: ["active", "expired"] }).notNull().default("active"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("direct_social_links_org_provider_uq").on(t.orgId, t.provider), index("direct_social_links_user_idx").on(t.provider, t.providerUserId)]);

export const directSocialPublishes = sqliteTable("direct_social_publishes", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  publishId: text("publish_id").notNull(),
  title: text("title"),
  status: text("status", { enum: ["processing", "published", "failed", "removed"] }).notNull().default("processing"),
  postId: text("post_id"),
  error: text("error"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("direct_social_publishes_org_idx").on(t.orgId, t.createdAt), uniqueIndex("direct_social_publishes_pub_uq").on(t.provider, t.publishId)]);


/** R87: a short link (/l/<code>). The code is unique across Multies; tags are a JSON array. */
export const shortLinks = sqliteTable("short_links", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  url: text("url").notNull(),
  title: text("title"),
  tags: text("tags").notNull().default("[]"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  expiresAt: ts("expires_at"),
  maxClicks: integer("max_clicks"),
  passwordHash: text("password_hash"),
  clicks: integer("clicks").notNull().default(0),
  botClicks: integer("bot_clicks").notNull().default(0),
  lastClickAt: ts("last_click_at"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("short_links_code_uq").on(t.code), index("short_links_org_idx").on(t.orgId, t.createdAt)]);

/** R87: one counted click on a short link or a bio page link. No address: visitor is a salted hash for the day. */
export const linkClicks = sqliteTable("link_clicks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  linkId: text("link_id").notNull(),
  day: text("day").notNull(),
  at: ts("at").notNull(),
  country: text("country"),
  referrer: text("referrer"),
  device: text("device"),
  browser: text("browser"),
  os: text("os"),
  visitor: text("visitor"),
}, (t) => [index("link_clicks_link_day_idx").on(t.linkId, t.day)]);

/** R87: a link in bio page (/bio/<slug>): the workspace's (user_id null) or one person's. */
export const linkBioPages = sqliteTable("link_bio_pages", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id"),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  bio: text("bio"),
  avatar: text("avatar", { enum: ["logo", "photo", "none"] }).notNull().default("logo"),
  avatarUrl: text("avatar_url"),
  theme: text("theme", { enum: ["brand", "light", "dark"] }).notNull().default("brand"),
  brandColor: text("brand_color"),
  items: text("items").notNull().default("[]"),
  socials: text("socials").notNull().default("[]"),
  published: integer("published", { mode: "boolean" }).notNull().default(false),
  views: integer("views").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("link_bio_pages_slug_uq").on(t.slug), index("link_bio_pages_org_idx").on(t.orgId, t.userId)]);

/** R87: a team go link (go/<name>): a doc, task, project or web address, for workspace members only. */
export const goLinks = sqliteTable("go_links", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  targetKind: text("target_kind", { enum: ["url", "doc", "task", "project"] }).notNull(),
  targetId: text("target_id"),
  url: text("url"),
  label: text("label"),
  description: text("description"),
  clicks: integer("clicks").notNull().default(0),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("go_links_org_name_uq").on(t.orgId, t.name)]);

/** R87: a workspace's own link domain (a name under one of its verified domains). */
export const linkHosts = sqliteTable("link_hosts", {
  orgId: text("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  host: text("host").notNull(),
  domainId: text("domain_id"),
  status: text("status", { enum: ["pending", "dns_ok", "live", "failed"] }).notNull().default("pending"),
  checkedAt: ts("checked_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("link_hosts_host_uq").on(t.host)]);
// R119 (0111): helpdesk mode on the shared inbox and the website chat. Off for a workspace until an admin turns it on.
/** One row per workspace: the helpdesk settings (JSON, read with readSettings), the website chat key, the ticket counter and the sync cursor. */
export const hdSettings = sqliteTable("hd_settings", {
  orgId: text("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  settings: text("settings").notNull().default("{}"),
  /** Public key in the website chat snippet (not a secret: the allowed domains guard it). */
  widgetKey: text("widget_key").notNull(),
  ticketSeq: integer("ticket_seq").notNull().default(1000),
  /** Mail and chat activity is read after this moment (epoch ms) by the ticket sync. */
  syncCursor: integer("sync_cursor").notNull().default(0),
  syncedAt: integer("synced_at").notNull().default(0),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("hd_settings_widget_key_uq").on(t.widgetKey)]);

/** A ticket over one mail thread, chat conversation or website chat. Clock fields are epoch ms (see shared/helpdesk SlaClock). */
export const hdTickets = sqliteTable("hd_tickets", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  kind: text("kind", { enum: ["mail", "chat", "web"] }).notNull(),
  /** mail: thread id; chat: msg_conversations.id; web: the ticket's own id. */
  refId: text("ref_id").notNull(),
  mailboxId: text("mailbox_id"),
  subject: text("subject").notNull().default(""),
  snippet: text("snippet").notNull().default(""),
  requesterName: text("requester_name").notNull().default(""),
  requesterEmail: text("requester_email"),
  contactId: text("contact_id"),
  status: text("status", { enum: ["open", "pending", "on_hold", "solved"] }).notNull().default("open"),
  priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull().default("normal"),
  assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  lastMessageAt: integer("last_message_at").notNull(),
  firstReplyAt: integer("first_reply_at"),
  firstReplyDueAt: integer("first_reply_due_at"),
  resolveDueAt: integer("resolve_due_at"),
  resolveUsedMin: integer("resolve_used_min").notNull().default(0),
  runningSince: integer("running_since"),
  solvedAt: integer("solved_at"),
  unread: integer("unread").notNull().default(0),
  csatTokenHash: text("csat_token_hash"),
  csatRating: text("csat_rating", { enum: ["great", "okay", "bad"] }),
  csatComment: text("csat_comment"),
  csatAt: integer("csat_at"),
  /** Website chat: the visitor's token (sha256), typing marks, the page it came from, the abuse window. */
  visitorTokenHash: text("visitor_token_hash"),
  visitorTypingAt: integer("visitor_typing_at"),
  agentTypingAt: integer("agent_typing_at"),
  visitorSeenAt: integer("visitor_seen_at"),
  offline: integer("offline", { mode: "boolean" }).notNull().default(false),
  pageUrl: text("page_url"),
  windowStart: integer("window_start").notNull().default(0),
  windowCount: integer("window_count").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  uniqueIndex("hd_tickets_ref_uq").on(t.orgId, t.kind, t.refId),
  index("hd_tickets_org_status_idx").on(t.orgId, t.status, t.lastMessageAt),
  index("hd_tickets_org_assignee_idx").on(t.orgId, t.assigneeUserId),
  index("hd_tickets_csat_idx").on(t.csatTokenHash),
  index("hd_tickets_visitor_idx").on(t.visitorTokenHash),
]);

/** Website chat messages (mail and chat tickets keep their messages where they already live). */
export const hdWebMessages = sqliteTable("hd_web_messages", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  ticketId: text("ticket_id").notNull().references(() => hdTickets.id, { onDelete: "cascade" }),
  author: text("author", { enum: ["visitor", "agent", "bot", "system", "note"] }).notNull(),
  authorUserId: text("author_user_id"),
  text: text("text").notNull(),
  /** "mail" when the reply also went out by email. */
  via: text("via"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("hd_web_messages_ticket_idx").on(t.ticketId, t.createdAt)]);

/** Named steps an agent runs on a ticket in one go (shared/helpdesk MacroStep[] as JSON). */
export const hdMacros = sqliteTable("hd_macros", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  steps: text("steps").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("hd_macros_org_idx").on(t.orgId)]);


// R90: automation builder. Flows are a graph of steps (trigger, conditions, waits, approvals, actions);
// every run keeps each step with its input and output; watchers check web pages and feeds on a schedule.
export const flows = sqliteTable("flows", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  /** The trigger node's kind, copied out of the graph so events find their flows with one indexed read. */
  triggerKind: text("trigger_kind").notNull(),
  /** JSON: the graph { nodes, edges } (shared/flows.ts FlowGraph). */
  graph: text("graph").notNull().default("{\"nodes\":[],\"edges\":[]}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  runCount: integer("run_count").notNull().default(0),
  lastRunAt: ts("last_run_at"),
  lastStatus: text("last_status"),
  ...suiteCols(),
}, (t) => [index("flows_org_trigger_idx").on(t.orgId, t.triggerKind, t.enabled)]);

export const flowRuns = sqliteTable("flow_runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  flowId: text("flow_id").notNull().references(() => flows.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["running", "waiting", "waiting_approval", "succeeded", "failed", "cancelled"] }).notNull().default("running"),
  /** One run per trigger event: the same event (a task id and change, a feed item id) never starts a second run. */
  dedupeKey: text("dedupe_key").notNull(),
  /** JSON: what the trigger handed over, secret looking keys redacted. */
  triggerData: text("trigger_data").notNull().default("{}"),
  currentNode: text("current_node"),
  resumeAt: ts("resume_at"),
  error: text("error"),
  startedAt: ts("started_at").notNull().$defaultFn(() => new Date()),
  finishedAt: ts("finished_at"),
}, (t) => [
  uniqueIndex("flow_runs_dedupe_idx").on(t.flowId, t.dedupeKey),
  index("flow_runs_due_idx").on(t.status, t.resumeAt),
  index("flow_runs_org_idx").on(t.orgId, t.startedAt),
  index("flow_runs_flow_idx").on(t.flowId, t.startedAt),
]);

export const flowRunSteps = sqliteTable("flow_run_steps", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => flowRuns.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  /** A retry adds attempt 2, 3; the unique index means a step attempt is claimed, and so run, once. */
  attempt: integer("attempt").notNull().default(1),
  kind: text("kind").notNull(),
  label: text("label").notNull().default(""),
  status: text("status", { enum: ["running", "succeeded", "failed", "waiting", "skipped"] }).notNull().default("running"),
  input: text("input"),
  output: text("output"),
  error: text("error"),
  startedAt: ts("started_at").notNull().$defaultFn(() => new Date()),
  finishedAt: ts("finished_at"),
}, (t) => [uniqueIndex("flow_run_steps_once_idx").on(t.runId, t.nodeId, t.attempt)]);

/** A page or feed a flow watches. One per flow; checked on a schedule by the maintenance pass. */
export const flowWatches = sqliteTable("flow_watches", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  flowId: text("flow_id").notNull().references(() => flows.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["page", "feed"] }).notNull(),
  url: text("url").notNull(),
  selector: text("selector"),
  everyMinutes: integer("every_minutes").notNull().default(360),
  nextCheckAt: ts("next_check_at"),
  lastCheckedAt: ts("last_checked_at"),
  lastHash: text("last_hash"),
  /** The page text at the last check (capped), so the next change can show what changed. */
  lastText: text("last_text"),
  /** JSON string[]: feed item ids already seen (newest 300). */
  seen: text("seen").notNull().default("[]"),
  lastError: text("last_error"),
  failCount: integer("fail_count").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("flow_watches_flow_idx").on(t.flowId), index("flow_watches_due_idx").on(t.nextCheckAt)]);

/** Items waiting for a flow's email digest step; sent together daily or weekly. */
export const flowDigestItems = sqliteTable("flow_digest_items", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  flowId: text("flow_id").notNull().references(() => flows.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  title: text("title").notNull(),
  link: text("link"),
  summary: text("summary"),
  /** When the digest that holds this item goes out (the step's next daily or weekly time). */
  sendAt: ts("send_at").notNull(),
  sentAt: ts("sent_at"),
  createdAt: createdAt(),
}, (t) => [index("flow_digest_due_idx").on(t.sentAt, t.sendAt), index("flow_digest_flow_idx").on(t.flowId, t.nodeId)]);
// ---------------------------------------------------------------------------------------------------------------
// R122: help center. Public pages read only rows a workspace published (status "published" while hc_settings.on).
// ---------------------------------------------------------------------------------------------------------------
export const hcSettings = sqliteTable("hc_settings", {
  orgId: text("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  on: integer("on", { mode: "boolean" }).notNull().default(false),
  slug: text("slug").notNull(),
  name: text("name").notNull().default(""),
  intro: text("intro").notNull().default(""),
  qaOn: integer("qa_on", { mode: "boolean" }).notNull().default(true),
  moderate: integer("moderate", { mode: "boolean" }).notNull().default(true),
  suggestInChat: integer("suggest_in_chat", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("hc_settings_slug_uq").on(t.slug)]);

export const hcCategories = sqliteTable("hc_categories", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description").notNull().default(""),
  position: real("position").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("hc_categories_slug_uq").on(t.orgId, t.slug)]);

/** A published snapshot of a doc: editing the doc changes nothing public until someone presses Update. */
export const hcArticles = sqliteTable("hc_articles", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  categoryId: text("category_id"),
  docId: text("doc_id"),
  docVersion: integer("doc_version"),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  bodyHtml: text("body_html").notNull().default(""),
  bodyText: text("body_text").notNull().default(""),
  status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
  position: real("position").notNull().default(0),
  helpfulYes: integer("helpful_yes").notNull().default(0),
  helpfulNo: integer("helpful_no").notNull().default(0),
  views: integer("views").notNull().default(0),
  publishedAt: integer("published_at"),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  uniqueIndex("hc_articles_slug_uq").on(t.orgId, t.slug),
  index("hc_articles_org_status_idx").on(t.orgId, t.status, t.categoryId, t.position),
  index("hc_articles_doc_idx").on(t.orgId, t.docId),
]);

export const hcQuestions = sqliteTable("hc_questions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  categoryId: text("category_id"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  authorName: text("author_name").notNull().default(""),
  source: text("source", { enum: ["public", "ticket", "team"] }).notNull().default("public"),
  ticketId: text("ticket_id"),
  status: text("status", { enum: ["pending", "published", "hidden"] }).notNull().default("pending"),
  votes: integer("votes").notNull().default(0),
  answerCount: integer("answer_count").notNull().default(0),
  acceptedAnswerId: text("accepted_answer_id"),
  visitorHash: text("visitor_hash"),
  publishedAt: integer("published_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  index("hc_questions_org_status_idx").on(t.orgId, t.status, t.createdAt),
  index("hc_questions_org_votes_idx").on(t.orgId, t.status, t.votes),
]);

export const hcAnswers = sqliteTable("hc_answers", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  questionId: text("question_id").notNull().references(() => hcQuestions.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  authorKind: text("author_kind", { enum: ["team", "visitor"] }).notNull().default("visitor"),
  authorUserId: text("author_user_id"),
  authorName: text("author_name").notNull().default(""),
  status: text("status", { enum: ["pending", "published", "hidden"] }).notNull().default("pending"),
  votes: integer("votes").notNull().default(0),
  visitorHash: text("visitor_hash"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  index("hc_answers_question_idx").on(t.questionId, t.status, t.createdAt),
  index("hc_answers_org_status_idx").on(t.orgId, t.status, t.createdAt),
]);

/** One vote per visitor per item (kind q, a or f for article feedback); the visitor is a keyed hash, no address is kept. */
export const hcVotes = sqliteTable("hc_votes", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  itemId: text("item_id").notNull(),
  voterHash: text("voter_hash").notNull(),
  value: integer("value").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.kind, t.itemId, t.voterHash] })]);

export const hcFeedback = sqliteTable("hc_feedback", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  articleId: text("article_id").notNull().references(() => hcArticles.id, { onDelete: "cascade" }),
  helpful: integer("helpful", { mode: "boolean" }).notNull(),
  comment: text("comment"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("hc_feedback_org_idx").on(t.orgId, t.createdAt)]);

/** Search: a small term index per workspace (prefix range on term), written when an item is published. */
export const hcTerms = sqliteTable("hc_terms", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  term: text("term").notNull(),
  kind: text("kind", { enum: ["a", "q"] }).notNull(),
  itemId: text("item_id").notNull(),
  weight: integer("weight").notNull().default(1),
}, (t) => [primaryKey({ columns: [t.orgId, t.term, t.kind, t.itemId] }), index("hc_terms_item_idx").on(t.itemId)]);
/**
 * R91 Dashboards plus (DASHBOARDS_PLUS). Additive only (migration 0112).
 * dashboard_shares: public read only links to one dashboard. Only the SHA-256 of the token is stored; the
 * public page reads one row by its unique index. The widget numbers are cached in `snapshot` for 15 minutes.
 */
export const dashboardShares = sqliteTable("dashboard_shares", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  dashboardId: text("dashboard_id").notNull().references(() => dashboards.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  passwordHash: text("password_hash"),
  showBrand: integer("show_brand", { mode: "boolean" }).notNull().default(true),
  /** "report" when an emailed report made it for outside recipients (hidden from the share list). */
  purpose: text("purpose").notNull().default("link"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  expiresAt: ts("expires_at"),
  revokedAt: ts("revoked_at"),
  snapshot: text("snapshot"),
  snapshotAt: ts("snapshot_at"),
}, (t) => [uniqueIndex("dashboard_shares_token_uq").on(t.tokenHash), index("dashboard_shares_dash_idx").on(t.dashboardId)]);

/** R91: scheduled report emails for one dashboard. Due rows are picked by (enabled, next_run_at). */
export const dashboardReports = sqliteTable("dashboard_reports", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  dashboardId: text("dashboard_id").notNull().references(() => dashboards.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull(),
  frequency: text("frequency", { enum: ["daily", "weekly", "monthly"] }).notNull(),
  hour: integer("hour").notNull().default(8),
  weekday: integer("weekday"),
  monthDay: integer("month_day"),
  timeZone: text("time_zone").notNull().default("UTC"),
  withPdf: integer("with_pdf", { mode: "boolean" }).notNull().default(true),
  /** JSON: { email: string; userId?: string }[] */
  recipients: text("recipients").notNull().default("[]"),
  /** JSON: lower cased emails that unsubscribed. */
  unsubscribed: text("unsubscribed").notNull().default("[]"),
  shareId: text("share_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  nextRunAt: ts("next_run_at").notNull(),
  lastRunAt: ts("last_run_at"),
  lastError: text("last_error"),
  createdAt: createdAt(),
}, (t) => [index("dashboard_reports_due_idx").on(t.enabled, t.nextRunAt), index("dashboard_reports_dash_idx").on(t.dashboardId)]);

/** R91: threshold alerts on a number card. Fires once per crossing; a crossing in quiet hours waits. */
export const dashboardAlerts = sqliteTable("dashboard_alerts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  dashboardId: text("dashboard_id").notNull().references(() => dashboards.id, { onDelete: "cascade" }),
  widgetId: text("widget_id").notNull(),
  createdBy: text("created_by").notNull(),
  direction: text("direction", { enum: ["above", "below"] }).notNull(),
  threshold: real("threshold").notNull(),
  byMail: integer("by_mail", { mode: "boolean" }).notNull().default(true),
  quietStart: integer("quiet_start"),
  quietEnd: integer("quiet_end"),
  timeZone: text("time_zone").notNull().default("UTC"),
  state: text("state", { enum: ["ok", "crossed"] }),
  pending: integer("pending", { mode: "boolean" }).notNull().default(false),
  lastValue: real("last_value"),
  lastFiredAt: ts("last_fired_at"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  nextCheckAt: ts("next_check_at").notNull(),
  createdAt: createdAt(),
}, (t) => [index("dashboard_alerts_due_idx").on(t.enabled, t.nextCheckAt), index("dashboard_alerts_dash_idx").on(t.dashboardId)]);

/** R91: uploaded CSV or a public CSV link, usable in the question builder. Rows are capped JSON. */
export const dashboardSources = sqliteTable("dashboard_sources", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["csv", "url"] }).notNull(),
  url: text("url"),
  refresh: text("refresh", { enum: ["manual", "hourly", "daily"] }).notNull().default("manual"),
  /** JSON: { name: string; kind: "number" | "date" | "text" }[] */
  columns: text("columns").notNull().default("[]"),
  /** JSON: (string | number | null)[][] */
  rows: text("rows").notNull().default("[]"),
  rowCount: integer("row_count").notNull().default(0),
  refreshedAt: ts("refreshed_at"),
  nextRefreshAt: ts("next_refresh_at"),
  lastError: text("last_error"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
}, (t) => [index("dashboard_sources_org_idx").on(t.orgId), index("dashboard_sources_due_idx").on(t.nextRefreshAt)]);

/* ------------------------------------------------------------- R118 (0122): Social P2b */

/** One comment, message thread or mention pulled from a social account. A message thread is one row (its newest message). */
export const socialInboxItems = sqliteTable("social_inbox_items", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  app: text("app").notNull(),
  kind: text("kind", { enum: ["comment", "message", "mention", "reply"] }).notNull(),
  remoteId: text("remote_id").notNull(),
  /** The Page (Facebook) or account id a reply goes out from. */
  target: text("target"),
  authorId: text("author_id"),
  authorName: text("author_name"),
  authorHandle: text("author_handle"),
  text: text("text").notNull(),
  postUrl: text("post_url"),
  postText: text("post_text"),
  receivedAt: ts("received_at").notNull(),
  /** Their newest message (the 24 hour reply window on Meta messages counts from here). */
  lastInboundAt: ts("last_inbound_at"),
  status: text("status", { enum: ["open", "done"] }).notNull().default("open"),
  assigneeId: text("assignee_id"),
  contactId: text("contact_id"),
  taskId: text("task_id"),
  repliedAt: ts("replied_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("social_inbox_remote_uq").on(t.orgId, t.accountId, t.remoteId),
  index("social_inbox_list_idx").on(t.orgId, t.status, t.receivedAt),
  index("social_inbox_assignee_idx").on(t.orgId, t.assigneeId, t.status),
]);

/** An internal note (never sent) or a reply that went to the network. */
export const socialInboxNotes = sqliteTable("social_inbox_notes", {
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull().references(() => socialInboxItems.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull(),
  authorId: text("author_id"),
  kind: text("kind", { enum: ["note", "reply"] }).notNull(),
  text: text("text").notNull(),
  status: text("status", { enum: ["sent", "failed"] }).notNull().default("sent"),
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [index("social_inbox_notes_item_idx").on(t.itemId, t.createdAt)]);

export const socialSavedReplies = sqliteTable("social_saved_replies", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("social_saved_replies_org_idx").on(t.orgId, t.title)]);

/** Results of one sent post on one account, as the network last told us. */
export const socialPostStats = sqliteTable("social_post_stats", {
  postId: text("post_id").notNull().references(() => socialPosts.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  orgId: text("org_id").notNull(),
  app: text("app").notNull(),
  reach: integer("reach"),
  engagement: integer("engagement"),
  clicks: integer("clicks"),
  fetchedAt: ts("fetched_at").notNull(),
}, (t) => [primaryKey({ columns: [t.postId, t.accountId] }), index("social_post_stats_org_idx").on(t.orgId, t.fetchedAt)]);

/** Per social account: when its inbox and results were last pulled, its health, and when the bell was told. */
export const socialAccountState = sqliteTable("social_account_state", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  app: text("app").notNull(),
  inboxSyncedAt: ts("inbox_synced_at"),
  inboxError: text("inbox_error"),
  statsSyncedAt: ts("stats_synced_at"),
  healthCode: text("health_code"),
  healthToldAt: ts("health_told_at"),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.orgId, t.accountId] }), index("social_account_state_inbox_idx").on(t.inboxSyncedAt)]);

/** Staging only: the test network account of a workspace (never read unless the config allows the test network). */
export const socialTestAccounts = sqliteTable("social_test_accounts", {
  orgId: text("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  broken: integer("broken", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by"),
  createdAt: createdAt(),
});
/** R96: topics inside a channel (rename, merge, resolve with a tick). `nameKey` is the lower case name, unique per channel. */
export const chatTopics = sqliteTable("chat_topics", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull().references(() => chatChannels.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  nameKey: text("name_key").notNull(),
  resolvedAt: ts("resolved_at"),
  resolvedBy: text("resolved_by"),
  lastMessageAt: ts("last_message_at"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("chat_topics_name_uq").on(t.channelId, t.nameKey)]);

/** R96: how far each person has read a topic (unread by topic). */
export const chatTopicReads = sqliteTable("chat_topic_reads", {
  topicId: text("topic_id").notNull().references(() => chatTopics.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  lastReadAt: ts("last_read_at").notNull(),
}, (t) => [primaryKey({ columns: [t.topicId, t.userId] })]);

/** R96: a chat message posted as an announcement (pinned, with seen by receipts). */
export const chatAnnouncements = sqliteTable("chat_announcements", {
  messageId: text("message_id").primaryKey().references(() => chatMessages.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull(),
  postedBy: text("posted_by"),
  createdAt: createdAt(),
}, (t) => [index("chat_announcements_org_idx").on(t.orgId, t.createdAt)]);

export const chatAnnouncementReads = sqliteTable("chat_announcement_reads", {
  messageId: text("message_id").notNull().references(() => chatAnnouncements.messageId, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull(),
  readAt: ts("read_at").notNull(),
}, (t) => [primaryKey({ columns: [t.messageId, t.userId] })]);

/** R96: polls, decision votes, live Q&A and word clouds, in a channel (with a card message) and or a meeting. */
export const chatPolls = sqliteTable("chat_polls", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  channelId: text("channel_id"),
  messageId: text("message_id"),
  meetingId: text("meeting_id"),
  kind: text("kind", { enum: ["poll", "decision", "qa", "cloud"] }).notNull(),
  question: text("question").notNull(),
  /** JSON string[]: the choices of a poll (fixed for a decision, empty for Q&A and word clouds). */
  options: text("options").notNull().default("[]"),
  multi: integer("multi", { mode: "boolean" }).notNull().default(false),
  anonymous: integer("anonymous", { mode: "boolean" }).notNull().default(false),
  closesAt: ts("closes_at"),
  closedAt: ts("closed_at"),
  /** JSON outcome written once when it closes. */
  outcome: text("outcome"),
  createdBy: text("created_by"),
  createdByName: text("created_by_name").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("chat_polls_message_uq").on(t.messageId), index("chat_polls_meeting_idx").on(t.meetingId).where(sql`${t.meetingId} IS NOT NULL`), index("chat_polls_due_idx").on(t.closedAt, t.closesAt)]);

/** R96: the questions of a live Q&A. */
export const chatPollItems = sqliteTable("chat_poll_items", {
  id: text("id").primaryKey(),
  pollId: text("poll_id").notNull().references(() => chatPolls.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull(),
  body: text("body").notNull(),
  authorId: text("author_id"),
  authorName: text("author_name").notNull().default(""),
  answeredAt: ts("answered_at"),
  createdAt: createdAt(),
  /** R114: a host hid this question from attendees. */
  hiddenAt: ts("hidden_at"),
  /** R114: a typed answer from the host. */
  answer: text("answer"),
}, (t) => [index("chat_poll_items_poll_idx").on(t.pollId)]);

/** R96: one row per voter and choice (an option index, a stance, a question id or a word). */
export const chatPollVotes = sqliteTable("chat_poll_votes", {
  pollId: text("poll_id").notNull().references(() => chatPolls.id, { onDelete: "cascade" }),
  voter: text("voter").notNull(),
  choice: text("choice").notNull(),
  orgId: text("org_id").notNull(),
  voterName: text("voter_name").notNull().default(""),
  reason: text("reason").notNull().default(""),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.pollId, t.voter, t.choice] })]);

// ---------------------------------------------------------------- R99: calendar and contacts sync (CalDAV and CardDAV)

/** R99: an app password for phone and desktop calendar and contacts apps. Only the SHA-256 hash is kept; revoking deletes the row. */
export const davAppPasswords = sqliteTable("dav_app_passwords", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  /** The last four characters, to tell two passwords apart. */
  hint: text("hint").notNull(),
  createdAt: createdAt(),
  /** Written at most every 10 minutes. */
  lastUsedAt: ts("last_used_at"),
}, (t) => [uniqueIndex("dav_app_passwords_hash_uq").on(t.tokenHash), index("dav_app_passwords_user_idx").on(t.orgId, t.userId)]);

/** R99: a sync token (RFC 6578) is a stored snapshot of a collection's { name: etag } for one app password. */
export const davSyncStates = sqliteTable("dav_sync_states", {
  id: text("id").primaryKey(),
  passwordId: text("password_id").notNull().references(() => davAppPasswords.id, { onDelete: "cascade" }),
  collection: text("collection").notNull(),
  members: text("members").notNull(),
  createdAt: createdAt(),
}, (t) => [index("dav_sync_states_pw_idx").on(t.passwordId, t.collection, t.createdAt)]);

/** R99: the resource name (and UID) a phone chose for an item it created. */
export const davNames = sqliteTable("dav_names", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  collection: text("collection").notNull(),
  name: text("name").notNull(),
  entityId: text("entity_id").notNull(),
  uid: text("uid"),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.collection, t.name] }), index("dav_names_entity_idx").on(t.orgId, t.collection, t.entityId)]);
/** R103: the team link library. One row per workspace and normalised address; a web clip keeps the doc it made. */
export const linkLibrary = sqliteTable("link_library", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  urlKey: text("url_key").notNull(),
  title: text("title").notNull().default(""),
  description: text("description").notNull().default(""),
  site: text("site").notNull().default(""),
  /** JSON array of lower case tags. */
  tags: text("tags").notNull().default("[]"),
  note: text("note").notNull().default(""),
  docId: text("doc_id"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
  deletedAt: ts("deleted_at"),
}, (t) => [index("link_library_org_idx").on(t.orgId, t.deletedAt, t.createdAt), uniqueIndex("link_library_key_uq").on(t.orgId, t.urlKey)]);

/**
 * R103: comments on docs. thread "team" is for the workspace and the doc's project guests; thread "public" is for
 * people with a share link (their posts wait for review) and the team's public replies.
 */
export const docComments = sqliteTable("doc_comments", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  docId: text("doc_id").notNull(),
  thread: text("thread", { enum: ["team", "public"] }).notNull().default("team"),
  shareLinkId: text("share_link_id"),
  authorType: text("author_type", { enum: ["member", "guest", "visitor"] }).notNull().default("member"),
  authorId: text("author_id"),
  authorName: text("author_name").notNull().default(""),
  /** A visitor's email, never shown publicly. */
  authorEmail: text("author_email"),
  body: text("body").notNull(),
  status: text("status", { enum: ["visible", "pending", "hidden"] }).notNull().default("visible"),
  mentions: text("mentions").notNull().default("[]"),
  moderatedBy: text("moderated_by"),
  moderatedAt: ts("moderated_at"),
  createdAt: createdAt(),
  editedAt: ts("edited_at"),
  deletedAt: ts("deleted_at"),
  /** R125: a comment on one row of a table doc (null for a comment on the doc). */
  rowId: text("row_id"),
}, (t) => [index("doc_comments_row_idx").on(t.orgId, t.rowId, t.createdAt).where(sql`${t.rowId} IS NOT NULL`), index("doc_comments_doc_idx").on(t.orgId, t.docId, t.createdAt), index("doc_comments_status_idx").on(t.orgId, t.status, t.createdAt)]);
/**
 * R111 (0128): a workspace's mail retention policy. No row, or enabled false, means keep forever: nothing is deleted
 * until an owner or admin of that workspace turns it on. keep_years null = forever. Deletion starts at starts_at
 * (7 days after it is turned on or made stricter), one pass a day, legal holds always win.
 */
export const mailRetentionPolicies = sqliteTable("mail_retention_policies", {
  orgId: text("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  keepYears: integer("keep_years"),
  startsAt: ts("starts_at"),
  enabledAt: ts("enabled_at"),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
  lastRunAt: ts("last_run_at"),
  lastRunDeleted: integer("last_run_deleted").notNull().default(0),
  totalDeleted: integer("total_deleted").notNull().default(0),
  /** 1 while the last pass hit its batch size, so the next cron run carries on instead of waiting a day. */
  backlog: integer("backlog", { mode: "boolean" }).notNull().default(false),
}, (t) => [index("mail_retention_due_idx").on(t.enabled, t.lastRunAt)]);

/** R111 (0128): a legal hold on a mailbox or a person. While it is active (released_at null) nothing in scope is deleted. */
export const mailLegalHolds = sqliteTable("mail_legal_holds", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["mailbox", "person"] }).notNull(),
  targetId: text("target_id").notNull(),
  name: text("name").notNull(),
  note: text("note"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  releasedAt: ts("released_at"),
  releasedBy: text("released_by"),
}, (t) => [index("mail_legal_holds_org_idx").on(t.orgId, t.releasedAt)]);

/** R111 (0128): a saved archive search (a case) that an owner or admin can export as mbox in a ZIP. */
export const mailCases = sqliteTable("mail_cases", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** JSON ArchiveFilters (src/shared/mail-archive.ts). */
  filters: text("filters").notNull().default("{}"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  lastExportedAt: ts("last_exported_at"),
  exportCount: integer("export_count").notNull().default(0),
}, (t) => [index("mail_cases_org_idx").on(t.orgId, t.createdAt)]);

/**
 * R115 (0123, MAPS_R115): one saved address per contact, company or booking page. lat and lon are set when the
 * address was picked from a lookup (or found later); an address typed by hand without a match has none.
 */
export const places = sqliteTable("places", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  entityType: text("entity_type", { enum: ["contact", "company", "scheduling_page"] }).notNull(),
  entityId: text("entity_id").notNull(),
  address: text("address").notNull(),
  lat: real("lat"),
  lon: real("lon"),
  ...suiteCols(),
}, (t) => [uniqueIndex("places_entity_uq").on(t.orgId, t.entityType, t.entityId)]);

/** R115: address lookup results shared by every workspace, keyed by a hash of service and query (no query text kept). */
export const geoCache = sqliteTable("geo_cache", {
  key: text("key").primaryKey(),
  results: text("results").notNull(),
  createdAt: createdAt(),
});

/** R115: live lookups a workspace made on one UTC day, for the daily cap (cache hits do not count). */
export const geoUsage = sqliteTable("geo_usage", {
  orgId: text("org_id").notNull(),
  day: text("day").notNull(),
  count: integer("count").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.orgId, t.day] })]);

/** R115: the earliest moment (ms) the next call to each lookup service may go out, so the app keeps to 1 a second. */
export const geoThrottle = sqliteTable("geo_throttle", {
  service: text("service").primaryKey(),
  nextAt: integer("next_at").notNull().default(0),
});
// R101 (migration 0129): Files plus. The workspace drive and the brand library. Bytes live in the S3 body store when
// configured, else in the separate FILES_DB database (drive_blobs, made on first use), never in this database.
export const driveItems = sqliteTable("drive_items", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  space: text("space", { enum: ["team", "private", "brand"] }).notNull(),
  /** The person whose My files it sits in (private space only). */
  ownerId: text("owner_id"),
  parentId: text("parent_id"),
  kind: text("kind", { enum: ["folder", "file"] }).notNull(),
  name: text("name").notNull(),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  versionId: text("version_id"),
  versions: integer("versions").notNull().default(0),
  tags: text("tags").notNull().default(""),
  note: text("note"),
  createdBy: text("created_by").notNull(),
  createdByName: text("created_by_name").notNull().default(""),
  updatedBy: text("updated_by"),
  trashedAt: integer("trashed_at"),
  trashedBy: text("trashed_by"),
  trashRootId: text("trash_root_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  index("drive_items_parent_idx").on(t.orgId, t.space, t.parentId),
  index("drive_items_owner_idx").on(t.orgId, t.ownerId),
  index("drive_items_trash_idx").on(t.orgId, t.trashRootId),
  index("drive_items_updated_idx").on(t.orgId, t.updatedAt),
]);

export const driveVersions = sqliteTable("drive_versions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  itemId: text("item_id").notNull(),
  number: integer("number").notNull(),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  blobKey: text("blob_key").notNull(),
  parts: integer("parts").notNull(),
  note: text("note"),
  createdBy: text("created_by").notNull(),
  createdByName: text("created_by_name").notNull().default(""),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("drive_versions_item_idx").on(t.itemId, t.number), index("drive_versions_org_idx").on(t.orgId, t.blobKey)]);

export const driveStars = sqliteTable("drive_stars", {
  userId: text("user_id").notNull(),
  itemId: text("item_id").notNull(),
  orgId: text("org_id").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.itemId] }), index("drive_stars_org_idx").on(t.orgId, t.userId)]);

export const driveShares = sqliteTable("drive_shares", {
  itemId: text("item_id").notNull(),
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull(),
  role: text("role", { enum: ["view", "edit"] }).notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.itemId, t.userId] }), index("drive_shares_user_idx").on(t.orgId, t.userId)]);
/** R108: a workspace contract template, made from a standard one (questions come from the base; the clause list is the workspace's). */
export const contractTemplates = sqliteTable("contract_templates", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  baseId: text("base_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  clauseKeys: text("clause_keys").notNull().default("[]"),
  retiredAt: ts("retired_at"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("contract_templates_org_idx").on(t.orgId, t.updatedAt)]);

/** R108: clause library versions. The newest version of a key is the one used; a standard clause is version 0 in code. */
export const contractClauses = sqliteTable("contract_clauses", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  retiredAt: ts("retired_at"),
  createdBy: text("created_by"),
  createdByName: text("created_by_name"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("contract_clauses_version_uq").on(t.orgId, t.key, t.version)]);

/** R108: a generated contract: which template, answers, the clause versions used, the Doc and reminder tasks made. */
export const contractRuns = sqliteTable("contract_runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  templateId: text("template_id").notNull(),
  title: text("title").notNull(),
  docId: text("doc_id"),
  answers: text("answers").notNull().default("{}"),
  clauseVersions: text("clause_versions").notNull().default("{}"),
  taskIds: text("task_ids").notNull().default("[]"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
}, (t) => [index("contract_runs_mine_idx").on(t.orgId, t.createdBy, t.createdAt)]);

/** SA1 (0134): who each connected social account is on its network (its own id, name and picture). One row per
 * connection; the unique index keeps one connection per network account in a workspace. */
export const socialAccountProfiles = sqliteTable("social_account_profiles", {
  orgId: text("org_id").notNull(),
  accountId: text("account_id").notNull(),
  app: text("app").notNull(),
  externalId: text("external_id"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  checkedAt: ts("checked_at").notNull(),
  /** W6 (0176): on a removal-pending marker, when the platform first refused to remove the connection. */
  removalFailedSince: ts("removal_failed_since"),
}, (t) => [primaryKey({ columns: [t.orgId, t.accountId] }), uniqueIndex("social_account_profiles_ext_uq").on(t.orgId, t.app, t.externalId)]);
// SOC1: the Pages (Facebook Pages, LinkedIn company Pages) an admin chose, one row per Page per workspace (migration 0163).
// key is the account id a post target carries; via_account_id is the connection the Page's own token is asked through
// at send time (no Page token is stored).
export const socialPages = sqliteTable("social_pages", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  app: text("app").notNull(),
  pageId: text("page_id").notNull(),
  key: text("key").notNull(),
  viaAccountId: text("via_account_id").notNull(),
  name: text("name"),
  pictureUrl: text("picture_url"),
  state: text("state", { enum: ["ok", "lost"] }).notNull().default("ok"),
  addedBy: text("added_by"),
  addedAt: ts("added_at").notNull(),
  checkedAt: ts("checked_at"),
}, (t) => [primaryKey({ columns: [t.orgId, t.app, t.pageId] }), uniqueIndex("social_pages_key_uq").on(t.orgId, t.key), index("social_pages_via_idx").on(t.orgId, t.viaAccountId)]);
// R110: Ask across the workspace (migration 0131). Private to each person; cards apply only on their click.
export const askThreads = sqliteTable("ask_threads", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [index("ask_threads_user_idx").on(t.orgId, t.userId, t.updatedAt)]);
export const askMessages = sqliteTable("ask_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => askThreads.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  sources: text("sources").notNull().default("[]"),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /** TD1 (0151): JSON { coverage, about } shown with the answer. Null on older answers. */
  meta: text("meta"),
}, (t) => [index("ask_messages_thread_idx").on(t.threadId, t.createdAt), index("ask_messages_user_idx").on(t.orgId, t.userId, t.createdAt)]);
export const askCards = sqliteTable("ask_cards", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => askMessages.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
  targetId: text("target_id"),
  payload: text("payload").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  resultId: text("result_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
}, (t) => [index("ask_cards_message_idx").on(t.messageId)]);
export const askPrompts = sqliteTable("ask_prompts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  text: text("text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [index("ask_prompts_user_idx").on(t.orgId, t.userId)]);

// R105: invoices and quotes. Money in integer cents; quantities in thousandths. See src/shared/invoices.ts.
const boolInt = (name: string) => integer(name, { mode: "boolean" });
export const invoiceSettings = sqliteTable("invoice_settings", {
  orgId: text("org_id").primaryKey(),
  businessName: text("business_name").notNull().default(""),
  abn: text("abn"),
  gstRegistered: boolInt("gst_registered").notNull().default(true),
  priceMode: text("price_mode", { enum: ["exclusive", "inclusive"] }).notNull().default("exclusive"),
  currency: text("currency").notNull().default("AUD"),
  termsDays: integer("terms_days").notNull().default(14),
  address: text("address"), email: text("email"), phone: text("phone"),
  bankName: text("bank_name"), bsb: text("bsb"), accountNumber: text("account_number"), accountName: text("account_name"),
  payNote: text("pay_note"), footer: text("footer"),
  prefixInvoice: text("prefix_invoice"), prefixQuote: text("prefix_quote"), prefixCredit: text("prefix_credit"),
  nextInvoice: integer("next_invoice").notNull().default(1),
  nextQuote: integer("next_quote").notNull().default(1),
  nextCreditNote: integer("next_credit_note").notNull().default(1),
  nextBill: integer("next_bill").notNull().default(1),
  remindBeforeDays: integer("remind_before_days").notNull().default(3),
  remindAfterDays: integer("remind_after_days").notNull().default(7),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
});
export const invoiceItems = sqliteTable("invoice_items", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  unitCents: integer("unit_cents").notNull().default(0),
  gstFree: boolInt("gst_free").notNull().default(false),
  archivedAt: ts("archived_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("invoice_items_org_idx").on(t.orgId, t.name)]);
export const invoiceSuppliers = sqliteTable("invoice_suppliers", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  abn: text("abn"), email: text("email"), phone: text("phone"),
  notes: text("notes").notNull().default(""),
  createdAt: createdAt(),
}, (t) => [index("invoice_suppliers_org_idx").on(t.orgId, t.name)]);
export const invoiceDocs = sqliteTable("invoice_docs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  kind: text("kind", { enum: ["quote", "invoice", "credit_note", "bill"] }).notNull(),
  seq: integer("seq"),
  number: text("number"),
  status: text("status", { enum: ["draft", "issued", "accepted", "declined", "void"] }).notNull().default("draft"),
  contactId: text("contact_id"), supplierId: text("supplier_id"), dealId: text("deal_id"),
  buyerName: text("buyer_name"), buyerEmail: text("buyer_email"), buyerAbn: text("buyer_abn"), buyerAddress: text("buyer_address"),
  issueDate: text("issue_date"), dueDate: text("due_date"),
  currency: text("currency").notNull().default("AUD"),
  priceMode: text("price_mode", { enum: ["exclusive", "inclusive"] }).notNull().default("exclusive"),
  gstRegistered: boolInt("gst_registered").notNull().default(true),
  subtotalCents: integer("subtotal_cents").notNull().default(0),
  gstCents: integer("gst_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),
  paidCents: integer("paid_cents").notNull().default(0),
  creditedCents: integer("credited_cents").notNull().default(0),
  reference: text("reference"), notes: text("notes"), terms: text("terms"),
  sourceId: text("source_id"), convertedId: text("converted_id"), repeatId: text("repeat_id"),
  viewToken: text("view_token"),
  sentAt: ts("sent_at"), viewedAt: ts("viewed_at"), answeredAt: ts("answered_at"),
  lastReminderAt: ts("last_reminder_at"), reminderCount: integer("reminder_count").notNull().default(0),
  voidedAt: ts("voided_at"), voidReason: text("void_reason"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("invoice_docs_number_uq").on(t.orgId, t.kind, t.seq).where(sql`${t.seq} IS NOT NULL`),
  uniqueIndex("invoice_docs_token_uq").on(t.viewToken).where(sql`${t.viewToken} IS NOT NULL`),
  index("invoice_docs_org_kind_idx").on(t.orgId, t.kind, t.createdAt),
  index("invoice_docs_contact_idx").on(t.orgId, t.contactId).where(sql`${t.contactId} IS NOT NULL`),
  index("invoice_docs_due_idx").on(t.kind, t.status, t.dueDate),
]);
export const invoiceLines = sqliteTable("invoice_lines", {
  id: text("id").primaryKey(),
  docId: text("doc_id").notNull(),
  orgId: text("org_id").notNull(),
  position: integer("position").notNull().default(0),
  itemId: text("item_id"),
  description: text("description").notNull().default(""),
  quantityMilli: integer("quantity_milli").notNull().default(1000),
  unitCents: integer("unit_cents").notNull().default(0),
  gstFree: boolInt("gst_free").notNull().default(false),
  netCents: integer("net_cents").notNull().default(0),
  gstCents: integer("gst_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),
}, (t) => [index("invoice_lines_doc_idx").on(t.docId, t.position)]);
export const invoicePayments = sqliteTable("invoice_payments", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  docId: text("doc_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  paidOn: text("paid_on").notNull(),
  method: text("method").notNull().default("bank"),
  reference: text("reference"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
}, (t) => [index("invoice_payments_doc_idx").on(t.docId), index("invoice_payments_org_idx").on(t.orgId, t.paidOn)]);
export const invoiceRepeats = sqliteTable("invoice_repeats", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  sourceId: text("source_id").notNull(),
  every: text("every", { enum: ["week", "fortnight", "month", "quarter", "year"] }).notNull(),
  anchorDay: integer("anchor_day").notNull(),
  nextRun: text("next_run").notNull(),
  endDate: text("end_date"),
  autoSend: boolInt("auto_send").notNull().default(false),
  active: boolInt("active").notNull().default(true),
  runs: integer("runs").notNull().default(0),
  lastDocId: text("last_doc_id"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
}, (t) => [index("invoice_repeats_due_idx").on(t.active, t.nextRun), index("invoice_repeats_org_idx").on(t.orgId)]);
/* R92 Booking plus: resources, time polls, free events with QR tickets, and the spam shield's spent challenges. */

/** A bookable room, desk, vehicle or piece of equipment with its booking rules. */
export const bookingResources = sqliteTable("booking_resources", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["room", "desk", "vehicle", "equipment"] }).notNull().default("room"),
  location: text("location").notNull().default(""),
  description: text("description").notNull().default(""),
  capacity: integer("capacity"),
  timezone: text("timezone").notNull(),
  /** JSON list of open days, e.g. ["mon","tue"]. */
  days: text("days").notNull(),
  openFrom: text("open_from").notNull().default("08:00"),
  openTo: text("open_to").notNull().default("18:00"),
  stepMin: integer("step_min").notNull().default(30),
  minMin: integer("min_min").notNull().default(30),
  maxMin: integer("max_min").notNull().default(240),
  /** Most minutes one member may hold in a week (Monday start), null for no limit. */
  quotaMinWeek: integer("quota_min_week"),
  needsApproval: integer("needs_approval", { mode: "boolean" }).notNull().default(false),
  checkinRequired: integer("checkin_required", { mode: "boolean" }).notNull().default(false),
  releaseAfterMin: integer("release_after_min").notNull().default(15),
  checkinKey: text("checkin_key").notNull(),
  createdBy: text("created_by").notNull(),
  archivedAt: ts("archived_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("booking_resources_org_idx").on(t.orgId)]);

export const resourceBookings = sqliteTable("resource_bookings", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  resourceId: text("resource_id").notNull().references(() => bookingResources.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  userName: text("user_name").notNull().default(""),
  title: text("title").notNull().default(""),
  startsAt: ts("starts_at").notNull(),
  endsAt: ts("ends_at").notNull(),
  status: text("status", { enum: ["pending", "confirmed", "declined", "cancelled", "released"] }).notNull().default("confirmed"),
  checkedInAt: ts("checked_in_at"),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  createdAt: createdAt(),
}, (t) => [index("resource_bookings_res_idx").on(t.resourceId, t.startsAt), index("resource_bookings_org_idx").on(t.orgId, t.status, t.startsAt), index("resource_bookings_user_idx").on(t.orgId, t.userId, t.startsAt)]);

/** A group time poll: guests vote on proposed times without an account; the host picks the winner. */
export const timePolls = sqliteTable("time_polls", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull(),
  token: text("token").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  location: text("location").notNull().default(""),
  durationMin: integer("duration_min").notNull().default(30),
  timezone: text("timezone").notNull(),
  video: integer("video", { mode: "boolean" }).notNull().default(true),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  winnerOptionId: text("winner_option_id"),
  meetingId: text("meeting_id"),
  deadlineAt: ts("deadline_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("time_polls_token_uq").on(t.token), index("time_polls_org_idx").on(t.orgId, t.createdAt)]);

export const timePollOptions = sqliteTable("time_poll_options", {
  id: text("id").primaryKey(),
  pollId: text("poll_id").notNull().references(() => timePolls.id, { onDelete: "cascade" }),
  startsAt: ts("starts_at").notNull(),
}, (t) => [index("time_poll_options_poll_idx").on(t.pollId, t.startsAt)]);

export const timePollVotes = sqliteTable("time_poll_votes", {
  id: text("id").primaryKey(),
  pollId: text("poll_id").notNull().references(() => timePolls.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull().default(""),
  /** JSON { optionId: "yes" | "maybe" | "no" }. */
  answers: text("answers").notNull(),
  editTokenHash: text("edit_token_hash").notNull(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("time_poll_votes_poll_idx").on(t.pollId, t.createdAt)]);

/** A free event with RSVP tickets, capacity and a waitlist. Paid tickets are held. */
export const bookingEvents = sqliteTable("booking_events", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  location: text("location").notNull().default(""),
  onlineUrl: text("online_url").notNull().default(""),
  startsAt: ts("starts_at").notNull(),
  endsAt: ts("ends_at").notNull(),
  timezone: text("timezone").notNull(),
  capacity: integer("capacity"),
  waitlist: integer("waitlist", { mode: "boolean" }).notNull().default(true),
  status: text("status", { enum: ["draft", "published", "cancelled"] }).notNull().default("draft"),
  goingCount: integer("going_count").notNull().default(0),
  waitlistCount: integer("waitlist_count").notNull().default(0),
  checkedInCount: integer("checked_in_count").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("booking_events_slug_uq").on(t.slug), index("booking_events_org_idx").on(t.orgId, t.startsAt)]);

export const eventTickets = sqliteTable("event_tickets", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => bookingEvents.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  status: text("status", { enum: ["going", "waitlist", "cancelled"] }).notNull(),
  codeHash: text("code_hash").notNull(),
  checkedInAt: ts("checked_in_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("event_tickets_email_uq").on(t.eventId, t.email), index("event_tickets_code_idx").on(t.eventId, t.codeHash), index("event_tickets_status_idx").on(t.eventId, t.status, t.createdAt)]);

/** Spam shield challenges already used once (kept until they expire). */
export const shieldSpent = sqliteTable("shield_spent", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
}, (t) => [index("shield_spent_exp_idx").on(t.expiresAt)]);

// R106: expenses and receipts (drizzle/0139_r106_expenses.sql).
export const expenseSettings = sqliteTable("expense_settings", {
  orgId: text("org_id").primaryKey(),
  receiptsToken: text("receipts_token"),
  approverIds: text("approver_ids").notNull().default("[]"),
  requireApproval: integer("require_approval", { mode: "boolean" }).notNull().default(true),
  updatedAt: ts("updated_at").notNull(),
});
export const expenses = sqliteTable("expenses", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  userName: text("user_name").notNull().default(""),
  status: text("status", { enum: ["draft", "submitted", "approved", "rejected"] }).notNull().default("draft"),
  supplier: text("supplier"), supplierAbn: text("supplier_abn"), spentOn: text("spent_on"),
  totalCents: integer("total_cents").notNull().default(0), gstCents: integer("gst_cents").notNull().default(0),
  currency: text("currency").notNull().default("AUD"), category: text("category"),
  gstClaimable: integer("gst_claimable", { mode: "boolean" }).notNull().default(false),
  reimbursable: integer("reimbursable", { mode: "boolean" }).notNull().default(true),
  note: text("note"),
  source: text("source", { enum: ["upload", "camera", "email"] }).notNull().default("upload"),
  fileKey: text("file_key"), fileParts: integer("file_parts").notNull().default(0), fileSize: integer("file_size").notNull().default(0),
  fileName: text("file_name"), fileType: text("file_type"),
  readState: text("read_state", { enum: ["none", "reading", "done", "failed", "unavailable"] }).notNull().default("none"),
  readToken: text("read_token"),
  readFields: text("read_fields").notNull().default("[]"),
  editedFields: text("edited_fields").notNull().default("[]"),
  splits: text("splits").notNull().default("[]"),
  every: text("every"),
  rebillDocId: text("rebill_doc_id"), rebillAt: ts("rebill_at"),
  decidedBy: text("decided_by"), decidedByName: text("decided_by_name"), decidedAt: ts("decided_at"), rejectReason: text("reject_reason"),
  submittedAt: ts("submitted_at"),
  createdAt: ts("created_at").notNull(), updatedAt: ts("updated_at").notNull(),
}, (t) => [index("expenses_org_user_idx").on(t.orgId, t.userId, t.createdAt), index("expenses_org_status_idx").on(t.orgId, t.status, t.createdAt), index("expenses_org_supplier_idx").on(t.orgId, t.supplier)]);

// ---------------------------------------------------------------- R125: tables (a doc type, kind "table")

/** R125: one row per table doc: who may edit, the next row number and the live row count (so a page never counts). */
export const docTables = sqliteTable("doc_tables", {
  docId: text("doc_id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  /** "everyone": every member edits; "admins": owners, admins and the creator edit, the rest view. */
  editAccess: text("edit_access", { enum: ["everyone", "admins"] }).notNull().default("everyone"),
  nextSeq: integer("next_seq").notNull().default(1),
  rowCount: integer("row_count").notNull().default(0),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at"),
}, (t) => [index("doc_tables_org_idx").on(t.orgId)]);

/** R125: a column. `config` is JSON (options, currency, link target, lookup, formula). The lowest position is the primary field. */
export const tableFields = sqliteTable("table_fields", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  docId: text("doc_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  config: text("config").notNull().default("{}"),
  position: real("position").notNull().default(0),
  width: integer("width"),
  createdAt: createdAt(),
  deletedAt: ts("deleted_at"),
}, (t) => [index("table_fields_doc_idx").on(t.orgId, t.docId, t.position)]);

/** R125: a row. `cells` is JSON keyed by field id; `search_text` is its text cells for the LK1 search. */
export const tableRows = sqliteTable("table_rows", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  docId: text("doc_id").notNull(),
  seq: integer("seq").notNull(),
  position: real("position").notNull(),
  cells: text("cells").notNull().default("{}"),
  searchText: text("search_text").notNull().default(""),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at"),
  deletedAt: ts("deleted_at"),
  version: integer("version").notNull().default(1),
}, (t) => [index("table_rows_doc_pos_idx").on(t.orgId, t.docId, t.position), index("table_rows_doc_seq_idx").on(t.orgId, t.docId, t.seq)]);

/** R125: a saved view (grid, kanban, calendar or form) with its settings as JSON. */
export const tableViews = sqliteTable("table_views", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  docId: text("doc_id").notNull(),
  name: text("name").notNull(),
  type: text("type", { enum: ["grid", "kanban", "calendar", "form"] }).notNull(),
  config: text("config").notNull().default("{}"),
  position: real("position").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: ts("updated_at"),
}, (t) => [index("table_views_doc_idx").on(t.orgId, t.docId, t.position)]);

/** R102 (DOC_INBOX_R102): one row per drive file read for Files > Documents. The text sits in the index database (doc_fts, rowid = id). */
export const docInbox = sqliteTable("doc_inbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: text("item_id").notNull(),
  orgId: text("org_id").notNull(),
  source: text("source", { enum: ["upload", "mail"] }).notNull().default("upload"),
  mailAttachmentId: text("mail_attachment_id"),
  addedBy: text("added_by").notNull(),
  status: text("status", { enum: ["queued", "reading", "done", "failed", "skipped"] }).notNull().default("queued"),
  jobId: text("job_id"),
  tries: integer("tries").notNull().default(0),
  versionId: text("version_id"),
  docType: text("doc_type"),
  sender: text("sender"),
  docDate: text("doc_date"),
  dueDate: text("due_date"),
  amount: integer("amount"),
  gst: integer("gst"),
  currency: text("currency").notNull().default("AUD"),
  paid: integer("paid").notNull().default(0),
  /** Comma separated fields a person corrected. */
  edited: text("edited").notNull().default(""),
  /** Comma separated rule ids that matched at the last read. */
  rules: text("rules").notNull().default(""),
  checked: integer("checked").notNull().default(0),
  chars: integer("chars").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  readAt: integer("read_at"),
}, (t) => [
  uniqueIndex("doc_inbox_item_uq").on(t.itemId),
  index("doc_inbox_org_status_idx").on(t.orgId, t.status),
  index("doc_inbox_org_created_idx").on(t.orgId, t.createdAt),
]);

/** R102: the workspace's matching rules for Files > Documents (admins write them). */
export const docRules = sqliteTable("doc_rules", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  match: text("match", { enum: ["any", "all", "exact", "regex", "fuzzy"] }).notNull(),
  pattern: text("pattern").notNull(),
  caseSensitive: integer("case_sensitive").notNull().default(0),
  setTags: text("set_tags").notNull().default(""),
  setSender: text("set_sender"),
  setType: text("set_type"),
  setFolderId: text("set_folder_id"),
  position: integer("position").notNull().default(0),
  enabled: integer("enabled").notNull().default(1),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("doc_rules_org_idx").on(t.orgId, t.position)]);

/** R102: documents read per workspace per UTC day ("*" = all workspaces). */
export const docInboxState = sqliteTable("doc_inbox_state", {
  orgId: text("org_id").primaryKey(),
  day: text("day").notNull(),
  n: integer("n").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});
// ---------------------------------------------------------------- R93 Forms plus (0142)

/** R93: one delivery of a form's own webhook (the last 20 per form are shown). */
export const formWebhookLog = sqliteTable("form_webhook_log", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  formId: text("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }),
  submissionId: text("submission_id"),
  ok: integer("ok", { mode: "boolean" }).notNull().default(false),
  httpStatus: integer("http_status"),
  error: text("error"),
  ms: integer("ms").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index("form_webhook_log_form_idx").on(t.formId, t.createdAt)]);

/** R93: a feedback board (public at /fb/<slug>, or members only). */
export const feedbackBoards = sqliteTable("feedback_boards", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  slug: text("slug").notNull(),
  isPublic: integer("is_public", { mode: "boolean" }).notNull().default(true),
  allowIdeas: integer("allow_ideas", { mode: "boolean" }).notNull().default(true),
  /** New ideas from visitors wait for approval. */
  moderate: integer("moderate", { mode: "boolean" }).notNull().default(true),
  createdBy: text("created_by").notNull(),
  archivedAt: ts("archived_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("feedback_boards_org_idx").on(t.orgId), uniqueIndex("feedback_boards_slug_uq").on(t.slug)]);

/** R93: an idea or request on a board. vote_count is kept on the row so lists sort without counting. */
export const feedbackPosts = sqliteTable("feedback_posts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  boardId: text("board_id").notNull().references(() => feedbackBoards.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  status: text("status", { enum: ["pending", "open", "review", "planned", "progress", "done", "closed", "merged"] }).notNull().default("open"),
  authorName: text("author_name").notNull().default(""),
  authorEmail: text("author_email"),
  authorUserId: text("author_user_id"),
  voteCount: integer("vote_count").notNull().default(0),
  mergedIntoId: text("merged_into_id"),
  ipHash: text("ip_hash"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("feedback_posts_board_idx").on(t.boardId, t.status, t.voteCount), index("feedback_posts_board_new_idx").on(t.boardId, t.createdAt)]);

/** R93: one vote per person per post (voter_key: u:<user id> or e:<hashed email>). */
export const feedbackVotes = sqliteTable("feedback_votes", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  boardId: text("board_id").notNull(),
  postId: text("post_id").notNull().references(() => feedbackPosts.id, { onDelete: "cascade" }),
  voterKey: text("voter_key").notNull(),
  voterName: text("voter_name").notNull().default(""),
  voterEmail: text("voter_email"),
  /** A hash of the token a public voter gets back, so only they can take the vote back. */
  tokenHash: text("token_hash"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("feedback_votes_post_voter_uq").on(t.postId, t.voterKey), index("feedback_votes_board_voter_idx").on(t.boardId, t.voterKey)]);

/** R93: a reviewer's assignment to one entry of a call for submissions, with their rubric scores. */
export const reviewAssignments = sqliteTable("review_assignments", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  formId: text("form_id").notNull(),
  submissionId: text("submission_id").notNull().references(() => formSubmissions.id, { onDelete: "cascade" }),
  reviewerId: text("reviewer_id").notNull(),
  status: text("status", { enum: ["pending", "done"] }).notNull().default("pending"),
  /** JSON { criterionId: score } */
  scores: text("scores").notNull().default("{}"),
  comment: text("comment").notNull().default(""),
  /** Weighted score out of 100. */
  total: real("total"),
  doneAt: ts("done_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("review_assignments_entry_reviewer_uq").on(t.submissionId, t.reviewerId), index("review_assignments_reviewer_idx").on(t.orgId, t.reviewerId, t.status), index("review_assignments_form_idx").on(t.formId)]);


// ---------------------------------------------------------------------------------------------------------------
// R123: Sites (page builder, comments, page view counts)
// ---------------------------------------------------------------------------------------------------------------
export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  commentsOn: integer("comments_on", { mode: "boolean" }).notNull().default(true),
  /** JSON array of user ids who may build, publish and moderate besides owners and admins. */
  editors: text("editors").notNull().default("[]"),
  homePageId: text("home_page_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("sites_slug_uq").on(t.slug), uniqueIndex("sites_org_uq").on(t.orgId)]);

export const sitePages = sqliteTable("site_pages", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  status: text("status", { enum: ["draft", "scheduled", "published"] }).notNull().default("draft"),
  draftBlocks: text("draft_blocks").notNull().default("[]"),
  seoTitle: text("seo_title").notNull().default(""),
  description: text("description").notNull().default(""),
  image: text("image").notNull().default(""),
  /** JSON snapshot visitors see now ({ title, blocks, seoTitle, description, image }); null when not public. */
  live: text("live"),
  /** JSON snapshot that goes live at publishAt. */
  next: text("next"),
  publishAt: integer("publish_at"),
  publishedAt: integer("published_at"),
  membersCanView: integer("members_can_view", { mode: "boolean" }).notNull().default(false),
  commentsOn: integer("comments_on", { mode: "boolean" }).notNull().default(true),
  hasUnpublished: integer("has_unpublished", { mode: "boolean" }).notNull().default(true),
  views: integer("views").notNull().default(0),
  position: integer("position").notNull().default(0),
  updatedBy: text("updated_by"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("site_pages_slug_uq").on(t.siteId, t.slug), index("site_pages_org_idx").on(t.orgId, t.position)]);

export const sitePageVersions = sqliteTable("site_page_versions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull().references(() => sitePages.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["saved", "published"] }).notNull().default("saved"),
  snapshot: text("snapshot").notNull(),
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("site_page_versions_page_idx").on(t.pageId, t.createdAt)]);

export const siteComments = sqliteTable("site_comments", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull().references(() => sitePages.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  body: text("body").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  /** A keyed hash of the sender for the per day limit; the address itself is never stored. */
  senderKey: text("sender_key").notNull(),
  moderatedBy: text("moderated_by"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("site_comments_page_idx").on(t.pageId, t.status, t.createdAt), index("site_comments_org_idx").on(t.orgId, t.status, t.createdAt), index("site_comments_sender_idx").on(t.senderKey, t.createdAt)]);

export const sitePageStats = sqliteTable("site_page_stats", {
  /** pageId:day:source:device */
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull().references(() => sitePages.id, { onDelete: "cascade" }),
  day: text("day").notNull(),
  source: text("source").notNull(),
  device: text("device").notNull(),
  views: integer("views").notNull().default(0),
}, (t) => [index("site_page_stats_org_idx").on(t.orgId, t.day)]);

// ---------------------------------------------------------------- R124: blog with newsletter (inside Sites, BLOG_R124)

/** R124: one blog per site. Subscribers live in the R109 audience list `listId`; post bodies are docs under `rootDocId`. */
export const siteBlogs = sqliteTable("site_blogs", {
  siteId: text("site_id").primaryKey().references(() => sites.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Blog"),
  description: text("description").notNull().default(""),
  listId: text("list_id"),
  rootDocId: text("root_doc_id"),
  subscribeOn: integer("subscribe_on", { mode: "boolean" }).notNull().default(true),
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("site_blogs_org_uq").on(t.orgId)]);

/** R124: a post. The body is the doc `docId`; publishing stores an escaped HTML snapshot (`liveHtml`) and its meta (`live`, JSON). */
export const blogPosts = sqliteTable("blog_posts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  docId: text("doc_id").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  excerpt: text("excerpt").notNull().default(""),
  cover: text("cover").notNull().default(""),
  /** JSON array of tag names. */
  tags: text("tags").notNull().default("[]"),
  authorId: text("author_id"),
  live: text("live"),
  liveHtml: text("live_html"),
  liveVersion: integer("live_version"),
  publishAt: integer("publish_at"),
  publishedAt: integer("published_at"),
  emailOnPublish: integer("email_on_publish", { mode: "boolean" }).notNull().default(false),
  campaignId: text("campaign_id"),
  emailedAt: integer("emailed_at"),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("blog_posts_slug_uq").on(t.siteId, t.slug), index("blog_posts_org_idx").on(t.orgId, t.updatedAt), index("blog_posts_live_idx").on(t.siteId, t.publishAt), index("blog_posts_doc_idx").on(t.docId)]);

/** R124: an author's public profile on a site (a workspace member). */
export const blogAuthors = sqliteTable("blog_authors", {
  siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  bio: text("bio").notNull().default(""),
  photo: text("photo").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.siteId, t.userId] }), uniqueIndex("blog_authors_slug_uq").on(t.siteId, t.slug)]);

/** R124: doc images a live post or an author profile shows; the public image route serves only these. */
export const blogImages = sqliteTable("blog_images", {
  siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  owner: text("owner").notNull(),
  imageId: text("image_id").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.siteId, t.owner, t.imageId] }), index("blog_images_image_idx").on(t.siteId, t.imageId)]);

// ---------------------------------------------------------------- R129: courses (a doc type, COURSES_R129)

/** R129: one per course doc (docs.kind "course"): its settings. Editors and managers are member user ids (JSON). */
export const docCourses = sqliteTable("doc_courses", {
  docId: text("doc_id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
  passMark: integer("pass_mark").notNull().default(80),
  certificate: integer("certificate", { mode: "boolean" }).notNull().default(true),
  editors: text("editors").notNull().default("[]"),
  managers: text("managers").notNull().default("[]"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at"),
}, (t) => [index("doc_courses_org_idx").on(t.orgId)]);

/** R129: a lesson. quiz holds the questions with the answer key (never sent to a learner). */
export const courseLessons = sqliteTable("course_lessons", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  docId: text("doc_id").notNull(),
  position: real("position").notNull().default(0),
  title: text("title").notNull(),
  type: text("type", { enum: ["page", "file", "video", "text", "quiz"] }).notNull(),
  refDocId: text("ref_doc_id"),
  url: text("url"),
  body: text("body").notNull().default(""),
  quiz: text("quiz").notNull().default("[]"),
  passMark: integer("pass_mark"),
  required: integer("required", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: ts("updated_at"),
  deletedAt: ts("deleted_at"),
}, (t) => [index("course_lessons_doc_idx").on(t.orgId, t.docId, t.position)]);

/** R129: a person taking a course (assigned, or started on their own). */
export const courseLearners = sqliteTable("course_learners", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  docId: text("doc_id").notNull(),
  userId: text("user_id").notNull(),
  source: text("source", { enum: ["assigned", "self"] }).notNull().default("self"),
  assignedBy: text("assigned_by"),
  dueAt: ts("due_at"),
  startedAt: ts("started_at"),
  completedAt: ts("completed_at"),
  certificateNo: text("certificate_no"),
  remindedSoonAt: ts("reminded_soon_at"),
  remindedOverdueAt: ts("reminded_overdue_at"),
  removedAt: ts("removed_at"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("course_learners_uq").on(t.orgId, t.docId, t.userId),
  index("course_learners_user_idx").on(t.orgId, t.userId),
  index("course_learners_due_idx").on(t.dueAt),
]);

/** R129: a learner's state on one lesson. */
export const courseProgress = sqliteTable("course_progress", {
  learnerId: text("learner_id").notNull(),
  lessonId: text("lesson_id").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  doneAt: ts("done_at"),
  score: integer("score"),
  bestScore: integer("best_score"),
  attempts: integer("attempts").notNull().default(0),
  attemptDay: text("attempt_day"),
  dayAttempts: integer("day_attempts").notNull().default(0),
  passed: integer("passed", { mode: "boolean" }).notNull().default(false),
  updatedAt: ts("updated_at"),
}, (t) => [primaryKey({ columns: [t.learnerId, t.lessonId] })]);

/** R131: a person's Home widgets layout (user_id '' = the workspace default an admin set). JSON in layout. */
export const homeLayouts = sqliteTable("home_layouts", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  layout: text("layout").notNull(),
  updatedAt: ts("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] })]);
/** R114: webinar mode on a meeting (registration, stage, chat setting, replay). */
export const webinars = sqliteTable("webinars", {
  meetingId: text("meeting_id").primaryKey(),
  orgId: text("org_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  registrationOpen: integer("registration_open", { mode: "boolean" }).notNull().default(true),
  /** The public registration page: /w/<slug>. */
  slug: text("slug").notNull(),
  chatMode: text("chat_mode", { enum: ["everyone", "hosts", "off"] }).notNull().default("everyone"),
  /** The R96 Q&A (chat_polls kind qa) attendees ask in. */
  qaPollId: text("qa_poll_id"),
  /** JSON [{ kind: "member" | "registrant", id, name }]: people on stage besides the hosts. */
  panelists: text("panelists").notNull().default("[]"),
  description: text("description").notNull().default(""),
  replayRecordingId: text("replay_recording_id"),
  replayShared: integer("replay_shared", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
}, (t) => [uniqueIndex("webinars_slug_uq").on(t.slug), index("webinars_org_idx").on(t.orgId)]);

/** R114: a person registered for a webinar. The personal join link's token is kept only as a hash. */
export const webinarRegistrations = sqliteTable("webinar_registrations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  meetingId: text("meeting_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailKey: text("email_key").notNull(),
  tokenHash: text("token_hash").notNull(),
  status: text("status", { enum: ["registered", "cancelled"] }).notNull().default("registered"),
  joinedAt: ts("joined_at"),
  lastSeenAt: ts("last_seen_at"),
  minutesWatched: integer("minutes_watched").notNull().default(0),
  createdAt: ts("created_at").notNull(),
}, (t) => [uniqueIndex("webinar_registrations_email_uq").on(t.meetingId, t.emailKey), uniqueIndex("webinar_registrations_token_uq").on(t.tokenHash)]);

/** R114: the webinar chat beside the stage (the host can hide a message or limit who chats). */
export const webinarChat = sqliteTable("webinar_chat", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  meetingId: text("meeting_id").notNull(),
  authorKind: text("author_kind", { enum: ["member", "registrant", "guest"] }).notNull(),
  authorId: text("author_id"),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  hiddenAt: ts("hidden_at"),
  createdAt: ts("created_at").notNull(),
}, (t) => [index("webinar_chat_meeting_idx").on(t.meetingId, t.id)]);

/** TD1 (0151): AI trust controls. One row per workspace once an admin decides; no row = off, unless the workspace saved its own AI key. */
export const aiTrust = sqliteTable("ai_trust", {
  orgId: text("org_id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  updatedBy: text("updated_by"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
/** R130: a workspace tour an admin built (steps JSON: target id, title, text). Draft until published. */
export const tours = sqliteTable("tours", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  page: text("page").notNull(),
  audience: text("audience", { enum: ["all", "admins", "members"] }).notNull().default("all"),
  newDays: integer("new_days"),
  status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
  steps: text("steps").notNull().default("[]"),
  createdById: text("created_by_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("tours_org_idx").on(t.orgId, t.status)]);

/** R130: one person's progress: key "checklist" (data JSON), "builtin:<id>" or a workspace tour id. */
export const tourProgress = sqliteTable("tour_progress", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  key: text("key").notNull(),
  state: text("state").notNull(),
  step: integer("step").notNull().default(0),
  data: text("data"),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId, t.key] })]);

// TD4 (0155): time to invoice. project_id '' is the workspace default row; rounding is minutes (0 = exact seconds).
export const billProjects = sqliteTable("bill_projects", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull(),
  contactId: text("contact_id"),
  currency: text("currency").notNull().default("AUD"),
  rateCents: integer("rate_cents"),
  rounding: integer("rounding").notNull().default(0),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.orgId, t.projectId] })]);
/** TD4: a person's rate on one project, or on every project when project_id is ''. */
export const billRates = sqliteTable("bill_rates", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull(),
  personId: text("person_id").notNull(),
  rateCents: integer("rate_cents").notNull(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.orgId, t.projectId, t.personId] })]);
/** TD4: one billing run: which time went onto which invoice; released when that invoice is deleted or voided. */
export const billRuns = sqliteTable("bill_runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull(),
  contactId: text("contact_id"),
  docId: text("doc_id").notNull(),
  dateFrom: text("date_from").notNull(),
  dateTo: text("date_to").notNull(),
  rounding: integer("rounding").notNull().default(0),
  entryCount: integer("entry_count").notNull().default(0),
  seconds: integer("seconds").notNull().default(0),
  amountCents: integer("amount_cents").notNull().default(0),
  currency: text("currency").notNull().default("AUD"),
  status: text("status", { enum: ["open", "released"] }).notNull().default("open"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  releasedAt: ts("released_at"),
  releasedBy: text("released_by"),
  releaseReason: text("release_reason"),
}, (t) => [index("bill_runs_org_idx").on(t.orgId, t.createdAt), index("bill_runs_doc_idx").on(t.orgId, t.docId)]);
/**
 * TD5 (0156): which text mentions which record. One row per (source, target); the source is the text that holds the
 * token (a chat message, a task description, a task or doc comment, a contact note) and parent is the record that text
 * lives on (the channel, task, doc or contact). No titles or text are stored. WITHOUT ROWID.
 */
export const recordRefs = sqliteTable("record_refs", {
  orgId: text("org_id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  parentType: text("parent_type"),
  parentId: text("parent_id"),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  createdBy: text("created_by"),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.sourceType, t.sourceId, t.targetType, t.targetId] }), index("record_refs_target_idx").on(t.orgId, t.targetType, t.targetId, t.createdAt), index("record_refs_parent_idx").on(t.orgId, t.parentType, t.parentId)]);

/** TD6 One inbox: a person's remembered Important or Noise choice for a sender (mail), a source record or an agent. */
export const inboxLaneRulesTd6 = sqliteTable("inbox_lane_rules_td6", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  lane: text("lane", { enum: ["important", "noise"] }).notNull(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId, t.key] })]);

/** TD6 One inbox: per person state of a mail, assistant or mention item (ids and state only; notifications keep their own). */
export const inboxItemStateTd6 = sqliteTable("inbox_item_state_td6", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["mail", "run", "ref"] }).notNull(),
  refId: text("ref_id").notNull(),
  /** null follows the source (mail: the message's own read flag), 1 read, 0 unread. */
  read: integer("read", { mode: "boolean" }),
  doneAt: ts("done_at"),
  snoozedUntil: ts("snoozed_until"),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId, t.kind, t.refId] })]);
// ---------------------------------------------------------------- TD7 Forms pro B (FORMS_TD7)

/** TD7: a form's brand kit, close date, response cap and save and resume settings; the password only as a hash. */
export const formProTd7 = sqliteTable("form_pro_td7", {
  formId: text("form_id").primaryKey(),
  orgId: text("org_id").notNull(),
  settings: text("settings").notNull().default("{}"),
  passwordHash: text("password_hash"),
  updatedAt: ts("updated_at").notNull(),
}, (t) => [index("form_pro_td7_org_idx").on(t.orgId)]);

/** TD7: a saved part of a form, opened again with a signed link until it expires. */
export const formPartialsTd7 = sqliteTable("form_partials_td7", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  formId: text("form_id").notNull(),
  answers: text("answers").notNull().default("{}"),
  answered: integer("answered").notNull().default(0),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
}, (t) => [index("form_partials_td7_form_idx").on(t.formId, t.updatedAt), index("form_partials_td7_exp_idx").on(t.expiresAt)]);

/** TD7: views, starts and completions per form per day. Counts only: no cookie, no visitor id. */
export const formStatsTd7 = sqliteTable("form_stats_td7", {
  formId: text("form_id").notNull(),
  day: text("day").notNull(),
  views: integer("views").notNull().default(0),
  starts: integer("starts").notNull().default(0),
  completions: integer("completions").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.formId, t.day] })]);

/** TD7: how many people reached each question (drop off per question). */
export const formReachTd7 = sqliteTable("form_reach_td7", {
  formId: text("form_id").notNull(),
  fieldId: text("field_id").notNull(),
  n: integer("n").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.formId, t.fieldId] })]);

/** TD10 (0161): a CRM change read from mail, waiting for a person to accept or discard it. Holds derived fields only, never message text. */
export const crmSuggestionsTd10 = sqliteTable("crm_suggestions_td10", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").notNull(),
  kind: text("kind", { enum: ["contact_details", "new_contact", "last_contacted", "next_step"] }).notNull(),
  targetType: text("target_type", { enum: ["contact", "deal", "email"] }).notNull(),
  targetId: text("target_id"),
  dedupeKey: text("dedupe_key").notNull(),
  fieldsJson: text("fields_json").notNull().default("{}"),
  messageId: text("message_id"),
  messageAt: integer("message_at", { mode: "timestamp_ms" }).notNull(),
  status: text("status", { enum: ["open", "accepted", "discarded"] }).notNull().default("open"),
  decidedBy: text("decided_by"),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [uniqueIndex("crm_suggestions_td10_key_uq").on(t.orgId, t.dedupeKey), index("crm_suggestions_td10_open_idx").on(t.orgId, t.status, t.messageAt)]);

/** TD10 (0161): when a person last checked mail for suggestions (one check a minute). */
export const crmScanTd10 = sqliteTable("crm_scan_td10", {
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  scannedAt: integer("scanned_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] })]);

/** TD10 (0161): a saved analysis made from a template, private or shared with the workspace. */
export const savedAnalysesTd10 = sqliteTable("saved_analyses_td10", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  template: text("template").notNull(),
  filtersJson: text("filters_json").notNull().default("{}"),
  shared: integer("shared", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
}, (t) => [index("saved_analyses_td10_org_idx").on(t.orgId, t.updatedAt)]);

/** TD10 (0161): per person preferences; shortcutsOff turns single key shortcuts off. */
export const userPrefsTd10 = sqliteTable("user_prefs_td10", {
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull(),
  shortcutsOff: integer("shortcuts_off", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.orgId] })]);
