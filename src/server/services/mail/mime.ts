/* STB1 (startup budget): the MIME parser loads on the first parse, once per isolate, not at Worker startup. */
let postalMimeModule: Promise<typeof import("postal-mime")> | null = null;
const loadPostalMime = () => (postalMimeModule ??= import("postal-mime").catch((err: unknown) => { postalMimeModule = null; throw err; }));
import type { Address, AuthResults } from "@/shared/mail";

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface ParsedEmail {
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  date: Date;
  attachments: ParsedAttachment[];
  authResults: AuthResults;
  headers: Record<string, string>;
}

type PMAddress = { address?: string; name?: string; group?: PMAddress[] };

function flatten(list: PMAddress[] | PMAddress | undefined): Address[] {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  const out: Address[] = [];
  for (const a of arr) {
    if (a.group) out.push(...flatten(a.group));
    else if (a.address) out.push({ address: a.address.toLowerCase(), name: a.name || undefined });
  }
  return out;
}

/** Reads SPF/DKIM/DMARC verdicts from Authentication-Results style headers. */
export function parseAuthResults(headerValues: string[]): AuthResults {
  const joined = headerValues.join(";").toLowerCase();
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const m = joined.match(new RegExp(`\\b${key}=([a-z]+)`));
    return m && (allowed as readonly string[]).includes(m[1]) ? (m[1] as T) : undefined;
  };
  return {
    spf: pick("spf", ["pass", "fail", "softfail", "neutral", "none"] as const),
    dkim: pick("dkim", ["pass", "fail", "none"] as const),
    dmarc: pick("dmarc", ["pass", "fail", "none"] as const),
  };
}

/** Parses a raw RFC 5322 message (string or bytes). */
export async function parseMime(raw: string | Uint8Array | ArrayBuffer): Promise<ParsedEmail> {
  const { default: PostalMime } = await loadPostalMime();
  const email = await PostalMime.parse(raw as ArrayBuffer);
  const headers: Record<string, string> = {};
  const authHeaders: string[] = [];
  for (const h of email.headers ?? []) {
    const key = h.key.toLowerCase();
    if (!(key in headers)) headers[key] = h.value;
    if (key === "authentication-results" || key === "arc-authentication-results") authHeaders.push(h.value);
  }
  const date = email.date ? new Date(email.date) : new Date();
  return {
    messageId: email.messageId || undefined,
    inReplyTo: email.inReplyTo || undefined,
    references: email.references || undefined,
    from: flatten(email.from as PMAddress)[0] ?? { address: "unknown@invalid" },
    to: flatten(email.to as PMAddress[]),
    cc: flatten(email.cc as PMAddress[]),
    replyTo: flatten(email.replyTo as PMAddress[])[0]?.address,
    subject: email.subject ?? "",
    text: email.text ?? "",
    html: email.html || undefined,
    date: Number.isNaN(date.getTime()) ? new Date() : date,
    attachments: (email.attachments ?? []).map((a) => ({
      filename: a.filename || "attachment",
      contentType: a.mimeType || "application/octet-stream",
      content: typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content),
    })),
    authResults: parseAuthResults(authHeaders),
    headers,
  };
}

/** Plain-text preview of a message for list views. */
export function makeSnippet(text: string, html?: string): string {
  let src = text;
  if (!src.trim() && html) src = html.replace(/<style[\s\S]*?(?:<\/style>|$)|<script[\s\S]*?(?:<\/script>|$)/gi, " ").replace(/<[^>]+>/g, " ");
  return src
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith(">"))
    .join(" ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
