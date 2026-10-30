import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseWebhook } from "@/server/services/channels/webhook";

/** C1: the parser against Meta's own sample payloads (copied from Meta's developer pages on 28 Oct 2026; ids are Meta's fakes). */
const dir = join(__dirname, "fixtures", "meta");
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("Meta sample payloads", () => {
  it("every sample parses without throwing", () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) expect(() => parseWebhook(load(f)), f).not.toThrow();
  });
  it("WhatsApp text", () => {
    const [b] = parseWebhook(load("whatsapp-text.json"));
    expect(b).toMatchObject({ family: "whatsapp", endpointId: "106540352242922" });
    expect(b.messages).toEqual([expect.objectContaining({ from: "16505551234", contactName: "Sheena Nelson", kind: "text" })]);
    expect(b.messages[0].externalId).toMatch(/^wamid\./);
    expect(b.messages[0].text.length).toBeGreaterThan(0);
  });
  it("WhatsApp image and document keep the media id, type, caption and file name", () => {
    const img = parseWebhook(load("whatsapp-image.json"))[0].messages[0];
    expect(img.kind).toBe("image");
    expect(img.media).toMatchObject({ mimeType: "image/jpeg" });
    expect(img.media?.id).toMatch(/^\d+$/);
    const doc = parseWebhook(load("whatsapp-document.json"))[0].messages[0];
    expect(doc).toMatchObject({ kind: "document", text: "my receipt", media: expect.objectContaining({ filename: "receipt.pdf" }) });
  });
  it("WhatsApp statuses in both the old and the v24 shape", () => {
    const one = (f: string) => parseWebhook(load(f))[0].statuses[0];
    expect(one("whatsapp-status-sent.json").delivery).toBe("sent");
    expect(one("whatsapp-status-sent-v24.json")).toMatchObject({ delivery: "sent", error: null });
    expect(one("whatsapp-status-delivered.json").delivery).toBe("delivered");
    expect(one("whatsapp-status-read.json").delivery).toBe("read");
    const failed = one("whatsapp-status-failed.json");
    expect(failed.delivery).toBe("failed");
    expect(failed.error).toBeTruthy();
  });
  it("account updates are not messages", () => {
    expect(parseWebhook(load("whatsapp-account-update-partner-app-installed.json"))).toEqual([]);
    expect(parseWebhook(load("whatsapp-account-update-partner-app-uninstalled.json"))).toEqual([]);
  });
  it("Messenger text, quick reply, image and shared link", () => {
    const t = parseWebhook(load("messenger-text.json"))[0];
    expect(t.family).toBe("messenger");
    expect(t.messages[0].kind).toBe("text");
    expect(parseWebhook(load("messenger-text-quick-reply.json"))[0].messages[0].kind).toBe("text");
    expect(parseWebhook(load("messenger-image.json"))[0].messages[0]).toMatchObject({ kind: "image", media: { url: "https://scontent.xx.fbcdn.net/v/t1.15752-9/example.jpg" } });
    const link = parseWebhook(load("messenger-fallback-link.json"))[0].messages[0];
    expect(link.text).toContain("https://youtu.be/bbo_fZAjIhg");
    expect(link.media).toBeNull();
  });
  it("Instagram text, and seen as a read receipt", () => {
    const t = parseWebhook(load("instagram-text.json"))[0];
    expect(t).toMatchObject({ family: "instagram", endpointId: "17841400000000001" });
    expect(t.messages[0].kind).toBe("text");
    const seen = parseWebhook(load("instagram-seen.json"));
    expect(seen.flatMap((b) => b.statuses).map((s) => s.delivery)).toEqual(["read"]);
  });
});
