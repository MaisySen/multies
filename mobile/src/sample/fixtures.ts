import type { Agent, Approval, MailboxOverview, Me, Message } from "@/api/types";
import { sampleWork } from "./tasks";

/** A believable Sydney small business, for the browser preview, screenshots and tests. */
export function sampleData(now = Date.now()) {
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const inHours = (h: number) => new Date(now + h * 3_600_000).toISOString();
  const me: Me = {
    user: { id: "usr_sample", email: "mia@harbourcoffee.com.au", name: "Mia Nguyen", emailVerified: true, twoFactor: true, platformAdmin: false },
    organization: { id: "org_sample", name: "Harbour Coffee Co", plan: "free", isDemo: true, role: "owner", timezone: "Australia/Sydney", country: "AU" },
  };
  const mailboxes: MailboxOverview[] = [
    { id: "mbx_mia", address: "mia@harbourcoffee.com.au", displayName: "Mia Nguyen", usedBytes: 412_000_000, quotaMb: 1024, kind: "person", folders: { inbox: { total: 9, unread: 3 } } },
    { id: "mbx_hello", address: "hello@harbourcoffee.com.au", displayName: "Harbour Coffee", usedBytes: 120_000_000, quotaMb: 1024, kind: "person", folders: { inbox: { total: 2, unread: 1 } } },
    { id: "mbx_agent_inv", address: "accounts-agent@harbourcoffee.com.au", displayName: "Invoice chaser", usedBytes: 2_000_000, quotaMb: 512, kind: "agent", folders: {} },
  ];
  const agents: Agent[] = [
    { id: "agt_invoice", name: "Invoice chaser", description: "Follows up unpaid invoices politely.", address: "accounts-agent@harbourcoffee.com.au", inboxId: "mbx_agent_inv", approvalMode: "always", sendCapDaily: 50, allowedRecipients: null, status: "active", mailboxIds: ["mbx_agent_inv", "mbx_hello"], sentToday: 4, pendingApprovals: 2, createdAt: ago(60 * 24 * 9) } as Agent,
    { id: "agt_support", name: "Support triage", description: "Answers order and opening hours questions.", address: "support-agent@harbourcoffee.com.au", inboxId: "mbx_agent_sup", approvalMode: "external", sendCapDaily: 100, allowedRecipients: null, status: "active", mailboxIds: ["mbx_hello"], sentToday: 11, pendingApprovals: 1, createdAt: ago(60 * 24 * 5) } as Agent,
  ];
  const a = (address: string, name?: string) => (name ? { address, name } : { address });
  const msg = (m: Partial<Message> & Pick<Message, "id" | "threadId" | "from" | "subject" | "text">): Message => ({
    mailboxId: "mbx_mia", folder: "inbox", to: [a("mia@harbourcoffee.com.au", "Mia Nguyen")], cc: [], bcc: [], replyTo: null, html: null,
    attachments: [], date: ago(30), isRead: true, isStarred: false, hasAttachments: false, sentByAgentId: null,
    snippet: m.text.replace(/\s+/g, " ").slice(0, 120), ...m,
  });
  const messages: Message[] = [
    msg({ id: "msg_1", threadId: "thr_1", from: a("orders@bondibakehouse.com.au", "Sam Patel"), subject: "Wholesale order for Saturday markets", isRead: false, date: ago(7),
      text: "Hi Mia,\n\nCould we bump Saturday's order to 12 kg of the house blend and 4 kg of decaf? We're expecting a big crowd at the Bondi markets.\n\nAlso, can you send the invoice to accounts@bondibakehouse.com.au this time?\n\nCheers,\nSam" }),
    msg({ id: "msg_2", threadId: "thr_2", from: a("noreply@ato.gov.au", "Australian Taxation Office"), subject: "Your BAS for the September quarter is due 28 October", isRead: false, date: ago(55),
      text: "Your business activity statement for July to September is due on 28 October. Lodge online through Online services for business or your registered tax agent." }),
    msg({ id: "msg_3", threadId: "thr_3", from: a("li.chen@greenroofcafe.com.au", "Li Chen"), subject: "Re: Invoice INV-1042 overdue", date: ago(80), isRead: false, hasAttachments: true,
      attachments: [{ id: "att_1", filename: "remittance-advice.pdf", contentType: "application/pdf", sizeBytes: 84_000, available: true }],
      text: "Hi there,\n\nApologies for the delay, our bookkeeper was away. Payment went through this morning, remittance attached.\n\nThanks for the reminder,\nLi" }),
    msg({ id: "msg_3a", threadId: "thr_3", folder: "sent", mailboxId: "mbx_hello", from: a("accounts-agent@harbourcoffee.com.au", "Invoice chaser"), to: [a("li.chen@greenroofcafe.com.au", "Li Chen")], sentByAgentId: "agt_invoice", subject: "Invoice INV-1042 overdue", date: ago(60 * 26),
      text: "Hi Li,\n\nA friendly reminder that invoice INV-1042 for A$1,240.00 was due on 14 October. You can pay by bank transfer to the details on the invoice.\n\nThanks,\nHarbour Coffee accounts" }),
    msg({ id: "msg_4", threadId: "thr_4", from: a("jordan@sydneyfitout.com.au", "Jordan Blake"), subject: "Quote for the Surry Hills kiosk fit out", date: ago(60 * 3), isStarred: true,
      text: "Hi Mia,\n\nAttached is our quote for the kiosk fit out. We can start the week of 9 November if you confirm by Friday. All prices include GST.\n\nRegards,\nJordan" }),
    msg({ id: "msg_5", threadId: "thr_5", from: a("team@mymail.au", "MyMail"), subject: "Your domain harbourcoffee.com.au is verified", date: ago(60 * 20),
      text: "Good news. MX, SPF, DKIM and DMARC all check out for harbourcoffee.com.au, so mail is flowing." }),
    msg({ id: "msg_6", threadId: "thr_6", from: a("bookings@marrickvillemarkets.org.au", "Marrickville Markets"), subject: "Stall confirmed for Sunday 1 November", date: ago(60 * 30),
      text: "Your stall (B14) is confirmed for Sunday 1 November. Bump in from 7 am. Please bring your public liability certificate." }),
    msg({ id: "msg_7", threadId: "thr_7", from: a("support-agent@harbourcoffee.com.au", "Support triage"), sentByAgentId: "agt_support", subject: "Re: Are you open on Melbourne Cup day?", date: ago(60 * 44), mailboxId: "mbx_hello", folder: "sent", to: [a("tom.r@example.com")],
      text: "Hi Tom,\n\nYes, we're open on Melbourne Cup day from 7 am to 2 pm.\n\nSee you then,\nHarbour Coffee" }),
    msg({ id: "msg_8", threadId: "thr_8", from: a("hello@harbourcoffee.com.au", "Mia Nguyen"), folder: "sent", to: [a("orders@bondibakehouse.com.au", "Sam Patel")], subject: "October price list", date: ago(60 * 50),
      text: "Hi Sam,\n\nHere's our October price list. Nothing has changed on the house blend.\n\nMia" }),
  ];
  const approvals: Approval[] = [
    { id: "apr_1", agentId: "agt_invoice", mailboxId: "mbx_agent_inv", threadId: "thr_9", status: "pending", to: ["accounts@bondibakehouse.com.au"], cc: [], bcc: [],
      subject: "Invoice INV-1051 is 14 days overdue", text: "Hi Sam,\n\nA quick reminder that invoice INV-1051 for A$860.00 was due on 9 October. If it's already paid, thank you and please ignore this.\n\nKind regards,\nHarbour Coffee accounts",
      html: null, inReplyToId: null, decidedBy: null, decidedAt: null, note: null, messageId: null, error: null, expiresAt: inHours(46), createdAt: ago(12) },
    { id: "apr_2", agentId: "agt_invoice", mailboxId: "mbx_agent_inv", threadId: "thr_10", status: "pending", to: ["finance@coastalcatering.com.au"], cc: ["mia@harbourcoffee.com.au"], bcc: [],
      subject: "Second reminder: invoice INV-1047", text: "Hello,\n\nWe haven't received payment for invoice INV-1047 (A$2,315.50), now 21 days overdue. Could you let us know when we can expect it?\n\nThanks,\nHarbour Coffee accounts",
      html: null, inReplyToId: null, decidedBy: null, decidedAt: null, note: null, messageId: null, error: null, expiresAt: inHours(40), createdAt: ago(35) },
    { id: "apr_3", agentId: "agt_support", mailboxId: "mbx_hello", threadId: "thr_11", status: "pending", to: ["priya.s@example.com"], cc: [], bcc: [],
      subject: "Re: Catering for 40 people", text: "Hi Priya,\n\nThanks for thinking of us. For 40 people we'd suggest two 5 L batch brews plus milk on the side, about A$190 delivered within 10 km of Pyrmont. Mia will confirm the date with you.\n\nHarbour Coffee",
      html: null, inReplyToId: null, decidedBy: null, decidedAt: null, note: null, messageId: null, error: null, expiresAt: inHours(30), createdAt: ago(90) },
    { id: "apr_4", agentId: "agt_invoice", mailboxId: "mbx_agent_inv", threadId: "thr_3", status: "sent", to: ["li.chen@greenroofcafe.com.au"], cc: [], bcc: [],
      subject: "Invoice INV-1042 overdue", text: "Hi Li,\n\nA friendly reminder that invoice INV-1042 for A$1,240.00 was due on 14 October.", html: null, inReplyToId: null,
      decidedBy: "mia@harbourcoffee.com.au", decidedAt: ago(60 * 26), note: null, messageId: "msg_3a", error: null, expiresAt: ago(60), createdAt: ago(60 * 27) },
  ];
  return { me, mailboxes, agents, messages, approvals, work: sampleWork(now, messages) };
}
