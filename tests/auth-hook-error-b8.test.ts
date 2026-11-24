/**
 * B8: when sending failed inside the Supabase Send Email Hook, the hook answered the caller with the raw internal
 * error text (a database or engine message). It answers a fixed message now and the detail goes to the log only.
 */
import { describe, it, expect, vi } from "vitest";
import { Webhook } from "standardwebhooks";
import { makeTestApp, Client } from "./helpers";

const fault = vi.hoisted(() => ({ on: false }));
vi.mock("@/server/services/mail/send", async (orig) => {
  const real = await orig<typeof import("@/server/services/mail/send")>();
  return { ...real, sendMessage: async (...a: Parameters<typeof real.sendMessage>) => {
    if (fault.on) throw new Error("D1_ERROR: no such column: messages.internal_secret_col at offset 42");
    return real.sendMessage(...a);
  } };
});

const SECRET = `v1,whsec_${Buffer.from("supabase-hook-secret-0123456789").toString("base64")}`;

describe("B8: the auth email hook never hands an internal error to its caller", () => {
  it("answers a fixed 500 message and logs the detail", async () => {
    const lines: { event: string; fields: unknown }[] = [];
    const ctx = await makeTestApp();
    const log = { debug: () => {}, info: () => {}, warn: (event: string, fields?: unknown) => { lines.push({ event, fields }); }, error: (event: string, fields?: unknown) => { lines.push({ event, fields }); } };
    ctx.deps.log = { ...ctx.deps.log, ...log } as typeof ctx.deps.log;
    const owner = new Client(ctx.app);
    await owner.signup("owner@haajir.test", "Olive Owner");
    const d = (await owner.post("/api/domains", { name: "haajir.test" })).body.domain;
    const { body } = await owner.get(`/api/domains/${d.id}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await owner.post(`/api/domains/${d.id}/verify`);
    expect((await owner.post("/api/mailboxes", { domainId: d.id, localPart: "no-reply", displayName: "Haajir" })).status).toBe(201);
    const key = (await owner.post("/api/developer/keys", { name: "Haajir HQ" })).body.secret as string;
    const made = await ctx.app.request("/api/v1/auth-email-hooks", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ from: "no-reply@haajir.test", secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Haajir" }) });
    const path = new URL(((await made.json()) as { hook: { url: string } }).hook.url).pathname;

    const call = async () => {
      const payload = JSON.stringify({ user: { email: "p@example.com" }, email_data: { token: "1", token_hash: "h", redirect_to: "", email_action_type: "signup", site_url: "https://haajir.test" } });
      const now = new Date();
      const id = `wh_${now.getTime()}`;
      const sig = new Webhook(SECRET.replace(/^v1,/, "")).sign(id, now, payload);
      const res = await ctx.app.request(path, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": sig }, body: payload });
      return { status: res.status, text: await res.text() };
    };
    fault.on = true;
    const r = await call();
    expect(r.status).toBe(500);
    expect(r.text).not.toMatch(/D1_ERROR|internal_secret_col|no such column/);
    expect(JSON.parse(r.text)).toEqual({ error: { http_code: 500, message: "Sending failed. Try again in a moment." } });
    expect(JSON.stringify(lines)).toContain("internal_secret_col");
    fault.on = false;
  }, 60_000);
});
