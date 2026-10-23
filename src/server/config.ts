import { z } from "zod";

/** Where a DNS lookup goes. `doh` works everywhere (incl. Workers); `node` uses the OS resolver. */
export type DnsResolverKind = "doh" | "node";

export interface AppConfig {
  /** `production` never seeds or fakes anything. `development` relaxes cookie security. */
  mode: "production" | "development";
  /** When true, visitors can open a sandbox workspace filled with sample data. */
  demoEnabled: boolean;
  appName: string;
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
  outbound: { driver: "log" | "resend"; resendApiKey?: string };
  /** Largest raw message accepted inbound, in bytes. */
  maxMessageBytes: number;
}

const csv = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  APP_MODE: z.enum(["production", "development"]).optional(),
  APP_NAME: z.string().optional(),
  APP_URL: z.string().url().optional(),
  APP_SECRET: z.string().optional(),
  DEMO_MODE: z.string().optional(),
  DNS_RESOLVER: z.enum(["doh", "node"]).optional(),
  MAIL_MX_HOSTS: z.string().optional(),
  MAIL_SPF_INCLUDES: z.string().optional(),
  MAIL_DKIM_SELECTOR: z.string().optional(),
  MAIL_DMARC_RUA: z.string().optional(),
  OUTBOUND_DRIVER: z.enum(["log", "resend"]).optional(),
  RESEND_API_KEY: z.string().optional(),
  MAX_MESSAGE_BYTES: z.string().optional(),
});

/** Cloudflare Email Routing's published MX hosts. */
export const CLOUDFLARE_MX = [
  { host: "route1.mx.cloudflare.net", priority: 10 },
  { host: "route2.mx.cloudflare.net", priority: 20 },
  { host: "route3.mx.cloudflare.net", priority: 30 },
];

export class ConfigError extends Error {}

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
    appName: env.APP_NAME ?? "MyMail",
    appUrl: (env.APP_URL ?? "http://localhost:5173").replace(/\/$/, ""),
    appSecret: secret || "dev-only-insecure-secret-change-me-0000000000",
    dnsResolver: env.DNS_RESOLVER ?? "doh",
    mail: {
      mxHosts,
      spfIncludes,
      dkimSelector: env.MAIL_DKIM_SELECTOR ?? "mymail",
      dmarcRua: env.MAIL_DMARC_RUA,
    },
    outbound: { driver: outboundDriver, resendApiKey: env.RESEND_API_KEY },
    maxMessageBytes: env.MAX_MESSAGE_BYTES ? Number(env.MAX_MESSAGE_BYTES) : 10 * 1024 * 1024,
  };
}
