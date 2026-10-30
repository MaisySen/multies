/**
 * C1: the seam between the inbox and a messaging provider. The Meta Cloud API adapter (meta.ts) speaks Meta's
 * documented webhook and Graph API shapes; the mock (mock.ts) answers the same calls locally for unit and E2E
 * runs. Nothing outside services/channels talks to a provider directly.
 */
import type { ChannelProvider, ChatDelivery, ChatMessageKind, ChatTemplate } from "@/shared/channels";

export interface InboundMedia { id?: string; url?: string; mimeType?: string; filename?: string; sha256?: string }

export interface InboundMessage {
  /** Meta's message id (wamid... or mid...). */
  externalId: string;
  /** The customer: WhatsApp wa_id, or the page scoped id. */
  from: string;
  contactName: string | null;
  date: Date;
  kind: ChatMessageKind;
  text: string;
  media: InboundMedia | null;
}

export interface StatusUpdate {
  externalId: string;
  delivery: Exclude<ChatDelivery, "pending" | "received">;
  date: Date;
  error: string | null;
}

/** One business endpoint's share of a webhook delivery. */
export interface WebhookBatch {
  /** "whatsapp" covers the mock too (same payload shape); the channel row decides. */
  family: "whatsapp" | "messenger" | "instagram";
  /** phone_number_id, Page id or Instagram account id: finds the channel row. */
  endpointId: string;
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

export interface ChannelCredentials {
  token: string;
  /** phone_number_id (WhatsApp) or Page / Instagram id. */
  externalId: string;
  /** WABA id (WhatsApp) for templates. */
  accountId: string | null;
}

export interface OutgoingFile { bytes: Uint8Array; contentType: string; filename: string }

export interface ConnectResult {
  token: string;
  /** Extra secret state kept encrypted beside the token (the registration PIN). */
  pin?: string;
  name: string;
  handle: string | null;
}

export interface ProviderAdapter {
  readonly provider: ChannelProvider;
  /**
   * Swaps an Embedded Signup code for a business token and finishes onboarding (webhooks subscribed, number registered).
   * A number shared with the WhatsApp Business app (coexistence) is already registered, so registration is skipped.
   */
  connect(input: { code: string; accountId: string; externalId: string; coexistence?: boolean }): Promise<ConnectResult>;
  sendText(c: ChannelCredentials, to: string, text: string): Promise<{ externalId: string }>;
  sendFile(c: ChannelCredentials, to: string, file: OutgoingFile, caption: string): Promise<{ externalId: string }>;
  sendTemplate(c: ChannelCredentials, to: string, t: { name: string; language: string; params: string[] }): Promise<{ externalId: string }>;
  listTemplates(c: ChannelCredentials): Promise<ChatTemplate[]>;
  /** Downloads an inbound file at once: Meta's media links expire within minutes. */
  fetchMedia(c: ChannelCredentials, media: InboundMedia): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

/** A provider refused or could not be reached; `message` is plain words for the person. */
export class ProviderError extends Error {
  constructor(message: string, readonly code?: number | string, readonly retryable = false) { super(message); }
}
