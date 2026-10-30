import { PALETTE_ACTIONS, PALETTE_PAGES } from "@/web/lib/palette-registry";
import type { Command } from "../types";

/** Second key after G, by page id in the page list (one list: lib/palette-registry.ts). */
export const GO_KEYS: { key: string; page: string; label?: string }[] = [
  { key: "w", page: "p-my-work" },
  { key: "o", page: "p-overview", label: "Overview" },
  { key: "n", page: "p-notifications" },
  { key: "i", page: "p-mail", label: "Mail" },
  { key: "u", page: "p-shared-inbox", label: "Shared inbox" },
  { key: "c", page: "p-chat" },
  { key: "t", page: "p-tasks" },
  { key: "d", page: "p-docs" },
  { key: "m", page: "p-meetings" },
  { key: "p", page: "p-contacts" },
  { key: "a", page: "p-agents" },
  { key: "r", page: "p-triage", label: "Triage" }, // R32: task Triage
  { key: "s", page: "p-settings" },
];

const goKey = new Map(GO_KEYS.map((g) => [g.page, g]));

/** Every app page: a command menu entry, and a G then key sequence when it has one. */
export const navCommands: Command[] = PALETTE_PAGES.map((p): Command => {
  const g = goKey.get(p.id);
  return {
    id: g ? `go-${g.key}` : `nav-${p.id}`,
    title: g ? `Go to ${g.label ?? p.label}` : p.label,
    group: "Go to", scope: "global", icon: p.icon, to: p.to,
    keys: g ? ["G", g.key.toUpperCase()] : undefined, sequence: g ? true : undefined,
    keywords: [p.label, ...(p.keywords ?? []), "navigate", "open"],
    palette: true, handler: "run", run: (c) => c.navigate(p.to), flag: p.flag,
  };
});

/** The command menu's actions (write an email, new task, theme, ...). */
export const actionCommands: Command[] = PALETTE_ACTIONS.map((a): Command => ({
  id: `action-${a.id}`, title: a.label, group: "General", scope: "global", icon: a.icon, to: a.to, keywords: a.keywords,
  palette: true, sheet: false, handler: "run",
  run: (c) => {
    if (a.kind === "shortcuts") c.openSheet();
    else if (a.kind === "theme") c.toggleTheme?.();
    else if (a.kind === "external" && a.to) window.open(a.to, "_blank", "noopener");
    else if (a.to) c.navigate(a.to);
  },
}));
