import { describe, expect, it } from "vitest";
import { NEEDS_DOMAIN_DETAIL, type OutboundMessage } from "../src/server/services/mail/outbound";
import { makeTestApp, Client } from "./helpers";

/** R41 (MB-228): POST /api/team/invites says emailed only when the email really went out. */
describe("R41 invite emailed is the truth", () => {
  it("answers emailed:false with a plain reason when the provider holds mail to outside addresses", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const sent: OutboundMessage[] = [];
    (ctx.deps as { outbound: unknown }).outbound = { name: "resend", send: async (m: OutboundMessage) => { sent.push(m); return { provider: "resend", status: "queued", detail: NEEDS_DOMAIN_DETAIL }; } };
    const r = await c.post("/api/team/invites", { email: "friend@elsewhere.example", role: "member" });
    expect(r.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(r.body).toMatchObject({ emailed: false, emailDetail: "This deployment can't email addresses outside Multies yet." });
    expect(r.body.link).toContain("/invite/");
  });

  it("answers emailed:true when the provider sent it, and false with a reason when it refused", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    (ctx.deps as { outbound: unknown }).outbound = { name: "resend", send: async () => ({ provider: "resend", status: "sent", providerMessageId: "x" }) };
    const ok = await c.post("/api/team/invites", { email: "a@elsewhere.example", role: "member" });
    expect(ok.body.emailed).toBe(true);
    expect(ok.body.emailDetail).toBeUndefined();
    const { OutboundError } = await import("../src/server/services/mail/outbound");
    (ctx.deps as { outbound: unknown }).outbound = { name: "resend", send: async () => { throw new OutboundError("Resend rejected the message: invalid", false); } };
    const no = await c.post("/api/team/invites", { email: "b@elsewhere.example", role: "member" });
    expect(no.body).toMatchObject({ emailed: false, emailDetail: "The email provider didn't accept this invite." });
  });
});
