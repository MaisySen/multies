import { IconClose, IconKeyboard, IconMegaphone, IconSearch } from "@/web/components/ui/icon";
import type { Command } from "../types";

/** Keys that work on every page. */
export const generalCommands: Command[] = [
  { id: "palette", title: "Open the command menu", group: "General", scope: "global", keys: ["Mod", "K"], keywords: ["search", "jump", "palette"], icon: IconSearch, palette: false, handler: "local" },
  { id: "sheet", title: "Show keyboard shortcuts", group: "General", scope: "global", keys: ["?"], keywords: ["help", "keys", "hotkeys"], icon: IconKeyboard, palette: false, handler: "run", run: (c) => c.openSheet() },
  { id: "escape", title: "Close a menu, dialog or message", group: "General", scope: "global", keys: ["Esc"], icon: IconClose, palette: false, handler: "local" },
  // P1 layout: P opens the Social composer from anywhere (it is not a key on any page).
  { id: "social-new", title: "New social post", group: "General", scope: "global", keys: ["P"], keywords: ["post", "social", "publish"], icon: IconMegaphone, palette: false, handler: "run", run: (c) => c.navigate("/app/social/new") },
];
