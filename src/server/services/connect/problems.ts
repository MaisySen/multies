/**
 * Turns IMAP and SMTP failures into words a person can act on: wrong password, app password
 * needed, IMAP switched off, server not reachable. The provider's own text is matched, never shown
 * raw (it can carry account details). G1: a scrubbed copy of the provider's reason rides beside the
 * message as `detail` for the person who is connecting (the API answer and the connect form) only.
 * It is never written to logs: callers log the step and code. The scrub takes out addresses, links,
 * network addresses, request ids, quoted values and the name after "user", "username", "login" or
 * "account", but a provider can still word a reply in a way it misses, which is why it stays out of logs.
 */
import { CONNECT_PRESETS, type ConnectPresetId, type ConnectProblem } from "@/shared/mail-connect";
import { SocketError } from "./socket";
import { SmtpError } from "./smtp";

function rawText(err: unknown): string {
  const e = err as { responseText?: string; response?: string; serverResponseCode?: string; message?: string; code?: string; reply?: { code: number; lines: string[] } };
  return [e?.serverResponseCode, e?.responseText, e?.response, e?.message, e?.code, e?.reply ? `${e.reply.code} ${e.reply.lines.join(" ")}` : ""].filter(Boolean).join(" ");
}

/**
 * G1: the provider's own reason, safe to show: the server's words only (not our wrapper's "Command failed"), with
 * bracketed IMAP codes, status numbers, links, addresses, network addresses and request ids taken out.
 */
export function providerDetail(err: unknown): string | undefined {
  const e = err as { responseText?: string; reply?: { code: number; lines: string[] }; message?: string } | null;
  const raw = e?.reply?.lines?.length ? e.reply.lines.join(" ") : e?.responseText ?? (err instanceof Error && !(err instanceof SocketError) ? e?.message : undefined);
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\[[A-Z0-9-]+\]/g, " ")
    .replace(/\S+@\S+/g, " ")
    // Quoted values ('jdoe', "ada") and the name after user, username, login or account (User=jdoe, for user jdoe).
    .replace(/"[^"]{0,120}"|'[^']{0,120}'/g, " ")
    .replace(/\b(user(?:name)?|login(?: name)?|account)(\s*[:=]\s*|\s+)(?!(?:and|or|is|was|has|not|does|did|or|password|disabled|locked|blocked|suspended|failed|unknown|not)\b)[\w.+-]+/gi, "$1 ")
    .replace(/\b(user(?:name)?|login|account)\s*[:=]\s*/gi, "$1 ")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, " ")
    .replace(/\b[0-9a-f]*:[0-9a-f:]{6,}\b/gi, " ")
    .replace(/\b\d\.\d{1,3}\.\d{1,3}\b/g, " ")
    .replace(/^\s*\d{3}\b/, " ")
    .replace(/\S*\d\S*[a-z]\S*\d\S{6,}/gi, " ")
    .replace(/\s-\s*gsmtp\b/gi, " ")
    .replace(/\((Failure|Success)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Words left with nothing after them once a value was taken out ("for from see").
    .replace(/(\s+\b(?:for|from|see|by|at|via)\b)+(?=\s*$)/gi, "")
    .replace(/(\s+\b(?:for|from|see|by|at|via)\b)+(?=\s+(?:for|from|see|by|at|via)\b)/gi, "")
    .replace(/[\s:;,-]+$/, "");
  if (!cleaned || /^(command failed|error)$/i.test(cleaned) || !/[a-z]{3}/i.test(cleaned)) return undefined;
  return cleaned.length > 160 ? `${cleaned.slice(0, 157).trimEnd()}...` : cleaned;
}

export function classifyProblem(err: unknown, step: "imap" | "smtp", preset: ConnectPresetId, host: string): ConnectProblem {
  const problem = classifyOnly(err, step, preset, host);
  const detail = providerDetail(err);
  return detail ? { ...problem, detail } : problem;
}

const GOOGLE = new Set<ConnectPresetId>(["gmail", "google_workspace"]);

function classifyOnly(err: unknown, step: "imap" | "smtp", preset: ConnectPresetId, host: string): ConnectProblem {
  const text = rawText(err);
  const p = CONNECT_PRESETS[preset] ?? CONNECT_PRESETS.custom;
  const where = host || "the server";
  const appPw = p.appPasswordUrl ? ` Make one at ${p.appPasswordUrl.replace(/^https:\/\//, "")}.` : "";

  if (err instanceof SocketError || /ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|getaddrinfo|proxy request failed|cannot connect|NoConnection|ECONNRESET/i.test(text)) {
    if ((err as SocketError).kind === "tls_failed" || /certificate|self.signed|SSL routines|TLS/i.test(text)) {
      return { code: "tls_failed", step, message: `${where} didn't offer a valid secure connection. Check the server name and port, and that it uses SSL/TLS.` };
    }
    if ((err as SocketError).kind === "timeout" || /timed? ?out|ETIMEDOUT/i.test(text)) {
      return { code: "timeout", step, message: `${where} didn't answer in time. Check the server name and port, then try again.` };
    }
    return { code: "unreachable", step, message: `Couldn't reach ${where}. Check the server name and port.` };
  }
  if (/timed? ?out|ETIMEDOUT/i.test(text)) return { code: "timeout", step, message: `${where} didn't answer in time. Try again in a minute.` };

  // Gmail: "[ALERT] Application-specific password required" (IMAP), 534-5.7.9 (SMTP).
  if (/application.specific password|5\.7\.9|app password/i.test(text)) {
    return { code: "app_password_needed", step, message: `${p.label} needs an app password here, not your normal password.${appPw}` };
  }
  // Gmail with IMAP off: "[ALERT] Your account is not enabled for IMAP use".
  if (/not enabled for IMAP|IMAP (access )?(is )?disabled|IMAP is disabled/i.test(text)) {
    return { code: "imap_disabled", step, message: `IMAP is turned off for this account. Turn on IMAP in your ${p.label} settings, then try again.` };
  }
  // G1: Google stops a sign in it finds unusual until the person approves it in a browser.
  // IMAP "[WEBALERT] Please log in via your web browser", SMTP "534 5.7.14 Please log in via your web browser".
  if (/WEBALERT|log ?in via your web browser|5\.7\.14|web login required/i.test(text)) {
    return GOOGLE.has(preset)
      ? { code: "web_login_required", step, message: "Google paused this sign in as unusual. Open Gmail in your browser while signed in to this account, approve the security alert if you see one, then try again here." }
      : { code: "web_login_required", step, message: `${where} wants you to sign in once in your browser first. Sign in to your mail on the web, then try again here.` };
  }
  // Microsoft: basic sign in switched off for IMAP ("Login is disabled", LOGINDISABLED, BasicAuthBlocked)
  // or for SMTP (535 5.7.139 "SmtpClientAuthentication is disabled").
  if (/5\.7\.139|SmtpClientAuthentication|SMTP AUTH.*disabled|authentication is disabled/i.test(text)) {
    return { code: "smtp_disabled", step, message: "Sending with a password is turned off for this account. Your admin can turn on authenticated SMTP, or connect with Microsoft once that option is live." };
  }
  if (/LOGINDISABLED|Login is disabled|BasicAuthBlocked|basic auth/i.test(text)) {
    return p.oauthPreferred
      ? { code: "oauth_required", step, message: `${p.label} turned off password sign in for mail apps on this account. It needs Microsoft's own sign in, which isn't available in Multies yet. A work or school admin can allow IMAP with a password instead.` }
      : { code: "imap_disabled", step, message: `${where} doesn't allow password sign in. Turn on IMAP access in your account settings, then try again.` };
  }
  if (/AUTHENTICATIONFAILED|AUTHENTICATE failed|Invalid credentials|authentication failed|LOGIN failed|incorrect|bad credentials|\b535\b|5\.7\.8|username and password not accepted|Authentication unsuccessful|authenticationFailed/i.test(text)
    || (err as { authenticationFailed?: boolean })?.authenticationFailed
    || (err instanceof SmtpError && err.stage === "auth")) {
    return {
      code: "auth_failed", step,
      message: step === "imap"
        ? GOOGLE.has(preset)
          ? `${p.label} didn't accept that address and app password. An app password only works for the same Google account it was made in: check the account shown at the top of the app password page is this address, then make a new one.${appPw}`
          : `${p.label === "Other server" ? where : p.label} didn't accept that address and password. Most providers want an app password here, not your normal password.${appPw}`
        : `The password works for reading mail but ${where} refused it for sending. Check the outgoing server and that SMTP is allowed for this account.`,
    };
  }
  if (err instanceof SmtpError && err.stage === "starttls") {
    return { code: "tls_failed", step, message: `${where} doesn't offer a secure connection on that port. Try port 465 with SSL/TLS.` };
  }
  return { code: "server_error", step, message: `${where} answered with an error we didn't expect. Check the settings and try again; if it keeps happening, tell us at support.` };
}

/** Thrown by the connection test; carries the problem for the API answer. */
export class ConnectFailed extends Error {
  constructor(public problem: ConnectProblem) { super(problem.message); this.name = "ConnectFailed"; }
}
