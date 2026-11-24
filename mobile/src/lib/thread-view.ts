import type { Address, Attachment, Message, ThreadView } from "@/api/types";

/**
 * Wave 3: the thread screen reads data that can be partial. The phone's saved copy comes back as saved
 * (offline.ts cached()), list prefetches seed the thread with a summary, and older servers stored to and cc
 * as plain strings. This fixes the fields up so the screen never reads a property of undefined; only a view
 * with no message id is refused (null), since nothing can be opened, replied to or acted on without one.
 */
export function normalizeThreadView(v: unknown): ThreadView | null {
  if (!isObject(v)) return null;
  const message = normalizeMessage(v.message);
  if (!message) return null;
  const items = Array.isArray(v.thread) ? v.thread.map(normalizeMessage).filter((m): m is Message => !!m) : [];
  return { message, thread: items.length ? items : [message] };
}

function normalizeMessage(raw: unknown): Message | null {
  if (!isObject(raw) || typeof raw.id !== "string" || !raw.id) return null;
  const out: Message = {
    ...(raw as unknown as Message),
    id: raw.id,
    threadId: str(raw.threadId),
    mailboxId: str(raw.mailboxId),
    folder: (typeof raw.folder === "string" ? raw.folder : "inbox") as Message["folder"],
    from: address(raw.from) ?? { address: "" },
    to: addresses(raw.to),
    cc: addresses(raw.cc),
    bcc: addresses(raw.bcc),
    subject: str(raw.subject),
    snippet: str(raw.snippet),
    date: typeof raw.date === "string" && !Number.isNaN(Date.parse(raw.date)) ? raw.date : "",
    isRead: raw.isRead === true,
    isStarred: raw.isStarred === true,
    hasAttachments: raw.hasAttachments === true,
    replyTo: typeof raw.replyTo === "string" ? raw.replyTo : null,
    text: str(raw.text),
    html: typeof raw.html === "string" ? raw.html : null,
    attachments: Array.isArray(raw.attachments) ? raw.attachments.map(attachment).filter((a): a is Attachment => !!a) : [],
    sentByAgentId: typeof raw.sentByAgentId === "string" ? raw.sentByAgentId : null,
  };
  if (Array.isArray(raw.labels)) out.labels = raw.labels.filter((l): l is string => typeof l === "string");
  else delete out.labels;
  return out;
}

function address(a: unknown): Address | null {
  if (typeof a === "string") return { address: a };
  if (!isObject(a)) return null;
  const out: Address = { address: str(a.address) };
  if (typeof a.name === "string") out.name = a.name;
  return out;
}

/** A list item without an address is dropped: it names nobody. */
function addresses(list: unknown): Address[] {
  if (!Array.isArray(list)) return [];
  return list.map(address).filter((a): a is Address => !!a && !!a.address);
}

function attachment(a: unknown): Attachment | null {
  if (!isObject(a) || typeof a.id !== "string" || !a.id) return null;
  return { id: a.id, filename: str(a.filename), contentType: str(a.contentType), sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : 0, available: a.available !== false };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
