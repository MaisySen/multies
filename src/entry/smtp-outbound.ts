/**
 * Outbound mail over SMTP, for self-hosted installs: MyMail hands each message to a
 * mail server (Stalwart in docker-compose.selfhost.yml) that delivers it. When the
 * sending domain has a DKIM key in MyMail, the message is signed with it, so the DKIM
 * record MyMail shows on the domain page is the one receivers check.
 *
 * Turned on by SMTP_HOST in the Node entry. Nodemailer is MIT-0.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { OutboundError, formatAddress, type OutboundMessage, type OutboundProvider, type OutboundResult } from "../server/services/mail/outbound";

export interface SmtpSettings {
  host: string;
  port: number;
  /** true: TLS from the first byte (465). false: STARTTLS when offered (587, 25). */
  secure: boolean;
  user?: string;
  pass?: string;
  /** Accept a self-signed certificate (the mail server on the same private network). */
  allowSelfSigned: boolean;
}

export interface DkimKey { domainName: string; keySelector: string; privateKey: string }

/** Reads SMTP_* variables. Returns undefined when SMTP_HOST is not set. */
export function smtpSettingsFrom(env: Record<string, string | undefined>): SmtpSettings | undefined {
  if (!env.SMTP_HOST) return undefined;
  const port = Number(env.SMTP_PORT ?? 587);
  return {
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" || env.SMTP_SECURE === "1" : port === 465,
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASS || undefined,
    allowSelfSigned: env.SMTP_ALLOW_SELF_SIGNED === "true" || env.SMTP_ALLOW_SELF_SIGNED === "1",
  };
}

/** SMTP reply codes 4xx (and network errors) are worth retrying; 5xx are not. */
export function isRetryable(err: unknown): boolean {
  const e = err as { responseCode?: number; code?: string };
  if (typeof e?.responseCode === "number") return e.responseCode < 500;
  return true;
}

export class SmtpOutbound implements OutboundProvider {
  readonly name = "smtp";
  private transport: Transporter;

  constructor(settings: SmtpSettings, private dkimFor: (domain: string) => Promise<DkimKey | undefined> = async () => undefined, transport?: Transporter) {
    this.transport = transport ?? nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: settings.user ? { user: settings.user, pass: settings.pass ?? "" } : undefined,
      tls: { rejectUnauthorized: !settings.allowSelfSigned },
    });
  }

  async send(msg: OutboundMessage): Promise<OutboundResult> {
    const domain = msg.from.address.split("@")[1]?.toLowerCase() ?? "";
    const dkim = domain ? await this.dkimFor(domain).catch(() => undefined) : undefined;
    try {
      const info = await this.transport.sendMail({
        from: formatAddress(msg.from),
        to: msg.to,
        cc: msg.cc?.length ? msg.cc : undefined,
        bcc: msg.bcc?.length ? msg.bcc : undefined,
        replyTo: msg.replyTo,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        messageId: msg.messageId,
        inReplyTo: msg.inReplyTo,
        references: msg.references,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content) })),
        dkim,
      });
      return { provider: this.name, status: "sent", providerMessageId: info.messageId ?? msg.messageId, detail: info.response };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new OutboundError(`The mail server did not take the message: ${why}`, isRetryable(err));
    }
  }
}
