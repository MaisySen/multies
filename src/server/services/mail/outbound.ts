import type { Resend } from "resend";
import { toB64 } from "../../lib/crypto";
export interface OutboundAddress { address: string; name?: string }

export interface OutboundMessage {
  from: OutboundAddress;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  attachments?: { filename: string; contentType: string; content: Uint8Array }[];
  /** R109: extra headers (List-Unsubscribe and List-Unsubscribe-Post on bulk mail). Never Message-ID or threading headers. */
  headers?: Record<string, string>;
}

export interface OutboundResult {
  provider: string;
  /** `sent`: handed to a real provider. `queued`: accepted locally, nothing left the platform. */
  status: "sent" | "queued";
  providerMessageId?: string;
  detail?: string;
}

/** Sends mail to recipients outside the platform. */
export interface OutboundProvider {
  readonly name: string;
  send(msg: OutboundMessage): Promise<OutboundResult>;
}

export class OutboundError extends Error {
  constructor(message: string, public retryable = false) { super(message); }
}

export function formatAddress(a: OutboundAddress): string {
  if (!a.name) return a.address;
  const safe = a.name.replace(/["\\\r\n]/g, "");
  return `"${safe}" <${a.address}>`;
}

/**
 * Development driver: records the message and reports `queued`. Nothing leaves
 * the machine. Used automatically when no provider key is configured.
 */
export class LogOutbound implements OutboundProvider {
  readonly name = "log";
  sent: OutboundMessage[] = [];
  /** `onSend` lets the Node server keep a local outbox (OUTBOX_DIR) for development and E2E tests. */
  constructor(private logger: (line: string) => void = () => {}, private onSend?: (msg: OutboundMessage) => void) {}
  async send(msg: OutboundMessage): Promise<OutboundResult> {
    this.sent.push(msg);
    this.onSend?.(msg);
    this.logger(`[outbound:log] ${msg.from.address} -> ${[...msg.to, ...(msg.cc ?? [])].join(", ")} "${msg.subject}"`);
    return {
      provider: this.name,
      status: "queued",
      providerMessageId: msg.messageId,
      detail: "No outbound provider configured; message stored but not sent externally.",
    };
  }
}

/** A plain text part from an HTML body, for a message written only in HTML. */
export function plainFromHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Resend (https://resend.com) transactional email API. */
/** Resend's message when an address needs a verified sending domain first. */
const NEEDS_DOMAIN = /verify a domain|domain is not verified|testing emails to your own email/i;

export const NEEDS_DOMAIN_DETAIL =
  "Held: the email provider only delivers to outside addresses once the sending domain is verified with it. Mail inside Multies is unaffected.";

/*
 * STB1 (startup budget): the Resend SDK (and the MIME parser it carries) loads on the first send, once per isolate,
 * instead of at Worker startup. Config already refuses the resend driver without a key, so nothing changes there.
 */
let resendModule: Promise<typeof import("resend")> | null = null;
const loadResend = () => (resendModule ??= import("resend").catch((err: unknown) => { resendModule = null; throw err; }));

/** Outbound through Resend's official SDK. */
export class ResendOutbound implements OutboundProvider {
  readonly name = "resend";
  private client: Resend | null = null;
  constructor(private readonly apiKey: string) {}

  private async resend(): Promise<Resend> {
    if (!this.client) {
      const { Resend } = await loadResend();
      this.client ??= new Resend(this.apiKey);
    }
    return this.client;
  }

  async send(msg: OutboundMessage): Promise<OutboundResult> {
    const headers: Record<string, string> = { ...(msg.headers ?? {}), "Message-ID": msg.messageId };
    if (msg.inReplyTo) headers["In-Reply-To"] = msg.inReplyTo;
    if (msg.references) headers["References"] = msg.references;
    const client = await this.resend();
    let res: Awaited<ReturnType<Resend["emails"]["send"]>>;
    try {
      res = await client.emails.send({
        from: formatAddress(msg.from),
        to: msg.to,
        cc: msg.cc?.length ? msg.cc : undefined,
        bcc: msg.bcc?.length ? msg.bcc : undefined,
        replyTo: msg.replyTo,
        subject: msg.subject,
        // Always a plain text part; the HTML part rides beside it when the message has one.
        text: msg.text || (msg.html ? plainFromHtml(msg.html) : ""),
        html: msg.html || undefined,
        headers,
        attachments: msg.attachments?.length ? msg.attachments.map((a) => ({ filename: a.filename, content: toB64(a.content), contentType: a.contentType })) : undefined,
      });
    } catch {
      throw new OutboundError("The email provider could not be reached.", true);
    }
    if (res.error) {
      if (NEEDS_DOMAIN.test(res.error.message)) return { provider: this.name, status: "queued", detail: NEEDS_DOMAIN_DETAIL };
      const retryable = res.error.name === "rate_limit_exceeded" || res.error.name === "application_error" || res.error.name === "internal_server_error";
      throw new OutboundError(`Resend rejected the message: ${res.error.message}`, retryable);
    }
    return { provider: this.name, status: "sent", providerMessageId: res.data?.id };
  }
}
