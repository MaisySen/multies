/**
 * Sending as a connected address: the message goes through the person's own provider over SMTP,
 * never through Multies' sender, so it passes SPF and DKIM as their own mail and takes no sending
 * domain slot. Providers that don't file SMTP mail in Sent themselves (everyone but Gmail and
 * Microsoft) get a copy added to Sent with IMAP APPEND, unless one with that Message-ID is there.
 */
import MailComposer from "nodemailer/lib/mail-composer";
import type { Deps } from "../../context";
import { OutboundError, type OutboundMessage, type OutboundProvider, type OutboundResult } from "../mail/outbound";
import { connectionSecret, imapConnector, socketOpener, type Connection } from ".";
import { classifyProblem } from "./problems";
import { smtpSend, SmtpError } from "./smtp";
import { parseState } from "./sync";
import type { ConnectPresetId } from "@/shared/mail-connect";

/** Builds the raw message (RFC 5322) with Nodemailer's composer. Bcc stays out of the headers. */
export async function composeRaw(msg: OutboundMessage): Promise<string> {
  const composer = new MailComposer({
    from: msg.from.name ? { name: msg.from.name, address: msg.from.address } : msg.from.address,
    to: msg.to, cc: msg.cc, bcc: msg.bcc, replyTo: msg.replyTo, subject: msg.subject, text: msg.text, html: msg.html,
    messageId: msg.messageId, inReplyTo: msg.inReplyTo, references: msg.references,
    attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content) })),
  });
  const buf = await new Promise<Buffer>((resolve, reject) => composer.compile().build((err, out) => (err ? reject(err) : resolve(out))));
  return buf.toString("utf8");
}

export function connectionOutbound(deps: Deps, c: Connection): OutboundProvider {
  return {
    name: "own-smtp",
    async send(msg: OutboundMessage): Promise<OutboundResult> {
      // R40: the demo's sample connected mailbox never opens a connection to a provider.
      if ((await import("../demo")).isSampleConnection(c)) throw new OutboundError("This is a sample connected mailbox in the demo, so nothing is sent from it.", false);
      const secret = await connectionSecret(deps, c);
      const access = c.authKind === "oauth" ? await (await import("./oauth")).accessTokenFor(deps, c, secret) : secret;
      const raw = await composeRaw(msg);
      const rcpts = [...new Set([...msg.to, ...(msg.cc ?? []), ...(msg.bcc ?? [])].map((a) => a.toLowerCase()))];
      let res;
      try {
        res = await smtpSend(socketOpener(deps), { host: c.smtpHost, port: c.smtpPort, security: c.smtpSecurity }, { user: c.username, secret: access, xoauth2: c.authKind === "oauth" }, { from: c.email, to: rcpts }, raw);
      } catch (err) {
        const problem = classifyProblem(err, "smtp", c.provider as ConnectPresetId, c.smtpHost);
        const retryable = err instanceof SmtpError ? err.retryable && err.stage !== "auth" : problem.code === "timeout" || problem.code === "unreachable";
        throw new OutboundError(problem.message, retryable);
      }
      if (!c.savesSent) await appendToSent(deps, c, access, msg.messageId, raw).catch((err) => deps.log?.warn("mail_connect.sent_copy_failed", { connection: c.id, error: (err as Error).message }));
      const rejected = res.rejected.length ? ` ${res.rejected.length} address(es) refused: ${res.rejected.map((r) => r.address).join(", ")}.` : "";
      return { provider: "own-smtp", status: "sent", providerMessageId: msg.messageId, detail: `Sent through ${c.smtpHost}.${rejected}` };
    },
  };
}

/** Files the sent message in the provider's Sent folder, once. */
export async function appendToSent(deps: Deps, c: Connection, access: string, messageId: string, raw: string) {
  const session = await imapConnector(deps)({ host: c.imapHost, port: c.imapPort, security: c.imapSecurity }, { user: c.username, secret: access, xoauth2: c.authKind === "oauth" }, { allowSelfSigned: deps.config.mailConnect.allowSelfSigned });
  try {
    const sent = parseState(c.syncState).paths?.sent ?? (await session.folders()).sent;
    if (!sent) return false;
    await session.open(sent, { write: true });
    if (await session.hasMessageId(messageId)) return false;
    await session.append(sent, raw, ["\\Seen"]);
    return true;
  } finally {
    await session.close().catch(() => undefined);
  }
}
