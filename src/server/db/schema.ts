import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

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
  isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  /** Stripe's subscription status, mirrored by webhooks (active, trialing, past_due, canceled, ...). */
  subscriptionStatus: text("subscription_status"),
  currentPeriodEnd: ts("current_period_end"),
  cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("organizations_slug_uq").on(t.slug)]);

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
  status: text("status", { enum: ["received", "delivered", "forwarded", "queued", "sent", "failed", "rejected"] }).notNull(),
  provider: text("provider").notNull(),
  providerMessageId: text("provider_message_id"),
  detail: text("detail"),
  createdAt: createdAt(),
}, (t) => [index("deliveries_org_idx").on(t.orgId, t.createdAt)]);

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
  createdAt: createdAt(),
}, (t) => [index("audit_org_idx").on(t.orgId, t.createdAt)]);

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
