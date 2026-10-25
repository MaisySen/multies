import { describe, it, expect, beforeEach } from "vitest";
import { FakeSmtpServer } from "./fake-mail-servers";
import { dotStuff, smtpSend, smtpVerify, SmtpError } from "@/server/services/connect/smtp";
import { classifyProblem } from "@/server/services/connect/problems";
import { SocketError, LineReader, type MailSocket } from "@/server/services/connect/socket";
import { pickFolders } from "@/server/services/connect/imap";
import { CONNECT_PRESETS, PRESET_ORDER, presetForEmail, serversFor } from "@/shared/mail-connect";
import { composeRaw } from "@/server/services/connect/outbound";
import { makeTestApp, Client } from "./helpers";
import { accessTokenFor, clearTokenCache, oauthAvailable } from "@/server/services/connect/oauth";
import { loadConfig } from "@/server/config";
import { FakeImapServer, FakeSmtpServer as Smtp } from "./fake-mail-servers";
import { mailConnections } from "@/server/db/schema";
import { decryptSecret } from "@/server/lib/crypto";

const server = { host: "smtp.example.com", port: 465, security: "tls" as const };

describe("SMTP client", () => {
  it("signs in with AUTH PLAIN and sends; Bcc only in the envelope", async () => {
    const s = new FakeSmtpServer(); s.accounts.set("me@example.com", "pw");
    const raw = await composeRaw({ from: { address: "me@example.com", name: "Me" }, to: ["a@x.com"], bcc: ["b@x.com"], subject: "Hi", text: "Hello", messageId: "<1@example.com>" });
    const r = await smtpSend(s.opener, server, { user: "me@example.com", secret: "pw" }, { from: "me@example.com", to: ["a@x.com", "b@x.com"] }, raw);
    expect(r.accepted).toEqual(["a@x.com", "b@x.com"]);
    expect(s.sent[0].data).not.toMatch(/^Bcc:/m);
    expect(s.sent[0].data).toContain("Message-ID: <1@example.com>");
  });

  it("falls back to AUTH LOGIN when PLAIN isn't offered", async () => {
    const s = new FakeSmtpServer(); s.accounts.set("u", "p"); s.authMechs = "LOGIN";
    await smtpVerify(s.opener, server, { user: "u", secret: "p" });
    expect(s.transcript.join("\n")).toContain("334 VXNlcm5hbWU6");
  });

  it("upgrades with STARTTLS on 587 and refuses a server that doesn't offer it", async () => {
    const s = new FakeSmtpServer(); s.accounts.set("u", "p");
    await smtpVerify(s.opener, { host: "smtp.example.com", port: 587, security: "starttls" }, { user: "u", secret: "p" });
    expect(s.transcript).toContain("C: STARTTLS");
    s.offerStartTls = false;
    await expect(smtpVerify(s.opener, { host: "smtp.example.com", port: 587, security: "starttls" }, { user: "u", secret: "p" })).rejects.toMatchObject({ stage: "starttls" });
  });

  it("signs in with XOAUTH2 for OAuth connections", async () => {
    const s = new FakeSmtpServer();
    await smtpVerify(s.opener, server, { user: "u@gmail.com", secret: "access-123", xoauth2: true });
    await expect(smtpVerify(s.opener, server, { user: "u@gmail.com", secret: "expired", xoauth2: true })).rejects.toBeInstanceOf(SmtpError);
  });

  it("reports a refused password as an auth error that is not retried", async () => {
    const s = new FakeSmtpServer(); s.accounts.set("u", "p");
    const err = await smtpVerify(s.opener, server, { user: "u", secret: "wrong" }).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.stage).toBe("auth");
    expect(err.code).toBe(535);
    expect(err.retryable).toBe(false);
  });

  it("keeps the accepted recipients when one is refused, fails when all are", async () => {
    const s = new FakeSmtpServer(); s.accounts.set("u", "p"); s.rejectRcpt.add("nobody@x.com");
    const r = await smtpSend(s.opener, server, { user: "u", secret: "p" }, { from: "u", to: ["a@x.com", "nobody@x.com"] }, "Subject: x\r\n\r\nhi");
    expect(r.accepted).toEqual(["a@x.com"]);
    expect(r.rejected[0].address).toBe("nobody@x.com");
    await expect(smtpSend(s.opener, server, { user: "u", secret: "p" }, { from: "u", to: ["nobody@x.com"] }, "x")).rejects.toMatchObject({ stage: "rcpt" });
  });

  it("dot-stuffs lines that start with a dot and ends with CRLF", () => {
    expect(dotStuff("a\n.b\n..c")).toBe("a\r\n..b\r\n...c\r\n");
    expect(dotStuff("x\r\n")).toBe("x\r\n");
  });

  it("a line split across reads, and a server that hangs up, are handled", async () => {
    const chunks = ["250-a\r", "\n250 b\r\n"].map((t) => new TextEncoder().encode(t));
    const sock: MailSocket = { read: async () => chunks.shift() ?? null, write: async () => {}, startTls: async () => sock, close: async () => {} };
    const r = new LineReader(sock);
    expect(await r.line()).toBe("250-a");
    expect(await r.line()).toBe("250 b");
    await expect(r.line()).rejects.toBeInstanceOf(SocketError);
  });

  it("times out a server that never answers", async () => {
    const sock: MailSocket = { read: () => new Promise(() => {}), write: async () => {}, startTls: async () => sock, close: async () => {} };
    await expect(new LineReader(sock, 50).line()).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("connection problems in plain words", () => {
  const cases: [unknown, "imap" | "smtp", string][] = [
    [{ responseText: "[AUTHENTICATIONFAILED] Invalid credentials (Failure)", authenticationFailed: true }, "imap", "auth_failed"],
    [{ responseText: "[ALERT] Application-specific password required" }, "imap", "app_password_needed"],
    [new SmtpError("auth", { code: 534, lines: ["5.7.9 Application-specific password required."] }, "534"), "smtp", "app_password_needed"],
    [{ responseText: "[ALERT] Your account is not enabled for IMAP use." }, "imap", "imap_disabled"],
    [{ responseText: "Login is disabled" }, "imap", "oauth_required"],
    [new SmtpError("auth", { code: 535, lines: ["5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled"] }, "535"), "smtp", "smtp_disabled"],
    [new SocketError("unreachable", "getaddrinfo ENOTFOUND imap.nope.example"), "imap", "unreachable"],
    [new SocketError("tls_failed", "self signed certificate"), "imap", "tls_failed"],
    [new SocketError("timeout", "No answer"), "smtp", "timeout"],
    [new Error("Something odd"), "imap", "server_error"],
  ];
  it.each(cases)("%#: maps to the right code", (err, step, code) => {
    const preset = code === "oauth_required" ? "outlook" : "gmail";
    expect(classifyProblem(err, step, preset, "imap.gmail.com").code).toBe(code);
  });

  it("never repeats the provider's raw text", () => {
    const p = classifyProblem({ responseText: "[AUTHENTICATIONFAILED] Invalid credentials for user ada@gmail.com" }, "imap", "gmail", "imap.gmail.com");
    expect(p.message).not.toContain("ada@gmail.com");
  });

  it("uses no dashes and no jargon codes in any message", () => {
    for (const [err, step] of cases) {
      const m = classifyProblem(err, step, "custom", "mail.example.com").message;
      expect(m).not.toMatch(/[\u2013\u2014]/);
      expect(m).not.toMatch(/AUTHENTICATIONFAILED|5\.7\./);
    }
  });
});

describe("provider presets", () => {
  it("covers every provider the owner listed, plus custom", () => {
    expect(PRESET_ORDER).toEqual(["gmail", "google_workspace", "outlook", "microsoft365", "yahoo", "icloud", "zoho", "fastmail", "gmx", "custom"]);
    for (const id of PRESET_ORDER.filter((x) => x !== "custom")) {
      const p = CONNECT_PRESETS[id];
      expect(p.imap.host).toMatch(/\./);
      expect(p.smtp.host).toMatch(/\./);
      expect([993]).toContain(p.imap.port);
      expect([465, 587]).toContain(p.smtp.port);
      expect(p.smtp.port === 465 ? "tls" : "starttls").toBe(p.smtp.security);
    }
  });

  it("guesses the provider from the address", () => {
    expect(presetForEmail("a@gmail.com")).toBe("gmail");
    expect(presetForEmail("a@hotmail.co.uk")).toBe("outlook");
    expect(presetForEmail("a@yahoo.com.au")).toBe("yahoo");
    expect(presetForEmail("a@me.com")).toBe("icloud");
    expect(presetForEmail("a@zohomail.com")).toBe("zoho");
    expect(presetForEmail("a@fastmail.fm")).toBe("fastmail");
    expect(presetForEmail("a@gmx.de")).toBe("gmx");
    expect(presetForEmail("ceo@acme.com")).toBeNull();
  });

  it("GMX picks the .net servers for gmx.net and gmx.de", () => {
    expect(serversFor("gmx", "a@gmx.de").imap.host).toBe("imap.gmx.net");
    expect(serversFor("gmx", "a@gmx.com").imap.host).toBe("imap.gmx.com");
  });

  it("only Gmail and Microsoft file SMTP mail in Sent by themselves", () => {
    expect(PRESET_ORDER.filter((id) => CONNECT_PRESETS[id].savesSent)).toEqual(["gmail", "google_workspace", "outlook", "microsoft365"]);
  });

  it("finds Sent, Archive and Trash by special use first, then by name", () => {
    expect(pickFolders([{ path: "[Gmail]/Sent Mail", specialUse: "\\Sent" }, { path: "[Gmail]/All Mail", specialUse: "\\All" }, { path: "[Gmail]/Bin", specialUse: "\\Trash" }]))
      .toEqual({ inbox: "INBOX", sent: "[Gmail]/Sent Mail", archive: "[Gmail]/All Mail", trash: "[Gmail]/Bin" });
    expect(pickFolders([{ path: "Sent Items" }, { path: "Deleted Items" }, { path: "Archive" }])).toEqual({ inbox: "INBOX", sent: "Sent Items", trash: "Deleted Items", archive: "Archive" });
  });
});

describe("test only switches", () => {
  it("self-signed certificates and private hosts can't be allowed in production", () => {
    const base = { APP_MODE: "production", APP_SECRET: "s".repeat(40) };
    expect(() => loadConfig({ ...base, MAIL_CONNECT_ALLOW_SELF_SIGNED: "true" })).toThrow(/production/);
    expect(() => loadConfig({ ...base, MAIL_CONNECT_ALLOW_PRIVATE_HOSTS: "true" })).toThrow(/production/);
    expect(loadConfig({ APP_SECRET: "s".repeat(40), MAIL_CONNECT_ALLOW_SELF_SIGNED: "true" }).mailConnect.allowSelfSigned).toBe(true);
  });
});

describe("OAuth for Google and Microsoft (behind MAIL_OAUTH)", () => {
  beforeEach(() => clearTokenCache());
  const GOOGLE = { MAIL_OAUTH: "on", GOOGLE_MAIL_CLIENT_ID: "gid", GOOGLE_MAIL_CLIENT_SECRET: "gsecret", MICROSOFT_MAIL_CLIENT_ID: "mid", MICROSOFT_MAIL_CLIENT_SECRET: "msecret" };
  const idToken = (email: string) => `x.${btoa(JSON.stringify({ email })).replace(/=+$/, "")}.y`;

  it("is off by default: no buttons, start answers 404", async () => {
    const ctx = await makeTestApp();
    expect(oauthAvailable(ctx.deps)).toEqual([]);
    const c = new Client(ctx.app); await c.signup();
    expect((await c.get("/api/connections/oauth/google/start")).status).toBe(404);
  });

  it("with the flag and a client, starts with PKCE and comes back connected", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      if (String(url).includes("oauth2.googleapis.com/token")) {
        const b = new URLSearchParams(String(init.body));
        if (b.get("grant_type") === "authorization_code") return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, id_token: idToken("ada@gmail.com") });
        return Response.json({ access_token: "access-2", expires_in: 3600 });
      }
      throw new Error("no network");
    }) as unknown as typeof fetch;
    const ctx = await makeTestApp(GOOGLE, { fetch: fetchImpl });
    const imap = new FakeImapServer().addAccount("ada@gmail.com", "unused");
    ctx.deps.imap = imap.connector; ctx.deps.openSocket = new Smtp().opener;
    expect(oauthAvailable(ctx.deps)).toEqual(["google", "microsoft"]);
    const c = new Client(ctx.app); await c.signup();
    const start = await ctx.app.request("/api/connections/oauth/google/start", { headers: { cookie: c.cookie, host: "localhost" } });
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("scope")).toContain("https://mail.google.com/");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("access_type")).toBe("offline");
    const state = loc.searchParams.get("state")!;
    const back = await ctx.app.request(`/api/connections/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: c.cookie, host: "localhost" } });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toContain("connected=ada%40gmail.com");
    const row = (await ctx.db.select().from(mailConnections).get())!;
    expect(row).toMatchObject({ authKind: "oauth", provider: "gmail", email: "ada@gmail.com" });
    expect(await decryptSecret(ctx.deps.config.appSecret, row.secretEnc)).toBe("refresh-1");
    // The code swap carried the PKCE verifier.
    expect(calls.find((x) => x.body.includes("authorization_code"))!.body).toContain("code_verifier=");
    // Access tokens are refreshed once and reused while fresh.
    expect(await accessTokenFor(ctx.deps, row, "refresh-1")).toBe("access-2");
    const n = calls.length;
    expect(await accessTokenFor(ctx.deps, row, "refresh-1")).toBe("access-2");
    expect(calls.length).toBe(n);
  });

  it("refuses a state from another person or a tampered one", async () => {
    const ctx = await makeTestApp(GOOGLE);
    const c = new Client(ctx.app); await c.signup();
    const start = await ctx.app.request("/api/connections/oauth/google/start", { headers: { cookie: c.cookie, host: "localhost" } });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const eve = new Client(ctx.app); await eve.signup();
    const r1 = await ctx.app.request(`/api/connections/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: eve.cookie, host: "localhost" } });
    expect(decodeURIComponent(r1.headers.get("location")!.replace(/\+/g, " "))).toMatch(/expired or belongs to someone else/);
    const r2 = await ctx.app.request("/api/connections/oauth/google/callback?code=abc&state=garbage", { headers: { cookie: c.cookie, host: "localhost" } });
    expect(decodeURIComponent(r2.headers.get("location")!.replace(/\+/g, " "))).toMatch(/not valid/);
    const r3 = await ctx.app.request("/api/connections/oauth/google/callback?error=access_denied", { headers: { cookie: c.cookie, host: "localhost" } });
    expect(decodeURIComponent(r3.headers.get("location")!.replace(/\+/g, " "))).toMatch(/cancelled/);
  });

  it("Microsoft uses its own endpoints and IMAP and SMTP scopes", async () => {
    const ctx = await makeTestApp(GOOGLE);
    const c = new Client(ctx.app); await c.signup();
    const start = await ctx.app.request("/api/connections/oauth/microsoft/start", { headers: { cookie: c.cookie, host: "localhost" } });
    const loc = new URL(start.headers.get("location")!);
    expect(loc.host).toBe("login.microsoftonline.com");
    expect(loc.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(loc.searchParams.get("scope")).toContain("IMAP.AccessAsUser.All");
    expect(loc.searchParams.get("scope")).toContain("SMTP.Send");
  });
});
