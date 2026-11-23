import type { Message } from "@/api/types";

export const detailDelayMs = 12_000;

export function mailSmokeMessages(now: number): Message[] {
  return ["Inbox", "Search"].map((path, i): Message => ({
    id: `msg_smoke_${path.toLowerCase()}`,
    threadId: `thr_smoke_${path.toLowerCase()}`,
    mailboxId: "mbx_mia", // The project's local sample mailbox, not a live account.
    folder: "inbox",
    subject: `Multies Mail Smoke ${path}`,
    from: { address: "sender@example.invalid", name: "Smoke Fixture" },
    to: [{ address: "recipient@example.invalid", name: "Smoke Recipient" }],
    cc: [], bcc: [], replyTo: null, attachments: [],
    text: path === "Inbox" ? "Plain text fixture opened from Inbox." : "",
    html: path === "Search" ? "<p>Search HTML is readable after &#1114112; then &#x1F642;.</p>" : null,
    snippet: "Synthetic preview",
    labels: [], sentByAgentId: null, date: new Date(now - i).toISOString(),
    isRead: true, isStarred: false, hasAttachments: false,
  }));
}

export function shouldDelaySmokeDetail(method: string, path: string): boolean {
  return method === "GET" && /^\/mail\/messages\/msg_smoke_(inbox|search)$/.test(path);
}
