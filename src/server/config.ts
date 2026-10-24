import { z } from "zod";

/** Where a DNS lookup goes. `doh` works everywhere (incl. Workers); `node` uses the OS resolver. */
export type DnsResolverKind = "doh" | "node";

export interface AppConfig {
  /** `production` never seeds or fakes anything. `development` relaxes cookie security. */
  mode: "production" | "development";
  /** When true, visitors can open a sandbox workspace filled with sample data. */
  demoEnabled: boolean;
  /** Public booking pages and the scheduling API (SCHEDULING_ENABLED=true). Off unless set. */
  schedulingEnabled: boolean;
  appName: string;
  /** Where people reach support (support page, store listings). SUPPORT_EMAIL. */
  supportEmail: string;
  /** Cloudflare Web Analytics beacon token (cookieless). Unset means no analytics. */
  cfBeaconToken: string | null;
  appUrl: string;
  /** Root secret for at-rest encryption. Must be long and random in production. */
  appSecret: string;
  dnsResolver: DnsResolverKind;
  mail: {
    /** MX records customers must publish, e.g. Cloudflare Email Routing's hosts. */
    mxHosts: { host: string; priority: number }[];
    /** SPF `include:` mechanisms customers must publish. */
    spfIncludes: string[];
    dkimSelector: string;
    /** Optional mailbox for DMARC aggregate reports; defaults to dmarc@<domain>. */
    dmarcRua?: string;
  };
  /** `resendWebhookSecret` verifies delivery, bounce and complaint events from Resend. */
  outbound: { driver: "log" | "resend"; resendApiKey?: string; resendWebhookSecret?: string };
  /** Sign-in options beyond email + password. Each turns on when its keys are set. */
  auth: {
    social: { google?: { clientId: string; clientSecret: string }; github?: { clientId: string; clientSecret: string } };
    /** The identity provider for people (OIDC, Universal Login). `nativeClientId` is the mobile app's public client. */
    auth0?: { domain: string; clientId: string; clientSecret: string; nativeClientId?: string };
    /**
     * The app's own email and password form. Off by default once the identity provider is
     * configured (sign up, reset and verification then happen there); on for self host and
     * Node deployments without it. AUTH_LOCAL_PASSWORD=on|off overrides.
     */
    localPassword: boolean;
    /** Believe X-Forwarded-For and X-Real-IP for client addresses (self host behind a known proxy). */
    trustProxy: boolean;
    /** Refuse passwords found in known breaches (Have I Been Pwned, k-anonymity). */
    breachCheck: boolean;
  };
  /** Error tracking and tracing. Each side turns on when its DSN is set. */
  sentry: { dsnApi?: string; dsnWeb?: string; environment: string; tracesSampleRate: number };
  /** Release id (the git commit) reported to Sentry and in logs and /api/health. */
  release: string;
  /** RFC 9116 contact for vulnerability reports (a mailto: or https: URI). */
  securityContact: string;
  /** Other deployments this one probes on its schedule (base URLs). */
  monitorUrls: string[];
  /** Days a workspace keeps its paid plan after a failed payment before it is restricted. */
  billingGraceDays: number;
  /** User ids or verified emails that get platform admin (operator console) on sign-in. */
  platformAdmins: string[];
  /** Demo workspaces the daily purge keeps (the fixed App Review account). KEEP_DEMO_ORG_IDS. */
  keepDemoOrgIds: string[];
  /** New demo workspaces allowed per rolling 24 hours, platform wide (DEMO_DAILY_LIMIT); 0 means no cap. */
  demoDailyLimit: number;
  /** Stripe billing. `enabled` only when every key below is set. */
  billing: {
    enabled: boolean;
    testMode: boolean;
    publishableKey?: string;
    stripeSecretKey?: string;
    stripeWebhookSecret?: string;
    prices: { pro?: string; business?: string };
    /** Which settings are missing, for the "billing not connected" screen. */
    missing: string[];
  };
  /** Sender of account emails (invites, password resets, verification). */
  systemFrom: { address: string; name: string };
  /** Largest raw message accepted inbound, in bytes. */
  maxMessageBytes: number;
  /**
   * The mail server (Stalwart) that gives mail apps IMAP and SMTP access. `enabled`
   * when STALWART_URL and its provisioner login are set.
   */
  /** Agent inboxes. `sharedDomain` hosts inboxes for workspaces with no domain yet (AGENT_MAIL_DOMAIN). */
  agents: { sharedDomain?: string };
  /** Push to phones through Expo (PUSH_ENABLED=1, optional EXPO_ACCESS_TOKEN). Off by default. */
  push: { enabled: boolean; expoAccessToken?: string };
  /** An S3 compatible bucket for large message parts (BODY_STORE_ENDPOINT, _BUCKET, _REGION, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY). */
  bodyStore?: { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };
  /** Mail import runners authenticate with this (IMPORT_RUNNER_TOKEN). Import is off without it. */
  importRunnerToken?: string;
  /** Xero, for invoice reminders (XERO_CLIENT_ID, XERO_CLIENT_SECRET). Off without both. */
  xero?: { clientId: string; clientSecret: string };
  /** Video meetings through LiveKit (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET). Off without all three. */
  meetings?: { url: string; apiKey: string; apiSecret: string };
  /** Cloudflare Turnstile on public forms (TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY). Without it, forms use a honeypot and rate limits. */
  turnstile?: { siteKey: string; secretKey: string };
  mailServer: {
    enabled: boolean;
    url?: string;
    adminUser?: string;
    adminSecret?: string;
    /** What people type into their mail app as the server name. */
    clientHost: string;
    imapPort: number;
    smtpPort: number;
    smtpSecurity: "ssl" | "starttls";
    missing: string[];
  };
}

const csv = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  APP_MODE: z.enum(["production", "development"]).optional(),
  APP_NAME: z.string().optional(),
  SUPPORT_EMAIL: z.string().email().optional(),
  APP_URL: z.string().url().optional(),
  APP_SECRET: z.string().optional(),
  DEMO_MODE: z.string().optional(),
  SCHEDULING_ENABLED: z.string().optional(),
  DNS_RESOLVER: z.enum(["doh", "node"]).optional(),
  MAIL_MX_HOSTS: z.string().optional(),
  MAIL_SPF_INCLUDES: z.string().optional(),
  MAIL_DKIM_SELECTOR: z.string().optional(),
  MAIL_DMARC_RUA: z.string().optional(),
  OUTBOUND_DRIVER: z.enum(["log", "resend"]).optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  MAX_MESSAGE_BYTES: z.string().optional(),
  SYSTEM_FROM: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  AUTH0_DOMAIN: z.string().optional(),
  AUTH0_CLIENT_ID: z.string().optional(),
  AUTH0_CLIENT_SECRET: z.string().optional(),
  AUTH0_NATIVE_CLIENT_ID: z.string().optional(),
  AUTH_LOCAL_PASSWORD: z.enum(["on", "off", "true", "false"]).optional(),
  TRUST_PROXY: z.string().optional(),
  PASSWORD_BREACH_CHECK: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  SENTRY_DSN_API: z.string().optional(),
  SENTRY_DSN_WEB: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  PLATFORM_ADMIN_EMAILS: z.string().optional(),
  KEEP_DEMO_ORG_IDS: z.string().optional(),
  DEMO_DAILY_LIMIT: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  PUSH_ENABLED: z.string().optional(),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),
  SYSTEM_FROM_NAME: z.string().optional(),
  STALWART_URL: z.string().url().optional(),
  STALWART_ADMIN_USER: z.string().optional(),
  STALWART_ADMIN_SECRET: z.string().optional(),
  MAIL_CLIENT_HOST: z.string().optional(),
  MAIL_IMAP_PORT: z.string().optional(),
  MAIL_SMTP_PORT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.string().optional(),
  RELEASE: z.string().optional(),
  CF_BEACON_TOKEN: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SECURITY_CONTACT: z.string().regex(/^(mailto:|https:\/\/)/, "SECURITY_CONTACT must be a mailto: or https: URI").optional(),
  BILLING_GRACE_DAYS: z.string().regex(/^\d+$/).optional(),
  MONITOR_URLS: z.string().optional(),
  BODY_STORE_ENDPOINT: z.string().url().optional(),
  BODY_STORE_BUCKET: z.string().optional(),
  BODY_STORE_REGION: z.string().optional(),
  BODY_STORE_ACCESS_KEY_ID: z.string().optional(),
  BODY_STORE_SECRET_ACCESS_KEY: z.string().optional(),
  IMPORT_RUNNER_TOKEN: z.string().min(24).optional(),
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  AGENT_MAIL_DOMAIN: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i).optional(),
  LIVEKIT_URL: z.string().regex(/^(wss|https):\/\//).optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
});

/** Cloudflare Email Routing's published MX hosts. */
export const CLOUDFLARE_MX = [
  { host: "route1.mx.cloudflare.net", priority: 10 },
  { host: "route2.mx.cloudflare.net", priority: 20 },
  { host: "route3.mx.cloudflare.net", priority: 30 },
];

export class ConfigError extends Error {}

function hostOf(url: string): string {
  try { return new URL(url).hostname || "localhost"; } catch { return "localhost"; }
}

/** Builds config from a plain env object (process.env on Node, bindings on Workers). */
export function loadConfig(raw: Record<string, string | undefined>): AppConfig {
  const env = EnvSchema.parse(raw);
  const mode = env.APP_MODE ?? (env.NODE_ENV === "production" ? "production" : "development");
  const secret = env.APP_SECRET ?? "";
  if (mode === "production" && secret.length < 32) {
    throw new ConfigError("APP_SECRET must be set to at least 32 random characters in production.");
  }
  const outboundDriver = env.OUTBOUND_DRIVER ?? (env.RESEND_API_KEY ? "resend" : "log");
  if (outboundDriver === "resend" && !env.RESEND_API_KEY) {
    throw new ConfigError("OUTBOUND_DRIVER=resend requires RESEND_API_KEY.");
  }
  const mxHosts = env.MAIL_MX_HOSTS
    ? csv(env.MAIL_MX_HOSTS).map((entry, i) => {
        const [host, prio] = entry.split(":");
        return { host: host.toLowerCase(), priority: prio ? Number(prio) : (i + 1) * 10 };
      })
    : CLOUDFLARE_MX;
  const spfIncludes = env.MAIL_SPF_INCLUDES
    ? csv(env.MAIL_SPF_INCLUDES)
    : ["_spf.mx.cloudflare.net", ...(outboundDriver === "resend" ? ["amazonses.com"] : [])];
  return {
    mode,
    demoEnabled: env.DEMO_MODE === "true" || env.DEMO_MODE === "1",
    schedulingEnabled: env.SCHEDULING_ENABLED === "true" || env.SCHEDULING_ENABLED === "1",
    appName: env.APP_NAME ?? "Multies",
    supportEmail: env.SUPPORT_EMAIL?.trim() || "support@mymail.au",
    cfBeaconToken: /^[a-f0-9]{32}$/i.test(env.CF_BEACON_TOKEN?.trim() ?? "") ? env.CF_BEACON_TOKEN!.trim() : null,
    appUrl: (env.APP_URL ?? "http://localhost:5173").replace(/\/$/, ""),
    appSecret: secret || "dev-only-insecure-secret-change-me-0000000000",
    dnsResolver: env.DNS_RESOLVER ?? "doh",
    mail: {
      mxHosts,
      spfIncludes,
      dkimSelector: env.MAIL_DKIM_SELECTOR ?? "mymail",
      dmarcRua: env.MAIL_DMARC_RUA,
    },
    outbound: { driver: outboundDriver, resendApiKey: env.RESEND_API_KEY, resendWebhookSecret: env.RESEND_WEBHOOK_SECRET },
    auth: {
      social: {
        ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
        ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } } : {}),
      },
      ...(env.AUTH0_DOMAIN && env.AUTH0_CLIENT_ID && env.AUTH0_CLIENT_SECRET
        ? { auth0: { domain: env.AUTH0_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, ""), clientId: env.AUTH0_CLIENT_ID, clientSecret: env.AUTH0_CLIENT_SECRET, ...(env.AUTH0_NATIVE_CLIENT_ID ? { nativeClientId: env.AUTH0_NATIVE_CLIENT_ID } : {}) } } : {}),
      trustProxy: env.TRUST_PROXY === "true" || env.TRUST_PROXY === "1",
      localPassword: resolveLocalPassword(env.AUTH_LOCAL_PASSWORD, !!(env.AUTH0_DOMAIN && env.AUTH0_CLIENT_ID && env.AUTH0_CLIENT_SECRET)),
      breachCheck: env.PASSWORD_BREACH_CHECK ? env.PASSWORD_BREACH_CHECK === "true" : mode === "production",
    },
    sentry: {
      dsnApi: env.SENTRY_DSN_API, dsnWeb: env.SENTRY_DSN_WEB, environment: env.SENTRY_ENVIRONMENT ?? mode,
      tracesSampleRate: clampRate(env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
    },
    release: env.RELEASE ?? env.SENTRY_RELEASE ?? "dev",
    securityContact: env.SECURITY_CONTACT ?? `mailto:security@${hostOf(env.APP_URL ?? "http://localhost")}`,
    monitorUrls: csv(env.MONITOR_URLS).filter((u) => /^https?:\/\//.test(u)),
    billingGraceDays: Math.max(0, Math.min(60, Number(env.BILLING_GRACE_DAYS ?? 7) || 7)),
    platformAdmins: csv(env.PLATFORM_ADMIN_EMAILS).map((e) => e.toLowerCase()),
    keepDemoOrgIds: csv(env.KEEP_DEMO_ORG_IDS),
    demoDailyLimit: Math.max(0, Number.parseInt(env.DEMO_DAILY_LIMIT ?? "0", 10) || 0),
    billing: {
      // Only the secret key is required. Prices are found by lookup key (and created in
      // test mode); the webhook secret adds server-to-server sync on top of the
      // checkout return.
      enabled: !!env.STRIPE_SECRET_KEY,
      testMode: /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? ""),
      stripeSecretKey: env.STRIPE_SECRET_KEY, stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY,
      prices: { pro: env.STRIPE_PRICE_PRO, business: env.STRIPE_PRICE_BUSINESS },
      missing: env.STRIPE_SECRET_KEY ? [] : ["STRIPE_SECRET_KEY"],
    },
    systemFrom: {
      address: (env.SYSTEM_FROM ?? `no-reply@${hostOf(env.APP_URL ?? "http://localhost")}`).toLowerCase(),
      name: env.SYSTEM_FROM_NAME ?? env.APP_NAME ?? "Multies",
    },
    agents: { sharedDomain: env.AGENT_MAIL_DOMAIN?.toLowerCase() },
    push: { enabled: env.PUSH_ENABLED === "1" || env.PUSH_ENABLED === "true", expoAccessToken: env.EXPO_ACCESS_TOKEN || undefined },
    importRunnerToken: env.IMPORT_RUNNER_TOKEN,
    bodyStore: env.BODY_STORE_ENDPOINT && env.BODY_STORE_BUCKET && env.BODY_STORE_ACCESS_KEY_ID && env.BODY_STORE_SECRET_ACCESS_KEY
      ? { endpoint: env.BODY_STORE_ENDPOINT, bucket: env.BODY_STORE_BUCKET, region: env.BODY_STORE_REGION ?? "auto", accessKeyId: env.BODY_STORE_ACCESS_KEY_ID, secretAccessKey: env.BODY_STORE_SECRET_ACCESS_KEY }
      : undefined,
    meetings: env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET ? { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET } : undefined,
    turnstile: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? { siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY } : undefined,
    xero: env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET ? { clientId: env.XERO_CLIENT_ID, clientSecret: env.XERO_CLIENT_SECRET } : undefined,
    maxMessageBytes: env.MAX_MESSAGE_BYTES ? Number(env.MAX_MESSAGE_BYTES) : 10 * 1024 * 1024,
    mailServer: (() => {
      const missing = (["STALWART_URL", "STALWART_ADMIN_USER", "STALWART_ADMIN_SECRET"] as const).filter((k) => !env[k]);
      const smtpPort = env.MAIL_SMTP_PORT ? Number(env.MAIL_SMTP_PORT) : 465;
      return {
        enabled: missing.length === 0,
        url: env.STALWART_URL?.replace(/\/$/, ""),
        adminUser: env.STALWART_ADMIN_USER,
        adminSecret: env.STALWART_ADMIN_SECRET,
        clientHost: env.MAIL_CLIENT_HOST ?? (env.STALWART_URL ? hostOf(env.STALWART_URL) : `mail.${hostOf(env.APP_URL ?? "http://localhost")}`),
        imapPort: env.MAIL_IMAP_PORT ? Number(env.MAIL_IMAP_PORT) : 993,
        smtpPort,
        smtpSecurity: smtpPort === 465 ? "ssl" as const : "starttls" as const,
        missing,
      };
    })(),
  };
}

function clampRate(v: string | undefined, fallback: number): number {
  const n = v === undefined ? fallback : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** AUTH_LOCAL_PASSWORD wins; otherwise the password form is on only when there is no identity provider. */
export function resolveLocalPassword(flag: string | undefined, idpConfigured: boolean): boolean {
  if (flag === "on" || flag === "true") return true;
  if (flag === "off" || flag === "false") return false;
  return !idpConfigured;
}
