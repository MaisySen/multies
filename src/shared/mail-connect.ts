/**
 * Connecting an existing mailbox (round 18): the provider presets the web app and the server share.
 *
 * Each preset names the IMAP and SMTP servers, where the person makes an app password, and
 * whether the provider files a copy of mail sent over SMTP in its own Sent folder by itself
 * (Gmail and Microsoft do; the others get a copy added with IMAP APPEND after sending).
 * Server names were checked against each provider's own help pages on 25 October 2026.
 */

export type ConnectSecurity = "tls" | "starttls";

export interface ServerSettings {
  host: string;
  port: number;
  security: ConnectSecurity;
}

export type ConnectPresetId =
  | "gmail" | "google_workspace" | "outlook" | "microsoft365" | "yahoo" | "icloud" | "zoho" | "fastmail" | "gmx" | "custom";

export interface ConnectPreset {
  id: ConnectPresetId;
  label: string;
  imap: ServerSettings;
  smtp: ServerSettings;
  /** The provider saves a copy of SMTP mail in Sent by itself. */
  savesSent: boolean;
  /** Where the person makes an app password, when the provider has a page for it. */
  appPasswordUrl?: string;
  /** Short steps shown next to the password field. */
  help: string;
  /** The provider mostly wants its own sign in (OAuth) now; an app password works only on some accounts. */
  oauthPreferred?: boolean;
}

const tls = (host: string, port = 993): ServerSettings => ({ host, port, security: "tls" });
const starttls = (host: string, port = 587): ServerSettings => ({ host, port, security: "starttls" });

export const CONNECT_PRESETS: Record<ConnectPresetId, ConnectPreset> = {
  gmail: {
    id: "gmail", label: "Gmail", imap: tls("imap.gmail.com"), smtp: tls("smtp.gmail.com", 465), savesSent: true,
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    help: "Gmail needs an app password, not your normal password. Turn on 2-Step Verification in your Google Account, then create an app password and paste it here.",
  },
  google_workspace: {
    id: "google_workspace", label: "Google Workspace", imap: tls("imap.gmail.com"), smtp: tls("smtp.gmail.com", 465), savesSent: true,
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    help: "Use an app password from your Google Account. If you can't make one, your Workspace admin has to allow 2-Step Verification and IMAP for your account.",
  },
  outlook: {
    id: "outlook", label: "Outlook.com or Hotmail", imap: tls("outlook.office365.com"), smtp: starttls("smtp-mail.outlook.com"), savesSent: true,
    appPasswordUrl: "https://account.microsoft.com/security", oauthPreferred: true,
    help: "Turn on two-step verification, then create an app password under Advanced security options. Microsoft has switched most accounts to its own sign in, so an app password may be refused.",
  },
  microsoft365: {
    id: "microsoft365", label: "Microsoft 365 (work or school)", imap: tls("outlook.office365.com"), smtp: starttls("smtp.office365.com"), savesSent: true,
    appPasswordUrl: "https://mysignins.microsoft.com/security-info", oauthPreferred: true,
    help: "Your admin has to allow IMAP and authenticated SMTP for your account. Most Microsoft 365 workspaces need Microsoft's own sign in instead of a password.",
  },
  yahoo: {
    id: "yahoo", label: "Yahoo Mail", imap: tls("imap.mail.yahoo.com"), smtp: tls("smtp.mail.yahoo.com", 465), savesSent: false,
    appPasswordUrl: "https://login.yahoo.com/account/security",
    help: "Yahoo needs an app password. Open Account security, choose Generate app password, and paste it here.",
  },
  icloud: {
    id: "icloud", label: "iCloud Mail", imap: tls("imap.mail.me.com"), smtp: starttls("smtp.mail.me.com"), savesSent: false,
    appPasswordUrl: "https://account.apple.com/account/manage",
    help: "iCloud needs an app specific password. Sign in to your Apple Account, open Sign-In and Security, then App-Specific Passwords.",
  },
  zoho: {
    id: "zoho", label: "Zoho Mail", imap: tls("imap.zoho.com"), smtp: tls("smtp.zoho.com", 465), savesSent: false,
    appPasswordUrl: "https://accounts.zoho.com/home#security/app_password",
    help: "Turn on IMAP access in Zoho Mail settings, then make an app password. Accounts in the EU, India or Australia use imap.zoho.eu, imap.zoho.in or imap.zoho.com.au: pick Other server and enter those.",
  },
  fastmail: {
    id: "fastmail", label: "Fastmail", imap: tls("imap.fastmail.com"), smtp: tls("smtp.fastmail.com", 465), savesSent: false,
    appPasswordUrl: "https://app.fastmail.com/settings/security/apps",
    help: "Create an app password in Settings, Privacy and Security, with access to IMAP and SMTP.",
  },
  gmx: {
    id: "gmx", label: "GMX", imap: tls("imap.gmx.com"), smtp: starttls("mail.gmx.com"), savesSent: false,
    help: "Turn on POP3 and IMAP access in your GMX settings first, then use your GMX password. Addresses on gmx.net, gmx.de, gmx.at and gmx.ch use the gmx.net servers, picked for you.",
  },
  custom: {
    id: "custom", label: "Other server", imap: tls(""), smtp: starttls(""), savesSent: false,
    help: "Your provider's help pages list the IMAP and SMTP server names. Use an app password if your provider has them.",
  },
};

export const PRESET_ORDER: ConnectPresetId[] = ["gmail", "google_workspace", "outlook", "microsoft365", "yahoo", "icloud", "zoho", "fastmail", "gmx", "custom"];

const BY_DOMAIN: [RegExp, ConnectPresetId][] = [
  [/^(gmail|googlemail)\.com$/, "gmail"],
  [/^(outlook|hotmail|live|msn)\.[a-z.]+$/, "outlook"],
  [/^(yahoo|ymail|rocketmail)\.[a-z.]+$/, "yahoo"],
  [/^(icloud|me|mac)\.com$/, "icloud"],
  [/^(zoho|zohomail)\.[a-z.]+$/, "zoho"],
  [/^fastmail\.(com|fm)$/, "fastmail"],
  [/^gmx\.[a-z.]+$/, "gmx"],
];

/** Guesses the provider from the address. Unknown domains (a company's own) return null. */
export function presetForEmail(email: string): ConnectPresetId | null {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return BY_DOMAIN.find(([re]) => re.test(domain))?.[1] ?? null;
}

/** The servers to use for an address on a preset; GMX picks its .net servers for gmx.net, .de, .at and .ch. */
export function serversFor(preset: ConnectPresetId, email: string): { imap: ServerSettings; smtp: ServerSettings } {
  const p = CONNECT_PRESETS[preset];
  if (preset === "gmx" && /@gmx\.(net|de|at|ch)$/i.test(email.trim())) {
    return { imap: tls("imap.gmx.net"), smtp: starttls("mail.gmx.net") };
  }
  return { imap: { ...p.imap }, smtp: { ...p.smtp } };
}

/** What a connected account shows on the Connected accounts page. */
export interface ConnectionView {
  id: string;
  mailboxId: string;
  email: string;
  displayName: string;
  provider: ConnectPresetId;
  providerLabel: string;
  authKind: "password" | "oauth";
  status: "active" | "syncing" | "auth_failed" | "error" | "paused";
  lastError: string | null;
  lastSyncAt: string | null;
  initialDone: boolean;
  messagesSynced: number;
  /** R57: copying the whole mailbox (older mail comes in on its own, header first, body on first open). */
  backfill?: { done: boolean; counted: boolean; synced: number; total: number; paused: boolean; wait: "daily" | "budget" | null };
  imapHost: string;
  smtpHost: string;
  createdAt: string;
  /** R41: true for the demo's sample connected mailbox. */
  sample?: boolean;
}

/** A failed connection test, in words a person can act on. */
export interface ConnectProblem {
  code: "auth_failed" | "app_password_needed" | "imap_disabled" | "smtp_disabled" | "unreachable" | "tls_failed" | "timeout" | "server_error" | "oauth_required";
  step: "imap" | "smtp";
  message: string;
}
