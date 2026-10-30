import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { S3BodyStore, type BodyStore } from "@/server/services/storage/body-store";

class MemoryStore implements BodyStore {
  name = "memory";
  objects = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) { this.objects.set(key, bytes); }
  async get(key: string) { return this.objects.get(key) ?? null; }
  async delete(key: string) { this.objects.delete(key); }
}

async function withAttachment(store?: BodyStore) {
  const ctx = await makeTestApp();
  if (store) ctx.deps.bodyStore = store;
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const box = (await c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" })).body.mailbox;
  const big = new Uint8Array(2 * 1024 * 1024).fill(7);
  await deliverInbound(ctx.deps, {
    envelopeFrom: "a@example.com", rcptTo: "me@acme.io", sizeBytes: big.byteLength + 500, via: "test",
    email: { messageId: "<big@example.com>", from: { address: "a@example.com" }, to: [{ address: "me@acme.io" }], cc: [], subject: "Plans", text: "Attached.", date: new Date(),
      attachments: [{ filename: "plans.pdf", contentType: "application/pdf", content: big }], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
  const id = (await c.get(`/api/mail/messages?mailboxId=${box.id}&folder=inbox`)).body.messages[0].id;
  const msg = (await c.get(`/api/mail/messages/${id}`)).body.message;
  return { ctx, c, att: msg.attachments[0] };
}

describe("body store", () => {
  it("drops large attachments' bytes without a store, as before", async () => {
    const { c, att } = await withAttachment();
    expect(att).toMatchObject({ filename: "plans.pdf", available: false });
    expect((await c.get(`/api/mail/attachments/${att.id}`)).status).toBe(404);
  });

  it("keeps large attachments in the store and serves them back", async () => {
    const store = new MemoryStore();
    const { c, att } = await withAttachment(store);
    expect(att.available).toBe(true);
    expect([...store.objects.keys()][0]).toMatch(/^attachments\/org_[a-z0-9]+\/att_/);
    const res = await c.call("GET", `/api/mail/attachments/${att.id}`);
    expect(res.status).toBe(200);
  });

  it("signs S3 requests with SigV4", async () => {
    const seen: Request[] = [];
    const s3 = new S3BodyStore({ endpoint: "https://s3.ap-southeast-2.amazonaws.com", bucket: "mymail-au", region: "ap-southeast-2", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      (async (req: Request) => { seen.push(req); return new Response(req.method === "GET" ? "hello" : null, { status: 200 }); }) as typeof fetch);
    await s3.put("attachments/org_1/att_1", new TextEncoder().encode("hello"), "text/plain");
    expect(new TextDecoder().decode((await s3.get("attachments/org_1/att_1"))!)).toBe("hello");
    expect(seen[0].url).toBe("https://s3.ap-southeast-2.amazonaws.com/mymail-au/attachments/org_1/att_1");
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-southeast-2\/s3\/aws4_request/);
  });
});
