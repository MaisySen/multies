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
  date: ts("date").notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("messages_mailbox_folder_idx").on(t.mailboxId, t.folder, t.date),
  index("messages_thread_idx").on(t.threadId),
  index("messages_org_idx").on(t.orgId),
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
  /** `always`: a person approves every send. `external`: only mail leaving MyMail. `never`: sends go straight out. */
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
 * The workspace's own AI provider key ("bring your own AI"). MyMail never pays for model
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
  ...suiteCols(),
}, (t) => [
  index("tasks_org_project_idx").on(t.orgId, t.projectId, t.statusId, t.position),
  index("tasks_org_thread_idx").on(t.orgId, t.threadId),
  index("tasks_org_due_idx").on(t.orgId, t.dueAt),
  index("tasks_parent_idx").on(t.parentId),
  uniqueIndex("tasks_project_number_uq").on(t.projectId, t.number),
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
  view: text("view", { enum: ["board", "list", "calendar", "timeline"] }).notNull().default("list"),
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
}, (t) => [index("companies_org_idx").on(t.orgId), uniqueIndex("companies_org_domain_uq").on(t.orgId, t.domain)]);

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
  action: text("action", { enum: ["create_task", "notify"] }).notNull(),
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
