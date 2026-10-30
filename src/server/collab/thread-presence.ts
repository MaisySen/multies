/**
 * Round 22 (R22.3): who is looking at a shared inbox thread right now, and who is replying.
 *
 * One room per org and thread (idFromName(orgId + ":" + threadId)). Everything lives in memory:
 * a heartbeat never writes storage or D1. Browsers beat every 15 seconds with their state
 * (viewing or replying); an entry nobody beat for 40 seconds is gone. On Workers the room is the
 * ThreadPresence Durable Object (THREAD_PRESENCE binding); hosts without it (Node, self host,
 * tests) keep the same rooms in a map in this process.
 */

export type PresenceState = "viewing" | "replying";

/** One open tab or MCP reader. A person with two tabs has two clients. */
interface Client { clientId: string; userId: string; name: string; state: PresenceState; at: number; since: number }

/** Something that happened in the thread that live viewers should see once (a draft changed hands). */
export interface PresenceNote { type: "draft_taken_over"; draftId: string; toUserId: string; byUserId: string; byName: string; subject: string; at: number }

/** One person in the thread: replying wins over viewing when they have several tabs. */
export interface PresencePerson { userId: string; name: string; state: PresenceState; since: string; lastSeen: string; tabs: number }

export interface PresenceView { people: PresencePerson[]; notes: PresenceNote[] }

export type PresenceOp =
  | { op: "beat"; clientId: string; userId: string; name: string; state: PresenceState }
  | { op: "leave"; clientId: string }
  | { op: "list" }
  | { op: "note"; note: Omit<PresenceNote, "at"> };

/** Seconds without a beat before an entry expires. */
export const PRESENCE_TTL_MS = 40_000;
/** How often browsers beat. */
export const PRESENCE_BEAT_MS = 15_000;
/** Notes stay visible this long. */
const NOTE_TTL_MS = 120_000;
const MAX_CLIENTS = 200;

export class PresenceRoom {
  private clients = new Map<string, Client>();
  private notes: PresenceNote[] = [];

  handle(op: PresenceOp, now: number): PresenceView {
    this.prune(now);
    if (op.op === "beat") {
      const prev = this.clients.get(op.clientId);
      if (!prev && this.clients.size >= MAX_CLIENTS) return this.view();
      const since = prev && prev.state === op.state && prev.userId === op.userId ? prev.since : now;
      this.clients.set(op.clientId, { clientId: op.clientId, userId: op.userId, name: op.name, state: op.state, at: now, since });
    } else if (op.op === "leave") {
      this.clients.delete(op.clientId);
    } else if (op.op === "note") {
      this.notes = [...this.notes.filter((n) => n.draftId !== op.note.draftId), { ...op.note, at: now }].slice(-20);
    }
    return this.view();
  }

  get empty() { return this.clients.size === 0 && this.notes.length === 0; }

  private prune(now: number) {
    for (const [id, c] of this.clients) if (now - c.at >= PRESENCE_TTL_MS) this.clients.delete(id);
    this.notes = this.notes.filter((n) => now - n.at < NOTE_TTL_MS);
  }

  private view(): PresenceView {
    const byUser = new Map<string, { c: Client; tabs: number; last: number; since: number }>();
    for (const c of this.clients.values()) {
      const cur = byUser.get(c.userId);
      if (!cur) { byUser.set(c.userId, { c, tabs: 1, last: c.at, since: c.since }); continue; }
      cur.tabs++;
      cur.last = Math.max(cur.last, c.at);
      if (c.state === "replying" && cur.c.state !== "replying") { cur.c = c; cur.since = c.since; }
      else if (c.state === cur.c.state) cur.since = Math.min(cur.since, c.since);
    }
    const people = [...byUser.values()].map(({ c, tabs, last, since }) => ({
      userId: c.userId, name: c.name, state: c.state, since: new Date(since).toISOString(), lastSeen: new Date(last).toISOString(), tabs,
    }));
    people.sort((a, b) => (a.state === b.state ? a.since.localeCompare(b.since) : a.state === "replying" ? -1 : 1));
    return { people, notes: [...this.notes] };
  }
}

/** What the app calls: one room per key, in a Durable Object or in this process. */
export type PresenceStore = (key: string, op: PresenceOp) => Promise<PresenceView>;

export const presenceKey = (orgId: string, threadId: string) => `${orgId}:${threadId}`;

/** The in-process rooms (Node, self host, tests, and Workers without the binding). */
export function memoryPresence(clock: () => number = () => Date.now()): PresenceStore {
  const rooms = new Map<string, PresenceRoom>();
  return async (key, op) => {
    let room = rooms.get(key);
    if (!room) { room = new PresenceRoom(); rooms.set(key, room); }
    const view = room.handle(op, clock());
    if (room.empty) rooms.delete(key);
    return view;
  };
}

interface DurableObjectNamespaceLike { idFromName(name: string): unknown; get(id: unknown): { fetch(input: Request): Promise<Response> } }

/** The Workers store: one ThreadPresence object per key. */
export function durablePresence(ns: DurableObjectNamespaceLike): PresenceStore {
  return async (key, op) => {
    const res = await ns.get(ns.idFromName(key)).fetch(new Request("https://thread-presence/op", { method: "POST", body: JSON.stringify(op) }));
    if (!res.ok) throw new Error(`thread presence answered ${res.status}`);
    return (await res.json()) as PresenceView;
  };
}

/**
 * The Durable Object (THREAD_PRESENCE binding). It never touches its storage: when it is evicted the
 * room is simply empty until the next beats, 15 seconds later at most.
 */
export class ThreadPresence {
  private room = new PresenceRoom();
  constructor(_state: unknown, _env: unknown) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let op: PresenceOp;
    try { op = (await request.json()) as PresenceOp; } catch { return new Response("Bad request", { status: 400 }); }
    if (!op || !["beat", "leave", "list", "note"].includes(op.op)) return new Response("Bad request", { status: 400 });
    return Response.json(this.room.handle(op, Date.now()));
  }
}
