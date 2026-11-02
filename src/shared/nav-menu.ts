/**
 * R121 (layout plan P2, NAV_P2_R121): the one menu model. A single typed list of sections and their pages drives the
 * desktop rail, the phone More sheet and the /api/nav/menu answer the mobile app reads, so they never drift apart again.
 * Pure data and functions (no React, no DOM): the web shell and the server import the same module.
 */
export type SectionId = "home" | "mail" | "tasks" | "docs" | "social" | "contacts" | "tools" | "chat" | "dashboards" | "agents" | "workspace";
export type IconKey =
  | "home" | "mail" | "tasks" | "docs" | "tools" | "chat" | "dashboards" | "workspace"
  | "today" | "overview" | "bell" | "triage" | "approvals" | "activity" | "sharedInbox" | "mailboxes" | "domains" | "deliverability"
  | "goals" | "portfolio" | "timesheet" | "templates" | "automations" | "files" | "forms" | "meetings" | "booking" | "contacts"
  | "reports" | "agents" | "integrations" | "connections" | "settings" | "operator" | "convert"
  | "social" | "planner" | "posts" | "accounts" | "library" | "help" | "socialInbox" | "analytics" | "sites"
  | "people" | "deals" // R121
  | "oneInbox"; // TD6

export type NavFlagKey = "sites" | "tools" | "files" | "scheduling" | "operator" | "flows" | "socialP2" | "helpCenter" | "socialP2b" | "docsPlus" | "inboxTd6";
export interface NavPage { to: string; label: string; icon: IconKey; end?: boolean; flag?: NavFlagKey }
export interface Section { id: SectionId; label: string; icon: IconKey; to: string; pages: NavPage[] }
export type NavFlagSet = Partial<Record<NavFlagKey, boolean>>;

/** The P1 rail (R79 and layout plan P1): what everyone sees while NAV_P2_R121 is off. Moved here unchanged from shell-nav.ts. */
export const SECTIONS_P1: Section[] = [
  { id: "home", label: "Home", icon: "home", to: "/app/my-work", pages: [
    { to: "/app/my-work", label: "My Work", icon: "today" },
    { to: "/app", label: "Overview", icon: "overview", end: true },
    { to: "/app/one-inbox", label: "One inbox", icon: "oneInbox", flag: "inboxTd6" }, // TD6: shown only with INBOX_TD6 on the web
    { to: "/app/notifications", label: "Notifications", icon: "bell" },
    { to: "/app/triage", label: "Triage", icon: "triage" },
    { to: "/app/approvals", label: "Approvals", icon: "approvals" },
  ] },
  { id: "mail", label: "Mail", icon: "mail", to: "/app/mail", pages: [
    { to: "/app/mail", label: "Mail", icon: "mail" },
    { to: "/app/inbox", label: "Shared inbox", icon: "sharedInbox" },
    { to: "/app/mailboxes", label: "Mailboxes", icon: "mailboxes" },
    { to: "/app/domains", label: "Domains", icon: "domains" },
    { to: "/app/deliverability", label: "Deliverability", icon: "deliverability" },
  ] },
  { id: "tasks", label: "Tasks", icon: "tasks", to: "/app/tasks", pages: [
    { to: "/app/tasks", label: "All tasks", icon: "tasks" },
    { to: "/app/goals", label: "Goals", icon: "goals" },
    { to: "/app/portfolio", label: "Portfolio", icon: "portfolio" },
    { to: "/app/time", label: "Timesheet", icon: "timesheet" },
    { to: "/app/templates", label: "Project templates", icon: "templates" },
  ] },
  { id: "docs", label: "Docs", icon: "docs", to: "/app/docs", pages: [
    { to: "/app/docs", label: "Docs", icon: "docs" },
    { to: "/app/forms", label: "Forms", icon: "forms" },
    { to: "/app/docs/links", label: "Link library", icon: "library", flag: "docsPlus" }, // R103
    { to: "/app/docs/help-center", label: "Help center", icon: "help", flag: "helpCenter" }, // R122
    { to: "/app/docs/sites", label: "Sites", icon: "sites", flag: "sites" }, // R123: shown once the workspace has a site
  ] },
  // P1 layout: posting is a daily tool, so it has its own place (it lived in Settings, Connections, Social posts).
  { id: "social", label: "Social", icon: "social", to: "/app/social", pages: [
    { to: "/app/social/inbox", label: "Inbox", icon: "socialInbox", flag: "socialP2b" }, // R118
    { to: "/app/social", label: "Planner", icon: "planner", end: true },
    { to: "/app/social/posts", label: "Posts", icon: "posts" },
    { to: "/app/social/library", label: "Library", icon: "library", flag: "socialP2" }, // R117
    { to: "/app/social/analytics", label: "Analytics", icon: "analytics", flag: "socialP2b" }, // R118
    { to: "/app/social/accounts", label: "Accounts", icon: "accounts" },
  ] },
  { id: "tools", label: "Tools", icon: "tools", to: "/app/tools", pages: [
    { to: "/app/tools", label: "Tools", icon: "tools", flag: "tools" },
    { to: "/app/tools/convert", label: "Convert files", icon: "convert", flag: "tools" }, // R82F (MB-283)
    { to: "/app/files", label: "Files", icon: "files", flag: "files" },
  ] },
  { id: "chat", label: "Chat", icon: "chat", to: "/app/chat", pages: [
    { to: "/app/chat", label: "Chat", icon: "chat" },
    { to: "/app/meetings", label: "Meetings", icon: "meetings" },
    { to: "/app/scheduling", label: "Booking page", icon: "booking", flag: "scheduling" },
    { to: "/app/contacts", label: "Contacts", icon: "contacts" },
  ] },
  { id: "dashboards", label: "Dashboards", icon: "dashboards", to: "/app/dashboards", pages: [
    { to: "/app/dashboards", label: "Dashboards", icon: "dashboards" },
    { to: "/app/reports", label: "Reports", icon: "reports" },
  ] },
  // P1 layout: Agents is a daily tool with its own place at the bottom of the rail, above Settings.
  { id: "agents", label: "Agents", icon: "agents", to: "/app/agents", pages: [
    { to: "/app/agents", label: "Agents", icon: "agents" },
    // R90 (layout plan: one Automations home under Agents): flows, rules and their runs.
    { to: "/app/automations", label: "Automations", icon: "automations" },
    { to: "/app/automations/runs", label: "Runs", icon: "activity", flag: "flows" },
  ] },
  // P1 layout: "Workspace" is called Settings; it holds only wiring (connect, keys, people, billing, the log).
  { id: "workspace", label: "Settings", icon: "workspace", to: "/app/settings", pages: [
    { to: "/app/settings", label: "Settings", icon: "settings" },
    { to: "/app/settings/apps", label: "Connections", icon: "connections" }, // R80C
    { to: "/app/activity", label: "Activity", icon: "activity" },
    { to: "/app/admin", label: "Operator", icon: "operator", flag: "operator" },
  ] },
];

const p1 = (id: SectionId): Section => SECTIONS_P1.find((s) => s.id === id)!;

/** R121: the plan's section 3 rail, in its order. Agents and Settings sit at the bottom of the rail. */
export const SECTIONS_P2: Section[] = [
  p1("home"),
  // Setup pages (Mailboxes, Domains, Deliverability, Routing) live in Settings, Mail setup.
  { id: "mail", label: "Mail", icon: "mail", to: "/app/mail", pages: [
    { to: "/app/mail", label: "Mail", icon: "mail" },
    { to: "/app/inbox", label: "Shared inbox", icon: "sharedInbox" },
  ] },
  // Chat moves up, next to Mail; Contacts leaves for its own section.
  { id: "chat", label: "Chat", icon: "chat", to: "/app/chat", pages: [
    { to: "/app/chat", label: "Chat", icon: "chat" },
    { to: "/app/meetings", label: "Meetings", icon: "meetings" },
    { to: "/app/scheduling", label: "Booking page", icon: "booking", flag: "scheduling" },
  ] },
  { id: "tasks", label: "Tasks", icon: "tasks", to: "/app/tasks", pages: [
    { to: "/app/tasks", label: "All tasks", icon: "tasks" },
    { to: "/app/goals", label: "Goals", icon: "goals" },
    { to: "/app/portfolio", label: "Portfolio", icon: "portfolio" },
    { to: "/app/time", label: "Timesheet", icon: "timesheet" },
    { to: "/app/templates", label: "Project templates", icon: "templates" },
  ] },
  // Files joins Docs (same address and switch as before).
  { id: "docs", label: "Docs", icon: "docs", to: "/app/docs", pages: [
    { to: "/app/docs", label: "Docs", icon: "docs" },
    { to: "/app/files", label: "Files", icon: "files", flag: "files" },
    { to: "/app/forms", label: "Forms", icon: "forms" },
    { to: "/app/docs/links", label: "Link library", icon: "library", flag: "docsPlus" },
    { to: "/app/docs/help-center", label: "Help center", icon: "help", flag: "helpCenter" },
    { to: "/app/docs/sites", label: "Sites", icon: "sites", flag: "sites" },
  ] },
  p1("social"),
  // Contacts out of Chat; Deals gets a home (it had no menu entry).
  { id: "contacts", label: "Contacts", icon: "contacts", to: "/app/contacts", pages: [
    { to: "/app/contacts", label: "People", icon: "people" },
    { to: "/app/deals", label: "Deals", icon: "deals" },
  ] },
  { id: "tools", label: "Tools", icon: "tools", to: "/app/tools", pages: [
    { to: "/app/tools", label: "Tools", icon: "tools", flag: "tools" },
    { to: "/app/tools/convert", label: "Convert files", icon: "convert", flag: "tools" },
  ] },
  p1("dashboards"),
  p1("agents"),
  p1("workspace"),
];

/** Settings, Mail setup (plan section 3): the setup pages that left the Mail sidebar, inside the one Settings sidebar. */
export const MAIL_SETUP: { to: string; label: string; old?: string }[] = [
  { to: "/app/settings/mailboxes", label: "Mailboxes", old: "/app/mailboxes" },
  { to: "/app/settings/domains", label: "Domains", old: "/app/domains" },
  { to: "/app/settings/deliverability", label: "Deliverability", old: "/app/deliverability" },
  { to: "/app/settings/mail", label: "Routing" },
];

/** Old address prefix to its new home, when the P2 menu is on. Deep links (ids), query and hash ride along. */
export const MOVED_P2: readonly (readonly [string, string])[] = MAIL_SETUP.filter((m) => m.old).map((m) => [m.old!, m.to] as const);

/** The new address for an old one (null when it did not move). Works on paths with a query or hash. */
export function movedPath(url: string): string | null {
  const cut = url.search(/[?#]/);
  const path = cut < 0 ? url : url.slice(0, cut);
  const rest = cut < 0 ? "" : url.slice(cut);
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  for (const [from, to] of MOVED_P2) {
    if (clean === from) return `${to}${rest}`;
    if (clean.startsWith(`${from}/`)) return `${to}${clean.slice(from.length)}${rest}`;
  }
  return null;
}

/** The address to link to: the new home while the P2 menu is on, the old address otherwise. */
export const navHref = (url: string, p2: boolean): string => (p2 ? movedPath(url) ?? url : url);

/** The sections and pages this person can open (switched off features leave no dead links). */
export function visibleIn(sections: Section[], flags: NavFlagSet): Section[] {
  return sections
    .map((s) => ({ ...s, pages: s.pages.filter((p) => !p.flag || !!flags[p.flag]) }))
    .filter((s) => s.pages.length > 0);
}

/** Home and Settings always stay: there must be a way home and a way to undo a hidden item. */
export const UNHIDEABLE: readonly SectionId[] = ["home", "workspace"];
export const canHide = (id: SectionId) => !UNHIDEABLE.includes(id);

/** Clean a stored hidden list: known, hideable ids only, no repeats. */
export function cleanHidden(raw: unknown): SectionId[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(SECTIONS_P2.map((s) => s.id));
  const out: SectionId[] = [];
  for (const x of raw) if (typeof x === "string" && known.has(x) && canHide(x as SectionId) && !out.includes(x as SectionId)) out.push(x as SectionId);
  return out;
}

/** The rail and More after the person's own hiding. The section you are in always shows, so you never lose your place. */
export function withoutHidden(sections: Section[], hidden: readonly SectionId[], active?: SectionId): Section[] {
  return sections.filter((s) => !hidden.includes(s.id) || !canHide(s.id) || s.id === active);
}

export type NavCount = { n: number; label: string; alert?: boolean };
/**
 * One number per section for the rail badge and the More tile (the same number in both places): what needs you (alerts,
 * coloured) when anything does, else the plain unread total (calm).
 */
export function sectionBadge(s: Section, counts: Record<string, NavCount | undefined>): { n: number; alert: boolean } {
  let alert = 0; let calm = 0;
  for (const p of s.pages) { const c = counts[p.to]; if (!c || c.n <= 0) continue; if (c.alert) alert += c.n; else calm += c.n; }
  return alert > 0 ? { n: alert, alert: true } : { n: calm, alert: false };
}

/** Phone tabs (plan section 9): Home, Mail, Chat, a fourth tab each person picks, More. */
export type FourthTab = "tasks" | "social" | "calendar" | "docs";
export const FOURTH_TABS: { id: FourthTab; label: string; to: string }[] = [
  { id: "tasks", label: "Tasks", to: "/app/tasks" },
  { id: "social", label: "Social", to: "/app/social" },
  { id: "calendar", label: "Calendar", to: "/app/tasks?view=calendar" },
  { id: "docs", label: "Docs", to: "/app/docs" },
];
export const cleanFourthTab = (raw: unknown): FourthTab => (FOURTH_TABS.some((t) => t.id === raw) ? raw as FourthTab : "tasks");

/** Which counts feed which page, for the app: the field in GET /api/counts. */
export const COUNT_KEYS: Record<string, string> = {
  "/app/notifications": "notifications.unread", "/app/triage": "triage", "/app/mail": "mail.inbox", "/app/chat": "chat.unread",
};
export const MENU_VERSION = 1;
