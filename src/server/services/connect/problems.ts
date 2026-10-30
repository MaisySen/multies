/**
 * Turns IMAP and SMTP failures into words a person can act on: wrong password, app password
 * needed, IMAP switched off, server not reachable. The provider's own text is matched, never shown
 * raw (it can carry account details), and never logged with the password.
 */
import { CONNECT_PRESETS, type ConnectPresetId, type ConnectProblem } from "@/shared/mail-connect";
import { SocketError } from "./socket";
import { SmtpError } from "./smtp";

function rawText(err: unknown): string {
  const e = err as { responseText?: string; response?: string; serverResponseCode?: string; message?: string; code?: string; reply?: { code: number; lines: string[] } };
  return [e?.serverResponseCode, e?.responseText, e?.response, e?.message, e?.code, e?.reply ? `${e.reply.code} ${e.reply.lines.join(" ")}` : ""].filter(Boolean).join(" ");
}

export function classifyProblem(err: unknown, step: "imap" | "smtp", preset: ConnectPresetId, host: string): ConnectProblem {
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
        ? `${p.label === "Other server" ? where : p.label} didn't accept that address and password. Most providers want an app password here, not your normal password.${appPw}`
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
