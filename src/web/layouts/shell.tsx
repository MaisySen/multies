/**
 * R79: the calm shell. An icon rail of sections (monochrome; colour only for the active item and for counts that
 * need attention), a sidebar for the open section with Favourites and the projects tree, and a top bar with
 * breadcrumbs, search, one Create menu and a View menu for the person's own layout.
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { IconBookmark, IconArrowRightLeft, IconLink, IconMegaphone, IconPlugZap, IconCalendarDays, IconSend, IconUserRoundCheck,
  IconActivity, IconAgent, IconApprovals, IconAttachment, IconBell, IconBriefcase, IconCalendarClock, IconCalendarPlus, IconChart, IconChats,
  IconChevronDown, IconChevronRight, IconClipboardList, IconCompose, IconContacts, IconDashboard, IconDocs, IconFilePlus, IconGlobe, IconHome,
  IconHelp, IconInbox, IconMessageCircle, IconPlug, IconPlus, IconSearch, IconSettings, IconShield, IconShieldCheck, IconSidebar, IconSliders,
  IconSquarePlus, IconStar, IconTarget, IconTasks, IconTeam, IconTemplate, IconTimer, IconToday, IconTodo, IconUpload, IconVideo, IconWrench, IconZap,
  type IconComponent,
} from "@/web/components/ui/icon";
import { buttonClass } from "@/web/components/ui/button";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { Kbd } from "@/web/components/ui/misc";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { openPalette } from "@/web/lib/shortcuts";
import { isFavourite, ownsSidebar, resetLayout, setLayout, sidebarHiddenOn, toggleFavourite, toggleSidebar, useLayout, type Favourite } from "@/web/lib/layout-prefs";
import { breadcrumbs, createItems, pageFor, SOCIAL_NEW, type IconKey, type NavFlags, type Section, type SectionId } from "./shell-nav";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";

export const NAV_ICONS: Record<IconKey, IconComponent> = {
  home: IconHome, mail: IconInbox, tasks: IconTasks, docs: IconDocs, tools: IconWrench, chat: IconMessageCircle, dashboards: IconDashboard, workspace: IconSettings,
  today: IconToday, overview: IconDashboard, bell: IconBell, triage: IconTodo, approvals: IconApprovals, activity: IconActivity, sharedInbox: IconChats,
  mailboxes: IconTeam, domains: IconGlobe, deliverability: IconShieldCheck, goals: IconTarget, portfolio: IconBriefcase, timesheet: IconTimer,
  templates: IconTemplate, automations: IconZap, files: IconAttachment, forms: IconClipboardList, meetings: IconVideo, booking: IconCalendarClock,
  contacts: IconContacts, reports: IconChart, agents: IconAgent, integrations: IconPlug, connections: IconPlugZap, settings: IconSettings, operator: IconShield, convert: IconArrowRightLeft,
  social: IconMegaphone, planner: IconCalendarDays, posts: IconSend, accounts: IconUserRoundCheck, library: IconBookmark, socialInbox: IconInbox, analytics: IconChart, // P1 layout, R118
  help: IconHelp, // R122
};

/** Counts the shell shows, keyed by page path. "alert" counts use the brand colour; the rest stay neutral. */
export type NavCounts = Record<string, { n: number; label: string; alert?: boolean }>;

const fmt = (n: number) => (n > 999 ? "999+" : String(n));

function CountPill({ c, className }: { c?: NavCounts[string]; className?: string }) {
  if (!c || c.n <= 0) return null;
  return (
    <span data-badge aria-label={c.label} className={cn("ml-auto min-w-[20px] rounded-full px-1.5 text-center text-[11px] font-semibold tabular-nums leading-[18px]",
      c.alert ? "bg-brand text-brand-fg" : "bg-fill text-muted", className)}>{fmt(c.n)}</span>
  );
}

/** The rail: one icon per section, the open section marked. */
export function IconRail({ sections, active, counts, footer }: { sections: Section[]; active: SectionId; counts: NavCounts; footer: ReactNode }) {
  const layout = useLayout();
  const loc = useLocation();
  const hidden = sidebarHiddenOn(layout, loc.pathname);
  // P1 layout: Agents and Settings sit together at the bottom, under a hairline.
  const main = sections.filter((s) => s.id !== "workspace" && s.id !== "agents");
  const ag = sections.find((s) => s.id === "agents");
  const ws = sections.find((s) => s.id === "workspace");
  const sectionCount = (s: Section) => {
    const alert = s.pages.reduce((a, p) => a + (counts[p.to]?.alert ? counts[p.to].n : 0), 0);
    return alert;
  };
  const item = (s: Section) => {
    const Icon = NAV_ICONS[s.icon];
    const on = s.id === active;
    const n = sectionCount(s);
    return (
      <Link key={s.id} to={s.to} aria-current={on ? "page" : undefined} data-testid={`rail-${s.id}`}
        className={cn("group relative flex w-16 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] font-medium tracking-[-0.01em] transition-colors duration-150 motion-reduce:transition-none",
          on ? "text-fg" : "text-muted hover:text-fg")}>
        <span className={cn("grid h-8 w-8 place-items-center rounded-lg transition-colors duration-150 motion-reduce:transition-none",
          on ? "bg-brand-soft text-fg" : "group-hover:bg-hover")}>
          <Icon filled={on} className="h-[19px] w-[19px]" aria-hidden />
        </span>
        <span className="max-w-full truncate px-0.5">{s.label}</span>
        {n > 0 && <span className="absolute right-1.5 top-0.5 min-w-[16px] rounded-full bg-brand px-1 text-center text-[10px] font-semibold leading-4 text-brand-fg" aria-label={`${n} need you`}>{n > 99 ? "99+" : n}</span>}
      </Link>
    );
  };
  return (
    <nav aria-label="Sections" className="glass-sidebar hairline-r flex h-full w-[72px] shrink-0 flex-col items-center gap-1 py-2" data-testid="icon-rail">
      <button type="button" onClick={() => toggleSidebar(loc.pathname)} aria-pressed={!hidden} data-testid="sidebar-toggle"
        title={`${hidden ? "Show" : "Hide"} sidebar (${MOD} \\)`} aria-label={hidden ? "Show sidebar" : "Hide sidebar"} hidden={ownsSidebar(loc.pathname)}
        className="mb-1 grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg">
        <IconSidebar className="h-[18px] w-[18px]" aria-hidden />
      </button>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto [scrollbar-width:none]">{main.map(item)}</div>
      <div className="hairline-t mt-1 flex w-14 flex-col items-center gap-0.5 pt-1.5" data-testid="rail-bottom">{ag && item(ag)}{ws && item(ws)}</div>
      <div className="mt-1">{footer}</div>
    </nav>
  );
}

interface ShellProject { id: string; name: string; color: string; archived: boolean; counts: Record<string, number> }

/** The open section's sidebar: favourites, then (for Tasks) the projects tree, then the section's pages. */
export function ContextSidebar({ section, counts, logo, header, footer }: { section: Section; counts: NavCounts; logo?: ReactNode; header: ReactNode; footer: ReactNode }) {
  const layout = useLayout();
  const loc = useLocation();
  const navigate = useNavigate();
  const projects = useQuery({
    queryKey: ["projects"], enabled: section.id === "tasks" || layout.favourites.some((f) => f.kind === "project"), staleTime: 30_000,
    queryFn: async () => (await api.get<{ projects: ShellProject[] }>("/projects")).projects,
  });
  const openProject = new URLSearchParams(loc.search).get("project");
  const live = (projects.data ?? []).filter((p) => !p.archived);
  const folded = (id: string) => layout.folded.includes(id);
  const fold = (id: string) => setLayout({ folded: folded(id) ? layout.folded.filter((x) => x !== id) : [...layout.folded, id] });
  const open = (p: ShellProject) => (p.counts.todo ?? 0) + (p.counts.doing ?? 0);
  const here = pageFor(loc.pathname);

  const heading = (id: string, label: string, action?: ReactNode) => (
    <div className="group flex items-center gap-1 px-2 pb-1 pt-3">
      <button type="button" onClick={() => fold(id)} aria-expanded={!folded(id)} className="flex min-w-0 flex-1 items-center gap-1 rounded text-[11.5px] font-semibold text-subtle hover:text-fg">
        {folded(id) ? <IconChevronRight className="h-3 w-3" aria-hidden /> : <IconChevronDown className="h-3 w-3" aria-hidden />}{label}
      </button>
      {action}
    </div>
  );
  const row = "flex items-center gap-2.5 rounded-md px-2 py-[6px] text-[13.5px] transition-colors duration-100 motion-reduce:transition-none";

  return (
    <div className="flex h-full min-w-0 flex-col" data-testid="context-sidebar">
      {/* R77B kept: the workspace logo (wide, or the square mark with the name) sits at the top of the sidebar. */}
      {logo && <div className="flex h-12 shrink-0 items-center px-4" data-testid="sidebar-logo">{logo}</div>}
      <div className="shrink-0 px-2.5 pt-1">{header}</div>
      <div className="px-4 pb-1 pt-3 text-[15px] font-semibold tracking-[-0.01em]">{section.label}</div>
      {/* P1 layout: one tap to write a post from anywhere in Social. */}
      {section.id === "social" && (
        <div className="px-2.5 pb-1.5 pt-1">
          <Link to={SOCIAL_NEW} data-testid="sidebar-new-post" aria-current={loc.pathname === SOCIAL_NEW ? "page" : undefined}
            className={buttonClass("primary", "sm", "w-full justify-start")}><IconCompose className="h-4 w-4" aria-hidden />New post</Link>
        </div>
      )}
      <nav aria-label={section.label} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        <div className="space-y-px">
          {section.pages.map((p) => {
            const Icon = NAV_ICONS[p.icon];
            const on = here?.page.to === p.to && !(p.to === "/app/tasks" && openProject);
            return (
              <NavLink key={p.to} to={p.to} end={p.end} aria-current={on ? "page" : undefined}
                className={cn(row, on ? "bg-brand-soft font-medium text-fg" : "text-fg/85 hover:bg-hover hover:text-fg")}>
                <Icon filled={on} className="h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{p.label}</span>
                <CountPill c={counts[p.to]} />
              </NavLink>
            );
          })}
        </div>

        {layout.favourites.length > 0 && <>
          {heading("favourites", "Favourites")}
          {!folded("favourites") && <div className="space-y-px" data-testid="sidebar-favourites">
            {layout.favourites.map((f) => {
              const p = f.kind === "project" ? live.find((x) => x.id === f.id) : undefined;
              const on = f.kind === "project" ? openProject === f.id : loc.pathname === f.to;
              return (
                <Link key={`${f.kind}:${f.id}`} to={f.to} aria-current={on ? "page" : undefined}
                  className={cn(row, on ? "bg-brand-soft font-medium text-fg" : "text-fg/85 hover:bg-hover hover:text-fg")}>
                  {p ? <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} aria-hidden /> : <IconStar className="h-4 w-4 shrink-0 text-subtle" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{p?.name ?? f.label}</span>
                  {p && open(p) > 0 && <span className="text-[11.5px] tabular-nums text-subtle" aria-label={`${open(p)} open`}>{open(p)}</span>}
                </Link>
              );
            })}
          </div>}
        </>}

        {section.id === "tasks" && <>
          {heading("projects", "Projects", (
            <button type="button" onClick={() => navigate("/app/tasks?newProject=1")} aria-label="New project" title="New project"
              className="grid h-6 w-6 place-items-center rounded text-subtle opacity-70 hover:bg-hover hover:text-fg group-hover:opacity-100"><IconPlus className="h-3.5 w-3.5" /></button>
          ))}
          {!folded("projects") && <div className="space-y-px" data-testid="sidebar-projects" role="list">
            {projects.isPending && <div className="space-y-1.5 px-2 py-1">{[0, 1, 2].map((i) => <div key={i} className="h-5 animate-pulse rounded bg-fill motion-reduce:animate-none" />)}</div>}
            {live.map((p) => {
              const on = openProject === p.id;
              const fav = isFavourite(layout, "project", p.id);
              const to = `/app/tasks?project=${encodeURIComponent(p.id)}`;
              return (
                <div key={p.id} role="listitem" className={cn("group/row", row, "p-0 pr-1", on ? "bg-brand-soft" : "hover:bg-hover")}>
                  <Link to={to} aria-current={on ? "page" : undefined} className={cn("flex min-w-0 flex-1 items-center gap-2.5 px-2 py-[6px]", on ? "font-medium text-fg" : "text-fg/85 hover:text-fg")}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {open(p) > 0 && <span className="text-[11.5px] tabular-nums text-subtle group-hover/row:hidden group-focus-within/row:hidden" aria-label={`${open(p)} open`}>{open(p)}</span>}
                  </Link>
                  <button type="button" onClick={() => toggleFavourite({ kind: "project", id: p.id, label: p.name, to })} aria-pressed={fav}
                    aria-label={fav ? `Remove ${p.name} from favourites` : `Add ${p.name} to favourites`}
                    className={cn("grid h-6 w-6 shrink-0 place-items-center rounded text-subtle hover:text-fg", fav ? "text-warn" : "hidden group-hover/row:grid group-focus-within/row:grid")}>
                    <IconStar filled={fav} className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              );
            })}
            {projects.isError && <div className="px-2 py-1 text-[12.5px] text-muted" role="alert">Projects did not load. <button type="button" onClick={() => void projects.refetch()} className="font-medium text-fg underline-offset-2 hover:underline">Try again</button></div>}
            {projects.isSuccess && !live.length && <div className="px-2 py-1 text-[12.5px] text-subtle">No projects yet. <button type="button" onClick={() => navigate("/app/tasks?newProject=1")} className="font-medium text-fg underline-offset-2 hover:underline">Start one</button></div>}
          </div>}
        </>}
      </nav>
      {footer}
    </div>
  );
}

/** Breadcrumbs, with a star to keep the page in Favourites. */
export function Breadcrumbs({ projectName }: { projectName?: string | null }) {
  const loc = useLocation();
  const layout = useLayout();
  const crumbs = breadcrumbs(loc.pathname, loc.search, { projectName });
  const project = new URLSearchParams(loc.search).get("project");
  const fav: Favourite | null = loc.pathname === "/app/tasks" && project && projectName
    ? { kind: "project", id: project, label: projectName, to: `/app/tasks?project=${encodeURIComponent(project)}` }
    : crumbs.length ? { kind: "page", id: loc.pathname, label: crumbs[crumbs.length - 1].label, to: loc.pathname } : null;
  const starred = fav ? isFavourite(layout, fav.kind, fav.id) : false;
  if (!crumbs.length) return <div className="min-w-0 flex-1" />;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-[13px]" data-testid="breadcrumbs">
      <ol className="flex min-w-0 items-center gap-1">
        {crumbs.map((c, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && <IconChevronRight className="h-3 w-3 shrink-0 text-subtle" aria-hidden />}
            {c.to ? <Link to={c.to} className="truncate rounded px-1 text-muted hover:bg-hover hover:text-fg">{c.label}</Link>
              : <span aria-current="page" className="truncate px-1 font-medium text-fg">{c.label}</span>}
          </li>
        ))}
      </ol>
      {fav && (
        <button type="button" onClick={() => toggleFavourite(fav)} aria-pressed={starred} data-testid="favourite-star"
          aria-label={starred ? "Remove from favourites" : "Add to favourites"} title={starred ? "Remove from favourites" : "Add to favourites"}
          className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-hover", starred ? "text-warn" : "text-subtle hover:text-fg")}>
          <IconStar filled={starred} className="h-4 w-4" aria-hidden />
        </button>
      )}
    </nav>
  );
}

const CREATE_ICON: Record<string, IconComponent> = { task: IconSquarePlus, doc: IconFilePlus, mail: IconCompose, event: IconCalendarPlus, file: IconUpload, post: IconMegaphone, link: IconLink };

/** One Create menu for everything new. */
export function CreateMenu({ flags }: { flags: NavFlags }) {
  const navigate = useNavigate();
  const items = useMemo(() => createItems(flags), [flags]);
  return (
    <Menu label="Create" align="end" trigger={
      <button type="button" id="create" data-testid="create-menu" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-[13px] font-medium text-brand-fg shadow-[var(--shadow-e1)] transition-colors hover:bg-brand/90">
        <IconPlus className="h-4 w-4" aria-hidden />Create<IconChevronDown className="h-3.5 w-3.5 opacity-80" aria-hidden />
      </button>}>
      <MenuLabel>Create</MenuLabel>
      {items.map((c) => { const Icon = CREATE_ICON[c.kind]; return <MenuItem key={c.kind} icon={<Icon />} onSelect={() => navigate(c.to)}>{c.label}</MenuItem>; })}
    </Menu>
  );
}

/** The person's own layout: sidebar, reading pane, task details, density, reset. */
export function ViewMenu() {
  const layout = useLayout();
  const loc = useLocation();
  const onTasks = loc.pathname.startsWith("/app/tasks");
  // R82F (MB-285): density lives only here now; with no choice of your own it shows what the workspace look uses.
  const density = layout.density ?? workspaceDensity();
  return (
    <Menu label="View" align="end" trigger={
      <button type="button" data-testid="view-menu" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg">
        <IconSliders className="h-4 w-4" aria-hidden /><span className="@max-[40rem]:sr-only">View</span>
      </button>}>
      <MenuItem checked={!sidebarHiddenOn(layout, loc.pathname)} hint={`${MOD} \\`} onSelect={() => toggleSidebar(loc.pathname)}>Sidebar</MenuItem>
      <div className="my-1 border-t border-line" />
      <MenuLabel>Reading pane in Mail</MenuLabel>
      <MenuItem checked={layout.mailPane === "right"} onSelect={() => setLayout({ mailPane: "right" })}>Right</MenuItem>
      <MenuItem checked={layout.mailPane === "bottom"} onSelect={() => setLayout({ mailPane: "bottom" })}>Bottom</MenuItem>
      <MenuItem checked={layout.mailPane === "off"} onSelect={() => setLayout({ mailPane: "off" })}>Off</MenuItem>
      <div className="my-1 border-t border-line" />
      <MenuLabel>Task details</MenuLabel>
      <MenuItem checked={layout.taskDetails === "side"} onSelect={() => setLayout({ taskDetails: "side" })}>Side panel</MenuItem>
      <MenuItem checked={layout.taskDetails === "overlay"} onSelect={() => setLayout({ taskDetails: "overlay" })}>Over the page</MenuItem>
      {onTasks && <MenuItem checked={layout.timelinePeople} onSelect={() => setLayout({ timelinePeople: !layout.timelinePeople })}>Assignee column on Timeline</MenuItem>}
      <div className="my-1 border-t border-line" />
      <MenuLabel>Density</MenuLabel>
      <MenuItem checked={density !== "compact"} onSelect={() => setLayout({ density: "comfortable" })}>Comfortable</MenuItem>
      <MenuItem checked={density === "compact"} onSelect={() => setLayout({ density: "compact" })}>Compact</MenuItem>
      <div className="my-1 border-t border-line" />
      <MenuItem onSelect={resetLayout}>Reset layout</MenuItem>
    </Menu>
  );
}

/** The workspace's density (an older branding choice may have made it compact): read from the painted spacing. */
function workspaceDensity(): "compact" | "comfortable" {
  if (typeof document === "undefined") return "comfortable";
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--spacing"));
  return v > 0 && v < 0.24 ? "compact" : "comfortable";
}

/** The search entry: opens the command menu (search everything, jump anywhere). */
export function SearchEntry() {
  return (
    <button type="button" onClick={() => openPalette()} data-testid="topbar-search-entry"
      // R82F (MB-281): the name comes from the visible words ("Search Ctrl K"); title names it when they fold away.
      title={`Search (${MOD} K)`} aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      className="flex h-8 items-center gap-2 rounded-lg bg-fill px-2.5 text-[13px] text-subtle transition-colors hover:bg-hover hover:text-muted @[52rem]:w-[22rem]">
      <IconSearch className="h-4 w-4" aria-hidden /><span className="hidden flex-1 text-left @[52rem]:inline">Search</span><span className="hidden @[52rem]:inline-flex"><Kbd>{MOD} K</Kbd></span>
    </button>
  );
}

/** Cmd or Ctrl + backslash folds the sidebar away and back, anywhere in the app (not while typing in a field). */
export function useSidebarShortcut() {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "\\" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      toggleSidebar(location.pathname);
    };
    // Capture phase: a page widget that stops key events (an editor, a grid) does not swallow the shortcut.
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);
}
