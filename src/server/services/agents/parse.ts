/**
 * Turns a stored message into what an agent needs: the new text without quoted history
 * or signature (email-reply-parser, the port of GitHub's parser), one-time codes and
 * links found in it, and attachments as API links.
 */
import EmailReplyParser from "email-reply-parser";
import type { attachments, messages } from "../../db/schema";
import { parseAddressList } from "../mail/address-list"; // Wave 3 (M4)

type Row = typeof messages.$inferSelect;
type Att = typeof attachments.$inferSelect;

/** The part of a reply that is new: quoted text and signatures removed. */
export function latestText(text: string): string {
  if (!text.trim()) return "";
  try {
    return new EmailReplyParser().read(text).getVisibleText().trim() || text.trim();
  } catch {
    return text.trim();
  }
}

const CODE_NEAR = /\b(code|passcode|otp|one[- ]time|verification|verify|pin|security|login|sign[- ]in)\b/i;

/** Verification codes: 4 to 8 digits (or 6 to 8 letters and digits) near a word like "code". */
export function extractCodes(text: string, subject = ""): string[] {
  const out = new Set<string>();
  const lines = `${subject}\n${text}`.split(/\r?\n/);
  lines.forEach((line, i) => {
    const context = `${lines[i - 1] ?? ""} ${line} ${lines[i + 1] ?? ""}`;
    if (!CODE_NEAR.test(context)) return;
    for (const m of line.matchAll(/(?<![\w-])(\d{3}[ -]?\d{3}|\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8})(?![\w-])/g)) {
      const code = m[1].replace(/[ -]/g, "");
      if (/^(19|20)\d{2}$/.test(code)) continue; // years
      out.add(code);
    }
  });
  return [...out].slice(0, 5);
}

/** http(s) links from the text and the HTML, in order, without duplicates. */
export function extractLinks(text: string, html?: string | null): string[] {
  const out = new Set<string>();
  for (const m of `${text}\n`.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) out.add(m[0].replace(/[.,;:!?]+$/, ""));
  for (const m of (html ?? "").matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) out.add(m[1].replace(/&amp;/g, "&"));
  return [...out].slice(0, 50);
}

export interface SenderInfo { agents: Map<string, string> }

/** A message as JSON for agents and the MCP server. */
export function agentMessage(m: Row, atts: Att[], origin: string, info?: SenderInfo) {
  const text = m.text ?? "";
  return {
    id: m.id,
    threadId: m.threadId,
    mailboxId: m.mailboxId,
    folder: m.folder,
    direction: m.folder === "sent" || m.folder === "drafts" ? "outbound" as const : "inbound" as const,
    from: { address: m.fromAddress, name: m.fromName || undefined },
    to: parseAddressList(m.to), // Wave 3 (M4)
    cc: parseAddressList(m.cc),
    replyTo: m.replyTo,
    subject: m.subject,
    date: new Date(m.date).toISOString(),
    isRead: m.isRead,
    text,
    latestText: latestText(text),
    html: m.html,
    codes: extractCodes(text, m.subject),
    links: extractLinks(text, m.html),
    attachments: atts.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, url: a.contentB64 !== null || a.storageKey !== null ? `${origin}/api/v1/attachments/${a.id}` : null })),
    sentBy: m.sentByAgentId
      ? { type: "agent" as const, agentId: m.sentByAgentId, name: info?.agents.get(m.sentByAgentId) ?? null }
      : m.folder === "sent" ? { type: "person" as const, userId: m.sentByUserId } : { type: "external" as const },
    auth: m.authResults ? JSON.parse(m.authResults) : null,
  };
}
