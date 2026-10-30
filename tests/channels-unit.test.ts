import { describe, it, expect } from "vitest";
import { parseWebhook, verifyChallenge, verifySignature } from "@/server/services/channels/webhook";
import { MetaCloudAdapter, countParams, mediaTypeFor, metaErrorWords, namedParams } from "@/server/services/channels/meta";
import { ProviderError } from "@/server/services/channels/provider";
import { snippetOf } from "@/server/services/channels/ingest";
import { decryptSecret, encryptSecret, hmacSha256Hex } from "@/server/lib/crypto";
import { fillTemplateBody, replyWindow, windowLeftLabel, REPLY_WINDOW_MS } from "@/shared/channels";
import { loadConfig } from "@/server/config";

/**
 * C1: the pure parts of chat channels. The sample payloads follow Meta's documented examples
 * (WhatsApp Cloud API webhook components, Messenger and Instagram messaging webhooks); ids are fake.
 */
const WA_TEXT = {
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", changes: [{ value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
    contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
    messages: [{ from: "16505551234", id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=", timestamp: "1749416383", type: "text", text: { body: "Does it come in another color?" } }],
  }, field: "messages" }] }],
};
const WA_IMAGE = {
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", changes: [{ value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
    contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
    messages: [{ from: "16505551234", id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=", timestamp: "1750090702", type: "image",
      image: { caption: "This is how it arrived", mime_type: "image/jpeg", sha256: "PDH4ARmy0H0G/b4Rn4Bm2f0R7+q7A+ePVDP6m2Z2WDs=", id: "1003383421387256" } }],
  }, field: "messages" }] }],
};
const WA_STATUSES = {
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", changes: [{ value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
    statuses: [
      { id: "wamid.OUT1", status: "sent", timestamp: "1750263773", recipient_id: "16505551234", pricing: { billable: true, pricing_model: "PMP", category: "service" } },
      { id: "wamid.OUT1", status: "delivered", timestamp: "1750263774", recipient_id: "16505551234" },
      { id: "wamid.OUT1", status: "read", timestamp: "1750263775", recipient_id: "16505551234" },
      { id: "wamid.OUT2", status: "failed", timestamp: "1750263776", recipient_id: "16505551234",
        errors: [{ code: 131049, title: "This message was not delivered to maintain healthy ecosystem engagement.", message: "This message was not delivered to maintain healthy ecosystem engagement.", error_data: { details: "In order to maintain a healthy ecosystem engagement, the message failed to be delivered." } }] },
      { id: "wamid.OUT3", status: "deleted", timestamp: "1750263777", recipient_id: "16505551234" },
    ],
  }, field: "messages" }] }],
};
const MESSENGER = {
  object: "page",
  entry: [{ id: "PAGE_1", time: 1458692752478, messaging: [
    { sender: { id: "USER_PSID" }, recipient: { id: "PAGE_1" }, timestamp: 1458692752478, message: { mid: "m_1457764197618:41d102a3e1ae206a38", text: "hello, world!" } },
    { sender: { id: "PAGE_1" }, recipient: { id: "USER_PSID" }, timestamp: 1458692752479, message: { mid: "m_echo", text: "our own reply", is_echo: true } },
    { sender: { id: "USER_PSID" }, recipient: { id: "PAGE_1" }, timestamp: 1458692752480, message: { mid: "m_att", attachments: [{ type: "image", payload: { url: "https://scontent.example/img.jpg" } }] } },
    { sender: { id: "USER_PSID" }, recipient: { id: "PAGE_1" }, timestamp: 1458692752481, read: { mid: "m_out_1" } },
  ] }],
};
const INSTAGRAM = {
  object: "instagram",
  entry: [{ id: "IG_ACCOUNT_1", time: 1569262486134, messaging: [{ sender: { id: "IGSID_1" }, recipient: { id: "IG_ACCOUNT_1" }, timestamp: 1569262485349, message: { mid: "aWdfZAG1faXRlbTox", text: "Is this available?" } }] }],
};

describe("parseWebhook: WhatsApp", () => {
  it("reads a text message with the contact's profile name", () => {
    const [b] = parseWebhook(WA_TEXT);
    expect(b).toMatchObject({ family: "whatsapp", endpointId: "106540352242922", statuses: [] });
    expect(b.messages[0]).toMatchObject({ from: "16505551234", contactName: "Sheena Nelson", kind: "text", text: "Does it come in another color?", media: null });
    expect(b.messages[0].date.toISOString()).toBe(new Date(1749416383 * 1000).toISOString());
  });
  it("reads an image with its media id, type and caption", () => {
    const m = parseWebhook(WA_IMAGE)[0].messages[0];
    expect(m).toMatchObject({ kind: "image", text: "This is how it arrived", media: { id: "1003383421387256", mimeType: "image/jpeg" } });
  });
  it("reads statuses, keeps the failure reason in plain words, skips unknown ones", () => {
    const s = parseWebhook(WA_STATUSES)[0].statuses;
    expect(s.map((x) => x.delivery)).toEqual(["sent", "delivered", "read", "failed"]);
    expect(s[3].error).toContain("healthy ecosystem");
    expect(s[0].error).toBeNull();
  });
  it("reads location, contacts, reactions, button replies and unknown types without throwing", () => {
    const base = (msg: object) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "9" }, messages: [{ from: "1", id: "x", timestamp: "1", ...msg }] } }] }] });
    expect(parseWebhook(base({ type: "location", location: { latitude: -33.86, longitude: 151.2, name: "Office" } }))[0].messages[0]).toMatchObject({ kind: "location", text: "Office (-33.86, 151.2)" });
    expect(parseWebhook(base({ type: "contacts", contacts: [{ name: { formatted_name: "Ann Lee" } }] }))[0].messages[0].text).toBe("Shared contact: Ann Lee");
    expect(parseWebhook(base({ type: "reaction", reaction: { message_id: "y", emoji: "👍" } }))[0].messages[0]).toMatchObject({ kind: "reaction", text: "👍" });
    expect(parseWebhook(base({ type: "button", button: { text: "Yes please", payload: "y" } }))[0].messages[0].text).toBe("Yes please");
    expect(parseWebhook(base({ type: "order" }))[0].messages[0].kind).toBe("unsupported");
  });
  it("ignores other fields, missing ids and junk", () => {
    expect(parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "account_update", value: {} }] }] })).toEqual([]);
    expect(parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages: [{ id: "x" }] } }] }] })).toEqual([]);
    for (const junk of [null, 1, "x", [], { object: "user" }, { entry: "no" }]) expect(parseWebhook(junk)).toEqual([]);
  });
});

describe("parseWebhook: Messenger and Instagram", () => {
  it("reads page messages, skips our own echoes, maps attachments and read receipts", () => {
    const [b] = parseWebhook(MESSENGER);
    expect(b.family).toBe("messenger");
    expect(b.endpointId).toBe("PAGE_1");
    expect(b.messages.map((m) => m.externalId)).toEqual(["m_1457764197618:41d102a3e1ae206a38", "m_att"]);
    expect(b.messages[1]).toMatchObject({ kind: "image", media: { url: "https://scontent.example/img.jpg" } });
    expect(b.statuses).toEqual([expect.objectContaining({ externalId: "m_out_1", delivery: "read" })]);
  });
  it("reads Instagram messages by account id", () => {
    const [b] = parseWebhook(INSTAGRAM);
    expect(b).toMatchObject({ family: "instagram", endpointId: "IG_ACCOUNT_1" });
    expect(b.messages[0]).toMatchObject({ from: "IGSID_1", text: "Is this available?" });
  });
});

describe("signature and handshake", () => {
  it("accepts only the HMAC SHA-256 of the exact raw body", async () => {
    const raw = JSON.stringify(WA_TEXT);
    const sig = `sha256=${await hmacSha256Hex("s3cret", raw)}`;
    expect(await verifySignature(raw, sig, ["s3cret"])).toBe(true);
    expect(await verifySignature(raw, sig.toUpperCase().replace("SHA256=", "sha256="), ["s3cret"])).toBe(true);
    expect(await verifySignature(raw + " ", sig, ["s3cret"])).toBe(false);
    expect(await verifySignature(raw, sig, ["other"])).toBe(false);
    expect(await verifySignature(raw, undefined, ["s3cret"])).toBe(false);
    expect(await verifySignature(raw, "sha1=abc", ["s3cret"])).toBe(false);
    expect(await verifySignature(raw, sig, [])).toBe(false);
  });
  it("answers the challenge only for subscribe with the right token", () => {
    expect(verifyChallenge({ mode: "subscribe", token: "t", challenge: "1158201444" }, "t")).toBe("1158201444");
    expect(verifyChallenge({ mode: "subscribe", token: "x", challenge: "1" }, "t")).toBeNull();
    expect(verifyChallenge({ mode: "unsubscribe", token: "t", challenge: "1" }, "t")).toBeNull();
    expect(verifyChallenge({ mode: "subscribe", token: "t", challenge: "<script>" }, "t")).toBeNull();
    expect(verifyChallenge({ mode: "subscribe", token: "t", challenge: "1" }, undefined)).toBeNull();
  });
});

describe("reply window", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  it("is open for 24 h after the customer's last message", () => {
    expect(replyWindow(new Date(now.getTime() - 3600_000), now)).toEqual({ open: true, closesAt: new Date(now.getTime() - 3600_000 + REPLY_WINDOW_MS).toISOString() });
    expect(replyWindow(new Date(now.getTime() - REPLY_WINDOW_MS), now).open).toBe(false);
    expect(replyWindow(new Date(now.getTime() - REPLY_WINDOW_MS + 1), now).open).toBe(true);
    expect(replyWindow(null, now)).toEqual({ open: false, closesAt: null });
    expect(replyWindow("not a date", now).open).toBe(false);
  });
  it("words the pill in hours, then minutes", () => {
    expect(windowLeftLabel(replyWindow(new Date(now.getTime() - 21 * 3600_000), now), now)).toBe("Reply window closes in 3 h");
    expect(windowLeftLabel(replyWindow(new Date(now.getTime() - REPLY_WINDOW_MS + 25 * 60_000), now), now)).toBe("Reply window closes in 25 min");
    expect(windowLeftLabel({ open: false, closesAt: null }, now)).toBeNull();
  });
});

describe("token encryption and config", () => {
  it("stores a channel token as AES-GCM ciphertext that only the app secret opens", async () => {
    const secret = "x".repeat(40);
    const enc = await encryptSecret(secret, JSON.stringify({ token: "EAAG-very-secret" }));
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("EAAG");
    expect(await encryptSecret(secret, "same")).not.toBe(await encryptSecret(secret, "same"));
    expect(JSON.parse(await decryptSecret(secret, enc)).token).toBe("EAAG-very-secret");
    await expect(decryptSecret("y".repeat(40), enc)).rejects.toThrow();
  });
  it("counts Meta as configured only with all four values, and refuses the test provider in production", () => {
    const base = { APP_SECRET: "t".repeat(40) };
    expect(loadConfig({ ...base, META_APP_ID: "1", META_APP_SECRET: "2", META_VERIFY_TOKEN: "3" }).channels.meta).toBeUndefined();
    expect(loadConfig({ ...base, META_APP_ID: "1", META_APP_SECRET: "2", META_VERIFY_TOKEN: "3", META_ES_CONFIG_ID: "4", META_GRAPH_VERSION: "v25.0" }).channels.meta).toMatchObject({ graphVersion: "v25.0" });
    expect(loadConfig({ ...base, META_APP_ID: "1", META_APP_SECRET: "2", META_VERIFY_TOKEN: "3", META_ES_CONFIG_ID: "4", META_GRAPH_VERSION: "latest" }).channels.meta?.graphVersion).toBe("v26.0");
    expect(() => loadConfig({ ...base, APP_MODE: "production", CHANNELS_MOCK: "on" })).toThrow(/production/);
    expect(loadConfig({ ...base, CHANNELS_DAILY_SOFT_CAP: "50" }).channels.dailySoftCap).toBe(50);
  });
});

describe("Meta Cloud API adapter (fake fetch)", () => {
  type Call = { url: string; method: string; auth: string | null; body: unknown };
  function fakeFetch(routes: Record<string, unknown>) {
    const calls: Call[] = [];
    const f = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const h = new Headers(init?.headers);
      let body: unknown = init?.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* keep */ } }
      calls.push({ url, method: init?.method ?? "GET", auth: h.get("authorization"), body });
      const key = Object.keys(routes).find((k) => url.includes(k));
      const v = key ? routes[key] : { error: { code: 100, message: "Unsupported" } };
      if (v instanceof Uint8Array) return new Response(v as BodyInit, { headers: { "content-type": "image/jpeg" } });
      const status = (v as { error?: unknown }).error ? 400 : 200;
      return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { f, calls };
  }
  const cfg = { appId: "APP", appSecret: "APPSECRET", graphVersion: "v24.0" };
  const creds = { token: "BIZTOKEN", externalId: "106540352242922", accountId: "102290129340398" };

  it("connect: code to token server side, then subscribes the app and registers the number", async () => {
    const { f, calls } = fakeFetch({ "oauth/access_token": { access_token: "BIZTOKEN", token_type: "bearer" }, "fields=display_phone_number": { display_phone_number: "+1 555-078-3881", verified_name: "Jasper's Market" }, subscribed_apps: { success: true }, "/register": { success: true } });
    const r = await new MetaCloudAdapter(cfg, f).connect({ code: "CODE123", accountId: "102290129340398", externalId: "106540352242922" });
    expect(r).toMatchObject({ token: "BIZTOKEN", name: "Jasper's Market", handle: "+1 555-078-3881" });
    expect(r.pin).toMatch(/^\d{6}$/);
    expect(calls[0].url).toMatch(/^https:\/\/graph\.facebook\.com\/v24\.0\/oauth\/access_token\?client_id=APP&client_secret=APPSECRET&code=CODE123$/);
    expect(calls[2]).toMatchObject({ url: "https://graph.facebook.com/v24.0/102290129340398/subscribed_apps", method: "POST", auth: "Bearer BIZTOKEN" });
    expect(calls[3].body).toMatchObject({ messaging_product: "whatsapp", pin: r.pin });
  });
  it("connect: a number already registered (shared with the business app) still connects, without a PIN", async () => {
    const { f } = fakeFetch({ "oauth/access_token": { access_token: "T" }, "fields=display_phone_number": { display_phone_number: "+61 400 000 000" }, subscribed_apps: { success: true }, "/register": { error: { code: 133005, message: "already registered" } } });
    const r = await new MetaCloudAdapter(cfg, f).connect({ code: "C", accountId: "1", externalId: "2" });
    expect(r.pin).toBeUndefined();
    expect(r.name).toBe("+61 400 000 000");
  });
  it("connect: a coexistence number (shared with the WhatsApp Business app) skips registration", async () => {
    const { f, calls } = fakeFetch({ "oauth/access_token": { access_token: "T" }, "fields=display_phone_number": { display_phone_number: "+61 400 000 000", verified_name: "Shop" }, subscribed_apps: { success: true } });
    const r = await new MetaCloudAdapter(cfg, f).connect({ code: "C", accountId: "1", externalId: "2", coexistence: true });
    expect(r).toMatchObject({ token: "T", name: "Shop" });
    expect(r.pin).toBeUndefined();
    expect(calls.some((c) => c.url.includes("/register"))).toBe(false);
  });
  it("sends text in Meta's message shape with the token only in the header", async () => {
    const { f, calls } = fakeFetch({ "/messages": { messaging_product: "whatsapp", contacts: [{ input: "16505551234", wa_id: "16505551234" }], messages: [{ id: "wamid.SENT1" }] } });
    const r = await new MetaCloudAdapter(cfg, f).sendText(creds, "16505551234", "Hello https://multies.si");
    expect(r.externalId).toBe("wamid.SENT1");
    expect(calls[0].url).toBe("https://graph.facebook.com/v24.0/106540352242922/messages");
    expect(calls[0].url).not.toContain("BIZTOKEN");
    expect(calls[0].body).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "16505551234", type: "text", text: { preview_url: true, body: "Hello https://multies.si" } });
  });
  it("sends a template with body parameters", async () => {
    const { f, calls } = fakeFetch({ "/messages": { messages: [{ id: "wamid.T" }] } });
    await new MetaCloudAdapter(cfg, f).sendTemplate(creds, "1", { name: "order_update", language: "en_US", params: ["Ann", "#42"] });
    expect(calls[0].body).toMatchObject({ type: "template", template: { name: "order_update", language: { code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ann" }, { type: "text", text: "#42" }] }] } });
  });
  it("named templates: blanks listed by name and sent with parameter_name; headers with pictures or blanks are left out", async () => {
    const { f, calls } = fakeFetch({ message_templates: { data: [
      { name: "reservation_confirmation", parameter_format: "NAMED", language: "en_US", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Table for {{number_of_guests}} on {{day}}. See you {{day}}!" }, { type: "FOOTER", text: "Lucky Shrub" }] },
      { name: "with_photo", language: "en_US", status: "APPROVED", category: "MARKETING", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{1}}" }] },
      { name: "header_blank", language: "en_US", status: "APPROVED", category: "MARKETING", components: [{ type: "HEADER", format: "TEXT", text: "Act fast, {{1}}!" }, { type: "BODY", text: "Code {{1}}" }] },
      { name: "link_blank", language: "en_US", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Track it" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://x.example/{{1}}" }] }] },
    ] }, "/messages": { messages: [{ id: "wamid.N" }] } });
    const a = new MetaCloudAdapter(cfg, f);
    const list = await a.listTemplates(creds);
    expect(list).toEqual([{ name: "reservation_confirmation", language: "en_US", category: "utility", body: "Table for {{number_of_guests}} on {{day}}. See you {{day}}!", params: 2, paramNames: ["number_of_guests", "day"] }]);
    await a.sendTemplate(creds, "1", { name: "reservation_confirmation", language: "en_US", params: ["4", "Saturday"], paramNames: ["number_of_guests", "day"] });
    expect((calls[1].body as { template: { components: unknown } }).template.components).toEqual([{ type: "body", parameters: [{ type: "text", parameter_name: "number_of_guests", text: "4" }, { type: "text", parameter_name: "day", text: "Saturday" }] }]);
    expect(fillTemplateBody("Table for {{number_of_guests}} on {{day}}. See you {{day}}!", ["4", ""], ["number_of_guests", "day"])).toBe("Table for 4 on {{day}}. See you {{day}}!");
    expect(fillTemplateBody("Hi {{1}}, order {{2}}", ["Ann", "#42"])).toBe("Hi Ann, order #42");
    expect(namedParams("{{a}} {{b_2}} {{a}} {{1}}")).toEqual(["a", "b_2"]);
  });
  it("uploads a file then sends it by media id", async () => {
    const { f, calls } = fakeFetch({ "/media": { id: "MEDIA1" }, "/messages": { messages: [{ id: "wamid.F" }] } });
    await new MetaCloudAdapter(cfg, f).sendFile(creds, "1", { bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf", filename: "quote.pdf" }, "Your quote");
    expect(calls[0].url).toContain("/106540352242922/media");
    expect(calls[1].body).toMatchObject({ type: "document", document: { id: "MEDIA1", caption: "Your quote", filename: "quote.pdf" } });
  });
  it("lists approved templates only, with their blanks counted", async () => {
    const { f } = fakeFetch({ message_templates: { data: [
      { name: "order_update", language: "en_US", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}, order {{2}} shipped." }] },
      { name: "draft_one", language: "en_US", status: "PENDING", category: "MARKETING", components: [] },
    ] } });
    expect(await new MetaCloudAdapter(cfg, f).listTemplates(creds)).toEqual([{ name: "order_update", language: "en_US", category: "utility", body: "Hi {{1}}, order {{2}} shipped.", params: 2 }]);
  });
  it("downloads media in two steps (id to url, then the bytes with the token)", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    const { f, calls } = fakeFetch({ "/1003383421387256": { messaging_product: "whatsapp", url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", mime_type: "image/jpeg", sha256: "x", file_size: 3, id: "1003383421387256" }, "lookaside.fbsbx.com": bytes });
    const r = await new MetaCloudAdapter(cfg, f).fetchMedia(creds, { id: "1003383421387256", mimeType: "image/jpeg" });
    expect(r!.bytes).toEqual(bytes);
    expect(calls[1].auth).toBe("Bearer BIZTOKEN");
  });
  it("turns Meta errors into plain words and marks rate limits retryable", async () => {
    const { f } = fakeFetch({ "/messages": { error: { code: 131047, message: "Re-engagement message" } } });
    await expect(new MetaCloudAdapter(cfg, f).sendText(creds, "1", "hi")).rejects.toMatchObject({ message: expect.stringContaining("24 hours") });
    const net = new MetaCloudAdapter(cfg, (async () => { throw new Error("down"); }) as typeof fetch);
    await expect(net.sendText(creds, "1", "hi")).rejects.toBeInstanceOf(ProviderError);
    expect(metaErrorWords(130429, "x")).toContain("busy");
    expect(metaErrorWords(999, "fallback")).toBe("fallback");
  });
  it("helpers", () => {
    expect(countParams("Hi {{1}} and {{2}}, {{1}}")).toBe(2);
    expect(countParams("No blanks")).toBe(0);
    expect(mediaTypeFor("image/png")).toBe("image");
    expect(mediaTypeFor("image/webp")).toBe("sticker");
    expect(mediaTypeFor("application/pdf")).toBe("document");
    expect(mediaTypeFor("audio/ogg")).toBe("audio");
    expect(snippetOf("image", "")).toBe("Photo");
    expect(snippetOf("text", "  many   spaces ")).toBe("many spaces");
  });
});
