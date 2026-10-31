import type { IconName } from "@/components/icons";

/**
 * R31: one command registry for the phone. The command sheet, the long-press menus on task and mail
 * rows, the swipe actions and the run detail all read their titles and icons from here, so a title
 * never drifts between two places. Ids match the web registry (shortcuts.ts / palette-registry.ts)
 * where the same command exists there; `web` names the web keys for that command (shown as a hint
 * on a tablet keyboard later, and checked against the web list at merge).
 */
export type CommandScope = "app" | "go" | "task" | "mail" | "triage" | "run";

export interface Command {
  id: CommandId;
  title: string;
  scope: CommandScope;
  icon: IconName;
  keywords?: string[];
  /** The web keys for the same command, if any. */
  web?: string[];
  destructive?: boolean;
}

export const COMMAND_IDS = [
  // Go to
  "go-i", "go-t", "go-d", "go-c", "go-m", "go-n",
  // App actions
  "compose", "new-task", "search-mail", "runs", "tools", "settings", "social-new", "social",
  // Task actions (long-press on a task row)
  "task-status", "task-assignee", "task-priority", "task-label", "task-due",
  // Mail actions (long-press and swipe on a mail row)
  "mail-reply", "mail-archive", "mail-snooze", "mail-star", "mail-read", "mail-trash",
  // Triage (notifications inbox)
  "triage-open", "triage-done", "triage-undone", "triage-snooze",
  // Agent runs
  "run-cancel",
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

export const COMMANDS: Command[] = [
  { id: "go-i", title: "Go to Mail", scope: "go", icon: "inbox", web: ["G", "I"], keywords: ["inbox", "email"] },
  { id: "go-t", title: "Go to Tasks", scope: "go", icon: "check-square", web: ["G", "T"], keywords: ["todo", "board"] },
  { id: "go-d", title: "Go to Docs", scope: "go", icon: "file-text", web: ["G", "D"], keywords: ["documents", "notes", "pages"] },
  { id: "go-c", title: "Go to Chat", scope: "go", icon: "message-circle", web: ["G", "C"], keywords: ["channels", "dm"] },
  { id: "go-m", title: "Go to Meetings", scope: "go", icon: "video", web: ["G", "M"], keywords: ["calls", "video"] },
  { id: "go-n", title: "Go to Notifications", scope: "go", icon: "bell", web: ["G", "N"], keywords: ["triage", "activity", "mentions"] },
  { id: "compose", title: "Write an email", scope: "app", icon: "edit-3", web: ["C"], keywords: ["compose", "new message", "send"] },
  { id: "new-task", title: "New task", scope: "app", icon: "plus", keywords: ["create task", "add task", "todo"] },
  { id: "search-mail", title: "Search mail", scope: "app", icon: "search", web: ["/"], keywords: ["find"] },
  { id: "runs", title: "Agent runs", scope: "app", icon: "cpu", keywords: ["agents", "runs", "history"] },
  { id: "tools", title: "Tools", scope: "app", icon: "wrench", keywords: ["pdf", "compress", "merge", "convert", "documents", "word to pdf", "redact", "ocr", "watermark"] },
  { id: "social-new", title: "New social post", scope: "app", icon: "send", keywords: ["facebook", "linkedin", "instagram", "post", "share"] },
  { id: "social", title: "Social posts", scope: "app", icon: "send", keywords: ["facebook", "linkedin", "posted", "accounts"] },
  { id: "settings", title: "Settings", scope: "app", icon: "settings", keywords: ["preferences", "account", "version"] },

  { id: "task-status", title: "Change status", scope: "task", icon: "check-circle", web: ["S"], keywords: ["move", "done"] },
  { id: "task-assignee", title: "Assign to", scope: "task", icon: "user", web: ["A"], keywords: ["owner", "assignee"] },
  { id: "task-priority", title: "Set priority", scope: "task", icon: "flag", web: ["P"], keywords: ["urgent", "high"] },
  { id: "task-label", title: "Add a label", scope: "task", icon: "tag", web: ["L"], keywords: ["tag", "labels"] },
  { id: "task-due", title: "Set due date", scope: "task", icon: "calendar", web: ["D"], keywords: ["deadline", "due"] },

  { id: "mail-reply", title: "Reply", scope: "mail", icon: "corner-up-left", web: ["R"] },
  { id: "mail-archive", title: "Archive", scope: "mail", icon: "archive", web: ["E"] },
  { id: "mail-snooze", title: "Snooze", scope: "mail", icon: "alarm-clock", web: ["H"], keywords: ["later", "remind"] },
  { id: "mail-star", title: "Star or unstar", scope: "mail", icon: "star", web: ["S"], keywords: ["flag"] },
  { id: "mail-read", title: "Mark read or unread", scope: "mail", icon: "mail-open", web: ["U"] },
  { id: "mail-trash", title: "Move to trash", scope: "mail", icon: "trash-2", web: ["#"], keywords: ["delete"], destructive: true },

  { id: "triage-open", title: "Open", scope: "triage", icon: "arrow-right", web: ["O"] },
  { id: "triage-done", title: "Mark done", scope: "triage", icon: "check", web: ["E"] },
  { id: "triage-undone", title: "Move back to Inbox", scope: "triage", icon: "inbox", web: ["Shift", "E"] },
  { id: "triage-snooze", title: "Snooze", scope: "triage", icon: "alarm-clock", web: ["H"] },

  { id: "run-cancel", title: "Cancel run", scope: "run", icon: "circle-stop", destructive: true, keywords: ["stop"] },
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function command(id: CommandId): Command {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`Unknown command ${id}`);
  return c;
}

/**
 * The title shown for a command in its context. Toggles read as the action they will do
 * ("Star" or "Unstar", "Mark read" or "Mark unread"), the way a menu should.
 */
export function commandTitle(id: CommandId, ctx: { starred?: boolean; read?: boolean } = {}): string {
  if (id === "mail-star" && ctx.starred !== undefined) return ctx.starred ? "Unstar" : "Star";
  if (id === "mail-read" && ctx.read !== undefined) return ctx.read ? "Mark unread" : "Mark read";
  return command(id).title;
}

export function commandsFor(scope: CommandScope | CommandScope[]): Command[] {
  const scopes = Array.isArray(scope) ? scope : [scope];
  return COMMANDS.filter((c) => scopes.includes(c.scope));
}

/** The order of the long-press menus. */
export const TASK_MENU: CommandId[] = ["task-status", "task-assignee", "task-priority", "task-label", "task-due"];
export const MAIL_MENU: CommandId[] = ["mail-reply", "mail-archive", "mail-snooze", "mail-star", "mail-read", "mail-trash"];
export const TRIAGE_MENU: CommandId[] = ["triage-open", "triage-done", "triage-snooze"];

/**
 * Filter for the command sheet: every word must match the title or a keyword, and titles that
 * start with the query come first. An empty query returns the list as is.
 */
export function searchCommands(query: string, list: Command[] = commandsFor(["go", "app"])): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const words = q.split(/\s+/);
  const scored = list
    .map((c) => {
      const title = c.title.toLowerCase();
      const hay = [title, ...(c.keywords ?? [])].join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      const bare = title.replace(/^go to /, "");
      const score = title.startsWith(q) || bare.startsWith(q) ? 0 : title.includes(q) ? 1 : 2;
      return { c, score };
    })
    .filter((x): x is { c: Command; score: number } => !!x);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.c);
}

// ---------------------------------------------------------------- handlers

export interface CommandContext {
  taskId?: string;
  messageId?: string;
  starred?: boolean;
  read?: boolean;
  notificationId?: string;
  runId?: string;
}

/** What a command needs from the app. Screens pass the pieces they have; the rest are no-ops. */
export interface CommandDeps {
  navigate: (href: string | { pathname: string; params?: Record<string, string> }) => void;
  openWeb: (path: string) => void;
  /** Opens a picker for one task field (status, assignee, priority, label, due). */
  pickTaskField?: (field: "status" | "assignee" | "priority" | "label" | "due", taskId: string) => void;
  mail?: (action: "archive" | "star" | "unstar" | "read" | "unread" | "trash", messageId: string) => void;
  pickSnooze?: (target: "mail" | "triage", id: string) => void;
  triage?: (action: "open" | "done" | "undone", notificationId: string) => void;
  cancelRun?: (runId: string) => void;
}

export type CommandHandler = (ctx: CommandContext) => void;

/**
 * Every command's handler. The Record type makes the compiler refuse a command with no handler,
 * and __tests__/commands-r31.test.ts checks the same at run time.
 */
export function createHandlers(d: CommandDeps): Record<CommandId, CommandHandler> {
  const task = (field: "status" | "assignee" | "priority" | "label" | "due"): CommandHandler => (c) => { if (c.taskId) d.pickTaskField?.(field, c.taskId); };
  return {
    "go-i": () => d.navigate("/inbox"),
    "go-t": () => d.navigate("/tasks"),
    "go-d": () => d.openWeb("/app/docs"),
    "go-c": () => d.navigate("/chat"),
    "go-m": () => d.navigate("/meetings"),
    "go-n": () => d.navigate("/activity"),
    compose: () => d.navigate("/compose"),
    "new-task": () => d.navigate("/task/new"),
    "search-mail": () => d.navigate("/search"),
    runs: () => d.navigate("/runs"),
    tools: () => d.navigate("/tools"),
    settings: () => d.navigate("/settings"),
    "social-new": () => d.navigate({ pathname: "/social", params: { tab: "new" } }),
    social: () => d.navigate("/social"),
    "task-status": task("status"),
    "task-assignee": task("assignee"),
    "task-priority": task("priority"),
    "task-label": task("label"),
    "task-due": task("due"),
    "mail-reply": (c) => { if (c.messageId) d.navigate({ pathname: "/compose", params: { replyTo: c.messageId } }); },
    "mail-archive": (c) => { if (c.messageId) d.mail?.("archive", c.messageId); },
    "mail-snooze": (c) => { if (c.messageId) d.pickSnooze?.("mail", c.messageId); },
    "mail-star": (c) => { if (c.messageId) d.mail?.(c.starred ? "unstar" : "star", c.messageId); },
    "mail-read": (c) => { if (c.messageId) d.mail?.(c.read ? "unread" : "read", c.messageId); },
    "mail-trash": (c) => { if (c.messageId) d.mail?.("trash", c.messageId); },
    "triage-open": (c) => { if (c.notificationId) d.triage?.("open", c.notificationId); },
    "triage-done": (c) => { if (c.notificationId) d.triage?.("done", c.notificationId); },
    "triage-undone": (c) => { if (c.notificationId) d.triage?.("undone", c.notificationId); },
    "triage-snooze": (c) => { if (c.notificationId) d.pickSnooze?.("triage", c.notificationId); },
    "run-cancel": (c) => { if (c.runId) d.cancelRun?.(c.runId); },
  };
}
