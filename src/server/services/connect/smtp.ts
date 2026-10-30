/**
 * SMTP submission to a person's own provider (RFC 5321, 3207 STARTTLS, 4954 AUTH, 6409 submission).
 *
 * Nodemailer builds the message (its MIME composer runs on Workers); this sends it. Nodemailer's
 * own SMTP transport could not open sockets on Workers (checked in wrangler dev on 25 October 2026:
 * "proxy request failed" on 465 and 587 while cloudflare:sockets reached the same servers), so the
 * conversation itself runs over MailSocket, the same code on Workers and Node.
 */
import { LineReader, SocketError, type MailSocket, type SocketOpener } from "./socket";
import type { ServerSettings } from "@/shared/mail-connect";

export interface SmtpAuth {
  user: string;
  /** An app password, or an OAuth access token when `xoauth2` is set. */
  secret: string;
  xoauth2?: boolean;
}

export interface SmtpReply { code: number; lines: string[] }

export class SmtpError extends Error {
  constructor(public stage: "connect" | "greeting" | "ehlo" | "starttls" | "auth" | "mail" | "rcpt" | "data", public reply: SmtpReply | null, message: string) {
    super(message);
    this.name = "SmtpError";
  }
  get code() { return this.reply?.code ?? 0; }
  /** 4xx replies and broken connections are worth another try later; 5xx are not. */
  get retryable() { return !this.reply || (this.code >= 400 && this.code < 500); }
}

const enc = new TextEncoder();
const b64 = (s: string) => btoa(String.fromCharCode(...enc.encode(s)));

class Session {
  private r: LineReader;
  caps = new Set<string>();
  authMechs = new Set<string>();
  constructor(private sock: MailSocket, timeoutMs: number) { this.r = new LineReader(sock, timeoutMs); }

  async reply(): Promise<SmtpReply> {
    const lines: string[] = [];
    for (;;) {
      const l = await this.r.line();
      const m = /^(\d{3})([ -])(.*)$/.exec(l);
      if (!m) throw new SocketError("closed", `Unexpected answer from the mail server: ${l.slice(0, 120)}`);
      lines.push(m[3]);
      if (m[2] === " ") return { code: Number(m[1]), lines };
    }
  }

  async send(line: string) { await this.sock.write(enc.encode(`${line}\r\n`)); }

  async writeRaw(text: string) { await this.sock.write(enc.encode(text)); }

  async cmd(line: string, stage: SmtpError["stage"], expect: number[]): Promise<SmtpReply> {
    await this.send(line);
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new SmtpError(stage, r, `${r.code} ${r.lines.join(" ")}`);
    return r;
  }

  async ehlo(name: string) {
    const r = await this.cmd(`EHLO ${name}`, "ehlo", [250]);
    this.caps.clear(); this.authMechs.clear();
    for (const l of r.lines.slice(1)) {
      const [k, ...rest] = l.toUpperCase().split(/\s+/);
      this.caps.add(k);
      if (k === "AUTH") rest.forEach((m) => this.authMechs.add(m));
    }
  }

  async upgrade() {
    this.sock = await this.sock.startTls();
    this.r.reset(this.sock);
  }

  async close() {
    try { await this.send("QUIT"); } catch { /* closing anyway */ }
    await this.sock.close();
  }
}

/** Opens a session and signs in: the connection test and the first half of every send. */
async function open(openSocket: SocketOpener, server: ServerSettings, auth: SmtpAuth, opts: { timeoutMs?: number; heloName?: string }) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const sock = await openSocket({ host: server.host, port: server.port, security: server.security, timeoutMs });
  const s = new Session(sock, timeoutMs);
  try {
    const greet = await s.reply();
    if (greet.code !== 220) throw new SmtpError("greeting", greet, `${greet.code} ${greet.lines.join(" ")}`);
    const helo = opts.heloName ?? "multies.si";
    await s.ehlo(helo);
    if (server.security === "starttls") {
      if (!s.caps.has("STARTTLS")) throw new SmtpError("starttls", null, "The server does not offer STARTTLS, so the password would travel unencrypted.");
      await s.cmd("STARTTLS", "starttls", [220]);
      await s.upgrade();
      await s.ehlo(helo);
    }
    if (auth.xoauth2) {
      await s.cmd(`AUTH XOAUTH2 ${b64(`user=${auth.user}\x01auth=Bearer ${auth.secret}\x01\x01`)}`, "auth", [235]);
    } else if (s.authMechs.has("PLAIN") || !s.authMechs.has("LOGIN")) {
      await s.cmd(`AUTH PLAIN ${b64(`\0${auth.user}\0${auth.secret}`)}`, "auth", [235]);
    } else {
      await s.cmd("AUTH LOGIN", "auth", [334]);
      await s.cmd(b64(auth.user), "auth", [334]);
      await s.cmd(b64(auth.secret), "auth", [235]);
    }
    return s;
  } catch (e) {
    await s.close().catch(() => undefined);
    throw e;
  }
}

/** Signs in and out again: proves the SMTP settings and password work. */
export async function smtpVerify(openSocket: SocketOpener, server: ServerSettings, auth: SmtpAuth, opts: { timeoutMs?: number } = {}) {
  const s = await open(openSocket, server, auth, opts);
  await s.close();
}

/** Dot-stuffs a message and makes sure it ends with CRLF (RFC 5321 4.5.2). */
export function dotStuff(raw: string): string {
  const crlf = raw.replace(/\r?\n/g, "\r\n");
  const stuffed = crlf.replace(/^\./gm, "..");
  return stuffed.endsWith("\r\n") ? stuffed : `${stuffed}\r\n`;
}

export interface SmtpSendResult { accepted: string[]; rejected: { address: string; reply: string }[]; response: string }

/** Sends one message. Throws SmtpError when nothing was accepted. */
export async function smtpSend(openSocket: SocketOpener, server: ServerSettings, auth: SmtpAuth, envelope: { from: string; to: string[] }, raw: string, opts: { timeoutMs?: number } = {}): Promise<SmtpSendResult> {
  const s = await open(openSocket, server, auth, opts);
  try {
    await s.cmd(`MAIL FROM:<${envelope.from}>`, "mail", [250]);
    const accepted: string[] = [];
    const rejected: SmtpSendResult["rejected"] = [];
    let last: SmtpError | null = null;
    for (const to of envelope.to) {
      try { await s.cmd(`RCPT TO:<${to}>`, "rcpt", [250, 251]); accepted.push(to); } catch (e) {
        if (!(e instanceof SmtpError)) throw e;
        last = e;
        rejected.push({ address: to, reply: e.message });
      }
    }
    if (!accepted.length) throw last ?? new SmtpError("rcpt", null, "No recipient was accepted.");
    await s.cmd("DATA", "data", [354]);
    await s.writeRaw(dotStuff(raw));
    const done = await s.cmd(".", "data", [250]);
    return { accepted, rejected, response: `${done.code} ${done.lines.join(" ")}` };
  } finally {
    await s.close().catch(() => undefined);
  }
}
