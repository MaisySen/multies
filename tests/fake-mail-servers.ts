/**
 * In-memory IMAP and SMTP servers for the connected mailbox tests (round 18). The IMAP one stands
 * behind the ImapSession interface the sync engine uses; the SMTP one speaks real SMTP lines over a
 * MailSocket, so the SMTP client is exercised byte for byte. The live test against a real server is
 * tests/connect.live.test.ts.
 */
import type { FetchedMessage, FolderPaths, ImapConnector, ImapSession } from "@/server/services/connect/imap";
import type { MailSocket, SocketOpener } from "@/server/services/connect/socket";
import { SocketError } from "@/server/services/connect/socket";

interface Stored { uid: number; flags: Set<string>; raw: string; internalDate: Date }
interface Folder { uidValidity: string; uidNext: number; msgs: Stored[]; specialUse?: string }

export class FakeImapServer {
  accounts = new Map<string, { password: string; folders: Map<string, Folder> }>();
  /** When set, sign in fails with this text (as a provider's NO answer). */
  loginError: string | null = null;
  unreachable = false;
  logins = 0;
  actions: string[] = [];

  addAccount(user: string, password: string, opts: { sentPath?: string } = {}) {
    const folders = new Map<string, Folder>();
    folders.set("INBOX", { uidValidity: "1001", uidNext: 1, msgs: [] });
    folders.set(opts.sentPath ?? "Sent", { uidValidity: "2002", uidNext: 1, msgs: [], specialUse: "\\Sent" });
    folders.set("Archive", { uidValidity: "3003", uidNext: 1, msgs: [], specialUse: "\\Archive" });
    folders.set("Trash", { uidValidity: "4004", uidNext: 1, msgs: [], specialUse: "\\Trash" });
    this.accounts.set(user, { password, folders });
    return this;
  }

  deliver(user: string, raw: string, opts: { folder?: string; flags?: string[]; date?: Date } = {}) {
    const f = this.accounts.get(user)!.folders.get(opts.folder ?? "INBOX")!;
    const uid = f.uidNext++;
    f.msgs.push({ uid, flags: new Set(opts.flags ?? []), raw, internalDate: opts.date ?? new Date() });
    return uid;
  }

  folder(user: string, path: string) { return this.accounts.get(user)!.folders.get(path)!; }

  connector: ImapConnector = async (_server, auth) => {
    if (this.unreachable) throw new SocketError("unreachable", "connect ECONNREFUSED");
    const acct = this.accounts.get(auth.user);
    if (this.loginError) throw Object.assign(new Error("Command failed"), { responseText: this.loginError, authenticationFailed: /AUTHENTICATIONFAILED|Invalid credentials/i.test(this.loginError) });
    if (!acct || (acct.password !== auth.secret && !(auth.xoauth2 && auth.secret.startsWith("access-")))) {
      throw Object.assign(new Error("Command failed"), { responseText: "[AUTHENTICATIONFAILED] Invalid credentials (Failure)", authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
    }
    this.logins++;
    let open: Folder | null = null;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this;
    const session: ImapSession = {
      async folders(): Promise<FolderPaths> {
        const out: FolderPaths = { inbox: "INBOX" };
        for (const [path, f] of acct.folders) {
          if (f.specialUse === "\\Sent") out.sent = path;
          if (f.specialUse === "\\Archive") out.archive = path;
          if (f.specialUse === "\\Trash") out.trash = path;
        }
        return out;
      },
      async open(path) { open = acct.folders.get(path)!; return { uidValidity: open.uidValidity, uidNext: open.uidNext }; },
      async searchSince(since) { return open!.msgs.filter((m) => m.internalDate >= since).map((m) => m.uid); },
      async uidsAfter(uid) { return open!.msgs.filter((m) => m.uid > uid).map((m) => m.uid); },
      async fetch(uids, maxBytes) {
        return open!.msgs.filter((m) => uids.includes(m.uid)).map((m): FetchedMessage => {
          const size = Buffer.byteLength(m.raw);
          const subject = /^Subject: (.*)$/m.exec(m.raw)?.[1];
          return { uid: m.uid, flags: new Set(m.flags), size, source: size <= maxBytes ? new TextEncoder().encode(m.raw) : undefined, envelope: { subject, messageId: /^Message-ID: (.*)$/mi.exec(m.raw)?.[1]?.trim(), date: m.internalDate, from: { address: "big@example.com" } } };
        });
      },
      async flags(lo, hi) { return new Map(open!.msgs.filter((m) => m.uid >= lo && m.uid <= hi).map((m) => [m.uid, new Set(m.flags)])); },
      async addFlags(uids, flags) { if (!uids.length) return; server.actions.push(`+${flags.join(",")}:${uids.join(",")}`); for (const m of open!.msgs) if (uids.includes(m.uid)) flags.forEach((f) => m.flags.add(f)); },
      async removeFlags(uids, flags) { if (!uids.length) return; server.actions.push(`-${flags.join(",")}:${uids.join(",")}`); for (const m of open!.msgs) if (uids.includes(m.uid)) flags.forEach((f) => m.flags.delete(f)); },
      async move(uids, dest) {
        if (!uids.length) return;
        server.actions.push(`move:${uids.join(",")}>${dest}`);
        const to = acct.folders.get(dest)!;
        for (const m of open!.msgs.filter((x) => uids.includes(x.uid))) to.msgs.push({ ...m, uid: to.uidNext++ });
        open!.msgs = open!.msgs.filter((x) => !uids.includes(x.uid));
      },
      async append(path, raw, flags) {
        server.actions.push(`append:${path}`);
        const f = acct.folders.get(path)!;
        f.msgs.push({ uid: f.uidNext++, flags: new Set(flags), raw: typeof raw === "string" ? raw : new TextDecoder().decode(raw), internalDate: new Date() });
      },
      async hasMessageId(id) { return open!.msgs.some((m) => m.raw.includes(`Message-ID: ${id}`)); },
      async close() { /* nothing to close */ },
    };
    return session;
  };
}

export interface SentMail { from: string; to: string[]; data: string; user: string }

/** An SMTP submission server that speaks over in-memory sockets. */
export class FakeSmtpServer {
  accounts = new Map<string, string>();
  sent: SentMail[] = [];
  /** Reply to AUTH when set, for example "535 5.7.8 Username and Password not accepted". */
  authReply: string | null = null;
  rejectRcpt = new Set<string>();
  offerStartTls = true;
  authMechs = "PLAIN LOGIN XOAUTH2";
  transcript: string[] = [];
  /** Called for every accepted message (deliver to a fake IMAP inbox, say). */
  onMessage?: (m: SentMail) => void;

  opener: SocketOpener = async (opts) => new FakeSmtpSocket(this, opts.security === "tls");
}

class FakeSmtpSocket implements MailSocket {
  private out: Uint8Array[] = [];
  private waiting: ((v: Uint8Array | null) => void)[] = [];
  private buf = "";
  private mode: "cmd" | "data" | "authLoginUser" | "authLoginPass" = "cmd";
  private user = "";
  private authed = false;
  private from = "";
  private to: string[] = [];
  private data: string[] = [];
  private closed = false;
  constructor(private s: FakeSmtpServer, private secure: boolean) { this.reply("220 fake.smtp ESMTP ready"); }

  private reply(line: string) {
    this.s.transcript.push(`S: ${line.split("\r\n")[0]}`);
    const bytes = new TextEncoder().encode(`${line}\r\n`);
    const w = this.waiting.shift();
    if (w) w(bytes); else this.out.push(bytes);
  }
  async read() {
    const o = this.out.shift();
    if (o) return o;
    if (this.closed) return null;
    return new Promise<Uint8Array | null>((r) => this.waiting.push(r));
  }
  async write(data: Uint8Array) {
    this.buf += new TextDecoder().decode(data);
    let i;
    while ((i = this.buf.indexOf("\r\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.line(line);
    }
  }
  private line(l: string) {
    if (this.mode === "data") {
      if (l === ".") {
        const m = { from: this.from, to: [...this.to], data: this.data.join("\r\n"), user: this.user };
        this.s.sent.push(m);
        this.s.onMessage?.(m);
        this.mode = "cmd"; this.data = []; this.to = [];
        this.reply("250 2.0.0 OK queued");
      } else this.data.push(l.startsWith("..") ? l.slice(1) : l);
      return;
    }
    this.s.transcript.push(`C: ${/^AUTH|^[A-Za-z0-9+/=]{12,}$/.test(l) ? "(auth)" : l}`);
    if (this.mode === "authLoginUser") { this.user = atob(l); this.mode = "authLoginPass"; this.reply("334 UGFzc3dvcmQ6"); return; }
    if (this.mode === "authLoginPass") { this.mode = "cmd"; this.finishAuth(this.user, atob(l)); return; }
    const [verb, ...rest] = l.split(" ");
    switch (verb.toUpperCase()) {
      case "EHLO": {
        const caps = ["250-fake.smtp", ...(this.secure || !this.s.offerStartTls ? [] : ["250-STARTTLS"]), "250-PIPELINING", `250 AUTH ${this.s.authMechs}`];
        this.reply(caps.join("\r\n")); return;
      }
      case "STARTTLS": this.reply("220 2.0.0 Ready to start TLS"); return;
      case "AUTH": {
        const [mech, arg] = rest;
        if (mech === "PLAIN") { const [, u, p] = atob(arg).split("\0"); this.finishAuth(u, p); return; }
        if (mech === "LOGIN") { this.mode = "authLoginUser"; this.reply("334 VXNlcm5hbWU6"); return; }
        // eslint-disable-next-line no-control-regex
        if (mech === "XOAUTH2") { const m = /user=([^\x01]+)\x01auth=Bearer ([^\x01]+)/.exec(atob(arg)); this.finishAuth(m?.[1] ?? "", "", m?.[2]); return; }
        this.reply("504 5.5.4 Unrecognized authentication type"); return;
      }
      case "MAIL": if (!this.authed) { this.reply("530 5.7.0 Authentication required"); return; } this.from = /<(.*)>/.exec(l)?.[1] ?? ""; this.reply("250 2.1.0 OK"); return;
      case "RCPT": { const a = /<(.*)>/.exec(l)?.[1] ?? ""; if (this.s.rejectRcpt.has(a)) { this.reply("550 5.1.1 No such user"); return; } this.to.push(a); this.reply("250 2.1.5 OK"); return; }
      case "DATA": this.mode = "data"; this.reply("354 Go ahead"); return;
      case "QUIT": this.reply("221 2.0.0 Bye"); this.closed = true; for (const w of this.waiting.splice(0)) w(null); return;
      default: this.reply("502 5.5.2 Command not recognized");
    }
  }
  private finishAuth(user: string, pass: string, token?: string) {
    if (this.s.authReply) { this.reply(this.s.authReply); return; }
    const ok = token ? token.startsWith("access-") : this.s.accounts.get(user) === pass;
    if (!ok) { this.reply("535 5.7.8 Username and Password not accepted"); return; }
    this.user = user; this.authed = true; this.reply("235 2.7.0 Accepted");
  }
  async startTls() { this.secure = true; return this; }
  async close() { this.closed = true; for (const w of this.waiting.splice(0)) w(null); }
}

export function rawMail(o: { from?: string; to: string; subject: string; id: string; body?: string; inReplyTo?: string; date?: Date }) {
  return [
    `From: ${o.from ?? "Grace Hopper <grace@navy.mil>"}`, `To: ${o.to}`, `Subject: ${o.subject}`, `Message-ID: ${o.id}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
    `Date: ${(o.date ?? new Date()).toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", o.body ?? "Hello there.", "",
  ].join("\r\n");
}
