import type { DB } from "./db";
import type { AppConfig } from "./config";
import type { DnsResolver } from "./services/dns/resolver";
import type { OutboundProvider } from "./services/mail/outbound";

/** Everything the app needs from the outside world. Swapped wholesale in tests. */
export interface Deps {
  db: DB;
  /** When set, recordWrite collects activity and change rows here and the caller writes them in one batch (bulk seeds). */
  writeBuffer?: { activity: unknown[]; changes: unknown[] };
  config: AppConfig;
  dns: DnsResolver;
  outbound: OutboundProvider;
  now: () => Date;
  /** Outbound HTTP (Stripe, webhooks). Swapped for a fake in tests. */
  fetch: typeof fetch;
  /** Sends an unexpected error to error tracking (Sentry when a DSN is set). Returns the event id. */
  reportError?: (err: unknown, context?: Record<string, unknown>) => string | undefined;
  /**
   * Verifies SPF, DKIM and DMARC on inbound mail (mailauth, Node only). Without it the
   * verdicts the receiving MTA wrote into the message are used.
   */
  /**
   * Cloudflare rate limiting bindings, when the deployment declares them. Without one
   * the limiter falls back to a counter in the database, shared by every instance.
   */
  rateLimiters?: Partial<Record<RateLimitScope, RateLimitBinding | undefined>>;
  /** Structured logger (JSON lines). Defaults to console. */
  log?: Logger;
  /** S3 compatible storage for large attachments (BODY_STORE_*). */
  bodyStore?: import("./services/storage/body-store").BodyStore;
  /** R43: where an import's upload waits so the scheduled pass can finish it after the page closes (Workers KV IMPORT_FILES). */
  importFiles?: import("./services/data-move/kept-file").ImportFileStore;
  /** Tools P2: Workers AI (binding AI). Call only through the AI meter, which holds the free daily cap. */
  ai?: import("./services/tools/p2-bindings").AiRunner;
  /** R110: a local stand in for Ask in end to end tests only (ASK_AI_FAKE=1 on a localhost APP_URL). */
  askAi?: import("./services/tools/p2-bindings").AiRunner;
  /** Tools P2: files kept past one job (share links, signing requests) in KV with their own expiry. */
  toolFiles?: import("./services/tools/p2-bindings").ToolFileStore;
  /**
   * Tools P2 (17): the separate attachment text index database (binding INDEX_DB on Workers, a second SQLite
   * file on Node). Rebuildable, not backed up, the only place extracted attachment text and its FTS5 table live.
   * Without it, indexing and search inside attachments stay off.
   */
  indexDb?: import("./db").DB;
  /** R101: the separate database for drive file bytes (binding FILES_DB); absent = the main database. */
  filesDb?: import("./db").DB;
  /** Opens TCP or TLS connections to mail servers (connected mailboxes). Workers inject cloudflare:sockets; Node uses node:net. */
  openSocket?: import("./services/connect/socket").SocketOpener;
  /** Opens IMAP sessions for connected mailboxes. Defaults to ImapFlow; tests inject an in-memory server. */
  imap?: import("./services/connect/imap").ImapConnector;
  /** Watches a connected mailbox's Inbox for new mail (IDLE). Defaults to ImapFlow; tests inject a fake. */
  imapWatcher?: import("./services/connect/imap").InboxWatcher;
  /** Opens or extends a connection's live window (its Durable Object on Workers). Without it the window runs in this process. */
  liveMail?: (connectionId: string, seconds: number) => Promise<import("./services/connect/live").LiveTouch>;
  /** Waits up to `ms` for a connection's live window to store new mail (its Durable Object on Workers). */
  liveWait?: (connectionId: string, ms: number) => Promise<boolean>;
  /** Runs a connected mailbox's sync in its own invocation (a Durable Object on Workers). Without it the sync runs inline. */
  dispatchMailSync?: (connectionId: string) => Promise<void>;
  /** R57: fetch an older message's body from its provider (Workers: in the connection's Durable Object). */
  loadMailBody?: (mailboxId: string, messageId: string) => Promise<void>;
  /** Round 22: live thread presence rooms (the ThreadPresence Durable Object on Workers). Without it the rooms live in this process. */
  presence?: import("./collab/thread-presence").PresenceStore;
  /** Round 32: the workspace live chat hub (the ChatHub Durable Object on Workers, MemoryChatHub on Node). Without it chat only polls. */
  chatLive?: import("./realtime/hub").ChatLiveBus;
  /** Round 23: who is in a video room (LiveKit RoomService). Tests inject a fake; without it the meeting keys decide. */
  callRooms?: import("./services/suite/calls").CallRooms;
  authenticate?: (raw: Uint8Array, ctx: { sender?: string; ip?: string; helo?: string }) => Promise<{ results: import("@/shared/mail").AuthResults; header: string }>;
}

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  orgId: string;
  role: "owner" | "admin" | "member";
  sessionId: string;
  emailVerified?: boolean;
  twoFactor?: boolean;
  /** Platform-level role (Better Auth admin plugin): "admin" for operators. */
  platformRole?: string;
  /** How this session signed in ("email" or an SSO provider id). */
  loginMethod?: string;
  /** The workspace requires SSO and this session did not use it. */
  ssoBlocked?: boolean;
}

export interface AppEnv {
  Variables: { deps: Deps; auth: AuthContext; ip: string; requestId: string; log: Logger; apiKeyOrg?: string };
}

export type RateLimitScope = "auth" | "api" | "webhooks" | "app";

/** The shape of a Cloudflare Workers rate limiting binding. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
