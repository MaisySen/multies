import { describe, it, expect, afterEach, vi } from "vitest";
import { NEEDS_DOMAIN_DETAIL, OutboundError, ResendOutbound } from "@/server/services/mail/outbound";

const msg = { from: { address: "a@acme.io", name: "Ada" }, to: ["b@example.com"], subject: "Hi", text: "Hi", messageId: "<m1@acme.io>" };
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

afterEach(() => vi.unstubAllGlobals());

describe("Resend outbound (official SDK)", () => {
  it("sends and returns the provider id", async () => {
    const f = answer(200, { id: "re_123" });
    vi.stubGlobal("fetch", f);
    expect(await new ResendOutbound("re_test").send(msg)).toMatchObject({ provider: "resend", status: "sent", providerMessageId: "re_123" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/emails");
    expect(JSON.parse(String(init.body))).toMatchObject({ from: '"Ada" <a@acme.io>', to: ["b@example.com"], headers: { "Message-ID": "<m1@acme.io>" } });
  });

  it("holds mail for addresses that need a verified domain", async () => {
    vi.stubGlobal("fetch", answer(403, { statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address (x@y.z). To send emails to other recipients, please verify a domain at resend.com/domains." }));
    expect(await new ResendOutbound("re_test").send(msg)).toEqual({ provider: "resend", status: "queued", detail: NEEDS_DOMAIN_DETAIL });
  });

  it("raises other refusals as errors", async () => {
    vi.stubGlobal("fetch", answer(422, { statusCode: 422, name: "validation_error", message: "Invalid `to` field." }));
    await expect(new ResendOutbound("re_test").send(msg)).rejects.toBeInstanceOf(OutboundError);
  });
});
