/**
 * Live mail for connected mailboxes (round 19).
 *
 * Without this, new mail at a connected provider reaches Multies at the next scheduled pass (the
 * 15 minute cron). While someone has Multies open, the browser says so every minute (POST
 * /api/connections/live), and each of the workspace's connections gets a live window of 90 seconds,
 * extended by every heartbeat:
 *
 * The heartbeat can also wait (a long poll, up to 25 seconds) for the window to store new mail, so
 * the app shows it the moment it is in without beating more often.
 *
 * - push: one IMAP connection sits in IDLE on the Inbox; the server tells us the moment mail lands
 *   and a sync pass copies it in (one to three seconds end to end on the local test server).
 * - poll: servers without IDLE are asked with NOOP every 20 seconds over the same connection.
 * - check: when the day's live budget is used up, each heartbeat (at most one a minute) runs a pass
 *   that ends without writing anything when there is no new mail.
 *
 * On Workers each connection's live window runs in its Durable Object (MailSyncRunner), which stays
 * in memory while heartbeats arrive. A Durable Object is billed for wall time while it is in memory,
 * and the Workers free plan allows 13,000 GB-s a day for the whole account (about 1,700 minutes of
 * one object at 128 MB), so live windows draw from a daily budget of minutes (MAIL_LIVE_MINUTES_PER_DAY,
 * kept by one coordinating object, "live-budget") and fall back to checks when it is spent.
 *
 * Database writes: none for the window itself; a pass writes only when it stores new mail or applies
 * queued changes (same rows as a scheduled pass).
 */
import type { Deps } from "../../context";
import { eq } from "drizzle-orm";
import { mailConnections } from "../../db/schema";
import { connectionSecret } from ".";
import { imapflowWatcher, type InboxWatch, type InboxWatcher } from "./imap";
import { syncConnection, type SyncResult } from "./sync";

export type LiveMode = "push" | "poll" | "check" | "off";
export interface LiveTouch { mode: LiveMode; until: number }

/** Each heartbeat keeps a connection live this long; the browser beats every minute. */
export const LIVE_WINDOW_SECONDS = 90;
/** A live window takes budget in leases this long. */
export const LEASE_SECONDS = 300;
/** Without a lease, at most one check pass per connection this often. */
export const CHECK_EVERY_MS = 60_000;

/** Grants live minutes from a daily allowance. One per account on Workers (the "live-budget" object). */
export class LiveBudget {
  private day = "";
  private used = 0;
  private loaded = false;
  constructor(private minutesPerDay: number, private now: () => number = Date.now, private store?: { get(): Promise<{ day: string; used: number } | undefined>; put(v: { day: string; used: number }): Promise<void> }) {}

  /** Grants `seconds` of live time when today's allowance has room. One storage write per grant. */
  async lease(seconds: number): Promise<boolean> {
    if (!this.loaded && this.store) {
      const saved = await this.store.get();
      if (saved) { this.day = saved.day; this.used = saved.used; }
      this.loaded = true;
    }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.used = 0; }
    if (this.used + seconds > this.minutesPerDay * 60) return false;
    this.used += seconds;
    await this.store?.put({ day: this.day, used: this.used });
    return true;
  }

  usage() { return { day: this.day, usedSeconds: this.used, allowanceSeconds: this.minutesPerDay * 60 }; }
}

interface Session {
  until: number;
  watch?: InboxWatch;
  starting?: Promise<void>;
  leaseUntil: number;
  lastCheck: number;
  syncing?: Promise<void>;
  again: boolean;
  timer?: ReturnType<typeof setInterval>;
}

export interface LiveOptions {
  /** Asks for live time; true when granted. */
  lease: (seconds: number) => Promise<boolean>;
  watcher?: InboxWatcher;
  now?: () => number;
  /** Runs a pass (tests count them). Defaults to syncConnection with onlyIfNew. */
  sync?: (deps: Deps, id: string) => Promise<SyncResult>;
  /** How often the window is checked for its end and its lease (ms). */
  tickMs?: number;
}

/**
 * Live windows for connected mailboxes in this process (one Durable Object on Workers, the whole
 * server on Node).
 */
export class LiveMail {
  private sessions = new Map<string, Session>();
  private waiters = new Map<string, Set<() => void>>();
  private readonly now: () => number;
  /** Pass results, newest last (tests and the /live answer read them). */
  readonly events: { id: string; at: number; kind: "start" | "new" | "stored" | "stop"; detail?: string }[] = [];

  constructor(private deps: () => Promise<Deps>, private opts: LiveOptions) {
    this.now = opts.now ?? Date.now;
  }

  mode(id: string): LiveMode {
    const s = this.sessions.get(id);
    if (!s || s.until < this.now()) return "off";
    if (s.watch) return s.watch.push ? "push" : "poll";
    return s.starting ? "push" : "check";
  }

  /** A heartbeat for one connection: opens or extends its live window. */
  async touch(id: string, seconds = LIVE_WINDOW_SECONDS): Promise<LiveTouch> {
    const now = this.now();
    const s = this.sessions.get(id) ?? { until: 0, leaseUntil: 0, lastCheck: 0, again: false };
    this.sessions.set(id, s);
    s.until = Math.max(s.until, now + Math.min(Math.max(seconds, 10), 120) * 1000);
    if (s.watch || s.starting) return { mode: this.mode(id), until: s.until };
    if (await this.opts.lease(LEASE_SECONDS)) {
      s.leaseUntil = now + LEASE_SECONDS * 1000;
      s.starting = this.start(id, s).finally(() => { s.starting = undefined; });
      await s.starting;
      return { mode: this.mode(id), until: s.until };
    }
    if (now - s.lastCheck >= CHECK_EVERY_MS) {
      s.lastCheck = now;
      this.kick(id);
    }
    return { mode: "check", until: s.until };
  }

  /**
   * Resolves true as soon as a pass stores new mail for this connection, or false after `ms`. The
   * app's heartbeat waits on this (a long poll), so new mail shows up at once without beating often.
   */
  waitForMail(id: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const done = (v: boolean) => { clearTimeout(timer); set.delete(wake); resolve(v); };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), Math.min(Math.max(ms, 0), 30_000));
      set.add(wake);
    });
  }

  /** Waits for every running pass (tests). */
  async settle() {
    for (const s of this.sessions.values()) { await s.starting; while (s.syncing) await s.syncing; }
  }

  async stop(id: string, why = "window ended") {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.timer) clearInterval(s.timer);
    s.timer = undefined;
    const w = s.watch;
    s.watch = undefined;
    s.until = 0;
    if (w) { await w.stop().catch(() => undefined); this.events.push({ id, at: this.now(), kind: "stop", detail: why }); }
  }

  async stopAll() { for (const id of [...this.sessions.keys()]) await this.stop(id, "shutdown"); }

  private async start(id: string, s: Session) {
    const deps = await this.deps();
    const c = await deps.db.select().from(mailConnections).where(eq(mailConnections.id, id)).get();
    if (!c || !["active", "error", "syncing"].includes(c.status) || c.authKind === "oauth") {
      // OAuth tokens expire within the hour; those connections are checked, not held open.
      s.lastCheck = this.now();
      if (c && c.authKind === "oauth") this.kick(id);
      return;
    }
    try {
      const secret = await connectionSecret(deps, c);
      const watcher = this.opts.watcher ?? deps.imapWatcher ?? imapflowWatcher;
      const path = (JSON.parse(c.syncState || "{}") as { paths?: { inbox?: string } }).paths?.inbox ?? "INBOX";
      s.watch = await watcher({ host: c.imapHost, port: c.imapPort, security: c.imapSecurity }, { user: c.username, secret }, { allowSelfSigned: deps.config.mailConnect.allowSelfSigned, path }, () => {
        this.events.push({ id, at: this.now(), kind: "new" });
        this.kick(id);
      });
    } catch (err) {
      deps.log?.warn("mail_live.watch_failed", { connection: id, error: (err as Error).message });
      s.lastCheck = this.now();
      this.kick(id);
      return;
    }
    this.events.push({ id, at: this.now(), kind: "start", detail: s.watch.push ? "push" : "poll" });
    const w = s.watch;
    void w.done.then(() => { if (s.watch === w) { s.watch = undefined; if (s.timer) clearInterval(s.timer); s.timer = undefined; } });
    s.timer = setInterval(() => { void this.tick(id, s); }, this.opts.tickMs ?? 5_000);
    // Mail that arrived since the last pass.
    this.kick(id);
  }

  private async tick(id: string, s: Session) {
    const now = this.now();
    if (now >= s.until) return this.stop(id);
    if (now >= s.leaseUntil - 10_000) {
      if (await this.opts.lease(LEASE_SECONDS)) s.leaseUntil = now + LEASE_SECONDS * 1000;
      else return this.stop(id, "live budget used up");
    }
  }

  /** Runs a pass now; a pass already running runs once more after it. */
  private kick(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.syncing) { s.again = true; return; }
    s.syncing = (async () => {
      const deps = await this.deps();
      const run = this.opts.sync ?? ((d: Deps, x: string) => syncConnection(d, x, { onlyIfNew: true }));
      do {
        s.again = false;
        try {
          const r = await run(deps, id);
          if (r.stored) {
            this.events.push({ id, at: this.now(), kind: "stored", detail: String(r.stored) });
            for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
          }
          if (r.more && !r.skipped) s.again = true;
        } catch (err) {
          deps.log?.warn("mail_live.sync_failed", { connection: id, error: (err as Error).message });
        }
      } while (s.again);
    })().finally(() => { s.syncing = undefined; });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }
}

// Keyed by the database: some hosts hand each request its own copy of deps, but one database is one server.
const perDb = new WeakMap<object, LiveMail>();

/** The in-process live mail for hosts without Durable Objects (Node, tests). */
export function localLiveMail(deps: Deps): LiveMail {
  let live = perDb.get(deps.db as object);
  if (!live) {
    const budget = new LiveBudget(deps.config.mailConnect.liveMinutesPerDay, () => deps.now().getTime());
    live = new LiveMail(async () => deps, { lease: (sec) => budget.lease(sec), now: () => deps.now().getTime() });
    perDb.set(deps.db as object, live);
  }
  return live;
}
