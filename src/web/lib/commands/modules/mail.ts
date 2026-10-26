import { IconArchive, IconArrowDown, IconArrowUp, IconChecklist, IconCompose, IconForward, IconMail, IconRead, IconReply, IconReplyAll, IconSearch, IconSnooze, IconSquareCheck, IconSquareDashed, IconStar, IconTrash, IconUndo } from "@/web/components/ui/icon";
import type { Command } from "../types";
import { getSelectionCount } from "@/web/lib/mail-selection";

const openMessage = (ctx: { focus: { kind: string | null } }) => ctx.focus.kind === "mail";
/** R32: offered in the command menu only while rows are selected. */
const hasSelection = () => getSelectionCount() > 0;

/**
 * Mail keys. Bound by the Mail page (pages/app/webmail.tsx) through useCommandHandlers.
 * R32: E, H, #, U and S act on the whole selection when rows are selected (X, Shift+X, Cmd/Ctrl+A).
 */
export const mailCommands: Command[] = [
  { id: "mail-next", title: "Next message", group: "Mail", scope: "mail", keys: ["J"], keywords: ["down"], icon: IconArrowDown, handler: "page" },
  { id: "mail-prev", title: "Previous message", group: "Mail", scope: "mail", keys: ["K"], keywords: ["up"], icon: IconArrowUp, handler: "page" },
  { id: "mail-compose", title: "Write an email", group: "Mail", scope: "mail", keys: ["C"], keywords: ["compose", "new"], icon: IconCompose, handler: "page" },
  { id: "mail-search", title: "Search mail", group: "Mail", scope: "mail", keys: ["/"], keywords: ["find"], icon: IconSearch, handler: "page" },
  { id: "mail-archive", title: "Archive", group: "Mail", scope: "mail-message", keys: ["E"], icon: IconArchive, palette: true, when: openMessage, handler: "page" },
  { id: "mail-reply", title: "Reply", group: "Mail", scope: "mail-message", keys: ["R"], icon: IconReply, palette: true, when: openMessage, handler: "page" },
  { id: "mail-reply-all", title: "Reply all", group: "Mail", scope: "mail-message", keys: ["A"], icon: IconReplyAll, palette: true, when: openMessage, handler: "page" },
  { id: "mail-forward", title: "Forward", group: "Mail", scope: "mail-message", keys: ["F"], icon: IconForward, palette: true, when: openMessage, handler: "page" },
  { id: "mail-trash", title: "Move to trash", group: "Mail", scope: "mail-message", keys: ["#"], keywords: ["delete"], icon: IconTrash, palette: true, when: openMessage, handler: "page" },
  { id: "mail-star", title: "Star or unstar", group: "Mail", scope: "mail-message", keys: ["S"], keywords: ["flag"], icon: IconStar, palette: true, when: openMessage, handler: "page" },
  { id: "mail-read", title: "Mark read or unread", group: "Mail", scope: "mail-message", keys: ["U"], keywords: ["unread", "seen"], icon: IconRead, palette: true, when: openMessage, handler: "page" },
  { id: "mail-snooze", title: "Snooze", group: "Mail", scope: "mail-message", keys: ["H"], keywords: ["later", "remind"], icon: IconSnooze, palette: true, when: openMessage, handler: "page" },
  { id: "mail-task", title: "Make a task from the open email", group: "Mail", scope: "mail-message", keys: ["T"], keywords: ["todo"], icon: IconChecklist, palette: false, when: openMessage, handler: "local" },
  // R32: multi-select and bulk actions. X toggles the open row; Shift+X, Cmd/Ctrl+A, Esc and Cmd/Ctrl+Z are read by the page.
  { id: "mail-select", title: "Select conversation", group: "Mail", scope: "mail-message", keys: ["X"], keywords: ["check", "multi", "bulk"], icon: IconSquareCheck, palette: true, when: openMessage, handler: "page" },
  { id: "mail-select-range", title: "Select a range of conversations", group: "Mail", scope: "mail", keys: ["Shift", "X"], keywords: ["shift click"], icon: IconSquareCheck, handler: "local" },
  { id: "mail-select-all", title: "Select all conversations", group: "Mail", scope: "mail", keys: ["Mod", "A"], keywords: ["bulk"], icon: IconSquareCheck, palette: true, handler: "page" },
  { id: "mail-select-clear-key", title: "Clear the selection", group: "Mail", scope: "mail", keys: ["Esc"], icon: IconSquareDashed, handler: "local" },
  { id: "mail-undo", title: "Undo the last mail action", group: "Mail", scope: "mail", keys: ["Mod", "Z"], keywords: ["revert"], icon: IconUndo, handler: "local" },
  { id: "mail-bulk-archive", title: "Archive selected", group: "Mail", scope: "mail", keywords: ["bulk", "selection"], icon: IconArchive, palette: true, sheet: false, when: hasSelection, handler: "page" },
  { id: "mail-bulk-snooze", title: "Snooze selected", group: "Mail", scope: "mail", keywords: ["bulk", "later"], icon: IconSnooze, palette: true, sheet: false, when: hasSelection, handler: "page" },
  { id: "mail-bulk-read", title: "Mark selected read", group: "Mail", scope: "mail", keywords: ["bulk", "seen"], icon: IconRead, palette: true, sheet: false, when: hasSelection, handler: "page" },
  { id: "mail-bulk-unread", title: "Mark selected unread", group: "Mail", scope: "mail", keywords: ["bulk"], icon: IconMail, palette: true, sheet: false, when: hasSelection, handler: "page" },
  { id: "mail-bulk-trash", title: "Delete selected", group: "Mail", scope: "mail", keywords: ["bulk", "trash"], icon: IconTrash, palette: true, sheet: false, when: hasSelection, handler: "page" },
  { id: "mail-bulk-clear", title: "Clear the selection", group: "Mail", scope: "mail", keywords: ["deselect"], icon: IconSquareDashed, palette: true, sheet: false, when: hasSelection, handler: "page" },
  { id: "mail-close", title: "Close the message", group: "Mail", scope: "mail-message", keys: ["Esc"], icon: IconMail, palette: false, sheet: false, handler: "page" },
];
