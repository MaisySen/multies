import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

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
  /** How the Stripe subscription bills: "month", or "year" when add-ons total under A$5 a month. */
  billingInterval: text("billing_interval", { enum: ["month", "year"] }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("organizations_slug_uq").on(t.slug)]);

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
  verifiedAt: ts("verified_at"),
  catchAllMailboxId: text("catch_all_mailbox_id"),
  /** The outbound provider's id for this domain (Resend), once registered for sending and receiving. */
  providerDomainId: text("provider_domain_id"),
  /** JSON: the DNS records the provider asks for (DKIM, return path, receiving MX). */
  providerRecords: text("provider_records"),
  /** The provider's last word: its status ("verified", "pending"), or why registering failed. */
  providerStatus: text("provider_status"),
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
  createdAt: createdAt(),
}, (t) => [uniqueIndex("mailboxes_address_uq").on(t.address), index("mailboxes_org_idx").on(t.orgId)]);

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
  /** For a connected mailbox (mail_connections): which remote folder (a folder key: "inbox", "sent", "archive", "drafts", "spam", "trash" or "f:<path>") and IMAP UID the copy came from. A null UID means the copy is not tied to a provider folder right now (moved, or sent from Multies). */
  remoteBox: text("remote_box"),
  remoteUid: integer("remote_uid"),
  date: ts("date").notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("messages_mailbox_folder_idx").on(t.mailboxId, t.folder, t.date),
  index("messages_thread_idx").on(t.threadId),
  index("messages_org_idx").on(t.orgId),
  // Dedupe by Message-ID (connected mailbox sync, imports) and thread lookups by In-Reply-To.
  index("messages_mailbox_msgid_idx").on(t.mailboxId, t.messageIdHeader),
  index("messages_mailbox_provider_msgid_idx").on(t.mailboxId, t.providerMessageIdHeader),
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
}, (t) => [index("deliveries_org_idx").on(t.orgId, t.createdAt), index("deliveries_provider_msg_idx").on(t.providerMessageId)]);

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
}, (t) => [index("audit_org_idx").on(t.orgId, t.createdAt), index("audit_agent_idx").on(t.agentId, t.createdAt)]);

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

/** Processed billing webhooks, keyed by the provider's event id so retries are no-ops. */
export const billingEvents = sqliteTable("billing_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  orgId: text("org_id"),
  createdAt: createdAt(),
});

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
  /** `full` or `read`. */
  scope: text("scope", { enum: ["full", "read"] }).notNull().default("full"),
  /** An agent key acts only as this agent: its own inbox and the mailboxes it was given. */
  agentId: text("agent_id"),
  lastUsedAt: ts("last_used_at"),
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
  provider: text("provider", { enum: ["openai", "anthropic", "openrouter", "groq"] }).notNull(),
  model: text("model").notNull(),
  keyEnc: text("key_enc").notNull(),
  /** The last 4 characters, to show which key is saved. */
  keyHint: text("key_hint").notNull(),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
});

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
  status: text("status", { enum: ["active", "syncing", "auth_failed", "error", "paused"] }).notNull().default("active"),
  lastError: text("last_error"),
  lastSyncAt: ts("last_sync_at"),
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
  /** Next task number in this project. */
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
}, (t) => [index("project_statuses_project_idx").on(t.projectId, t.position)]);

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
  triageSource: text("triage_source", { enum: ["mail", "form", "api", "chat"] }),
  ...suiteCols(),
}, (t) => [
  index("tasks_org_project_idx").on(t.orgId, t.projectId, t.statusId, t.position),
  index("tasks_org_thread_idx").on(t.orgId, t.threadId),
  index("tasks_org_due_idx").on(t.orgId, t.dueAt),
  index("tasks_parent_idx").on(t.parentId),
  uniqueIndex("tasks_project_number_uq").on(t.projectId, t.number),
  uniqueIndex("tasks_org_import_key_uq").on(t.orgId, t.importKey).where(sql`${t.importKey} IS NOT NULL`),
  index("tasks_sprint_idx").on(t.sprintId).where(sql`${t.sprintId} IS NOT NULL`),
  index("tasks_org_triage_idx").on(t.orgId, t.createdAt).where(sql`${t.triageState} IS NOT NULL`),
]);

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
  view: text("view", { enum: ["board", "list", "calendar", "timeline", "sprints"] }).notNull().default("list"),
  /** JSON: { assignee?, status?, priority?, label?, due?, q? } */
  filters: text("filters").notNull().default("{}"),
  ...suiteCols(),
}, (t) => [index("saved_views_org_idx").on(t.orgId, t.projectId)]);

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
  ...suiteCols(),
}, (t) => [index("docs_org_idx").on(t.orgId, t.updatedAt)]);

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
}, (t) => [uniqueIndex("contacts_org_email_uq").on(t.orgId, t.email), index("contacts_org_last_idx").on(t.orgId, t.lastContactAt), index("contacts_company_idx").on(t.companyId)]);

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
  ...suiteCols(),
}, (t) => [index("deals_org_stage_idx").on(t.orgId, t.stage, t.position)]);

/** The glue: any item linked to any item (a doc to a task, a contact to a thread). */
export const entityLinks = sqliteTable("entity_links", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  fromType: text("from_type").notNull(),
  fromId: text("from_id").notNull(),
  toType: text("to_type").notNull(),
  toId: text("to_id").notNull(),
  relation: text("relation").notNull().default("related"),
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
}, (t) => [index("changes_org_seq_idx").on(t.orgId, t.seq)]);

/** Simple rules: when this happens, do that. No AI and no outside sends without approval. */
export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  trigger: text("trigger", { enum: ["email_received", "status_changed", "due_soon"] }).notNull(),
  /** JSON: email_received { from?, subjectContains?, mailboxId? }; status_changed { projectId?, toCategory? }; due_soon { hoursBefore } */
  conditions: text("conditions").notNull().default("{}"),
  action: text("action", { enum: ["create_task", "notify", "assign_thread"] }).notNull(),
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
  createdAt: createdAt(),
}, (t) => [index("notifications_user_idx").on(t.userId, t.orgId, t.createdAt)]);

/** Phones registered for push (Expo push tokens). Payloads carry only an event type and an id. */
export const pushDevices = sqliteTable("push_devices", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  platform: text("platform", { enum: ["ios", "android"] }).notNull(),
  createdAt: createdAt(),
  lastSeenAt: ts("last_seen_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("push_devices_org_idx").on(t.orgId), index("push_devices_user_idx").on(t.userId)]);


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
  ...suiteCols(),
}, (t) => [
  index("time_entries_org_person_idx").on(t.orgId, t.personId, t.startedAt),
  index("time_entries_org_project_idx").on(t.orgId, t.projectId, t.startedAt),
  index("time_entries_task_idx").on(t.taskId),
]);

/** A public form: each submission makes a task or a contact. */
export const forms = sqliteTable("forms", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** The public address: /f/<slug>. Random, so forms can't be guessed. */
  slug: text("slug").notNull(),
  target: text("target", { enum: ["task", "contact"] }).notNull().default("task"),
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
  createdAt: createdAt(),
}, (t) => [index("form_submissions_form_idx").on(t.formId, t.createdAt)]);

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
  /** A weekly RRULE without the "RRULE:" prefix (FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=10). Occurrences are expanded on read. */
  recurrence: text("recurrence"),
  /** The IANA zone the series keeps its wall clock time in. */
  recurrenceTz: text("recurrence_tz"),
  /** Round 23: the chat channel or DM a call was started from (its summary is posted there). */
  channelId: text("channel_id"),
  /** Round 23: the meeting's agenda and notes doc. */
  docId: text("doc_id"),
  ...suiteCols(),
}, (t) => [index("meetings_org_idx").on(t.orgId, t.startsAt), uniqueIndex("meetings_guest_token_uq").on(t.guestToken), index("meetings_source_idx").on(t.orgId, t.sourceType, t.sourceId)]);

/**
 * Custom fields per project. `options` holds the choices for single and multi select
 * fields as JSON [{ id, label, color }].
 */
export const customFields = sqliteTable("custom_fields", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type", { enum: ["text", "number", "currency", "date", "select", "multiselect", "person", "checkbox", "url"] }).notNull(),
  options: text("options").notNull().default("[]"),
  position: integer("position").notNull().default(0),
  ...suiteCols(),
}, (t) => [index("custom_fields_project_idx").on(t.projectId, t.position)]);

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
  deletedAt: ts("deleted_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("chat_messages_channel_idx").on(t.channelId, t.parentId, t.createdAt), index("chat_messages_updated_idx").on(t.channelId, t.updatedAt), index("chat_messages_parent_idx").on(t.parentId)]);

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
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.userId, t.orgId] })]);

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
}, (t) => [index("mail_schedules_due_idx").on(t.status, t.dueAt)]);

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
