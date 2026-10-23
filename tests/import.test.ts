import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { folderFor } from "@/server/services/import";

const TOKEN = "runner-token-0123456789abcdef";
const raw = (id: string, subject: string) => new TextEncoder().encode(
  `Message-ID: <${id}@old.example>\r\nFrom: Old Friend <friend@old.example>\r\nTo: me@acme.io\r\nSubject: ${subject}\r\nDate: Tue, 1 Sep 2026 09:00:00 +1000\r\nContent-Type: text/plain\r\n\r\nHello from the old inbox.\r\n`);

async function setup(env: Record<string, string> = { IMPORT_RUNNER_TOKEN: TOKEN }) {
  const ctx = await makeTestApp(env);
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const box = (await c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" })).body.mailbox;
  const runner = (path: string, body?: BodyInit, headers: Record<string, string> = {}) =>
    ctx.app.request(`/api/import-runner${path}`, { method: "POST", headers: { host: "localhost", authorization: `Bearer ${TOKEN}`, ...headers }, body });
  return { ctx, c, box, runner };
}

describe("mail import", () => {
  it("is off without a runner token", async () => {
    const { c, box } = await setup({});
    expect((await c.get("/api/imports")).body.enabled).toBe(false);
    expect((await c.post("/api/imports", { mailboxId: box.id, provider: "gmail", sourceUser: "me@gmail.com", appPassword: "abcd efgh ijkl mnop" })).body.error.code).toBe("import_off");
  });

  it("queues a Gmail import, hands it to the runner, stores messages once and wipes the password", async () => {
    const { ctx, c, box, runner } = await setup();
    const made = await c.post("/api/imports", { mailboxId: box.id, provider: "gmail", sourceUser: "me@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    expect(made.status).toBe(201);
    expect(made.body.import).toMatchObject({ status: "queued", sourceHost: "imap.gmail.com" });
    expect(JSON.stringify(made.body)).not.toContain("abcd");
    expect((await c.post("/api/imports", { mailboxId: box.id, provider: "gmail", sourceUser: "me@gmail.com", appPassword: "x".repeat(16) })).status).toBe(409);

    expect((await ctx.app.request("/api/import-runner/claim", { method: "POST", headers: { host: "localhost", authorization: "Bearer wrong-token-wrong-token-1234" } })).status).toBe(401);
    const claimed = await (await runner("/claim")).json();
    expect(claimed.job).toMatchObject({ mailbox: "me@acme.io", source: { host: "imap.gmail.com", port: 993, user: "me@gmail.com", password: "abcd efgh ijkl mnop" } });
    expect((await runner("/claim")).status).toBe(204);
    const id = claimed.job.id;
    await runner(`/jobs/${id}/progress`, JSON.stringify({ total: 3 }), { "content-type": "application/json" });
    expect((await runner(`/jobs/${id}/messages`, raw("a1", "Old news"), { "x-mymail-folder": "INBOX" })).status).toBe(201);
    expect((await runner(`/jobs/${id}/messages`, raw("a2", "My reply"), { "x-mymail-folder": "[Gmail]/Sent Mail" })).status).toBe(201);
    const dup = await runner(`/jobs/${id}/messages`, raw("a1", "Old news"), { "x-mymail-folder": "[Gmail]/All Mail" });
    expect((await dup.json()).reason).toBe("duplicate");
    await runner(`/jobs/${id}/finish`, JSON.stringify({}), { "content-type": "application/json" });

    const list = (await c.get("/api/imports")).body.imports[0];
    expect(list).toMatchObject({ status: "done", messagesDone: 3, messagesTotal: 3 });
    const inbox = (await c.get(`/api/mail/messages?mailboxId=${box.id}&folder=inbox`)).body.messages;
    expect(inbox.map((m: { subject: string }) => m.subject)).toEqual(["Old news"]);
    expect((await c.get(`/api/mail/messages?mailboxId=${box.id}&folder=sent`)).body.messages[0].subject).toBe("My reply");
    const row = await ctx.db.query.importJobs.findFirst();
    expect(row?.secretEnc).toBeNull();
    // A finished job takes no more messages.
    expect((await runner(`/jobs/${id}/messages`, raw("a3", "Late"), {})).status).toBe(409);
  });

  it("maps folder names", () => {
    expect(["INBOX", "Sent Items", "[Gmail]/All Mail", "Junk Email", "Deleted Items", "Projects/2024"].map(folderFor)).toEqual(["inbox", "sent", "archive", "spam", "trash", "archive"]);
  });
});

describe("Xero", () => {
  it("is hidden until configured, then connects with OAuth and lists unpaid invoices", async () => {
    const off = await setup();
    expect((await off.c.get("/api/integrations")).body.xero).toEqual({ configured: false, connected: false });
    const calls: string[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u}`);
      if (u.includes("/connect/token")) return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 1800 });
      if (u.endsWith("/connections")) return Response.json([{ tenantId: "t1", tenantName: "Bondi Plumbing", tenantType: "ORGANISATION" }]);
      if (u.includes("/Invoices")) return Response.json({ Invoices: [{ InvoiceNumber: "INV-1042", AmountDue: 1850, CurrencyCode: "AUD", DueDateString: "2026-10-14T00:00:00", Contact: { Name: "Tom Nguyen", EmailAddress: "tom@example.com" } }] });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const ctx = await makeTestApp({ XERO_CLIENT_ID: "cid", XERO_CLIENT_SECRET: "csecret" }, { fetch: fake });
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const go = await ctx.app.request("/api/integrations/xero/connect", { headers: { host: "localhost", cookie: c.cookie } });
    expect(go.status).toBe(302);
    const to = new URL(go.headers.get("location")!);
    expect(to.host).toBe("login.xero.com");
    expect(to.searchParams.get("scope")).toContain("accounting.transactions.read");
    const state = to.searchParams.get("state")!;
    const stateCookie = go.headers.get("set-cookie")!.split(";")[0];
    const back = await ctx.app.request(`/api/integrations/xero/callback?code=abc&state=${state}`, { headers: { host: "localhost", cookie: `${c.cookie}; ${stateCookie}` } });
    expect(back.headers.get("location")).toBe("/app/settings/general?xero=connected");
    expect((await c.get("/api/integrations")).body.xero).toEqual({ configured: true, connected: true, tenantName: "Bondi Plumbing" });
    expect((await c.get("/api/integrations/xero/invoices")).body.invoices).toEqual([{ invoiceNumber: "INV-1042", customerName: "Tom Nguyen", email: "tom@example.com", amount: 1850, currency: "AUD", dueDate: "2026-10-14" }]);
    // A forged state is refused.
    const bad = await ctx.app.request("/api/integrations/xero/callback?code=abc&state=forged", { headers: { host: "localhost", cookie: `${c.cookie}; ${stateCookie}` } });
    expect(bad.headers.get("location")).toBe("/app/settings/general?xero=failed");
    expect(calls.some((x) => x.startsWith("POST https://identity.xero.com/connect/token"))).toBe(true);
  });
});
