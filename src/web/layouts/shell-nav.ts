/**
 * R79: the app's navigation model. A calm icon rail of sections; each section owns the pages listed in its sidebar.
 * Pure data and functions (no React), so routing, breadcrumbs and the rail stay testable and agree with each other.
 */
export type SectionId = "home" | "mail" | "tasks" | "docs" | "tools" | "chat" | "dashboards" | "workspace";
export type IconKey =
  | "home" | "mail" | "tasks" | "docs" | "tools" | "chat" | "dashboards" | "workspace"
  | "today" | "overview" | "bell" | "triage" | "approvals" | "activity" | "sharedInbox" | "mailboxes" | "domains" | "deliverability"
  | "goals" | "portfolio" | "timesheet" | "templates" | "automations" | "files" | "forms" | "meetings" | "booking" | "contacts"
  | "reports" | "agents" | "integrations" | "settings" | "operator";

export interface NavPage { to: string; label: string; icon: IconKey; end?: boolean; flag?: "tools" | "files" | "scheduling" | "operator" }
export interface Section { id: SectionId; label: string; icon: IconKey; to: string; pages: NavPage[] }

export const SECTIONS: Section[] = [
  { id: "home", label: "Home", icon: "home", to: "/app/my-work", pages: [
    { to: "/app/my-work", label: "My Work", icon: "today" },
    { to: "/app", label: "Overview", icon: "overview", end: true },
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
    { to: "/app/automations", label: "Automations", icon: "automations" },
  ] },
  { id: "docs", label: "Docs", icon: "docs", to: "/app/docs", pages: [
    { to: "/app/docs", label: "Docs", icon: "docs" },
    { to: "/app/forms", label: "Forms", icon: "forms" },
  ] },
  { id: "tools", label: "Tools", icon: "tools", to: "/app/tools", pages: [
    { to: "/app/tools", label: "Tools", icon: "tools", flag: "tools" },
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
  { id: "workspace", label: "Workspace", icon: "workspace", to: "/app/settings", pages: [
    { to: "/app/settings", label: "Settings", icon: "settings" },
    { to: "/app/agents", label: "Agents", icon: "agents" },
    { to: "/app/integrations", label: "Integrations", icon: "integrations" },
    { to: "/app/activity", label: "Activity", icon: "activity" },
    { to: "/app/admin", label: "Operator", icon: "operator", flag: "operator" },
  ] },
];

export interface NavFlags { tools?: boolean; files?: boolean; scheduling?: boolean; operator?: boolean }

/** The sections and pages this person can open (switched off features leave no dead links). */
export function visibleSections(flags: NavFlags): Section[] {
  return SECTIONS
    .map((s) => ({ ...s, pages: s.pages.filter((p) => !p.flag || flags[p.flag]) }))
    .filter((s) => s.pages.length > 0);
}

const matches = (pathname: string, p: NavPage) => (p.end ? pathname === p.to || pathname === `${p.to}/` : pathname === p.to || pathname.startsWith(`${p.to}/`));

/** The page a path belongs to: the longest matching entry wins (/app/settings/branding is Settings). */
export function pageFor(pathname: string, sections: Section[] = SECTIONS): { section: Section; page: NavPage } | null {
  let best: { section: Section; page: NavPage } | null = null;
  for (const section of sections) for (const page of section.pages) {
    if (matches(pathname, page) && (!best || page.to.length > best.page.to.length)) best = { section, page };
  }
  return best;
}

export function sectionFor(pathname: string, sections: Section[] = SECTIONS): Section {
  return pageFor(pathname, sections)?.section ?? sections[0];
}

/** Settings sub pages read better than their slugs in the breadcrumb. */
const SUB_LABEL: Record<string, string> = {
  account: "Account and security", team: "People", billing: "Plan and billing", branding: "Branding", appearance: "Appearance",
  developers: "Developers", "mail-apps": "Mail apps", import: "Import", calendar: "Calendar", security: "Security",
};
const titleCase = (slug: string) => { const s = decodeURIComponent(slug).replace(/[-_]+/g, " ").trim(); return s ? s[0].toUpperCase() + s.slice(1) : s; };

export interface Crumb { label: string; to?: string }

/**
 * Breadcrumbs for the top bar: section, then the page when it differs, then a project or settings page.
 * Ids in paths (a doc or a meeting) are not shown as words; the page itself carries its title.
 */
export function breadcrumbs(pathname: string, search: string, ctx: { projectName?: string | null } = {}, sections: Section[] = SECTIONS): Crumb[] {
  const hit = pageFor(pathname, sections);
  if (!hit) return [];
  const out: Crumb[] = [{ label: hit.section.label, to: hit.section.to }];
  if (hit.page.label !== hit.section.label) out.push({ label: hit.page.label, to: hit.page.to });
  const params = new URLSearchParams(search);
  if (hit.page.to === "/app/tasks" && params.get("project") && ctx.projectName) out.push({ label: ctx.projectName });
  const rest = pathname.slice(hit.page.to.length).split("/").filter(Boolean);
  if (hit.page.to === "/app/settings" && rest[0]) out.push({ label: SUB_LABEL[rest[0]] ?? titleCase(rest[0]) });
  // The last crumb is where you are: it is text, not a link.
  if (out.length) out[out.length - 1] = { label: out[out.length - 1].label };
  return out;
}

export type CreateKind = "task" | "doc" | "mail" | "event" | "file";
export const CREATE_ITEMS: { kind: CreateKind; label: string; to: string; hint: string }[] = [
  { kind: "task", label: "Task", to: "/app/tasks?new=1", hint: "T" },
  { kind: "doc", label: "Doc", to: "/app/docs?new=1", hint: "D" },
  { kind: "mail", label: "Email", to: "/app/mail?compose=1", hint: "M" },
  { kind: "event", label: "Meeting", to: "/app/meetings?new=1", hint: "E" },
  { kind: "file", label: "File", to: "/app/tools", hint: "F" },
];

/** Create items this workspace can use: a file opens Tools, else Docs (where files can be added to a doc). */
export function createItems(flags: NavFlags) {
  return CREATE_ITEMS.map((c) => (c.kind === "file" && !flags.tools ? { ...c, to: "/app/docs" } : c));
}
