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
  constructor(private logger: (line: string) => void = () => {}) {}
  async send(msg: OutboundMessage): Promise<OutboundResult> {
    this.sent.push(msg);
    this.logger(`[outbound:log] ${msg.from.address} -> ${[...msg.to, ...(msg.cc ?? [])].join(", ")} "${msg.subject}"`);
    return {
      provider: this.name,
      status: "queued",
      providerMessageId: msg.messageId,
      detail: "No outbound provider configured; message stored but not sent externally.",
    };
  }
}

/** Resend (https://resend.com) transactional email API. */
export class ResendOutbound implements OutboundProvider {
  readonly name = "resend";
  constructor(private apiKey: string, private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  async send(msg: OutboundMessage): Promise<OutboundResult> {
    const headers: Record<string, string> = { "Message-ID": msg.messageId };
    if (msg.inReplyTo) headers["In-Reply-To"] = msg.inReplyTo;
    if (msg.references) headers["References"] = msg.references;
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: formatAddress(msg.from),
        to: msg.to,
        cc: msg.cc?.length ? msg.cc : undefined,
        bcc: msg.bcc?.length ? msg.bcc : undefined,
        reply_to: msg.replyTo,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers,
        attachments: msg.attachments?.length ? msg.attachments.map((a) => ({ filename: a.filename, content: toB64(a.content), content_type: a.contentType })) : undefined,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok) {
      throw new OutboundError(`Resend rejected the message: ${body.message ?? res.statusText}`, res.status >= 500 || res.status === 429);
    }
    return { provider: this.name, status: "sent", providerMessageId: body.id };
  }
}
