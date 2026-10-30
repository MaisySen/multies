/**
 * R56 (MB-242): the reply a shared inbox thread opens in the Mail composer. Same rules as Mail's own Reply: answer the
 * last message's sender (or, when the last message is ours, the people it went to); Reply all adds everyone else on it
 * as cc, never our own addresses. The quote is the last message, as in Mail.
 */
import { fullDate } from "@/web/lib/format";
import type { ComposeDraft } from "./mail/compose";

export interface ReplyThread {
  id: string; mailboxId: string; subject: string;
  messages: { id: string; from: { address: string; name?: string }; to: { address: string }[]; cc?: { address: string }[]; subject: string; date: string; text: string }[];
}

export function replyDraftFor(t: ReplyThread, ownAddresses: string[], all: boolean): ComposeDraft {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const last = t.messages[t.messages.length - 1]!;
  const isOwn = (a: string) => own.has(a.toLowerCase());
  const to = isOwn(last.from.address) ? last.to.map((x) => x.address).filter((a) => !isOwn(a)) : [last.from.address];
  const cc = all ? [...last.to, ...(last.cc ?? [])].map((x) => x.address).filter((a, i, arr) => !isOwn(a) && !to.includes(a) && arr.indexOf(a) === i) : [];
  const subject = t.subject || last.subject || "";
  return {
    mailboxId: t.mailboxId, to: to.join(", "), cc: cc.join(", "), inReplyToId: last.id, threadId: t.id,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    text: `\n\nOn ${fullDate(last.date)}, ${last.from.name || last.from.address} wrote:\n${last.text.split("\n").map((l) => `> ${l}`).join("\n")}`,
  };
}
