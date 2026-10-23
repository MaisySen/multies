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
}

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  orgId: string;
  role: "owner" | "admin" | "member";
  sessionId: string;
}

export interface AppEnv {
  Variables: { deps: Deps; auth: AuthContext; ip: string };
}
