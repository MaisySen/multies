/**
 * R31: the one command registry. Cmd+K, the global key handler and the "?" sheet all read COMMANDS,
 * composed from per area modules (commands/modules/*). Another area adds its keys with registerCommandModule.
 */
import type { Command, CommandContext, CommandScope } from "./types";
import type { Focus } from "./focus";
import { generalCommands } from "./modules/general";
import { actionCommands, navCommands } from "./modules/nav";
import { mailCommands } from "./modules/mail";
import { taskCommands } from "./modules/tasks";
import { writingCommands } from "./modules/writing";
import { pageCommands } from "./modules/page";

export const COMMANDS: Command[] = [...generalCommands, ...navCommands, ...actionCommands, ...mailCommands, ...taskCommands, ...pageCommands, ...writingCommands];

/** Add an area's commands (ids must be new; the registry test checks keys stay unique per scope). */
export function registerCommandModule(mod: Command[]) {
  for (const c of mod) if (!COMMANDS.some((x) => x.id === c.id)) COMMANDS.push(c);
}

export const commandById = (id: string) => COMMANDS.find((c) => c.id === id);
export const inSheet = (c: Command) => c.sheet ?? !!c.keys?.length;
export const inPalette = (c: Command) => c.palette ?? false;

/** How long after the first key of a sequence the next one still counts, in ms. */
export const SEQUENCE_MS = 1000;

const MODS = new Set(["Mod", "Alt", "Shift", "Ctrl"]);
/** A single key or a sequence the global handler reads (not a chord, not a key handled in a field). */
export const isPlainKeys = (c: Command) => c.handler !== "local" && !!c.keys?.length && !c.keys.some((k) => MODS.has(k)) && !c.keys.includes("Esc");

/** The scopes active now, most specific first. */
export function activeScopes(pathname: string, focus: Focus): CommandScope[] {
  const s: CommandScope[] = [];
  if (focus.kind === "task") s.push("task");
  if (focus.kind === "mail") s.push("mail-message");
  if (pathname.startsWith("/app/mail")) s.push("mail");
  if (pathname.startsWith("/app/tasks") || pathname.startsWith("/app/my-work")) s.push("tasks-list");
  if (pathname.startsWith("/app/notifications")) s.push("notifications");
  if (pathname.startsWith("/app/meetings")) s.push("meeting");
  s.push("global");
  return s;
}

const norm = (k: string) => (k.length === 1 ? k.toUpperCase() : k);

export type KeyState = { pending: string[]; at: number };
export const idleKeys = (): KeyState => ({ pending: [], at: 0 });
export type KeyResult =
  | { kind: "run"; command: Command }
  | { kind: "pending"; keys: string[] }
  | { kind: "none" };

/**
 * The global key reducer, pure so it is tested without a browser. A key that completes a command
 * runs it (most specific scope wins), a key that starts a sequence waits up to SEQUENCE_MS for the next.
 */
export function readKeys(state: KeyState, e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }, now: number, scopes: CommandScope[], list: Command[] = COMMANDS): { state: KeyState; result: KeyResult } {
  if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return { state: idleKeys(), result: { kind: "none" } };
  const k = norm(e.key);
  const usable = list.filter((c) => isPlainKeys(c) && scopes.includes(c.scope));
  const rank = (c: Command) => scopes.indexOf(c.scope);
  const tryKeys = (seq: string[]): KeyResult | null => {
    const exact = usable.filter((c) => c.keys!.length === seq.length && c.keys!.every((x, i) => norm(x) === seq[i])).sort((a, b) => rank(a) - rank(b));
    if (exact.length) return { kind: "run", command: exact[0] };
    if (usable.some((c) => c.keys!.length > seq.length && seq.every((x, i) => norm(c.keys![i]) === x))) return { kind: "pending", keys: seq };
    return null;
  };
  if (state.pending.length && now - state.at <= SEQUENCE_MS) {
    const r = tryKeys([...state.pending, k]);
    if (r) return { state: r.kind === "pending" ? { pending: r.keys, at: now } : idleKeys(), result: r };
    // The armed sequence did not match: the key is swallowed (G then an unknown key does nothing).
    return { state: idleKeys(), result: { kind: "none" } };
  }
  const r = tryKeys([k]);
  if (!r) return { state: idleKeys(), result: { kind: "none" } };
  return { state: r.kind === "pending" ? { pending: r.keys, at: now } : idleKeys(), result: r };
}

// Page handlers: a page binds the commands it runs (mail keys need the open message, the list, ...).
type Handler = () => boolean | void;
const handlers = new Map<string, Handler[]>();
export function bindCommand(id: string, fn: Handler): () => void {
  const list = handlers.get(id) ?? [];
  list.push(fn);
  handlers.set(id, list);
  return () => { const l = handlers.get(id); if (l) l.splice(l.indexOf(fn), 1); };
}
export const isBound = (id: string) => (handlers.get(id)?.length ?? 0) > 0;

/** Runs a command; false when nothing handled it (so the key is left alone). */
export function runCommand(c: Command, ctx: CommandContext): boolean {
  if (c.handler === "run" && c.run) { c.run(ctx); return true; }
  const list = handlers.get(c.id) ?? [];
  // R32: newest binding first; one that returns false passes to the one bound before it (the Mail page's
  // H snoozes the selection, else the open message's own H runs).
  for (let i = list.length - 1; i >= 0; i--) if (list[i]() !== false) return true;
  return false;
}

/** Key labels as this computer shows them. */
export function displayKeys(c: Pick<Command, "keys">, mac: boolean): string[] {
  return (c.keys ?? []).map((k) => (k === "Mod" ? (mac ? "⌘" : "Ctrl") : k === "Alt" && mac ? "⌥" : k === "Shift" && mac ? "⇧" : k));
}
