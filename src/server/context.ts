import type { DB } from "./db";
import type { AppConfig } from "./config";
import type { DnsResolver } from "./services/dns/resolver";
import type { OutboundProvider } from "./services/mail/outbound";

/** Everything the app needs from the outside world. Swapped wholesale in tests. */
export interface Deps {
  db: DB;
  /** When set, recordWrite collects activity and change rows here and the caller writes them in one batch (bulk seeds). */
  writeBuffer?: { activity: unknown[]; changes: unknown[] };
  config: AppConfig;
  dns: DnsResolver;
  outbound: OutboundProvider;
  now: () => Date;
  /** Outbound HTTP (Stripe, webhooks). Swapped for a fake in tests. */
  fetch: typeof fetch;
  /** Sends an unexpected error to error tracking (Sentry when a DSN is set). Returns the event id. */
  reportError?: (err: unknown, context?: Record<string, unknown>) => string | undefined;
  /**
   * Verifies SPF, DKIM and DMARC on inbound mail (mailauth, Node only). Without it the
   * verdicts the receiving MTA wrote into the message are used.
   */
  /**
   * Cloudflare rate limiting bindings, when the deployment declares them. Without one
   * the limiter falls back to a counter in the database, shared by every instance.
   */
  rateLimiters?: Partial<Record<RateLimitScope, RateLimitBinding | undefined>>;
  /** Structured logger (JSON lines). Defaults to console. */
  log?: Logger;
  /** S3 compatible storage for large attachments (BODY_STORE_*). */
  bodyStore?: import("./services/storage/body-store").BodyStore;
  authenticate?: (raw: Uint8Array, ctx: { sender?: string; ip?: string; helo?: string }) => Promise<{ results: import("@/shared/mail").AuthResults; header: string }>;
}

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  orgId: string;
  role: "owner" | "admin" | "member";
  sessionId: string;
  emailVerified?: boolean;
  twoFactor?: boolean;
  /** Platform-level role (Better Auth admin plugin): "admin" for operators. */
  platformRole?: string;
  /** How this session signed in ("email" or an SSO provider id). */
  loginMethod?: string;
  /** The workspace requires SSO and this session did not use it. */
  ssoBlocked?: boolean;
}

export interface AppEnv {
  Variables: { deps: Deps; auth: AuthContext; ip: string; requestId: string; log: Logger; apiKeyOrg?: string };
}

export type RateLimitScope = "auth" | "api" | "webhooks" | "app";

/** The shape of a Cloudflare Workers rate limiting binding. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
