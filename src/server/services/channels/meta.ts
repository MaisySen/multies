/**
 * C1: the Meta Cloud API adapter (WhatsApp first; Messenger and Instagram sends come in C2). Written to Meta's
 * documented Graph API shapes; we have no Meta app yet, so tests drive it through a fake fetch.
 *   Code exchange: GET /oauth/access_token?client_id&client_secret&code
 *     https://developers.facebook.com/docs/whatsapp/embedded-signup/
 *   Onboarding: POST /{waba-id}/subscribed_apps, POST /{phone-number-id}/register {messaging_product, pin}
 *   Send: POST /{phone-number-id}/messages ; media upload: POST /{phone-number-id}/media (multipart)
 *     https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *   Media download: GET /{media-id} -> { url, mime_type }, then GET url with the same bearer token
 *   Templates: GET /{waba-id}/message_templates
 * Tokens are only ever sent in the Authorization header, never in a URL, a log line or an error.
 */
import type { ChatTemplate } from "@/shared/channels";
import { ProviderError, type ChannelCredentials, type ConnectResult, type InboundMedia, type OutgoingFile, type ProviderAdapter } from "./provider";

export interface MetaAppConfig { appId: string; appSecret: string; graphVersion: string }

/** Plain words for Meta's common error codes; the code itself goes to the log, never to the person. */
export function metaErrorWords(code: number | undefined, fallback: string): string {
  switch (code) {
    case 131047: return "More than 24 hours have passed since the customer last wrote, so only an approved template can be sent.";
    case 131026: return "This number cannot receive WhatsApp messages.";
    case 131051: return "WhatsApp does not support this kind of message.";
    case 131053: return "WhatsApp could not use the attached file.";
    case 132001: return "That template does not exist or is not approved yet.";
    case 190: return "The connection to WhatsApp has expired. An admin needs to reconnect the number in Settings.";
    case 4: case 80007: case 130429: return "WhatsApp is busy right now. Try again in a minute.";
    default: return fallback;
  }
}

const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export class MetaCloudAdapter implements ProviderAdapter {
  readonly provider = "whatsapp" as const;
  constructor(private cfg: MetaAppConfig, private fetchImpl: typeof fetch) {}

  private url(path: string) { return `https://graph.facebook.com/${this.cfg.graphVersion}/${path.replace(/^\//, "")}`; }

  private async call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
    const { token, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    let res: Response;
    try {
      res = await this.fetchImpl(path.startsWith("https://") ? path : this.url(path), { ...rest, headers });
    } catch {
      throw new ProviderError("Could not reach WhatsApp. Try again in a minute.", "network", true);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } } & T;
    if (!res.ok || body.error) {
      const code = body.error?.code;
      throw new ProviderError(metaErrorWords(code, "WhatsApp did not accept that."), code ?? res.status, res.status >= 500 || code === 4 || code === 130429);
    }
    return body;
  }

  async connect(input: { code: string; accountId: string; externalId: string }): Promise<ConnectResult> {
    // The code is short lived and single use; the client secret only travels in this server side call.
    const q = new URLSearchParams({ client_id: this.cfg.appId, client_secret: this.cfg.appSecret, code: input.code });
    const tok = await this.call<{ access_token?: string }>(`oauth/access_token?${q.toString()}`);
    if (!tok.access_token) throw new ProviderError("WhatsApp did not finish the connection. Try again.");
    const token = tok.access_token;
    const phone = await this.call<{ display_phone_number?: string; verified_name?: string }>(`${encodeURIComponent(input.externalId)}?fields=display_phone_number,verified_name`, { token });
    await this.call(`${encodeURIComponent(input.accountId)}/subscribed_apps`, { method: "POST", token });
    // A new number has to be registered for Cloud API with a two step PIN we choose. A number shared with the
    // WhatsApp Business app (coexistence) is already registered and answers an error here, which is fine.
    const pin = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    let registered = true;
    try {
      await this.call(`${encodeURIComponent(input.externalId)}/register`, { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", pin }) });
    } catch { registered = false; }
    return { token, pin: registered ? pin : undefined, name: phone.verified_name || phone.display_phone_number || "WhatsApp", handle: phone.display_phone_number ?? null };
  }

  private async send(c: ChannelCredentials, payload: Record<string, unknown>): Promise<{ externalId: string }> {
    const r = await this.call<{ messages?: { id?: string }[] }>(`${encodeURIComponent(c.externalId)}/messages`, {
      method: "POST", token: c.token, headers: { "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
    });
    const id = r.messages?.[0]?.id;
    if (!id) throw new ProviderError("WhatsApp did not confirm the message.", "no_id", true);
    return { externalId: id };
  }

  sendText(c: ChannelCredentials, to: string, text: string) {
    return this.send(c, { to, type: "text", text: { preview_url: /https?:\/\//.test(text), body: text } });
  }

  async sendFile(c: ChannelCredentials, to: string, file: OutgoingFile, caption: string) {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", file.contentType);
    form.append("file", new Blob([file.bytes as BlobPart], { type: file.contentType }), file.filename);
    const up = await this.call<{ id?: string }>(`${encodeURIComponent(c.externalId)}/media`, { method: "POST", token: c.token, body: form });
    if (!up.id) throw new ProviderError("WhatsApp did not accept the file.");
    const type = mediaTypeFor(file.contentType);
    const media: Record<string, unknown> = { id: up.id };
    if (caption && type !== "audio" && type !== "sticker") media.caption = caption;
    if (type === "document") media.filename = file.filename;
    return this.send(c, { to, type, [type]: media });
  }

  sendTemplate(c: ChannelCredentials, to: string, t: { name: string; language: string; params: string[] }) {
    const components = t.params.length ? [{ type: "body", parameters: t.params.map((text) => ({ type: "text", text })) }] : undefined;
    return this.send(c, { to, type: "template", template: { name: t.name, language: { code: t.language }, ...(components ? { components } : {}) } });
  }

  async listTemplates(c: ChannelCredentials): Promise<ChatTemplate[]> {
    if (!c.accountId) return [];
    const r = await this.call<{ data?: { name?: string; language?: string; status?: string; category?: string; components?: { type?: string; text?: string }[] }[] }>(
      `${encodeURIComponent(c.accountId)}/message_templates?fields=name,language,status,category,components&limit=100`, { token: c.token });
    return (r.data ?? []).filter((t) => t.status === "APPROVED" && t.name).map((t) => {
      const body = t.components?.find((x) => x.type === "BODY")?.text ?? "";
      return { name: t.name!, language: t.language ?? "en", category: (t.category ?? "UTILITY").toLowerCase(), body, params: countParams(body) };
    });
  }

  async fetchMedia(c: ChannelCredentials, media: InboundMedia) {
    let url = media.url, type = media.mimeType;
    if (!url && media.id) {
      const info = await this.call<{ url?: string; mime_type?: string; file_size?: number }>(encodeURIComponent(media.id), { token: c.token });
      if ((info.file_size ?? 0) > MAX_MEDIA_BYTES) return null;
      url = info.url; type = info.mime_type ?? type;
    }
    if (!url || !url.startsWith("https://")) return null;
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${c.token}` } }).catch(() => null);
    if (!res || !res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_MEDIA_BYTES) return null;
    return { bytes, contentType: type || res.headers.get("content-type") || "application/octet-stream" };
  }
}

export function mediaTypeFor(contentType: string): "image" | "video" | "audio" | "document" | "sticker" {
  if (contentType === "image/webp") return "sticker";
  if (contentType === "image/jpeg" || contentType === "image/png") return "image";
  if (contentType === "video/mp4" || contentType === "video/3gpp") return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "document";
}

export function countParams(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/\{\{(\d{1,2})\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}
