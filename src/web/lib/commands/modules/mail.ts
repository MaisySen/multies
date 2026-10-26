import { Archive, Forward, Mail, MailOpen, PenSquare, Reply, ReplyAll, Search, Star, Trash2, AlarmClock, ArrowDown, ArrowUp, ListChecks } from "lucide-react";
import type { Command } from "../types";

const openMessage = (ctx: { focus: { kind: string | null } }) => ctx.focus.kind === "mail";

/** Mail keys. Bound by the Mail page (pages/app/webmail.tsx) through useCommandHandlers. */
export const mailCommands: Command[] = [
  { id: "mail-next", title: "Next message", group: "Mail", scope: "mail", keys: ["J"], keywords: ["down"], icon: ArrowDown, handler: "page" },
  { id: "mail-prev", title: "Previous message", group: "Mail", scope: "mail", keys: ["K"], keywords: ["up"], icon: ArrowUp, handler: "page" },
  { id: "mail-compose", title: "Write an email", group: "Mail", scope: "mail", keys: ["C"], keywords: ["compose", "new"], icon: PenSquare, handler: "page" },
  { id: "mail-search", title: "Search mail", group: "Mail", scope: "mail", keys: ["/"], keywords: ["find"], icon: Search, handler: "page" },
  { id: "mail-archive", title: "Archive", group: "Mail", scope: "mail-message", keys: ["E"], icon: Archive, palette: true, when: openMessage, handler: "page" },
  { id: "mail-reply", title: "Reply", group: "Mail", scope: "mail-message", keys: ["R"], icon: Reply, palette: true, when: openMessage, handler: "page" },
  { id: "mail-reply-all", title: "Reply all", group: "Mail", scope: "mail-message", keys: ["A"], icon: ReplyAll, palette: true, when: openMessage, handler: "page" },
  { id: "mail-forward", title: "Forward", group: "Mail", scope: "mail-message", keys: ["F"], icon: Forward, palette: true, when: openMessage, handler: "page" },
  { id: "mail-trash", title: "Move to trash", group: "Mail", scope: "mail-message", keys: ["#"], keywords: ["delete"], icon: Trash2, palette: true, when: openMessage, handler: "page" },
  { id: "mail-star", title: "Star or unstar", group: "Mail", scope: "mail-message", keys: ["S"], keywords: ["flag"], icon: Star, palette: true, when: openMessage, handler: "page" },
  { id: "mail-read", title: "Mark read or unread", group: "Mail", scope: "mail-message", keys: ["U"], keywords: ["unread", "seen"], icon: MailOpen, palette: true, when: openMessage, handler: "page" },
  { id: "mail-snooze", title: "Snooze", group: "Mail", scope: "mail-message", keys: ["H"], keywords: ["later", "remind"], icon: AlarmClock, palette: true, when: openMessage, handler: "page" },
  { id: "mail-task", title: "Make a task from the open email", group: "Mail", scope: "mail-message", keys: ["T"], keywords: ["todo"], icon: ListChecks, palette: false, when: openMessage, handler: "local" },
  { id: "mail-close", title: "Close the message", group: "Mail", scope: "mail-message", keys: ["Esc"], icon: Mail, palette: false, sheet: false, handler: "page" },
];
