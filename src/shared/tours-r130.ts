/**
 * R130: guided onboarding (flag TOURS_R130). One shape for the server (validation, rules) and the web app (checklist,
 * tours, builder). Tours point at elements by their stable data-tour or data-testid id, never by CSS paths.
 * Text is plain text everywhere (rendered as text, never as HTML).
 */
import { z } from "zod";

export type Role = "owner" | "admin" | "member";
export const isManagerRole = (r: Role | string | null | undefined) => r === "owner" || r === "admin";

/* ------------------------------------------------------------------ checklist */

export type ChecklistStepId = "mail" | "invite" | "task" | "site" | "palette" | "tour" | "open_mail" | "doc";
/** How a step completes: "data" steps are checked against real rows on the server; "mark" steps are marked by the app. */
export type StepKind = "data" | "mark";
export interface ChecklistStepDef { id: ChecklistStepId; kind: StepKind; title: string; body: string; to?: string; action?: "palette" | "tour" }

const STEP: Record<ChecklistStepId, ChecklistStepDef> = {
  mail: { id: "mail", kind: "data", title: "Set up mail", body: "Add a mailbox or connect the one you already use.", to: "/app/settings/mailboxes" },
  invite: { id: "invite", kind: "data", title: "Invite a teammate", body: "Work together on mail, tasks and docs.", to: "/app/settings/team" },
  task: { id: "task", kind: "data", title: "Create a task", body: "Write down the first thing to get done.", to: "/app/tasks" },
  site: { id: "site", kind: "data", title: "Set up a site", body: "Pick a name and publish your first page.", to: "/app/docs/sites" },
  palette: { id: "palette", kind: "mark", title: "Try Ctrl K", body: "Jump anywhere and do anything from the keyboard.", action: "palette" },
  tour: { id: "tour", kind: "mark", title: "Take the quick tour", body: "A one minute look at where everything lives.", action: "tour" },
  open_mail: { id: "open_mail", kind: "mark", title: "Open your mail", body: "See the mail shared with you.", to: "/app/mail" },
  doc: { id: "doc", kind: "data", title: "Write a doc", body: "Notes, plans or a how to for the team.", to: "/app/docs" },
};

/** Admins set the workspace up; members learn their way around. Sites only when that area is on. */
export function checklistFor(role: Role | string, opts: { sites?: boolean } = {}): ChecklistStepDef[] {
  const ids: ChecklistStepId[] = isManagerRole(role)
    ? ["mail", "invite", "task", ...(opts.sites ? (["site"] as const) : []), "palette", "tour"]
    : ["open_mail", "task", "doc", "palette", "tour"];
  return ids.map((id) => STEP[id]);
}
export const MARKABLE: readonly ChecklistStepId[] = ["palette", "tour", "open_mail"];
export const isMarkable = (id: string): id is ChecklistStepId => (MARKABLE as readonly string[]).includes(id);

export interface ChecklistState { done: ChecklistStepId[]; dismissed: boolean; celebrated: boolean }
export function parseChecklist(raw: unknown): ChecklistState {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<ChecklistState>;
  const done = Array.isArray(o.done) ? o.done.filter((x): x is ChecklistStepId => typeof x === "string" && x in STEP) : [];
  return { done: [...new Set(done)], dismissed: o.dismissed === true, celebrated: o.celebrated === true };
}
export interface ChecklistView {
  steps: (ChecklistStepDef & { done: boolean })[];
  doneCount: number; total: number; complete: boolean; dismissed: boolean; celebrated: boolean;
}
export function checklistView(defs: ChecklistStepDef[], state: ChecklistState): ChecklistView {
  const steps = defs.map((d) => ({ ...d, done: state.done.includes(d.id) }));
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, total: steps.length, complete: doneCount === steps.length, dismissed: state.dismissed, celebrated: state.celebrated };
}
/** Show the panel and ring: not dismissed, and either not complete or the "all set" moment not yet seen. */
export const checklistVisible = (v: ChecklistView | null | undefined) => !!v && !v.dismissed && (!v.complete || !v.celebrated);

/* ------------------------------------------------------------------ tours */

export const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,79}$/;
export const Target = z.string().trim().regex(TARGET_RE, "Pick an element on the page.");
/** Plain text only: control characters (other than tab and new line) are dropped. */
const stripControl = (s: string) => [...s].filter((ch) => { const c = ch.charCodeAt(0); return c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127); }).join("");
const plain = (max: number) => z.string().trim().max(max).transform(stripControl);
export const TourStep = z.object({ target: Target, title: plain(80).pipe(z.string().min(1, "Give each step a title.")), body: plain(400) });
export type TourStep = z.infer<typeof TourStep>;
export const AUDIENCES = ["all", "admins", "members"] as const;
export type Audience = (typeof AUDIENCES)[number];
export const PagePath = z.string().trim().max(120).regex(/^\/app(\/[A-Za-z0-9_-]+)*$/, "Pick a page in the app.");
export const MAX_STEPS = 10;
const tourFields = {
  name: plain(80).pipe(z.string().min(1, "Give the tour a name.")),
  page: PagePath,
  audience: z.enum(AUDIENCES),
  newDays: z.number().int().min(1).max(365).nullable(),
  steps: z.array(TourStep).max(MAX_STEPS, `Up to ${MAX_STEPS} steps.`),
};
export const TourInput = z.object({ ...tourFields, audience: tourFields.audience.default("all"), newDays: tourFields.newDays.default(null), steps: tourFields.steps.default([]) });
export type TourInput = z.infer<typeof TourInput>;
/** A change: only the fields sent are touched (no defaults, so a publish never resets the audience). */
export const TourPatch = z.object({ ...tourFields, status: z.enum(["draft", "published"]) }).partial();
export type TourPatch = z.infer<typeof TourPatch>;

export interface TourDef { id: string; name: string; page: string; steps: TourStep[]; builtin?: boolean; phoneOnly?: boolean; desktopOnly?: boolean }
export interface AdminTour extends TourDef { audience: Audience; newDays: number | null; status: "draft" | "published"; updatedAt: number }

/** Does a published tour's audience include this person? newDays counts from when they joined the workspace. */
export function audienceMatches(t: { audience: Audience; newDays: number | null }, who: { role: Role | string; joinedAt: number }, now = Date.now()): boolean {
  const manager = isManagerRole(who.role);
  if (t.audience === "admins" && !manager) return false;
  if (t.audience === "members" && manager) return false;
  if (t.newDays != null && now - who.joinedAt > t.newDays * 86_400_000) return false;
  return true;
}
/** A tour runs on its page and on that page's own sub pages, never elsewhere. */
export function pageMatches(page: string, pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p === page || (page !== "/app" && p.startsWith(page + "/"));
}
/** Tours only ever run inside the signed in app (never on sites, blog, booking, forms or reports). */
export const inApp = (pathname: string) => pathname === "/app" || pathname.startsWith("/app/");

export const PROGRESS_KEY_RE = /^(checklist|builtin:[a-z_-]{1,40}|tour_[A-Za-z0-9_-]{1,60})$/;
export const ProgressInput = z.object({ key: z.string().regex(PROGRESS_KEY_RE), state: z.enum(["done", "skipped"]), step: z.number().int().min(0).max(50).default(0) });

/** Built in tours: they follow the R121 navigation (Contacts, Settings Mail setup, Docs with Files, the phone More sheet). */
export const BUILTIN_TOURS: TourDef[] = [
  { id: "builtin:getting_around", name: "Getting around", page: "/app", builtin: true, steps: [
    { target: "rail-home", title: "Your sections", body: "Each section of Multies lives in this rail. Hide the ones you never use from Customise menu." },
    { target: "tab-more", title: "Everything else", body: "Tap More for every section, Settings and Customise menu." },
    { target: "create-menu", title: "Create anything", body: "New tasks, docs, mail and posts start here." },
    { target: "topbar-search-entry", title: "Search and commands", body: "Press Ctrl K to search and jump anywhere." },
    { target: "topbar-search", title: "Search and commands", body: "Search mail, tasks, docs and people from here." },
    { target: "sidebar-account", title: "You and your workspace", body: "Settings, keyboard shortcuts, tours and this checklist live here." },
    { target: "topbar-account", title: "You and your workspace", body: "Settings, tours and this checklist live here." },
  ] },
  { id: "builtin:contacts", name: "Contacts", page: "/app/contacts", builtin: true, desktopOnly: true, steps: [
    { target: "rail-contacts", title: "Contacts", body: "People and Deals now have their own section." },
    { target: "nav-app-contacts", title: "People", body: "Everyone you work with, with their mail, tasks and notes in one place." },
    { target: "nav-app-deals", title: "Deals", body: "Track each deal from first hello to signed." },
  ] },
  { id: "builtin:mail_setup", name: "Mail setup", page: "/app/settings", builtin: true, steps: [
    { target: "pane-app-settings-mailboxes", title: "Mailboxes", body: "Add addresses for people and teams, like sales or support." },
    { target: "pane-app-settings-domains", title: "Domains", body: "Use your own domain and check its records." },
    { target: "pane-app-settings-deliverability", title: "Deliverability", body: "See if your mail lands in the inbox." },
    { target: "pane-app-settings-mail", title: "Routing", body: "Forwarding, undo send and saved replies." },
  ] },
  { id: "builtin:docs_files", name: "Docs and files", page: "/app/docs", builtin: true, desktopOnly: true, steps: [
    { target: "rail-docs", title: "Docs", body: "Docs, Files, Forms and Sites live together here." },
    { target: "nav-app-docs", title: "Docs", body: "Write together, with comments and history." },
    { target: "nav-app-files", title: "Files", body: "Every upload, with smart folders and previews." },
  ] },
  { id: "builtin:more_sheet", name: "The More sheet", page: "/app", builtin: true, phoneOnly: true, steps: [
    { target: "tab-more", title: "More", body: "Every section lives behind More on your phone." },
  ] },
];
/** MB-326: the built in tours that can show at this width (rail and section links are not on the phone layout). */
export const builtinToursFor = (phone: boolean) => BUILTIN_TOURS.filter((t) => (phone ? !t.desktopOnly : !t.phoneOnly));
export const builtinTour = (id: string) => BUILTIN_TOURS.find((t) => t.id === id) ?? null;

/** MB-329: "1 step", "2 steps". */
export const stepsLabel = (n: number) => `${n} ${n === 1 ? "step" : "steps"}`;
/** MB-327: the side rail and the sidebar (its section links and account button) are not on the phone layout. */
export const hiddenOnPhone = (target: string) => /^(rail|nav|sidebar)-/.test(target);
/** MB-327: a workspace tour with steps that all point at parts phones do not show can only run on computers and tablets. */
export const desktopOnlySteps = (steps: { target: string }[]) => steps.length > 0 && steps.every((s) => hiddenOnPhone(s.target));

/** The data-tour id for an app link (nav-app-contacts for /app/contacts). */
export const navTourId = (to: string, prefix = "nav") => `${prefix}-${to.replace(/^\//, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "")}`.slice(0, 80);

export interface ToursMe {
  enabled: boolean; canBuild: boolean;
  checklist: ChecklistView | null;
  /** Published workspace tours this person has not seen yet (each runs once on its page). */
  tours: TourDef[];
  /** Built in tours this person finished or closed. */
  seen: string[];
}
