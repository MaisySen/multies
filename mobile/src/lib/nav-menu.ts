/**
 * M2 (1.10.10): the More grid on the phone, from the web's one menu model (GET /api/nav/menu, web R121). Pure data and
 * functions (no React): which sections and pages the server says this person can open, the count on each tile, where a
 * page opens (a screen in the app, else the web page in the in-app browser) and the person's own hidden sections.
 * When the server has no menu (an older server, an error, offline with nothing saved) the app shows FALLBACK_MENU:
 * only what the app itself can open today.
 */
import type { IconName } from "@/components/ui";
import type { TileColor } from "@/components/ui";
import type { Counts } from "./counts";

export interface MenuPage { to: string; label: string; icon: string; count?: string; whenUsed?: string }
export interface MenuSection { id: string; label: string; icon: string; to: string; pages: MenuPage[] }
export interface NavMenu { version: number; navP2: boolean; sections: MenuSection[]; mailSetup: { to: string; label: string }[] }

const str = (v: unknown, max = 120): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const appPath = (v: unknown): string | null => { const s = str(v, 300); return s && s.startsWith("/app") ? s : null; };

/** Only a well formed answer survives; anything else is null and the app falls back. Unknown fields are dropped. */
export function parseMenu(raw: unknown): NavMenu | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.version !== "number" || o.version < 1 || !Array.isArray(o.sections)) return null;
  const sections: MenuSection[] = [];
  for (const s of o.sections as unknown[]) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const id = str(r.id, 40); const label = str(r.label); const to = appPath(r.to);
    if (!id || !label || !to || !Array.isArray(r.pages)) continue;
    const pages: MenuPage[] = [];
    for (const p of r.pages as unknown[]) {
      if (!p || typeof p !== "object") continue;
      const q = p as Record<string, unknown>;
      const pto = appPath(q.to); const pl = str(q.label);
      if (!pto || !pl) continue;
      pages.push({ to: pto, label: pl, icon: str(q.icon, 40) ?? "", ...(str(q.count, 60) ? { count: q.count as string } : {}),
        ...(str(q.whenUsed, 200)?.startsWith("/api/") ? { whenUsed: q.whenUsed as string } : {}) });
    }
    if (pages.length) sections.push({ id, label, icon: str(r.icon, 40) ?? "", to, pages });
  }
  if (!sections.length) return null;
  const mailSetup = Array.isArray(o.mailSetup) ? (o.mailSetup as unknown[]).flatMap((m) => {
    const r = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
    const to = appPath(r.to); const label = str(r.label);
    return to && label ? [{ to, label }] : [];
  }) : [];
  return { version: o.version, navP2: o.navP2 === true, sections, mailSetup };
}

/** What the app can open by itself today, in the web's order. Shown when the server has no menu for us. */
export const FALLBACK_MENU: NavMenu = {
  version: 0, navP2: false, mailSetup: [],
  sections: [
    { id: "home", label: "Home", icon: "home", to: "/app/my-work", pages: [
      { to: "/app/my-work", label: "My Work", icon: "today" },
      { to: "/app/notifications", label: "Notifications", icon: "bell", count: "notifications.unread" },
      { to: "/app/approvals", label: "Approvals", icon: "approvals" },
    ] },
    { id: "mail", label: "Mail", icon: "mail", to: "/app/mail", pages: [{ to: "/app/mail", label: "Mail", icon: "mail", count: "mail.inbox" }] },
    { id: "chat", label: "Chat", icon: "chat", to: "/app/chat", pages: [
      { to: "/app/chat", label: "Chat", icon: "chat", count: "chat.unread" },
      { to: "/app/meetings", label: "Meetings", icon: "meetings" },
    ] },
    { id: "tasks", label: "Tasks", icon: "tasks", to: "/app/tasks", pages: [
      { to: "/app/tasks", label: "All tasks", icon: "tasks" },
      { to: "/app/portfolio", label: "Portfolio", icon: "portfolio" },
    ] },
    { id: "docs", label: "Docs", icon: "docs", to: "/app/docs", pages: [
      { to: "/app/docs", label: "Docs", icon: "docs" },
      { to: "/app/files", label: "Files", icon: "files" },
    ] },
    { id: "social", label: "Social", icon: "social", to: "/app/social", pages: [{ to: "/app/social", label: "Planner", icon: "planner" }] },
    { id: "contacts", label: "Contacts", icon: "contacts", to: "/app/contacts", pages: [{ to: "/app/contacts", label: "People", icon: "people" }] },
    { id: "tools", label: "Tools", icon: "tools", to: "/app/tools", pages: [{ to: "/app/tools", label: "Tools", icon: "tools" }] },
    { id: "agents", label: "Agents", icon: "agents", to: "/app/agents", pages: [{ to: "/app/automations/runs", label: "Runs", icon: "activity" }] },
    { id: "workspace", label: "Settings", icon: "workspace", to: "/app/settings", pages: [
      { to: "/app/settings", label: "Settings", icon: "settings" },
      { to: "/app/activity", label: "Activity", icon: "activity" },
    ] },
  ],
};

/** Web menu icons to the app's icon names. */
const ICON: Record<string, IconName> = {
  home: "home", mail: "mail", tasks: "tasks", docs: "doc", tools: "wrench", chat: "chat", dashboards: "columns", workspace: "settings",
  today: "today", overview: "compass", bell: "bell", triage: "filter", approvals: "approvals", activity: "activity", sharedInbox: "inbox",
  mailboxes: "mail-open", domains: "globe", deliverability: "send", goals: "flag", portfolio: "briefcase", timesheet: "clock",
  templates: "layers", automations: "zap", files: "hard-drive", forms: "list", meetings: "meeting", booking: "calendar", contacts: "users",
  reports: "file-text", agents: "bot", integrations: "link", connections: "link", settings: "settings", operator: "shield",
  convert: "refresh-cw", social: "at-sign", planner: "calendar", posts: "edit", accounts: "user-check", library: "layers", help: "life-buoy",
  socialInbox: "inbox", analytics: "activity", sites: "globe", people: "user", deals: "dollar-sign",
};
export const iconFor = (key: string): IconName => ICON[key] ?? "more-horizontal";

const COLOR: Record<string, TileColor> = {
  home: "brand", mail: "blue", chat: "green", tasks: "orange", docs: "indigo", social: "pink", contacts: "teal", tools: "gray",
  dashboards: "yellow", agents: "purple", workspace: "gray",
};
export const colorFor = (sectionId: string): TileColor => COLOR[sectionId] ?? "blue";

/** Web pages the app has its own screen for. Anything else opens the web page in the in-app browser. */
const NATIVE: Record<string, string> = {
  "/app": "/today", "/app/my-work": "/today", "/app/notifications": "/notifications", "/app/approvals": "/approvals",
  "/app/mail": "/inbox", "/app/chat": "/chat", "/app/meetings": "/meetings", "/app/tasks": "/tasks", "/app/portfolio": "/portfolio",
  "/app/docs": "/docs", "/app/files": "/files", "/app/social": "/social", "/app/contacts": "/contacts", "/app/deals": "/deals", "/app/tools": "/tools",
  "/app/automations/runs": "/runs", "/app/activity": "/activity", "/app/settings": "/settings",
};
/** The app screen for a web page, or null when it opens on the web. Tasks needs the app's tasks switch. */
export function nativeRoute(to: string, opts: { tasks: boolean } = { tasks: true }): string | null {
  const path = to.split(/[?#]/)[0].replace(/\/+$/, "") || "/app";
  if (path === "/app/tasks" && !opts.tasks) return null;
  return NATIVE[path] ?? null;
}

/** The number a count key names in GET /api/counts ("mail.inbox", "triage"). 0 when missing. */
export function countOf(counts: Counts | null | undefined, key: string | undefined): number {
  if (!counts || !key) return 0;
  let v: unknown = counts;
  for (const part of key.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[part] : undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** One number per tile: the sum of its pages' counts, the same number the web's More sheet shows. */
export const sectionCount = (s: MenuSection, counts: Counts | null | undefined) => s.pages.reduce((n, p) => n + countOf(counts, p.count), 0);

/** Short words for a count on a tile, for screen readers too. */
export const countText = (n: number) => (n > 99 ? "99+" : String(n));

/** Home and Settings always stay, as on the web: there must be a way home and a way to undo hiding. */
export const UNHIDEABLE = ["home", "workspace"] as const;
export const canHide = (id: string) => !(UNHIDEABLE as readonly string[]).includes(id);

export function cleanHidden(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) if (typeof x === "string" && x.length <= 40 && canHide(x) && !out.includes(x)) out.push(x);
  return out.slice(0, 20);
}
export const visibleSections = (m: NavMenu, hidden: readonly string[]) => m.sections.filter((s) => !canHide(s.id) || !hidden.includes(s.id));

/** Drops pages the server marked "shown once used" when the workspace does not use them (Sites before a site exists). */
export function withUsed(m: NavMenu, used: Record<string, boolean>): NavMenu {
  const sections = m.sections.map((s) => ({ ...s, pages: s.pages.filter((p) => !p.whenUsed || used[p.whenUsed] === true) })).filter((s) => s.pages.length > 0);
  return { ...m, sections };
}
