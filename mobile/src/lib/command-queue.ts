import { useEffect, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import type { KV } from "./kv";
import { ApiError } from "@/api/errors";
import { isTempId, tempId } from "./pending";
import type { Api } from "@/api/endpoints";
import type { TaskCreate, TaskPatch } from "@/api/types";

/**
 * R33: edits made offline become commands, saved on the phone (the same SQLite store as the
 * offline cache) and sent in order through the normal API calls when the connection is back.
 * A task made offline has a temp id; when its create lands, the real id replaces the temp id in
 * every command still waiting. A command the server definitely refuses is dropped (with anything
 * that depends on its temp id) and reported; a network error stops the flush and keeps the rest.
 */
export type MailAction = "archive" | "inbox" | "star" | "unstar" | "read" | "unread" | "trash";
export type Command =
  | { id: string; at: number; kind: "task.create"; tempId: string; input: TaskCreate }
  | { id: string; at: number; kind: "task.update"; taskId: string; patch: TaskPatch }
  | { id: string; at: number; kind: "task.delete"; taskId: string }
  | { id: string; at: number; kind: "mail.action"; messageId: string; action: MailAction };
export type NewCommand = Command extends infer C ? (C extends Command ? Omit<C, "id" | "at"> : never) : never;
/** PRIV1b (P53): the workspace a command was made in ("" for none), recorded when it is queued. */
export type QueuedCommand = Command & { ws?: string };
/** The current workspace id ("" for none), or null while it is not known yet. */
export type WorkspaceOf = () => string | null;

/** Runs one command; a create answers with the real id. */
export type Executor = (c: Command) => Promise<{ realId?: string } | void>;

export const QUEUE_KEY = "queue:v1";
/** PRIV1b (P53): the last workspace seen, for changes made offline before the app learns it (cleared with the queue). */
export const QUEUE_WS_KEY = "queue:ws";
export const OFFLINE_SYNC_TEXT = "Your changes will sync when you are back online.";
export const NOT_OFFLINE_TEXT = "Not available offline. Reconnect to do this.";
export const OTHER_WORKSPACE_TEXT = "This change was made in another workspace.";

/** "1 change waiting", "3 changes waiting". */
export function waitingLabel(n: number): string { return `${n} ${n === 1 ? "change" : "changes"} waiting`; }

/** Swaps a temp id for the real one everywhere it appears in a command. */
export function swapId(c: Command, from: string, to: string): Command {
  if (c.kind === "task.update" || c.kind === "task.delete") return c.taskId === from ? { ...c, taskId: to } : c;
  if (c.kind === "task.create" && c.input.parentId === from) return { ...c, input: { ...c.input, parentId: to } };
  return c;
}

/** Whether a command still points at a temp id that will never be real (its create was refused). */
function dependsOn(c: Command, temp: string): boolean {
  return (c.kind === "task.update" || c.kind === "task.delete") ? c.taskId === temp : c.kind === "task.create" && c.input.parentId === temp;
}

/** A definite refusal (the command can never succeed) versus a reason to try again later. */
export function isRejection(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 0 || err.status === 401 || err.status === 408 || err.status === 429 || err.status >= 500) return false;
  return err.status >= 400;
}

export interface FlushResult { sent: number; rejected: { command: Command; error: ApiError }[]; stopped: boolean; ids: Record<string, string> }

export class CommandQueue {
  private items: Command[] = [];
  private loaded = false;
  private flushing: Promise<FlushResult> | null = null;
  /** PRIV1b (MH1): set while a workspace switch runs; `gen` moves on hold and clear so a running flush stops. */
  private held = false;
  private gen = 0;
  private listeners = new Set<() => void>();
  /** temp id to real id, kept so screens can follow a row whose id changed. */
  readonly ids = new Map<string, string>();

  constructor(private store: KV, private exec: Executor, private workspace?: WorkspaceOf) {}

  async load(): Promise<Command[]> {
    if (!this.loaded) {
      this.loaded = true;
      try { this.items = JSON.parse((await this.store.get(QUEUE_KEY)) ?? "[]") as Command[]; } catch { this.items = []; }
      const ws = this.workspace?.();
      if (ws != null) await this.store.set(QUEUE_WS_KEY, ws).catch(() => {});
      this.emit();
    }
    return this.items;
  }
  get size() { return this.items.length; }
  list(): readonly Command[] { return this.items; }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach((l) => l()); }
  private async save() { await this.store.set(QUEUE_KEY, JSON.stringify(this.items)).catch(() => {}); }

  async enqueue(c: NewCommand, now = Date.now()): Promise<Command> {
    await this.load();
    const ws = this.workspace ? this.workspace() ?? (await this.store.get(QUEUE_WS_KEY).catch(() => null)) : null;
    const cmd = { ...c, id: tempId(now).replace("tmp_", "cmd_"), at: now, ...(ws != null ? { ws } : {}) } as Command;
    this.items = [...this.items, cmd];
    await this.save();
    this.emit();
    return cmd;
  }

  /** Sends every waiting command in order. One flush runs at a time. */
  flush(): Promise<FlushResult> {
    if (!this.flushing) this.flushing = this.run().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async run(): Promise<FlushResult> {
    await this.load();
    const out: FlushResult = { sent: 0, rejected: [], stopped: false, ids: {} };
    const gen = this.gen;
    while (this.items.length) {
      // PRIV1b (P53, MH1): a change made in one workspace never lands in another. Each command checks its own workspace
      // against the current one when it is sent; a hold or clear (workspace switch) stops the flush; wait while unknown.
      const ws = this.workspace ? this.workspace() : undefined;
      if (this.held || gen !== this.gen || ws === null) { out.stopped = true; break; }
      const c = this.items[0];
      try {
        if (ws !== undefined && (c as QueuedCommand).ws !== ws) throw new ApiError(409, "other_workspace", OTHER_WORKSPACE_TEXT);
        const r = await this.exec(c);
        if (this.items[0] === c) this.items = this.items.slice(1); // a clear while it was sent leaves nothing to drop
        out.sent++;
        if (c.kind === "task.create" && r && r.realId) {
          this.ids.set(c.tempId, r.realId);
          out.ids[c.tempId] = r.realId;
          this.items = this.items.map((x) => swapId(x, c.tempId, r.realId!));
        }
      } catch (err) {
        if (!isRejection(err)) { out.stopped = true; break; }
        if (this.items[0] === c) this.items = this.items.slice(1);
        out.rejected.push({ command: c, error: err as ApiError });
        if (c.kind === "task.create") {
          const dropped = this.items.filter((x) => dependsOn(x, c.tempId));
          this.items = this.items.filter((x) => !dependsOn(x, c.tempId));
          for (const d of dropped) out.rejected.push({ command: d, error: err as ApiError });
        }
      }
      await this.save();
      this.emit();
    }
    await this.save();
    this.emit();
    return out;
  }

  async clear() { this.gen++; this.items = []; this.ids.clear(); await this.store.remove(QUEUE_KEY).catch(() => {}); this.emit(); }

  /** PRIV1b (MH1): stops sending before a workspace switch: a running flush stops before its next command, and this waits for the one in flight. */
  async hold(): Promise<void> { this.held = true; this.gen++; await this.flushing?.catch(() => {}); }
  /** Sends again (the switch failed, so the workspace did not change). */
  release() { this.held = false; }
}

/** The executor for the live API: each command is the same REST call the screen would make. */
export function apiExecutor(api: Api): Executor {
  return async (c) => {
    switch (c.kind) {
      case "task.create": return { realId: (await api.createTask(c.input)).task.id };
      case "task.update": if (isTempId(c.taskId)) throw new ApiError(404, "not_found", "That task was never saved."); await api.updateTask(c.taskId, c.patch); return;
      case "task.delete": if (isTempId(c.taskId)) return; await api.deleteTask(c.taskId); return;
      case "mail.action":
        if (c.action === "trash") { await api.trash(c.messageId); return; }
        await api.updateMessage(c.messageId, c.action === "archive" || c.action === "inbox" ? { folder: c.action } : c.action === "star" || c.action === "unstar" ? { isStarred: c.action === "star" } : { isRead: c.action === "read" });
        return;
    }
  };
}

// ---------------------------------------------------------------- the app's one queue

let shared: CommandQueue | null = null;
export function setCommandQueue(q: CommandQueue | null) { shared = q; }
export function commandQueue(): CommandQueue | null { return shared; }

/** How many changes are waiting, for the pill. */
export function useWaitingCount(): number {
  const q = shared;
  useEffect(() => { void q?.load(); }, [q]);
  return useSyncExternalStore((fn) => (q ? q.subscribe(fn) : () => {}), () => q?.size ?? 0, () => q?.size ?? 0);
}

/** Says a server only action can't run offline. Returns true when it is offline (and stops the caller). */
export function blockOffline(offline: boolean): boolean {
  if (offline) Alert.alert("You're offline", NOT_OFFLINE_TEXT);
  return offline;
}
