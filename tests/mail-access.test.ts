import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { fakeStalwart } from "./fake-stalwart";
import { deliverInbound } from "@/server/services/mail/delivery";
import { parseMime } from "@/server/services/mail/mime";

describe("mail app access (Stalwart)", () => {
  let server: ReturnType<typeof fakeStalwart>;
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let c: Client;
  let mailboxId: string;

  beforeEach(async () => {
    server = fakeStalwart();
    ctx = await makeTestApp({ ...server.env, MAIL_CLIENT_HOST: "mail.acme-hosting.net" }, { fetch: server.fetch });
    c = new Client(ctx.app);
    await c.signup();
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" })).body.mailbox.id;
  });

  it("reports the settings a mail app needs", async () => {
    const r = await c.get("/api/mail-access");
    expect(r.body).toMatchObject({ enabled: true, imap: { host: "mail.acme-hosting.net", port: 993 }, smtp: { host: "mail.acme-hosting.net", port: 465, security: "ssl" } });
  });

  it("provisions the server account on first app password, then reuses it", async () => {
    const first = await c.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "MacBook" });
    expect(first.status).toBe(201);
    expect(first.body.username).toBe("ada@acme.io");
    expect(first.body.secret).toMatch(/^app_/);
    expect(first.body.appPassword).toMatchObject({ name: "MacBook", hint: first.body.secret.slice(-4) });
    expect(server.accounts.size).toBe(1);
    const acct = [...server.accounts.values()][0];
    expect(acct.quota).toBe(1024 * 1024 * 1024);
    await c.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "iPhone" });
    expect(server.accounts.size).toBe(1);
    expect(acct.appPasswords.size).toBe(2);
    const list = await c.get(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`);
    expect(list.body.appPasswords.map((p: { name: string }) => p.name).sort()).toEqual(["MacBook", "iPhone"]);
    // The secret is never listed again.
    expect(JSON.stringify(list.body)).not.toContain(first.body.secret);
  });

  it("revokes an app password on the server", async () => {
    const made = await c.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "Outlook" });
    const acct = [...server.accounts.values()][0];
    expect(acct.appPasswords.size).toBe(1);
    expect((await c.del(`/api/mail-access/app-passwords/${made.body.appPassword.id}`)).status).toBe(200);
    expect(acct.appPasswords.size).toBe(0);
    expect((await c.get(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`)).body.appPasswords).toEqual([]);
  });

  it("removes the server account when the mailbox is deleted, and keeps quotas in sync", async () => {
    await c.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "Outlook" });
    await c.patch(`/api/mailboxes/${mailboxId}`, { quotaMb: 512 });
    expect([...server.accounts.values()][0].quota).toBe(512 * 1024 * 1024);
    expect((await c.del(`/api/mailboxes/${mailboxId}`)).status).toBe(200);
    expect(server.accounts.size).toBe(0);
  });

  it("copies inbound mail into the server account once mail apps are on", async () => {
    await c.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "Outlook" });
    const raw = new TextEncoder().encode("From: bob@example.com\r\nTo: ada@acme.io\r\nSubject: Hi\r\nMessage-ID: <x1@example.com>\r\n\r\nHello\r\n");
    await deliverInbound(ctx.deps, { envelopeFrom: "bob@example.com", rcptTo: "ada@acme.io", email: await parseMime(raw), sizeBytes: raw.length, via: "test", raw });
    expect([...server.accounts.values()][0].inbox).toHaveLength(1);
  });

  it("validates input and hides other workspaces' mailboxes", async () => {
    expect((await c.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "" })).status).toBe(422);
    const other = new Client(ctx.app);
    await other.signup();
    expect((await other.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "x" })).status).toBe(404);
  });
});

describe("mail app access without a mail server", () => {
  it("says so plainly and refuses to create app passwords", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup();
    expect((await c.get("/api/mail-access")).body).toMatchObject({ enabled: false, missing: ["STALWART_URL", "STALWART_ADMIN_USER", "STALWART_ADMIN_SECRET"] });
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" })).body.mailbox.id;
    const r = await c.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "x" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("mail_server_not_connected");
    // Deleting a mailbox still works when no server was ever connected.
    expect((await c.del(`/api/mailboxes/${mailboxId}`)).status).toBe(200);
  });
});
