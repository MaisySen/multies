import { describe, it, expect, beforeEach } from "vitest";
import { Webhook } from "standardwebhooks";
import { gzipSync, zipSync, strToU8 } from "fflate";
import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { parseMime } from "@/server/services/mail/mime";
import { parseDmarcReport } from "@/server/services/deliverability/dmarc";
import { mailauthAuthenticator } from "@/server/services/mail/mailauth";

const RESEND_SECRET = `whsec_${Buffer.from("resend-test-secret-0123456789ab").toString("base64")}`;

const dmarcXml = (domain: string, id = "rep-1") => {
  const today = ctx.deps.now();
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 1000 - 1;
  const begin = end - 86_399;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata><org_name>google.com</org_name><email>noreply-dmarc-support@google.com</email><report_id>${id}</report_id>
    <date_range><begin>${begin}</begin><end>${end}</end></date_range></report_metadata>
  <policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><sp>none</sp><pct>100</pct></policy_published>
  <record><row><source_ip>209.85.220.41</source_ip><count>40</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
    <identifiers><header_from>${domain}</header_from></identifiers><auth_results><dkim><domain>${domain}</domain><result>pass</result></dkim><spf><domain>${domain}</domain><result>pass</result></spf></auth_results></record>
  <record><row><source_ip>45.83.12.9</source_ip><count>10</count><policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row>
    <identifiers><header_from>${domain}</header_from></identifiers><auth_results><spf><domain>spoof.example</domain><result>fail</result></spf></auth_results></record>
</feedback>`;
};

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let domainId: string;
let mailboxId: string;

async function verify() {
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
}

beforeEach(async () => {
  ctx = await makeTestApp({ RESEND_WEBHOOK_SECRET: RESEND_SECRET });
  c = new Client(ctx.app);
  await c.signup();
  domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" })).body.mailbox.id;
  await verify();
});

async function resendEvent(event: unknown, secret = RESEND_SECRET) {
  const body = JSON.stringify(event);
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const now = new Date();
  const sig = new Webhook(secret).sign(id, now, body);
  const res = await ctx.app.request("/api/webhooks/resend", { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(now.getTime() / 1000)), "svix-signature": sig }, body });
  return { status: res.status, body: await res.json() };
}

describe("bounces, complaints and the suppression list", () => {
  it("marks a hard bounce, suppresses the address, and skips it next time", async () => {
    await c.post("/api/mail/send", { mailboxId, to: ["gone@example.com"], subject: "Hi", text: "Hello" });
    const sent = ctx.outbound.sent.at(-1)!;
    const r = await resendEvent({ type: "email.bounced", data: { email_id: sent.messageId, to: ["gone@example.com"], bounce: { type: "Permanent", message: "550 5.1.1 user unknown" } } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handled: true, updated: 1 });
    const list = await c.get("/api/deliverability/suppressions");
    expect(list.body.suppressions[0]).toMatchObject({ address: "gone@example.com", reason: "hard_bounce" });
    const before = ctx.outbound.sent.length;
    const again = await c.post("/api/mail/send", { mailboxId, to: ["gone@example.com", "ok@example.com"], subject: "Hi", text: "Hello" });
    expect(again.body.external).toEqual(expect.arrayContaining([expect.objectContaining({ address: "gone@example.com", status: "failed" })]));
    expect(ctx.outbound.sent.length).toBe(before + 1);
    expect(ctx.outbound.sent.at(-1)!.to).toEqual(["ok@example.com"]);
  });

  it("treats a complaint as a suppression too, and ignores soft bounces", async () => {
    await c.post("/api/mail/send", { mailboxId, to: ["a@example.com", "b@example.com"], subject: "Hi", text: "Hello" });
    const id = ctx.outbound.sent.at(-1)!.messageId;
    await resendEvent({ type: "email.complained", data: { email_id: id, to: ["a@example.com"] } });
    await resendEvent({ type: "email.bounced", data: { email_id: id, to: ["b@example.com"], bounce: { type: "Transient", message: "mailbox full" } } });
    const list = (await c.get("/api/deliverability/suppressions")).body.suppressions;
    expect(list.map((s: { address: string; reason: string }) => [s.address, s.reason])).toEqual([["a@example.com", "complaint"]]);
  });

  it("rejects events with a bad signature", async () => {
    const bad = await resendEvent({ type: "email.bounced", data: { email_id: "x" } }, `whsec_${Buffer.from("wrong-secret-wrong-secret-0000").toString("base64")}`);
    expect(bad.status).toBe(401);
  });

  it("lets admins add and remove addresses by hand", async () => {
    const add = await c.post("/api/deliverability/suppressions", { address: "Block@Example.com" });
    expect(add.status).toBe(201);
    const list = (await c.get("/api/deliverability/suppressions")).body.suppressions;
    expect(list[0]).toMatchObject({ address: "block@example.com", reason: "manual" });
    expect((await c.del(`/api/deliverability/suppressions/${list[0].id}`)).status).toBe(200);
    expect((await c.get("/api/deliverability/suppressions")).body.suppressions).toHaveLength(0);
  });
});

describe("DMARC aggregate reports", () => {
  it("parses plain, gzip and zip reports", () => {
    const xml = dmarcXml("acme.io");
    for (const input of [strToU8(xml), gzipSync(strToU8(xml)), zipSync({ "google.com!acme.io!1!2.xml": strToU8(xml) })]) {
      const r = parseDmarcReport(input);
      expect(r).toMatchObject({ reporter: "google.com", reportId: "rep-1", domain: "acme.io", policy: { p: "none", pct: 100 } });
      expect(r.rows).toHaveLength(2);
    }
  });

  it("stores an uploaded report once and summarizes sources", async () => {
    const contentB64 = Buffer.from(gzipSync(strToU8(dmarcXml("acme.io")))).toString("base64");
    const up = await c.post("/api/deliverability/dmarc/reports", { filename: "report.xml.gz", contentB64 });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ domain: "acme.io", messages: 50, duplicate: false });
    expect((await c.post("/api/deliverability/dmarc/reports", { contentB64 })).body.duplicate).toBe(true);
    const sum = await c.get("/api/deliverability/dmarc");
    expect(sum.body.reports[0]).toMatchObject({ domain: "acme.io", messages: 50, passed: 40 });
    expect(sum.body.sources[0]).toMatchObject({ sourceIp: "209.85.220.41", messages: 40, passed: 40 });
  });

  it("refuses reports for domains outside the workspace", async () => {
    const contentB64 = Buffer.from(dmarcXml("someone-else.com")).toString("base64");
    expect((await c.post("/api/deliverability/dmarc/reports", { contentB64 })).status).toBe(400);
  });

  it("picks reports out of inbound mail", async () => {
    const zip = zipSync({ "google.com!acme.io.xml": strToU8(dmarcXml("acme.io", "rep-mail")) });
    const email = await parseMime(new TextEncoder().encode("From: noreply-dmarc-support@google.com\r\nTo: ada@acme.io\r\nSubject: Report domain: acme.io Submitter: google.com\r\n\r\nx\r\n"));
    email.attachments = [{ filename: "google.com!acme.io.zip", contentType: "application/zip", content: zip }];
    await deliverInbound(ctx.deps, { envelopeFrom: "noreply-dmarc-support@google.com", rcptTo: "ada@acme.io", email, sizeBytes: 500, via: "test" });
    expect((await c.get("/api/deliverability/dmarc")).body.reports.map((r: { reporter: string }) => r.reporter)).toContain("google.com");
  });
});

describe("domain health score", () => {
  it("scores a fully set up domain and explains each factor", async () => {
    const h = (await c.get("/api/deliverability/health")).body.domains[0];
    expect(h.domain).toBe("acme.io");
    expect(h.factors.map((f: { id: string }) => f.id)).toEqual(["mx", "spf", "dkim", "dmarc", "dmarc_policy", "dmarc_pass", "bounces", "complaints"]);
    expect(h.factors.find((f: { id: string }) => f.id === "dkim").status).toBe("good");
    expect(h.score).toBeGreaterThanOrEqual(80);
  });

  it("drops with bounces and failing DMARC traffic", async () => {
    const before = (await c.get("/api/deliverability/health")).body.domains[0].score;
    await c.post("/api/deliverability/dmarc/reports", { contentB64: Buffer.from(dmarcXml("acme.io")).toString("base64") });
    await c.post("/api/mail/send", { mailboxId, to: ["x1@example.com", "x2@example.com"], subject: "Hi", text: "Hello" });
    const id = ctx.outbound.sent.at(-1)!.messageId;
    await resendEvent({ type: "email.bounced", data: { email_id: id, to: ["x1@example.com"], bounce: { type: "Permanent" } } });
    const after = (await c.get("/api/deliverability/health")).body.domains[0];
    expect(after.score).toBeLessThan(before);
    expect(after.stats.bounceRate).toBe(50);
    expect(after.stats.dmarcPassRate).toBe(80);
  });
});

describe("mailauth on inbound mail (Node)", () => {
  it("verifies a DKIM signature and DMARC alignment with a real signer", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const msg = "From: Bob <bob@sender.test>\r\nTo: ada@acme.io\r\nSubject: Signed\r\nDate: Thu, 23 Oct 2026 05:00:00 +0000\r\nMessage-ID: <s1@sender.test>\r\n\r\nHello, signed.\r\n";
    const signed = await dkimSign(msg, { signatureData: [{ signingDomain: "sender.test", selector: "s1", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }] });
    const raw = new TextEncoder().encode(signed.signatures + msg);
    const records: Record<string, string[][]> = {
      "s1._domainkey.sender.test": [[`v=DKIM1; k=rsa; p=${pub}`]],
      "_dmarc.sender.test": [["v=DMARC1; p=reject"]],
    };
    const resolver = async (name: string, type: string) => {
      if (type === "TXT" && records[name]) return records[name];
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    };
    const auth = mailauthAuthenticator({ resolver: resolver as never });
    expect((await auth(raw, { sender: "bob@sender.test" })).results).toMatchObject({ dkim: "pass", dmarc: "pass" });
    const tampered = new TextEncoder().encode((signed.signatures + msg).replace("Hello, signed.", "Hello, changed."));
    expect((await auth(tampered, { sender: "bob@sender.test" })).results).toMatchObject({ dkim: "fail", dmarc: "fail" });
  });
});
