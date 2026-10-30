/**
 * C1 (chat channels, phase 1): the shapes the web app and the server share for WhatsApp, Messenger and
 * Instagram conversations in the shared inbox. Server: src/server/services/channels/*, routes under
 * /api/channels (session) and /api/webhooks/meta (public, signed). Docs: docs/channels.md.
 */
export type ChannelProvider = "whatsapp" | "messenger" | "instagram" | "mock";
export type ChannelStatus = "active" | "disconnected" | "error";
export type ConversationStatus = "open" | "waiting" | "done";
export type ChatDirection = "in" | "out";
export type ChatMessageKind = "text" | "image" | "video" | "audio" | "document" | "sticker" | "location" | "contacts" | "template" | "reaction" | "unsupported";
export type ChatDelivery = "pending" | "sent" | "delivered" | "read" | "failed" | "received";

/** Meta's customer service window: a free form reply is allowed until 24 h after the customer's last message. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ChannelSummary {
  id: string;
  provider: ChannelProvider;
  /** What people see: the business phone number, page name or handle. */
  name: string;
  /** The display phone number or handle, when the provider gave one. */
  handle: string | null;
  status: ChannelStatus;
  connectedAt: string;
  disconnectedAt: string | null;
}

/** GET /api/channels/status */
export interface ChannelsStatus {
  /** The server has the Meta app settings (or the local mock is on). False: Settings shows "Coming soon". */
  available: boolean;
  /** Only the local test provider is on (never in production). */
  mock: boolean;
  /** The workspace switch (admins turn it on in Settings, Channels). Off by default. */
  enabled: boolean;
  /** The caller is an owner or admin. */
  canManage: boolean;
  channels: ChannelSummary[];
  /** What the Embedded Signup button needs; null when the Meta app is not configured. */
  embeddedSignup: { appId: string; configId: string; graphVersion: string } | null;
  /** Today's inbound chat messages (UTC day) against the soft cap. */
  usage: { today: number; softCap: number; level: "ok" | "near" | "over" };
}

export interface ConversationSummary {
  id: string;
  channelId: string;
  provider: ChannelProvider;
  /** The customer's name as the provider gave it, else their number or handle. */
  contactName: string;
  /** wa_id (phone number) or the page scoped id. */
  contactHandle: string;
  snippet: string;
  lastMessageAt: string;
  lastInboundAt: string | null;
  unreadCount: number;
  status: ConversationStatus;
  assignee: { userId: string; name: string } | null;
  labels: string[];
}

export interface ChatMessage {
  id: string;
  direction: ChatDirection;
  kind: ChatMessageKind;
  text: string;
  date: string;
  delivery: ChatDelivery;
  /** Plain words when delivery is failed. */
  error: string | null;
  /** Set when the message carries a file; url serves the stored copy (Meta's own link expires in minutes). */
  media: { filename: string; contentType: string; size: number; url: string | null } | null;
  sentBy: { userId: string; name: string } | null;
  templateName: string | null;
}

/** GET /api/channels/conversations/:id */
export interface ConversationDetail {
  conversation: ConversationSummary;
  channel: ChannelSummary;
  messages: ChatMessage[];
  window: ReplyWindow;
}

export interface ReplyWindow {
  open: boolean;
  /** ISO time the window closes; null when the customer never wrote. */
  closesAt: string | null;
}

export interface ChatTemplate {
  name: string;
  language: string;
  category: string;
  /** The body with {{1}} style placeholders. */
  body: string;
  /** Number of {{n}} placeholders. */
  params: number;
}

/** The reply window at `now`, from the customer's last inbound message. */
export function replyWindow(lastInboundAt: Date | string | null | undefined, now: Date = new Date()): ReplyWindow {
  if (!lastInboundAt) return { open: false, closesAt: null };
  const t = typeof lastInboundAt === "string" ? Date.parse(lastInboundAt) : lastInboundAt.getTime();
  if (!Number.isFinite(t)) return { open: false, closesAt: null };
  const closes = t + REPLY_WINDOW_MS;
  return { open: now.getTime() < closes, closesAt: new Date(closes).toISOString() };
}

/** "Reply window closes in 3 h" style words for the pill; null when closed or never opened. */
export function windowLeftLabel(w: ReplyWindow, now: Date = new Date()): string | null {
  if (!w.open || !w.closesAt) return null;
  const ms = Date.parse(w.closesAt) - now.getTime();
  if (ms <= 0) return null;
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `Reply window closes in ${mins} min`;
  const hours = Math.floor(mins / 60);
  return `Reply window closes in ${hours} h`;
}

export const PROVIDER_LABEL: Record<ChannelProvider, string> = {
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  mock: "Test channel",
};
