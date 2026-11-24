/**
 * Getting an email address from inside the app: connect an existing mailbox (IMAP and SMTP with an
 * app password) or take a free address on the Multies shared domain. The screens call the same
 * API the web app uses (/api/connections and /api/free-address) with the app's own session.
 *
 * The provider presets mirror src/shared/mail-connect.ts in the web app (server names checked
 * against each provider's help pages on 25 October 2026). The server checks everything again.
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
  /** Where the person makes an app password, when the provider has a page for it. */
  appPasswordUrl?: string;
  /** Short steps shown under the password field. */
  help: string;
  /** The provider mostly wants its own sign in now; an app password works only on some accounts. */
  oauthPreferred?: boolean;
}

const tls = (host: string, port = 993): ServerSettings => ({ host, port, security: "tls" });
const starttls = (host: string, port = 587): ServerSettings => ({ host, port, security: "starttls" });

export const CONNECT_PRESETS: Record<ConnectPresetId, ConnectPreset> = {
  gmail: {
    id: "gmail", label: "Gmail", imap: tls("imap.gmail.com"), smtp: tls("smtp.gmail.com", 465),
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    help: "Gmail needs an app password, not your normal password. Turn on 2-Step Verification in your Google Account, then create an app password and paste it here.",
  },
  google_workspace: {
    id: "google_workspace", label: "Google Workspace", imap: tls("imap.gmail.com"), smtp: tls("smtp.gmail.com", 465),
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    help: "Use an app password from your Google Account. If you can't make one, your Workspace admin has to allow 2-Step Verification and IMAP for your account.",
  },
  outlook: {
    id: "outlook", label: "Outlook.com or Hotmail", imap: tls("outlook.office365.com"), smtp: starttls("smtp-mail.outlook.com"),
    appPasswordUrl: "https://account.microsoft.com/security", oauthPreferred: true,
    help: "Turn on two-step verification, then create an app password under Advanced security options. Microsoft has switched most accounts to its own sign in, so an app password may be refused.",
  },
  microsoft365: {
    id: "microsoft365", label: "Microsoft 365 (work or school)", imap: tls("outlook.office365.com"), smtp: starttls("smtp.office365.com"),
    appPasswordUrl: "https://mysignins.microsoft.com/security-info", oauthPreferred: true,
    help: "Your admin has to allow IMAP and authenticated SMTP for your account. Most Microsoft 365 workspaces need Microsoft's own sign in instead of a password.",
  },
  yahoo: {
    id: "yahoo", label: "Yahoo Mail", imap: tls("imap.mail.yahoo.com"), smtp: tls("smtp.mail.yahoo.com", 465),
    appPasswordUrl: "https://login.yahoo.com/account/security",
    help: "Yahoo needs an app password. Open Account security, choose Generate app password, and paste it here.",
  },
  icloud: {
    id: "icloud", label: "iCloud Mail", imap: tls("imap.mail.me.com"), smtp: starttls("smtp.mail.me.com"),
    appPasswordUrl: "https://account.apple.com/account/manage",
    help: "iCloud needs an app specific password. Sign in to your Apple Account, open Sign-In and Security, then App-Specific Passwords.",
  },
  zoho: {
    id: "zoho", label: "Zoho Mail", imap: tls("imap.zoho.com"), smtp: tls("smtp.zoho.com", 465),
    appPasswordUrl: "https://accounts.zoho.com/home#security/app_password",
    help: "Turn on IMAP access in Zoho Mail settings, then make an app password. Accounts in the EU, India or Australia use imap.zoho.eu, imap.zoho.in or imap.zoho.com.au: pick Other server and enter those.",
  },
  fastmail: {
    id: "fastmail", label: "Fastmail", imap: tls("imap.fastmail.com"), smtp: tls("smtp.fastmail.com", 465),
    appPasswordUrl: "https://app.fastmail.com/settings/security/apps",
    help: "Create an app password in Settings, Privacy and Security, with access to IMAP and SMTP.",
  },
  gmx: {
    id: "gmx", label: "GMX", imap: tls("imap.gmx.com"), smtp: starttls("mail.gmx.com"),
    help: "Turn on POP3 and IMAP access in your GMX settings first, then use your GMX password.",
  },
  custom: {
    id: "custom", label: "Other server", imap: tls(""), smtp: starttls(""),
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

/** The servers for an address on a preset; GMX uses its .net servers for gmx.net, .de, .at and .ch. */
export function serversFor(preset: ConnectPresetId, email: string): { imap: ServerSettings; smtp: ServerSettings } {
  const p = CONNECT_PRESETS[preset];
  if (preset === "gmx" && /@gmx\.(net|de|at|ch)$/i.test(email.trim())) {
    return { imap: tls("imap.gmx.net"), smtp: starttls("mail.gmx.net") };
  }
  return { imap: { ...p.imap }, smtp: { ...p.smtp } };
}

/** What GET /api/connections lists for each connected mailbox. */
export interface ConnectionView {
  id: string;
  mailboxId: string;
  email: string;
  displayName: string;
  provider: ConnectPresetId;
  providerLabel: string;
  authKind: "password" | "oauth";
  /** "verifying" (server PRIV1b P60): waiting for the code emailed to the address; it is entered on the web. */
  status: "active" | "syncing" | "auth_failed" | "error" | "paused" | "verifying";
  lastError: string | null;
  lastSyncAt: string | null;
  initialDone: boolean;
  messagesSynced: number;
  imapHost: string;
  smtpHost: string;
  createdAt: string;
}

/**
 * MPLAT-110: an owner or admin sees a personal connected mailbox they can't open as this reduced row (address and
 * status only). Show it read only, with no counts and no actions.
 */
export interface ConnectionLimited {
  id: string;
  mailboxId: string;
  email: string;
  status: ConnectionView["status"];
  openable: false;
}

/** One row of GET /api/connections. A row without `openable` (an older server) is a full row. */
export type ConnectionListItem = (ConnectionView & { openable?: true }) | ConnectionLimited;

export function isFullConnection(c: ConnectionListItem): c is ConnectionView & { openable?: true } {
  return c.openable !== false;
}

export interface ConnectionsInfo {
  enabled: boolean;
  oauth?: unknown;
  connections: ConnectionListItem[];
}

/** The body POST /api/connections and POST /api/connections/test take. */
export interface ConnectInput {
  email: string;
  password: string;
  preset?: ConnectPresetId;
  username?: string;
  displayName?: string;
  imap?: Partial<ServerSettings>;
  smtp?: Partial<ServerSettings>;
}

export type FreeAddressInfo =
  | { enabled: false }
  | { enabled: true; domain: string; dailySends: number; available: boolean; suggestion: string; addresses: { id: string; address: string; displayName: string }[] };

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The form on the Connect screen, as typed. */
export interface ConnectForm {
  preset: ConnectPresetId;
  email: string;
  password: string;
  username: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: ConnectSecurity;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: ConnectSecurity;
}

export function emptyConnectForm(preset: ConnectPresetId = "gmail"): ConnectForm {
  const p = CONNECT_PRESETS[preset];
  return {
    preset, email: "", password: "", username: "",
    imapHost: p.imap.host, imapPort: String(p.imap.port), imapSecurity: p.imap.security,
    smtpHost: p.smtp.host, smtpPort: String(p.smtp.port), smtpSecurity: p.smtp.security,
  };
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function port(v: string): number | null {
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * Checks the form before anything is sent and builds the request body. Returns the first problem
 * in plain words, or the body. Presets other than "Other server" send no server settings: the
 * server picks them, the same as on the web.
 */
export function connectRequest(f: ConnectForm): { error: string } | { body: ConnectInput } {
  const email = f.email.trim();
  if (!EMAIL_SHAPE.test(email)) return { error: "Enter the full email address, like name@example.com." };
  if (!f.password) return { error: f.preset === "gmx" || f.preset === "custom" ? "Enter the password for this mailbox." : "Paste the app password for this mailbox." };
  const body: ConnectInput = { email, password: f.password, preset: f.preset };
  if (f.username.trim()) body.username = f.username.trim();
  if (f.preset === "custom") {
    const imapPort = port(f.imapPort);
    const smtpPort = port(f.smtpPort);
    if (!HOST_RE.test(f.imapHost.trim())) return { error: "Enter the IMAP server name, like imap.example.com." };
    if (!imapPort) return { error: "The IMAP port is a number from 1 to 65535, usually 993." };
    if (!HOST_RE.test(f.smtpHost.trim())) return { error: "Enter the SMTP server name, like smtp.example.com." };
    if (!smtpPort) return { error: "The SMTP port is a number from 1 to 65535, usually 465 or 587." };
    body.imap = { host: f.imapHost.trim().toLowerCase(), port: imapPort, security: f.imapSecurity };
    body.smtp = { host: f.smtpHost.trim().toLowerCase(), port: smtpPort, security: f.smtpSecurity };
  }
  return { body };
}

/** Where a failed connection test went wrong, from the server's answer ({ step: "imap" | "smtp" }). */
export function failedStep(details: Record<string, unknown> | undefined): "imap" | "smtp" | null {
  const s = details?.step;
  return s === "imap" || s === "smtp" ? s : null;
}

const LOCAL_RE = /^[a-z0-9](?:[a-z0-9.-]{1,38}[a-z0-9])$/;

/** A free address name, cleaned the way the field shows it: lowercase, no spaces. */
export function cleanLocalPart(v: string): string {
  return v.replace(/\s+/g, "").toLowerCase().replace(/@.*$/, "");
}

/**
 * The shape rules for a free address name, checked before asking the server. The server also
 * keeps role and brand names back and checks the name is free; its words are shown as they come.
 */
export function localPartProblem(local: string): string | null {
  if (local.length < 3) return "Use at least 3 letters or numbers.";
  if (!LOCAL_RE.test(local)) return "Use 3 to 40 lowercase letters, numbers, dots or dashes, starting and ending with a letter or number.";
  if (/[.-]{2}/.test(local)) return "Dots and dashes can't sit next to each other.";
  return null;
}

const STATUS_LABEL: Record<ConnectionView["status"], string> = {
  active: "Connected", syncing: "Syncing", auth_failed: "Password needed", error: "Problem", paused: "Paused", verifying: "Enter the emailed code on the web",
};

export function connectionStatusLabel(s: ConnectionView["status"]): string {
  return STATUS_LABEL[s] ?? s;
}

export function connectionTone(s: ConnectionView["status"]): "ok" | "warn" | "bad" | "neutral" {
  if (s === "active") return "ok";
  if (s === "syncing" || s === "paused") return "neutral";
  if (s === "auth_failed" || s === "verifying") return "warn";
  return "bad";
}

/** "Synced 5 min ago", "Synced 2 h ago", or "Not synced yet". */
export function lastSyncLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "Not synced yet";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Not synced yet";
  const mins = Math.round((now - t) / 60_000);
  if (mins < 1) return "Synced just now";
  if (mins < 60) return `Synced ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Synced ${hours} h ago`;
  const days = Math.round(hours / 24);
  return `Synced ${days} ${days === 1 ? "day" : "days"} ago`;
}
