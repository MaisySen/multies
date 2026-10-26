import { Keyboard, Search, X } from "lucide-react";
import type { Command } from "../types";

/** Keys that work on every page. */
export const generalCommands: Command[] = [
  { id: "palette", title: "Open the command menu", group: "General", scope: "global", keys: ["Mod", "K"], keywords: ["search", "jump", "palette"], icon: Search, palette: false, handler: "local" },
  { id: "sheet", title: "Show keyboard shortcuts", group: "General", scope: "global", keys: ["?"], keywords: ["help", "keys", "hotkeys"], icon: Keyboard, palette: false, handler: "run", run: (c) => c.openSheet() },
  { id: "escape", title: "Close a menu, dialog or message", group: "General", scope: "global", keys: ["Esc"], icon: X, palette: false, handler: "local" },
];
