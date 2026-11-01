/**
 * R79: the app's navigation model. A calm icon rail of sections; each section owns the pages listed in its sidebar.
 * Pure data and functions (no React), so routing, breadcrumbs and the rail stay testable and agree with each other.
 */
export type SectionId = "home" | "mail" | "tasks" | "docs" | "social" | "tools" | "chat" | "dashboards" | "agents" | "workspace";
export type IconKey =
  | "home" | "mail" | "tasks" | "docs" | "tools" | "chat" | "dashboards" | "workspace"
  | "today" | "overview" | "bell" | "triage" | "approvals" | "activity" | "sharedInbox" | "mailboxes" | "domains" | "deliverability"
  | "goals" | "portfolio" | "timesheet" | "templates" | "automations" | "files" | "forms" | "meetings" | "booking" | "contacts"
  | "reports" | "agents" | "integrations" | "connections" | "settings" | "operator" | "convert"
  | "social" | "planner" | "posts" | "accounts" | "library" | "help" | "socialInbox" | "analytics";

export interface NavPage { to: string; label: string; icon: IconKey; end?: boolean; flag?: "tools" | "files" | "scheduling" | "operator" | "flows" | "socialP2" | "helpCenter" | "socialP2b" | "docsPlus" }
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
  ] },
  { id: "docs", label: "Docs", icon: "docs", to: "/app/docs", pages: [
    { to: "/app/docs", label: "Docs", icon: "docs" },
    { to: "/app/forms", label: "Forms", icon: "forms" },
    { to: "/app/docs/links", label: "Link library", icon: "library", flag: "docsPlus" }, // R103
    { to: "/app/docs/help-center", label: "Help center", icon: "help", flag: "helpCenter" }, // R122
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

export interface NavFlags { /** R122: the help center in Docs. */ helpCenter?: boolean; /** R103: the link library in Docs. */ docsPlus?: boolean; /** R90: the automation builder is on. */ flows?: boolean; tools?: boolean; files?: boolean; scheduling?: boolean; operator?: boolean; /** R80C: owners and admins can write social posts (R117: members too, sent for approval, with Social P2). */ social?: boolean; socialP2?: boolean; /** R118: Social inbox and analytics. */ socialP2b?: boolean; /** R87: Tools > Links is on. */ links?: boolean }

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
  // P1 layout: New post is a button at the top of the Social sidebar, not a list entry; it still belongs to Social.
  if (!best && (pathname === SOCIAL_NEW || pathname.startsWith(`${SOCIAL_NEW}/`))) {
    const section = sections.find((s) => s.id === "social");
    if (section) best = { section, page: { to: SOCIAL_NEW, label: "New post", icon: "social" } };
  }
  return best;
}

export function sectionFor(pathname: string, sections: Section[] = SECTIONS): Section {
  return pageFor(pathname, sections)?.section ?? sections[0];
}

/** P1 layout: the Social composer (the Create menu's Social post and shortcut P open it). */
export const SOCIAL_NEW = "/app/social/new";

/** Settings sub pages read better than their slugs in the breadcrumb. */
const SUB_LABEL: Record<string, string> = {
  account: "Account and security", team: "People", billing: "Plan and billing", branding: "Branding", appearance: "Appearance",
  developers: "Developers", "mail-apps": "Mail apps", import: "Import", calendar: "Calendar", security: "Security",
};
const titleCase = (slug: string) => { const s = decodeURIComponent(slug).replace(/[-_]+/g, " ").trim(); return s ? s[0].toUpperCase() + s.slice(1) : s; };

const TOOL_SUB: Record<string, string> = {
  ai: "AI document helpers", share: "Secure share", sign: "E-sign", workflows: "Tool workflows", templates: "Invoice and letter templates",
  merge: "Mail merge", pages: "Page editor", forms: "Fill a PDF form", compare: "Compare documents", organize: "Organise pages",
  "edit-pdf": "Edit a PDF", // R86
};

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
  // R82F (MB-283): a tool's own page names itself (an editor slug reads as words).
  // R108: the Contracts view of Tools > Templates names itself.
  if (hit.page.to === "/app/tools" && rest[0]) out.push({ label: rest[0] === "templates" && params.get("view") === "contracts" ? "Contracts" : TOOL_SUB[rest[0]] ?? titleCase(rest[0]) });
  // R80C, R82F (MB-279): the tabs of Connections.
  const CONNECTION_SUB: Record<string, string> = { mail: "Mail accounts", webhooks: "Webhooks" };
  if (hit.page.to === "/app/settings/apps" && rest[0] && CONNECTION_SUB[rest[0]]) out.push({ label: CONNECTION_SUB[rest[0]] });
  // The last crumb is where you are: it is text, not a link.
  if (out.length) out[out.length - 1] = { label: out[out.length - 1].label };
  return out;
}

/** Pages with no sidebar entry still get a real tab title. */
const OTHER_TITLES: Record<string, string> = {
  deals: "Deals", templates: "Project templates", admin: "Operator", agents: "Agents", meetings: "Meetings", docs: "Docs", contacts: "Contacts",
  integrations: "Webhooks", time: "Timesheet", social: "Social", dashboards: "Dashboards", chat: "Chat", inbox: "Shared inbox",
};

/**
 * R82F (MB-283): the browser tab title for an app page, "Tasks · Multies", "Branding · Settings · Multies": the page you
 * are on, then its parent when it sits inside Settings or Connections. Built from the same map as the breadcrumbs.
 */
export function pageTitle(pathname: string, search = "", sections: Section[] = SECTIONS): string {
  const crumbs = breadcrumbs(pathname, search, {}, sections);
  const hit = pageFor(pathname, sections);
  const parts: string[] = [];
  if (crumbs.length && hit) {
    const last = crumbs[crumbs.length - 1].label;
    parts.push(last === "All tasks" ? "Tasks" : last);
    // P1 layout: Settings is the section and the page now, so the parent is the page's own name, not the crumb before.
    if (last !== hit.page.label && (hit.page.to === "/app/settings" || hit.page.to === "/app/settings/apps")) parts.push(hit.page.label);
  } else {
    const seg = pathname.replace(/^\/app\/?/, "").split("/")[0];
    if (seg) parts.push(OTHER_TITLES[seg] ?? titleCase(seg));
  }
  return [...parts, "Multies"].join(" · ");
}

export type CreateKind = "task" | "doc" | "mail" | "event" | "file" | "post" | "link";
export const CREATE_ITEMS: { kind: CreateKind; label: string; to: string; hint: string }[] = [
  { kind: "task", label: "Task", to: "/app/tasks?new=1", hint: "T" },
  { kind: "doc", label: "Doc", to: "/app/docs?new=1", hint: "D" },
  { kind: "mail", label: "Email", to: "/app/mail?compose=1", hint: "M" },
  { kind: "event", label: "Meeting", to: "/app/meetings?new=1", hint: "E" },
  { kind: "file", label: "File", to: "/app/tools", hint: "F" },
];

/** Create items this workspace can use: a file opens Tools, else Docs (where files can be added to a doc). */
export function createItems(flags: NavFlags) {
  const items = CREATE_ITEMS.map((c) => (c.kind === "file" && !flags.tools ? { ...c, to: "/app/docs" } : c));
  // R80C: a social post, for the people who can send one.
  // R87: a short link, where Tools > Links is on.
  const withLink = flags.links ? [...items, { kind: "link" as const, label: "Short link", to: "/app/tools/links?new=1", hint: "" }] : items;
  // P1 layout: it opens the composer in Social (it opened Settings before).
  return flags.social ? [...withLink, { kind: "post" as const, label: "Social post", to: SOCIAL_NEW, hint: "P" }] : withLink;
}
