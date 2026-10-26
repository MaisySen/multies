import type { Command } from "../types";

/**
 * R31: keys that live on one page and are handled there (triage list, Inbox splits, pre-join,
 * the docs "/" menu). Listed here so the "?" sheet and the command menu tell the whole story.
 */
export const pageCommands: Command[] = [
  { id: "triage-next", title: "Next notification", group: "Notifications", scope: "notifications", keys: ["J"], handler: "local" },
  { id: "triage-prev", title: "Previous notification", group: "Notifications", scope: "notifications", keys: ["K"], handler: "local" },
  { id: "triage-open", title: "Open the notification", group: "Notifications", scope: "notifications", keys: ["O"], keywords: ["enter"], handler: "local" },
  { id: "triage-done", title: "Mark done", group: "Notifications", scope: "notifications", keys: ["E"], keywords: ["clear"], handler: "local" },
  { id: "triage-undo", title: "Undo the last done", group: "Notifications", scope: "notifications", keys: ["Shift", "E"], handler: "local" },
  { id: "triage-snooze", title: "Snooze until later", group: "Notifications", scope: "notifications", keys: ["H"], keywords: ["later", "remind"], handler: "local" },
  { id: "triage-read", title: "Mark read or unread", group: "Notifications", scope: "notifications", keys: ["U"], handler: "local" },
  { id: "mail-split-next", title: "Next Inbox split", group: "Mail", scope: "mail", keys: ["Tab"], keywords: ["important", "other", "split"], handler: "local" },
  { id: "mail-split-prev", title: "Previous Inbox split", group: "Mail", scope: "mail", keys: ["Shift", "Tab"], keywords: ["split"], handler: "local" },
  { id: "prejoin-join", title: "Join the call from the pre-join screen", group: "Meetings", scope: "meeting", keys: ["Enter"], keywords: ["camera", "mic"], handler: "local" },
  { id: "doc-slash", title: "Insert any block in a doc", group: "Writing", scope: "writing", keys: ["/"], keywords: ["heading", "list", "to-do", "quote", "code", "divider"], handler: "local" },
];
