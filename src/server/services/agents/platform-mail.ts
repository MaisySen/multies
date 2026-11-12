/**
 * AIS1 (audit of 11 Nov 2026, row 32): Multies' own mail never hands its codes or links to an agent or an app.
 *
 * Invites, "Confirm your email", password resets, guest invites and the rest of what the platform sends as itself
 * (services/system-mail.ts) carry links and codes that grant access. On the live workspace one landed in an agent's
 * inbox and the agent feed, which pulls codes and links out of inbound mail for agents (that is its purpose for
 * outside senders), handed the agent the confirmation link.
 *
 * The marker: `platform` in the message's stored authResults JSON. Only deliverInbound writes it, and only from
 * InboundDelivery.platformMail, which only the platform's own senders set (a code path, not a header: an outside
 * sender's Authentication-Results are parsed into spf, dkim and dmarc and nothing else, and deliverInbound drops any
 * other key). "system" is the system mailer; "notice" is a bounce notice, which carries no access and stays readable.
 * Mail that went out through the provider and came back in (an alias or a catch-all, a connected mailbox) has no
 * marker, so a message whose From is the system sender's address counts too. Forging that From only hides the
 * forger's own text, so it is safe to believe.
 *
 * The mark survives a forward inside the platform: a person's mail rule that forwards such a message sends it with
 * SendExtras.platformMail, so its Sent copy and every copy delivered inside are marked too (mail/send.ts). A forward
 * never goes to an address that reaches an AI agent at all, from a rule (mail/rules-r85.ts) or an alias
 * (mail/delivery.ts): an alias's copy to another workspace goes out through the provider and would come back unmarked.
 *
 * What an agent, an agent key, a workspace key or a connected AI app gets for such a message: the subject and the
 * sender, and in place of the text a short notice; no html, codes or links. People signed in to the app read it all.
 */
import { sql, type SQL } from "drizzle-orm";
import { messages } from "../../db/schema";
import type { AuthResults } from "@/shared/mail";

export type PlatformMark = "system" | "notice";

/** What an agent or an app reads in place of the text of the platform's own mail. */
export const WITHHELD_TEXT = "This is account mail from Multies, such as an invite, an email confirmation or a password reset. Its text, links and codes are hidden from agents and apps. A person can read it in Multies.";

/** Why a mail rule or an alias didn't forward the platform's own mail (rule run log and delivery log). */
export const NOT_FORWARDED_TO_AGENT = "Not sent: Multies' own account mail is never forwarded to an AI agent.";

/** spf, dkim and dmarc only, plus the platform mark when the platform itself delivered the message. */
export function storedAuth(auth: AuthResults | undefined, mark?: PlatformMark): AuthResults & { platform?: PlatformMark } {
  const { spf, dkim, dmarc } = auth ?? {};
  return { spf, dkim, dmarc, ...(mark ? { platform: mark } : {}) };
}

const same = (a: string, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/** True when this message is the platform's own mail whose text, codes and links agents and apps must not get. */
export function isWithheld(mark: unknown, fromAddress: string, systemFrom: string): boolean {
  if (mark === "system") return true;
  if (mark === "notice") return false;
  return same(fromAddress, systemFrom);
}

/** isWithheld for a stored message row. */
export function withheldRow(m: { authResults: string | null; fromAddress: string }, systemFrom: string): boolean {
  let mark: unknown;
  if (m.authResults && m.authResults.includes("platform")) {
    try { mark = (JSON.parse(m.authResults) as { platform?: unknown }).platform; } catch { mark = undefined; }
  }
  return isWithheld(mark, m.fromAddress, systemFrom);
}

/** The same rule in SQL, to keep such messages out of an app's text search (a search is an oracle on the text). */
export function withheldSql(systemFrom: string): SQL {
  return sql`(coalesce(${messages.authResults}, '') like '%"platform":"system"%' or (lower(${messages.fromAddress}) = ${systemFrom.trim().toLowerCase()} and coalesce(${messages.authResults}, '') not like '%"platform":"notice"%'))`;
}

/** Links and anything that looks like a code, taken out of a text (the stored snippet of the platform's mail). */
export function withoutSecrets(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{4,}\b/g, "")
    .replace(/[ \t]+/g, " ");
}

/**
 * A stored preview with any link or code taken out when the message is from the system sender. Rows stored since the
 * fix already have such a preview; rows stored before it were cut from the text, link included. Costs no read.
 */
export function safeSnippet(snippet: string, fromAddress: string, systemFrom: string): string {
  return same(fromAddress, systemFrom) ? withoutSecrets(snippet).trim() : snippet;
}

/** A message as an agent or an app may see it when it is the platform's own mail. */
export function withheldView<T extends { text?: string | null; html?: string | null; latestText?: string; snippet?: string; codes?: string[]; links?: string[] }>(m: T): T & { withheld: "platform_mail" } {
  return {
    ...m,
    ...("text" in m ? { text: WITHHELD_TEXT } : {}),
    ...("html" in m ? { html: null } : {}),
    ...("latestText" in m ? { latestText: WITHHELD_TEXT } : {}),
    ...("snippet" in m ? { snippet: WITHHELD_TEXT.slice(0, 200) } : {}),
    ...("codes" in m ? { codes: [] } : {}),
    ...("links" in m ? { links: [] } : {}),
    withheld: "platform_mail" as const,
  };
}
