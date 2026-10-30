/**
 * C1: the local test provider (CHANNELS_MOCK=on; refused in production). It answers every adapter call without
 * the network so unit tests and E2E can connect a channel, receive, reply and see templates. Inbound "customer"
 * messages are built in Meta's own webhook shape and signed, then run through the real webhook route.
 */
import type { ChatTemplate } from "@/shared/channels";
import { hmacSha256Hex, randomToken } from "../../lib/crypto";
import { MOCK_APP_SECRET } from "./webhook";
import { ProviderError, type ChannelCredentials, type OutgoingFile, type ProviderAdapter } from "./provider";

// A 1x1 PNG, served for mock inbound images.
const PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));

export const MOCK_TEMPLATES: ChatTemplate[] = [
  { name: "order_update", language: "en", category: "utility", body: "Hi {{1}}, your order {{2}} is on its way.", params: 2 },
  { name: "follow_up", language: "en", category: "utility", body: "Hi {{1}}, just checking in. Reply here any time.", params: 1 },
];

export class MockAdapter implements ProviderAdapter {
  readonly provider = "mock" as const;
  /** Sent payloads, for tests. */
  readonly sent: { to: string; kind: string; text: string }[] = [];
  /** Set to make the next send fail (tests). */
  failNext: ProviderError | null = null;

  async connect() {
    return { token: `mock_${randomToken(12)}`, name: "Test channel", handle: "+61 400 000 000" };
  }
  private out(to: string, kind: string, text: string) {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.sent.push({ to, kind, text });
    return { externalId: `wamid.MOCK.${randomToken(12)}` };
  }
  async sendText(_c: ChannelCredentials, to: string, text: string) { return this.out(to, "text", text); }
  async sendFile(_c: ChannelCredentials, to: string, f: OutgoingFile, caption: string) { return this.out(to, "file", caption || f.filename); }
  async sendTemplate(_c: ChannelCredentials, to: string, t: { name: string; params: string[] }) { return this.out(to, "template", `${t.name}:${t.params.join("|")}`); }
  async listTemplates() { return MOCK_TEMPLATES; }
  async fetchMedia() { return { bytes: PIXEL, contentType: "image/png" }; }
}

/** One adapter per isolate so tests can read what it sent. */
let shared: MockAdapter | null = null;
export const mockAdapter = () => (shared ??= new MockAdapter());

/** A Meta shaped WhatsApp webhook body from a test customer, and its signature header. */
export async function mockInboundPayload(i: { endpointId: string; from: string; name?: string; text?: string; image?: boolean; id?: string; at?: Date }) {
  const ts = Math.floor((i.at ?? new Date()).getTime() / 1000).toString();
  const msg = i.image
    ? { from: i.from, id: i.id ?? `wamid.MOCKIN.${randomToken(12)}`, timestamp: ts, type: "image", image: { caption: i.text ?? "", mime_type: "image/png", sha256: "mock", id: `media_${randomToken(6)}` } }
    : { from: i.from, id: i.id ?? `wamid.MOCKIN.${randomToken(12)}`, timestamp: ts, type: "text", text: { body: i.text ?? "" } };
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "0", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "61400000000", phone_number_id: i.endpointId },
      contacts: [{ profile: { name: i.name ?? "Test customer" }, wa_id: i.from }],
      messages: [msg],
    } }] }],
  });
  return { body, signature: `sha256=${await hmacSha256Hex(MOCK_APP_SECRET, body)}` };
}
