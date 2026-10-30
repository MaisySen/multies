import type { Command } from "../types";

/** Keys handled inside fields and editors; listed so the sheet tells the whole story. */
export const writingCommands: Command[] = [
  { id: "comment-send", title: "Post a comment or note", group: "Writing", scope: "writing", keys: ["Mod", "Enter"], keywords: ["submit", "send"], handler: "local" },
  { id: "snippet", title: "Insert a saved reply in Compose", group: "Writing", scope: "writing", keys: ["/shortcut", "Tab"], keywords: ["snippet", "template"], handler: "local" },
  { id: "chat-send", title: "Send a chat message", group: "Writing", scope: "writing", keys: ["Enter"], keywords: ["chat"], handler: "local" },
  { id: "chat-newline", title: "New line in a chat message", group: "Writing", scope: "writing", keys: ["Shift", "Enter"], keywords: ["chat"], handler: "local" },
];
