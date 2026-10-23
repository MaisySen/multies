import type { DB } from "./db";
import type { AppConfig } from "./config";
import type { DnsResolver } from "./services/dns/resolver";
import type { OutboundProvider } from "./services/mail/outbound";

/** Everything the app needs from the outside world. Swapped wholesale in tests. */
export interface Deps {
  db: DB;
  config: AppConfig;
  dns: DnsResolver;
  outbound: OutboundProvider;
  now: () => Date;
  /** Outbound HTTP (Stripe, webhooks). Swapped for a fake in tests. */
  fetch: typeof fetch;
  /** Sends an unexpected error to error tracking (Sentry when a DSN is set). Returns the event id. */
  reportError?: (err: unknown, context?: Record<string, unknown>) => string | undefined;
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
}

export interface AppEnv {
  Variables: { deps: Deps; auth: AuthContext; ip: string };
}
