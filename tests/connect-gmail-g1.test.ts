import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { mailConnections, users } from "@/server/db/schema";
import { syncConnection } from "@/server/services/connect/sync";
import { classifyProblem } from "@/server/services/connect/problems";
import { SmtpError } from "@/server/services/connect/smtp";
import { cleanAppPassword } from "@/shared/mail-connect";

/*
 * G1: Gmail app password sign in. The answers below are Gmail's own, as its servers sent them on 12 Nov 2026
 * (IMAP on 993 and SMTP on 465 and 587, from a local Workers runtime, with a made up address and code).
 */
const GMAIL = "ada.lovelace@gmail.com";
const PW = "abcd efgh ijkl mnop";
const IMAP_BAD = { message: "Command failed", responseText: "Invalid credentials (Failure)", serverResponseCode: "AUTHENTICATIONFAILED", authenticationFailed: true };
const SMTP_BAD = new SmtpError("auth", { code: 535, lines: ["5.7.8 Username and Password not accepted. For more information, go to", "5.7.8  https://support.google.com/mail/?p=BadCredentials 98e67ed59e1d1-3b197d27d26sm2360566a91.13 - gsmtp"] },
  "535 5.7.8 Username and Password not accepted. For more information, go to 5.7.8  https://support.google.com/mail/?p=BadCredentials 98e67ed59e1d1-3b197d27d26sm2360566a91.13 - gsmtp");
const IMAP_WEB = { message: "Command failed", responseText: "Please log in via your web browser: https://support.google.com/mail/accounts/answer/78754 (Failure)", serverResponseCode: "WEBALERT", authenticationFailed: true };
const SMTP_WEB = new SmtpError("auth", { code: 534, lines: ["5.7.14 <https://accounts.google.com/signin/continue?sarp=1&scc=1&plt=AKgnsbt> Please log in via your web browser and", "5.7.14 then try again. 98e67ed59e1d1-3b197d27d26sm2360566a91.13 - gsmtp"] }, "534 5.7.14 Please log in via your web browser");

describe("G1: Gmail sign in problems say what Google said", () => {
  it("shows Google's own reason for a refused app password, cleaned", () => {
    const p = classifyProblem(IMAP_BAD, "imap", "gmail", "imap.gmail.com");
    expect(p.code).toBe("auth_failed");
    expect(p.detail).toBe("Invalid credentials");
  });

  it("says the app password has to come from the same Google account", () => {
    const p = classifyProblem(IMAP_BAD, "imap", "gmail", "imap.gmail.com");
    expect(p.message).toMatch(/same Google account/);
    expect(p.message).toContain("myaccount.google.com/apppasswords");
  });

  it("cleans SMTP answers of links, request ids and status numbers", () => {
    const p = classifyProblem(SMTP_BAD, "smtp", "gmail", "smtp.gmail.com");
    expect(p.detail).toBe("Username and Password not accepted. For more information, go to");
    expect(p.detail).not.toMatch(/https?:|gsmtp|5\.7\.|535|98e67/);
  });

  it("tells a blocked sign in (Google wants the person to approve it in a browser) apart from a wrong password", () => {
    for (const [err, step] of [[IMAP_WEB, "imap"], [SMTP_WEB, "smtp"]] as const) {
      const p = classifyProblem(err, step, "gmail", step === "imap" ? "imap.gmail.com" : "smtp.gmail.com");
      expect(p.code).toBe("web_login_required");
      expect(p.message).toMatch(/browser/);
      expect(p.message).not.toMatch(/didn't accept that address and password/);
    }
  });

  it("never shows an address, a link or a network address in the detail", () => {
    const p = classifyProblem({ responseText: "[AUTHENTICATIONFAILED] Invalid credentials for ada@gmail.com from 34.169.219.26 see https://x.example/a (Failure)", authenticationFailed: true }, "imap", "gmail", "imap.gmail.com");
    expect(p.detail).toBe("Invalid credentials for from see");
    expect(p.detail).not.toMatch(/@|https?:|\d+\.\d+\.\d+\.\d+/);
  });

  it("leaves out a detail with nothing useful in it", () => {
    expect(classifyProblem(new Error("Command failed"), "imap", "gmail", "imap.gmail.com").detail).toBeUndefined();
  });
});

describe("G1: a pasted app password is cleaned", () => {
  it("turns non breaking spaces, zero width characters and a trailing line break into Google's own format", () => {
    expect(cleanAppPassword("gmail", "abcd\u00a0efgh\u00a0ijkl\u00a0mnop")).toBe(PW);
    expect(cleanAppPassword("gmail", "\u200babcdefghijklmnop\n")).toBe(PW);
    expect(cleanAppPassword("google_workspace", " abcd efgh ijkl mnop ")).toBe(PW);
  });
  it("leaves anything that is not a 16 letter code, and other providers, as typed", () => {
    expect(cleanAppPassword("gmail", "my normal password ")).toBe("my normal password ");
    expect(cleanAppPassword("custom", "abcd\u00a0efgh\u00a0ijkl\u00a0mnop")).toBe("abcd\u00a0efgh\u00a0ijkl\u00a0mnop");
  });

  it("a code pasted with non breaking spaces connects", async () => {
    const ctx = await makeTestApp();
    const imap = new FakeImapServer().addAccount(GMAIL, PW);
    const smtp = new FakeSmtpServer();
    smtp.accounts.set(GMAIL, PW);
    ctx.deps.imap = imap.connector;
    ctx.deps.openSocket = smtp.opener;
    const c = new Client(ctx.app);
    const email = await c.signup(undefined, "Ada Lovelace", "Acme");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
    const r = await c.post("/api/connections/test", { email: GMAIL, password: "abcd\u00a0efgh\u00a0ijkl\u00a0mnop\n" });
    expect(r.status).toBe(200);
  });

  it("the API answer carries Google's reason beside the step", async () => {
    const ctx = await makeTestApp();
    const imap = new FakeImapServer().addAccount(GMAIL, PW);
    ctx.deps.imap = imap.connector;
    ctx.deps.openSocket = new FakeSmtpServer().opener;
    const c = new Client(ctx.app);
    const email = await c.signup(undefined, "Ada Lovelace", "Acme");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
    const r = await c.post("/api/connections/test", { email: GMAIL, password: "wrong wrong wrong" });
    expect(r.status).toBe(422);
    expect(r.body.error.details).toEqual({ step: "imap", detail: "Invalid credentials" });
  });
});

describe("G1: a sign in Google paused during a later sync", () => {
  it("waits for the person (like a refused password) instead of trying again every few minutes", async () => {
    const ctx = await makeTestApp();
    const imap = new FakeImapServer().addAccount(GMAIL, PW);
    const smtp = new FakeSmtpServer();
    smtp.accounts.set(GMAIL, PW);
    ctx.deps.imap = imap.connector;
    ctx.deps.openSocket = smtp.opener;
    const c = new Client(ctx.app);
    const email = await c.signup(undefined, "Ada Lovelace", "Acme");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
    expect((await c.post("/api/connections", { email: GMAIL, password: PW })).status).toBe(201);
    const row = (await ctx.db.select().from(mailConnections).get())!;
    imap.loginError = "[WEBALERT] Please log in via your web browser: https://support.google.com/mail/accounts/answer/78754 (Failure)";
    const r = await syncConnection(ctx.deps, row.id);
    expect(r.skipped).toBe("auth_failed");
    const after = (await ctx.db.select().from(mailConnections).get())!;
    expect(after.status).toBe("auth_failed");
    expect(after.lastError).toMatch(/browser/);
  });
});
