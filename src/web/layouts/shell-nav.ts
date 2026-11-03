/**
 * R79: the app's navigation model. A calm icon rail of sections; each section owns the pages listed in its sidebar.
 * Pure data and functions (no React), so routing, breadcrumbs and the rail stay testable and agree with each other.
 */
import { navHref, SECTIONS_P1, SECTIONS_P2, visibleIn, type NavPage, type Section } from "@/shared/nav-menu";
// R121: the menu model lives in src/shared/nav-menu.ts (one source for the rail, the phone More sheet and /api/nav/menu).
export type { SectionId, IconKey, NavPage, Section } from "@/shared/nav-menu";

/** The P1 rail. Kept under its old name for the code and tests that read it. */
export const SECTIONS: Section[] = SECTIONS_P1;

/**
 * R121 (NAV_P2_R121): which model the shell is using. Set by the app shell from /api/config before the rail renders,
 * so breadcrumbs, tab titles and the rail always agree. Off (the default) is the P1 navigation, unchanged.
 */
let navP2 = false;
export function setNavModel(p2: boolean) { navP2 = p2; }
export const isNavP2 = () => navP2;
export const activeSections = (): Section[] => (navP2 ? SECTIONS_P2 : SECTIONS_P1);
/** R121: a link to a page that may have moved (Mail setup): its new home while P2 is on, the old address otherwise. */
export const appHref = (url: string): string => navHref(url, navP2);

export interface NavFlags { /** TD6: One inbox (INBOX_TD6). */ inboxTd6?: boolean; /** R122: the help center in Docs. */ helpCenter?: boolean; /** R103: the link library in Docs. */ docsPlus?: boolean; /** R90: the automation builder is on. */ flows?: boolean; tools?: boolean; files?: boolean; scheduling?: boolean; operator?: boolean; /** R80C: owners and admins can write social posts (R117: members too, sent for approval, with Social P2). */ social?: boolean; socialP2?: boolean; /** R118: Social inbox and analytics. */ socialP2b?: boolean; /** R87: Tools > Links is on. */ links?: boolean; /** R105: invoices and quotes. */ invoices?: boolean; /** R123: the workspace has a site (the Sites page shows only then). */ sites?: boolean; /** R123: Sites is on and this person can start or build it (Create menu). */ sitesCreate?: boolean; /** R124: the blog is on and this person can write on the site. */ blogCreate?: boolean }

/** The sections and pages this person can open (switched off features leave no dead links). */
export function visibleSections(flags: NavFlags): Section[] {
  return visibleIn(activeSections(), flags);
}

const matches = (pathname: string, p: NavPage) => (p.end ? pathname === p.to || pathname === `${p.to}/` : pathname === p.to || pathname.startsWith(`${p.to}/`));

/** The page a path belongs to: the longest matching entry wins (/app/settings/branding is Settings). */
export function pageFor(pathname: string, sections: Section[] = activeSections()): { section: Section; page: NavPage } | null {
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

export function sectionFor(pathname: string, sections: Section[] = activeSections()): Section {
  return pageFor(pathname, sections)?.section ?? sections[0];
}

/** P1 layout: the Social composer (the Create menu's Social post and shortcut P open it). */
export const SOCIAL_NEW = "/app/social/new";

/** Settings sub pages read better than their slugs in the breadcrumb. */
const SUB_LABEL: Record<string, string> = {
  account: "Account and security", team: "People", billing: "Plan and billing", branding: "Branding", appearance: "Appearance",
  developers: "Developers", "mail-apps": "Mail apps", import: "Import", calendar: "Calendar", security: "Security",
  mailboxes: "Mailboxes", domains: "Domains", deliverability: "Deliverability", // R121: Settings, Mail setup
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
export function breadcrumbs(pathname: string, search: string, ctx: { projectName?: string | null } = {}, sections: Section[] = activeSections()): Crumb[] {
  const hit = pageFor(pathname, sections);
  if (!hit) return [];
  const out: Crumb[] = [{ label: hit.section.label, to: hit.section.to }];
  if (hit.page.label !== hit.section.label) out.push({ label: hit.page.label, to: hit.page.to });
  const params = new URLSearchParams(search);
  if (hit.page.to === "/app/tasks" && params.get("project") && ctx.projectName) out.push({ label: ctx.projectName });
  const rest = pathname.slice(hit.page.to.length).split("/").filter(Boolean);
  if (hit.page.to === "/app/settings" && rest[0]) out.push({ label: rest[0] === "mail" && navP2 ? "Routing" : SUB_LABEL[rest[0]] ?? titleCase(rest[0]) });
  // R82F (MB-283): a tool's own page names itself (an editor slug reads as words).
  // R108: the Contracts view of Tools > Templates names itself.
  if (hit.page.to === "/app/tools" && rest[0]) out.push({ label: rest[0] === "templates" && params.get("view") === "contracts" ? "Contracts" : TOOL_SUB[rest[0]] ?? titleCase(rest[0]) });
  // R80C, R82F (MB-279): the tabs of Connections.
  const CONNECTION_SUB: Record<string, string> = { mail: "Mail accounts", webhooks: "Webhooks" };
  if (hit.page.to === "/app/settings/apps" && rest[0] && CONNECTION_SUB[rest[0]]) out.push({ label: CONNECTION_SUB[rest[0]] });
  // POL2 (R126 low): Staff pages sit under Contacts but name themselves, in the crumbs and the tab title.
  if (hit.page.to === "/app/contacts" && (rest[0] === "staff" || rest[0] === "assets")) {
    out.push({ label: "Staff", to: "/app/contacts/staff" });
    if (rest[0] === "assets") out.push({ label: "Assets", to: "/app/contacts/staff?view=assets" });
  }
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
export function pageTitle(pathname: string, search = "", sections: Section[] = activeSections()): string {
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

/** Every kind the Create menu can show; the top bar keeps one icon per kind (F13b MB-309: a kind with no icon crashed it). */
export const CREATE_KINDS = ["task", "doc", "mail", "event", "file", "post", "link", "invoice", "quote", "site", "blog"] as const;
export type CreateKind = (typeof CREATE_KINDS)[number];
export interface CreateItem { kind: CreateKind; label: string; to: string; hint: string }
export const CREATE_ITEMS: CreateItem[] = [
  { kind: "task", label: "Task", to: "/app/tasks?new=1", hint: "T" },
  { kind: "doc", label: "Doc", to: "/app/docs?new=1", hint: "D" },
  { kind: "mail", label: "Email", to: "/app/mail?compose=1", hint: "M" },
  { kind: "event", label: "Meeting", to: "/app/meetings?new=1", hint: "E" },
  { kind: "file", label: "File", to: "/app/tools", hint: "F" },
];

/** Create items this workspace can use: a file opens Tools, else Docs (where files can be added to a doc). */
export function createItems(flags: NavFlags): CreateItem[] {
  const items = CREATE_ITEMS.map((c) => (c.kind === "file" && !flags.tools ? { ...c, to: "/app/docs" } : c));
  // R80C: a social post, for the people who can send one.
  // R87: a short link, where Tools > Links is on.
  const withLinkOnly = flags.links ? [...items, { kind: "link" as const, label: "Short link", to: "/app/tools/links?new=1", hint: "" }] : items;
  // R105: an invoice or a quote, where invoices are on.
  const withLink = flags.invoices ? [...withLinkOnly, { kind: "invoice" as const, label: "Invoice", to: "/app/contacts/invoices?new=invoice", hint: "" }, { kind: "quote" as const, label: "Quote", to: "/app/contacts/invoices?new=quote", hint: "" }] : withLinkOnly;
  // R123: a site page, where Sites is on for this person.
  const withSite = flags.sitesCreate ? [...withLink, { kind: "site" as const, label: "Site page", to: "/app/docs/sites?new=1", hint: "" }] : withLink;
  // R124: a blog post, where the blog is on and this person writes on the site.
  const withBlog = flags.blogCreate ? [...withSite, { kind: "blog" as const, label: "Blog post", to: "/app/docs/sites?tab=blog&new=1", hint: "" }] : withSite;
  // P1 layout: it opens the composer in Social (it opened Settings before).
  return flags.social ? [...withBlog, { kind: "post" as const, label: "Social post", to: SOCIAL_NEW, hint: "P" }] : withBlog;
}
