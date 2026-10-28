/**
 * IMAP for connected mailboxes, through ImapFlow (MIT, the IMAP client from the Nodemailer project).
 * ImapFlow runs on Workers with nodejs_compat (checked in wrangler dev on 25 October 2026: TLS on
 * 993 to Gmail and Microsoft reached the login step). The sync engine talks to the small ImapSession
 * interface below, so unit tests can use an in-memory mailbox and the live test uses a real server.
 */
import { ImapFlow } from "imapflow";
import type { ServerSettings } from "@/shared/mail-connect";

export interface ImapAuth { user: string; secret: string; xoauth2?: boolean }

export interface FolderPaths { inbox: string; sent?: string; archive?: string; trash?: string; drafts?: string; spam?: string }

/** A folder at the provider, as LIST answers it. */
export interface RemoteFolder { path: string; name: string; specialUse?: string; noSelect?: boolean }

export interface FetchedMessage {
  uid: number;
  flags: Set<string>;
  size: number;
  /** The raw message; missing when it was over the size limit. */
  source?: Uint8Array;
  /** Headers only, for messages over the size limit. */
  envelope?: { subject?: string; messageId?: string; date?: Date; from?: { address?: string; name?: string } };
}

export interface ImapSession {
  folders(): Promise<FolderPaths>;
  open(path: string, opts?: { write?: boolean }): Promise<{ uidValidity: string; uidNext: number }>;
  /** UIDs of messages received on or after `since`, in the open folder. */
  searchSince(since: Date): Promise<number[]>;
  /** UIDs above `uid` in the open folder. */
  uidsAfter(uid: number): Promise<number[]>;
  fetch(uids: number[], maxBytes: number): Promise<FetchedMessage[]>;
  /** Flags of every message with a UID in [lo, hi]. */
  flags(lo: number, hi: number): Promise<Map<number, Set<string>>>;
  addFlags(uids: number[], flags: string[]): Promise<void>;
  removeFlags(uids: number[], flags: string[]): Promise<void>;
  /** Moves mail; answers old UID to new UID in `dest` when the server says (UIDPLUS), else null. */
  move(uids: number[], dest: string): Promise<Map<number, number> | null>;
  /** Every folder at the provider (round 19). */
  listFolders(): Promise<RemoteFolder[]>;
  append(path: string, raw: Uint8Array | string, flags: string[]): Promise<void>;
  /** Whether a message with this Message-ID is already in the open folder. */
  hasMessageId(messageId: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface ImapConnectOptions { allowSelfSigned?: boolean; timeoutMs?: number }
export type ImapConnector = (server: ServerSettings, auth: ImapAuth, opts?: ImapConnectOptions) => Promise<ImapSession>;

const SPECIAL: Record<string, keyof FolderPaths> = { "\\Sent": "sent", "\\Archive": "archive", "\\All": "archive", "\\Trash": "trash", "\\Drafts": "drafts", "\\Junk": "spam" };
const BY_NAME: [RegExp, keyof FolderPaths][] = [
  [/^(sent|sent items|sent messages|sent mail|\[gmail\]\/sent mail)$/i, "sent"], [/^(archive|archives)$/i, "archive"], [/^(trash|deleted items|deleted messages|bin)$/i, "trash"],
  [/^(drafts|draft)$/i, "drafts"], [/^(junk|spam|junk e-?mail|bulk mail|\[gmail\]\/spam)$/i, "spam"],
];

/** Picks Sent, Archive and Trash from a folder list: special-use flags first (RFC 6154), then common names. */
export function pickFolders(list: { path: string; specialUse?: string; name?: string }[]): FolderPaths {
  const out: FolderPaths = { inbox: "INBOX" };
  for (const f of list) {
    const k = f.specialUse ? SPECIAL[f.specialUse] : undefined;
    // Gmail's All Mail is where archived mail lives; a real \Archive folder wins over it.
    if (k && (!out[k] || (k === "archive" && f.specialUse === "\\Archive"))) out[k] = f.path;
  }
  for (const f of list) {
    const hit = BY_NAME.find(([re]) => re.test(f.path) || re.test(f.name ?? ""));
    if (hit && !out[hit[1]]) out[hit[1]] = f.path;
  }
  return out;
}

const range = (uids: number[]) => uids.join(",");

class FlowSession implements ImapSession {
  constructor(private c: ImapFlow) {}

  async folders() { return pickFolders(await this.c.list()); }

  async open(path: string, opts: { write?: boolean } = {}) {
    const box = await this.c.mailboxOpen(path, { readOnly: !opts.write });
    return { uidValidity: String(box.uidValidity), uidNext: Number(box.uidNext ?? 1) };
  }

  async searchSince(since: Date) {
    const r = await this.c.search({ since }, { uid: true });
    return (r || []).map(Number).sort((a, b) => a - b);
  }

  async uidsAfter(uid: number) {
    const r = await this.c.search({ uid: `${uid + 1}:*` }, { uid: true });
    return (r || []).map(Number).filter((u) => u > uid).sort((a, b) => a - b);
  }

  async fetch(uids: number[], maxBytes: number) {
    if (!uids.length) return [];
    const heads: FetchedMessage[] = [];
    for await (const m of this.c.fetch(range(uids), { uid: true, flags: true, size: true, envelope: true }, { uid: true })) {
      const e = m.envelope;
      heads.push({
        uid: Number(m.uid), flags: new Set(m.flags ?? []), size: Number(m.size ?? 0),
        envelope: e ? { subject: e.subject, messageId: e.messageId, date: e.date ? new Date(e.date) : undefined, from: e.from?.[0] ? { address: e.from[0].address, name: e.from[0].name } : undefined } : undefined,
      });
    }
    const small = heads.filter((h) => h.size <= maxBytes).map((h) => h.uid);
    if (small.length) {
      const byUid = new Map(heads.map((h) => [h.uid, h]));
      for await (const m of this.c.fetch(range(small), { uid: true, source: true }, { uid: true })) {
        const h = byUid.get(Number(m.uid));
        if (h && m.source) h.source = new Uint8Array(m.source);
      }
    }
    return heads.sort((a, b) => a.uid - b.uid);
  }

  async flags(lo: number, hi: number) {
    const out = new Map<number, Set<string>>();
    if (hi < lo) return out;
    for await (const m of this.c.fetch(`${lo}:${hi}`, { uid: true, flags: true }, { uid: true })) out.set(Number(m.uid), new Set(m.flags ?? []));
    return out;
  }

  async addFlags(uids: number[], flags: string[]) { if (uids.length) await this.c.messageFlagsAdd(range(uids), flags, { uid: true }); }
  async removeFlags(uids: number[], flags: string[]) { if (uids.length) await this.c.messageFlagsRemove(range(uids), flags, { uid: true }); }
  async move(uids: number[], dest: string) {
    if (!uids.length) return null;
    const r = await this.c.messageMove(range(uids), dest, { uid: true });
    return r && r.uidMap ? new Map([...r.uidMap].map(([a, b]) => [Number(a), Number(b)])) : null;
  }

  async listFolders() {
    return (await this.c.list()).map((f) => ({ path: f.path, name: f.name, specialUse: f.specialUse || undefined, noSelect: f.flags?.has("\\Noselect") || undefined }));
  }
  async append(path: string, raw: Uint8Array | string, flags: string[]) { await this.c.append(path, typeof raw === "string" ? raw : Buffer.from(raw), flags); }

  async hasMessageId(messageId: string) {
    const r = await this.c.search({ header: { "message-id": messageId } }, { uid: true });
    return !!r && r.length > 0;
  }

  async close() {
    try { await this.c.logout(); } catch { this.c.close(); }
  }
}

function newFlow(server: ServerSettings, auth: ImapAuth, opts: ImapConnectOptions) {
  const timeout = opts.timeoutMs ?? 20_000;
  const client = new ImapFlow({
    host: server.host, port: server.port, secure: server.security === "tls", doSTARTTLS: server.security === "starttls" ? true : undefined,
    auth: auth.xoauth2 ? { user: auth.user, accessToken: auth.secret } : { user: auth.user, pass: auth.secret },
    logger: false, emitLogs: false, disableAutoIdle: true, connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout * 3,
    // Only the local test server (MAIL_CONNECT_ALLOW_SELF_SIGNED, never in production) sets this; Workers can't skip the check anyway.
    ...(opts.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
  });
  client.on("error", () => { /* surfaced through the awaited call that failed */ });
  return client;
}

/** The default connector: ImapFlow, quiet (it never logs, so no password or mail reaches a log). */
export const imapflowConnector: ImapConnector = async (server, auth, opts = {}) => {
  const client = newFlow(server, auth, opts);
  await client.connect();
  return new FlowSession(client);
};

/**
 * A watch on one folder (round 19, live mail): one IMAP connection that sits in IDLE (RFC 2177), so
 * the server tells us about new mail the moment it lands. Servers without IDLE are asked with NOOP
 * every `pollMs` instead. `onNew` runs when the folder grows; `done` settles when the connection ends.
 */
export interface InboxWatch {
  /** True when the server pushes (IDLE); false when we ask it every few seconds. */
  readonly push: boolean;
  readonly done: Promise<void>;
  stop(): Promise<void>;
}
export type InboxWatcher = (server: ServerSettings, auth: ImapAuth, opts: ImapConnectOptions & { path?: string; pollMs?: number }, onNew: () => void) => Promise<InboxWatch>;

/** IDLE restarts after this long: under the 29 minutes RFC 2177 allows, and under idle TCP cutoffs on the way. */
export const IDLE_RESTART_MS = 4 * 60_000;

export const imapflowWatcher: InboxWatcher = async (server, auth, opts, onNew) => {
  const client = newFlow(server, auth, opts);
  await client.connect();
  try {
    await client.mailboxOpen(opts.path ?? "INBOX", { readOnly: true });
  } catch (err) {
    client.close();
    throw err;
  }
  const push = client.capabilities.has("IDLE");
  // ImapFlow polls with NOOP at min(2 minutes, maxIdleTime) when IDLE is missing.
  (client as unknown as { maxIdleTime: number }).maxIdleTime = push ? IDLE_RESTART_MS : (opts.pollMs ?? 20_000);
  client.on("exists", (e: { count: number; prevCount: number }) => { if (e.count > e.prevCount) onNew(); });
  let stopped = false;
  const done = (async () => {
    while (!stopped && client.usable) {
      const started = Date.now();
      try { await client.idle(); } catch { break; }
      // idle() hands back at once when the folder isn't selected any more: don't spin.
      if (!stopped && Date.now() - started < 100) await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return {
    push,
    done,
    async stop() {
      stopped = true;
      try { await client.logout(); } catch { client.close(); }
      await done.catch(() => undefined);
    },
  };
};
