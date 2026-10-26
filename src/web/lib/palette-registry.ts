/**
 * R30: what the command menu can jump to and do, in one list, plus its fuzzy matching.
 * tests/palette-r30.test.ts checks every app page in router.tsx has an entry here.
 */
import {
  Activity, BarChart3, Bell, BookOpen, Bot, Briefcase, CalendarClock, CheckSquare, ClipboardCheck, ClipboardList, Contact, CreditCard, FilePlus2,
  FileText, Globe, Inbox, Keyboard, KeyRound, LayoutDashboard, LayoutTemplate, ListTodo, Mail, MessageCircle, MessagesSquare, Moon, PenSquare, Plug,
  Plus, Settings, ShieldCheck, Smartphone, SquarePlus, Sun, Target, Timer, Upload, UserCog, UserPlus, Users, Video, Zap, Handshake, CalendarDays, Link2, AtSign,
} from "lucide-react";

export type PaletteIcon = React.ComponentType<{ className?: string }>;
export interface PalettePage { id: string; label: string; to: string; icon: PaletteIcon; keywords?: string[] }
export type PaletteActionKind = "navigate" | "shortcuts" | "theme" | "external";
export interface PaletteAction { id: string; label: string; icon: PaletteIcon; kind: PaletteActionKind; to?: string; keywords?: string[] }

export const PALETTE_PAGES: PalettePage[] = [
  { id: "p-my-work", label: "My Work", to: "/app/my-work", icon: Sun, keywords: ["today", "due", "home", "mentions"] },
  { id: "p-overview", label: "Overview", to: "/app", icon: LayoutDashboard, keywords: ["dashboard", "home"] },
  { id: "p-notifications", label: "Notifications", to: "/app/notifications", icon: Bell, keywords: ["alerts", "inbox"] },
  { id: "p-chat", label: "Chat", to: "/app/chat", icon: MessageCircle, keywords: ["channels", "messages", "dm", "direct message"] },
  { id: "p-tasks", label: "Tasks", to: "/app/tasks", icon: CheckSquare, keywords: ["board", "list", "kanban", "projects", "todo"] },
  { id: "p-triage", label: "Triage", to: "/app/triage", icon: ListTodo, keywords: ["intake", "requests"] },
  { id: "p-docs", label: "Docs", to: "/app/docs", icon: FileText, keywords: ["documents", "notes", "wiki", "pages"] },
  { id: "p-meetings", label: "Meetings", to: "/app/meetings", icon: Video, keywords: ["calls", "video", "calendar"] },
  { id: "p-scheduling", label: "Booking page", to: "/app/scheduling", icon: CalendarClock, keywords: ["scheduling", "book", "calendar link"] },
  { id: "p-goals", label: "Goals", to: "/app/goals", icon: Target, keywords: ["okr", "objectives"] },
  { id: "p-contacts", label: "Contacts", to: "/app/contacts", icon: Contact, keywords: ["crm", "people", "companies", "customers"] },
  { id: "p-deals", label: "Deals", to: "/app/deals", icon: Handshake, keywords: ["crm", "pipeline", "sales"] },
  { id: "p-time", label: "Timesheet", to: "/app/time", icon: Timer, keywords: ["time tracking", "hours", "timer"] },
  { id: "p-forms", label: "Forms", to: "/app/forms", icon: ClipboardList, keywords: ["survey", "intake"] },
  { id: "p-dashboards", label: "Dashboards", to: "/app/dashboards", icon: LayoutDashboard, keywords: ["charts", "widgets"] },
  { id: "p-reports", label: "Reports", to: "/app/reports", icon: BarChart3, keywords: ["analytics", "charts"] },
  { id: "p-portfolio", label: "Portfolio", to: "/app/portfolio", icon: Briefcase, keywords: ["projects", "status"] },
  { id: "p-templates", label: "Templates", to: "/app/templates", icon: LayoutTemplate, keywords: ["blueprints"] },
  { id: "p-automations", label: "Automations", to: "/app/automations", icon: Zap, keywords: ["rules", "workflows", "recipes"] },
  { id: "p-mail", label: "Mail", to: "/app/mail", icon: Inbox, keywords: ["inbox", "webmail", "email"] },
  { id: "p-shared-inbox", label: "Shared inbox", to: "/app/inbox", icon: MessagesSquare, keywords: ["team inbox", "support", "assign"] },
  { id: "p-mailboxes", label: "Mailboxes and aliases", to: "/app/mailboxes", icon: Users, keywords: ["addresses", "alias"] },
  { id: "p-domains", label: "Domains", to: "/app/domains", icon: Globe, keywords: ["dns"] },
  { id: "p-deliverability", label: "Deliverability", to: "/app/deliverability", icon: ShieldCheck, keywords: ["dmarc", "bounces", "suppression", "health"] },
  { id: "p-agents", label: "Agents", to: "/app/agents", icon: Bot, keywords: ["assistants", "runs", "triggers"] },
  { id: "p-approvals", label: "Approvals", to: "/app/approvals", icon: ClipboardCheck, keywords: ["review", "pending"] },
  { id: "p-integrations", label: "Integrations", to: "/app/integrations", icon: Plug, keywords: ["apps", "connect", "slack", "github"] },
  { id: "p-activity", label: "Activity", to: "/app/activity", icon: Activity, keywords: ["log", "audit"] },
  { id: "p-settings", label: "Settings", to: "/app/settings", icon: Settings, keywords: ["workspace", "preferences"] },
  { id: "p-team", label: "Team", to: "/app/settings/team", icon: Users, keywords: ["members", "people", "invite"] },
  { id: "p-billing", label: "Billing", to: "/app/settings/billing", icon: CreditCard, keywords: ["plan", "upgrade", "invoice"] },
  { id: "p-account", label: "Account and security", to: "/app/settings/account", icon: UserCog, keywords: ["profile", "password", "two factor", "sessions"] },
  { id: "p-notification-settings", label: "Notification settings", to: "/app/settings/notifications", icon: Bell, keywords: ["email alerts", "push"] },
  { id: "p-calendar-settings", label: "Calendar settings", to: "/app/settings/calendar", icon: CalendarDays, keywords: ["caldav", "ics", "google calendar"] },
  { id: "p-mail-settings", label: "Mail settings", to: "/app/settings/mail", icon: Mail, keywords: ["signature", "saved replies", "vacation"] },
  { id: "p-connections", label: "Connected mailboxes", to: "/app/settings/connections", icon: Link2, keywords: ["gmail", "outlook", "imap", "connections"] },
  { id: "p-mail-apps", label: "Mail apps", to: "/app/settings/mail-apps", icon: Smartphone, keywords: ["imap", "smtp", "app password", "outlook", "apple mail"] },
  { id: "p-developers", label: "Developers", to: "/app/settings/developers", icon: KeyRound, keywords: ["api", "webhooks", "keys", "mcp"] },
  { id: "p-sign-up-emails", label: "Sign-up emails", to: "/app/settings/sign-up-emails", icon: AtSign, keywords: ["auth emails", "verification", "hook"] },
  { id: "p-import", label: "Import", to: "/app/settings/import", icon: Upload, keywords: ["migrate", "move", "asana", "trello", "jira"] },
];

export const PALETTE_ACTIONS: PaletteAction[] = [
  { id: "compose", label: "Write an email", icon: PenSquare, kind: "navigate", to: "/app/mail?compose=1", keywords: ["compose", "new message", "send", "email"] },
  { id: "new-task", label: "New task", icon: SquarePlus, kind: "navigate", to: "/app/tasks?new=1", keywords: ["create task", "add task", "todo", "issue"] },
  { id: "new-doc", label: "New doc", icon: FilePlus2, kind: "navigate", to: "/app/docs?new=1", keywords: ["create doc", "page", "note", "write"] },
  { id: "new-chat", label: "Send a chat message", icon: MessageCircle, kind: "navigate", to: "/app/chat", keywords: ["message", "dm", "channel"] },
  { id: "add-domain", label: "Add a domain", icon: Plus, kind: "navigate", to: "/app/domains?add=1" },
  { id: "add-mailbox", label: "Create a mailbox", icon: Plus, kind: "navigate", to: "/app/mailboxes?add=1" },
  { id: "invite", label: "Invite a teammate", icon: UserPlus, kind: "navigate", to: "/app/settings/team", keywords: ["member", "team"] },
  { id: "api-key", label: "Create an API key", icon: KeyRound, kind: "navigate", to: "/app/settings/developers", keywords: ["developer", "token"] },
  { id: "app-password", label: "Set up Outlook or Apple Mail", icon: Smartphone, kind: "navigate", to: "/app/settings/mail-apps", keywords: ["imap", "smtp", "app password", "thunderbird", "phone"] },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard, kind: "shortcuts", keywords: ["keys", "help", "hotkeys"] },
  { id: "theme", label: "Switch light or dark appearance", icon: Moon, kind: "theme", keywords: ["theme", "dark mode", "light mode", "appearance"] },
  { id: "api-reference", label: "API reference", icon: BookOpen, kind: "external", to: "/api/v1/reference", keywords: ["docs", "openapi"] },
];

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();
const words = (s: string) => norm(s).split(/[^a-z0-9#/]+/).filter(Boolean);

/** At most one edit apart (insert, delete, replace or swap two letters). */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

function isSubsequence(q: string, text: string): number {
  // Returns how spread out the match is (lower is tighter), or -1.
  let from = 0, first = -1, last = -1;
  for (const ch of q) {
    const at = text.indexOf(ch, from);
    if (at < 0) return -1;
    if (first < 0) first = at;
    last = at; from = at + 1;
  }
  return last - first + 1 - q.length;
}

/**
 * Fuzzy score for cmdk's filter (0 hides the item, higher ranks first). Matches, best first:
 * a prefix of the label, a word start, anywhere in the label or keywords, the initials ("nt" for New task),
 * every typed word as a word prefix in any order, a one letter typo in a word, then letters in order.
 */
export function paletteScore(value: string, search: string, keywords: string[] = []): number {
  const q = norm(search);
  if (!q) return 1;
  // Values are "<label>|<id>" (unique for cmdk); only the label is matched.
  const label = norm(value.split("|")[0]);
  const kw = keywords.map(norm).join(" ");
  if (label.startsWith(q)) return 1;
  const labelWords = words(label);
  if (labelWords.some((w) => w.startsWith(q))) return 0.95;
  if (label.includes(q)) return 0.9;
  if (kw && words(kw).some((w) => w.startsWith(q))) return 0.85;
  if (kw.includes(q)) return 0.8;
  const compact = q.replace(/\s+/g, "");
  if (compact.length >= 2 && labelWords.map((w) => w[0]).join("").startsWith(compact)) return 0.75;
  const qWords = words(q);
  const all = [...labelWords, ...words(kw)];
  if (qWords.length > 1 && qWords.every((qw) => all.some((w) => w.startsWith(qw)))) return 0.7;
  const typo = (qw: string, w: string) => [w, w.slice(0, qw.length), w.slice(0, qw.length + 1), w.slice(0, qw.length - 1)].some((p) => withinOneEdit(qw, p));
  if (qWords.every((qw) => qw.length >= 4 && all.some((w) => typo(qw, w)))) return 0.5;
  const spread = isSubsequence(compact, label.replace(/\s+/g, ""));
  if (compact.length >= 2 && spread >= 0 && spread <= 4) return 0.3 - spread * 0.05;
  return 0;
}
