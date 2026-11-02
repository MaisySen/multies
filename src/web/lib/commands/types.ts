/**
 * R31: one command registry. Every command, its keys, where it applies and how it runs live here;
 * the command menu (Cmd+K), the global key handler and the "?" sheet all read the same list.
 */
import type { ComponentType } from "react";

/** Where a command applies. "global" works everywhere; the rest follow the page or the focused item. */
export type CommandScope = "global" | "mail" | "mail-message" | "tasks-list" | "task" | "writing" | "notifications" | "meeting" | "crm";

/** How the "?" sheet groups commands. */
export type CommandGroup = "General" | "Go to" | "Mail" | "Tasks" | "CRM" | "Notifications" | "Meetings" | "Writing";
export const COMMAND_GROUPS: CommandGroup[] = ["General", "Go to", "Mail", "Tasks", "CRM", "Notifications", "Meetings", "Writing"];

/** What a command's run gets: the app's own doors, never page state (pages bind that with useCommandHandlers). */
export interface CommandContext {
  navigate: (to: string) => void;
  openSheet: () => void;
  openPalette: (page?: string) => void;
  toggleTheme?: () => void;
}

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  scope: CommandScope;
  /**
   * Keys: a single key ["E"], a sequence ["G", "I"] (sequence: true) or a chord ["Mod", "K"].
   * "Mod" is Cmd on a Mac and Ctrl elsewhere.
   */
  keys?: string[];
  sequence?: boolean;
  keywords?: string[];
  icon?: ComponentType<{ className?: string }>;
  /** Go to commands: the page they open. */
  to?: string;
  /** Shown in the command menu (default: true for go to and actions, false for page keys). */
  palette?: boolean;
  /** Listed in the "?" sheet (default: true when the command has keys). */
  sheet?: boolean;
  /**
   * Who handles it: "run" (the command's own run), "page" (a page binds it with useCommandHandlers),
   * or "local" (a field or editor handles the keys itself, e.g. Enter in a chat box; listed for the sheet only).
   */
  handler: "run" | "page" | "local";
  /** Only offered when this says so (e.g. a task is focused). */
  /** R59: offered only while this server switch (from /api/config) is on. */
  flag?: "chatChannels" | "tools" | "docsVisual" | "helpCenter" | "sites" | "docsPlus" | "maps" | "filesPlus" | "askR110" | "vaultR128" | "peopleR126" | "inboxTd6" | "reporting" | "invoices" | "expenses" | "tablesR125" | "docInbox" | "coursesR129" | "blog" | "toursR130" | "billTd4" | "teamaiTd8" | "crmTd10";
  /** Tools P2: shown only while one of these P2 features is on (/api/config toolFeatures). */
  toolFeature?: string[];
  when?: (ctx: { focus: import("./focus").Focus }) => boolean;
  run?: (ctx: CommandContext) => void;
}
