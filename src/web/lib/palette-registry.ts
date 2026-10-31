/**
 * R30: what the command menu can jump to and do, in one list, plus its fuzzy matching.
 * tests/palette-r30.test.ts checks every app page in router.tsx has an entry here.
 */
import { IconPlugZap, IconMegaphone, IconWrench, IconPenLine, IconActivity, IconAgent, IconAssign, IconBell, IconBook, IconBriefcase, IconCalendarClock, IconCalendarDays, IconChart, IconChats, IconClipboardCheck, IconClipboardList, IconCompose, IconContacts, IconCreditCard, IconDashboard, IconDocs, IconFilePlus, IconGlobe, IconHandshake, IconInbox, IconKey, IconKeyboard, IconLink, IconMail, IconMention, IconMessageCircle, IconMoon, IconPlug, IconPlus, IconSettings, IconShieldCheck, IconSmartphone, IconSquarePlus, IconTarget, IconTasks, IconTeam, IconTemplate, IconTimer, IconToday, IconTodo, IconUpload, IconUserCog, IconVideo, IconZap, IconAttachment, IconWorkflow, IconTag, IconTable } from "@/web/components/ui/icon";

export type PaletteIcon = React.ComponentType<{ className?: string }>;
/**
 * R59: `flag` names a server switch from /api/config; the page is offered only while it is on.
 * Tools P2: `toolFeature` also needs one of these P2 features in /api/config toolFeatures.
 */
export interface PalettePage { id: string; label: string; to: string; icon: PaletteIcon; keywords?: string[]; flag?: "chatChannels" | "tools"; toolFeature?: string[] }
export type PaletteActionKind = "navigate" | "shortcuts" | "theme" | "external";
export interface PaletteAction { id: string; label: string; icon: PaletteIcon; kind: PaletteActionKind; to?: string; keywords?: string[]; flag?: "chatChannels" | "tools"; toolFeature?: string[] }

export const PALETTE_PAGES: PalettePage[] = [
  { id: "p-my-work", label: "My Work", to: "/app/my-work", icon: IconToday, keywords: ["today", "due", "home", "mentions"] },
  { id: "p-overview", label: "Overview", to: "/app", icon: IconDashboard, keywords: ["dashboard", "home"] },
  { id: "p-notifications", label: "Notifications", to: "/app/notifications", icon: IconBell, keywords: ["alerts", "inbox"] },
  { id: "p-chat", label: "Chat", to: "/app/chat", icon: IconMessageCircle, keywords: ["channels", "messages", "dm", "direct message"] },
  { id: "p-tasks", label: "Tasks", to: "/app/tasks", icon: IconTasks, keywords: ["board", "list", "kanban", "projects", "todo"] },
  { id: "p-triage", label: "Triage", to: "/app/triage", icon: IconTodo, keywords: ["intake", "requests"] },
  { id: "p-docs", label: "Docs", to: "/app/docs", icon: IconDocs, keywords: ["documents", "notes", "wiki", "pages"] },
  { id: "p-meetings", label: "Meetings", to: "/app/meetings", icon: IconVideo, keywords: ["calls", "video", "calendar"] },
  { id: "p-scheduling", label: "Booking page", to: "/app/scheduling", icon: IconCalendarClock, keywords: ["scheduling", "book", "calendar link"] },
  // Tools P1: shown only when the server has Tools on (flag "tools").
  { id: "p-tools", label: "Tools", to: "/app/tools", icon: IconWrench, keywords: ["pdf", "compress", "merge", "convert", "documents", "word to pdf"], flag: "tools" },
  { id: "p-tools-convert", label: "Convert files", to: "/app/tools/convert", icon: IconWrench, keywords: ["convert", "heic", "webp", "avif", "png", "jpg", "image to pdf", "csv to excel", "excel to csv", "split pdf", "rotate pdf", "page numbers"], flag: "tools" }, // R78
  { id: "p-tools-edit-pdf", label: "Edit a PDF", to: "/app/tools/edit-pdf", icon: IconWrench, keywords: ["edit pdf", "add text", "sign pdf", "black out", "redact", "watermark", "page numbers", "reorder pages", "delete pages"], flag: "tools" }, // R86
  { id: "p-tools-ai", label: "AI document helpers", to: "/app/tools/ai", icon: IconWrench, keywords: ["ask a document", "summary", "translate", "invoice", "receipt", "expense report", "contract dates"], flag: "tools", toolFeature: ["ask", "translate", "extract", "expenses", "contracts"] }, // Tools P2
  // Tools P2: share links and e-sign, each shown only while its feature is on.
  { id: "p-tools-share", label: "Share links", to: "/app/tools/share", icon: IconLink, keywords: ["send large file", "share file", "download link", "expiring link"], flag: "tools", toolFeature: ["share"] },
  { id: "p-tools-sign", label: "E-sign", to: "/app/tools/sign", icon: IconPenLine, keywords: ["sign", "signature", "esign", "sign pdf", "request signature"], flag: "tools", toolFeature: ["esign"] },
  // Tools P2 (H6): automation pages, each behind its own feature.
  { id: "p-tools-workflows", label: "Tool workflows", to: "/app/tools/workflows", icon: IconWrench, keywords: ["workflow", "chain", "scan", "ocr", "shrink", "protect"], flag: "tools", toolFeature: ["workflows"] },
  { id: "p-tools-templates", label: "Invoice and letter templates", to: "/app/tools/templates", icon: IconWrench, keywords: ["invoice", "quote", "letter", "gst", "pdf template"], flag: "tools", toolFeature: ["templates"] },
  { id: "p-tools-merge", label: "Mail merge", to: "/app/tools/merge", icon: IconWrench, keywords: ["merge", "bulk", "personal pdf", "csv", "mailing"], flag: "tools", toolFeature: ["merge_mail"] },
  // Tools P2 (16, 17): smart folders of mail attachments and search inside them.
  { id: "p-files", label: "Files", to: "/app/files", icon: IconAttachment, keywords: ["attachments", "smart folders", "invoices", "receipts", "contracts", "search inside attachments"], flag: "tools", toolFeature: ["folders", "index"] },
  { id: "p-goals", label: "Goals", to: "/app/goals", icon: IconTarget, keywords: ["okr", "objectives"] },
  { id: "p-contacts", label: "Contacts", to: "/app/contacts", icon: IconContacts, keywords: ["crm", "people", "companies", "customers"] },
  { id: "p-deals", label: "Deals", to: "/app/deals", icon: IconHandshake, keywords: ["crm", "pipeline", "sales"] },
  { id: "p-time", label: "Timesheet", to: "/app/time", icon: IconTimer, keywords: ["time tracking", "hours", "timer"] },
  { id: "p-forms", label: "Forms", to: "/app/forms", icon: IconClipboardList, keywords: ["survey", "intake"] },
  { id: "p-dashboards", label: "Dashboards", to: "/app/dashboards", icon: IconDashboard, keywords: ["charts", "widgets"] },
  { id: "p-reports", label: "Reports", to: "/app/reports", icon: IconChart, keywords: ["analytics", "charts"] },
  { id: "p-portfolio", label: "Portfolio", to: "/app/portfolio", icon: IconBriefcase, keywords: ["projects", "status"] },
  { id: "p-templates", label: "Project templates", to: "/app/templates", icon: IconTemplate, keywords: ["blueprints", "templates"] },
  { id: "p-automations", label: "Automations", to: "/app/automations", icon: IconZap, keywords: ["rules", "workflows", "recipes"] },
  { id: "p-mail", label: "Mail", to: "/app/mail", icon: IconInbox, keywords: ["inbox", "webmail", "email"] },
  { id: "p-mail-rules", label: "Mail rules", to: "/app/mail/rules", icon: IconWorkflow, keywords: ["filters", "labels", "auto reply", "forward", "sort mail", "inbox tabs"] }, // R85
  { id: "p-shared-inbox", label: "Shared inbox", to: "/app/inbox", icon: IconChats, keywords: ["team inbox", "support", "assign"] },
  { id: "p-mailboxes", label: "Mailboxes and aliases", to: "/app/mailboxes", icon: IconTeam, keywords: ["addresses", "alias"] },
  { id: "p-domains", label: "Domains", to: "/app/domains", icon: IconGlobe, keywords: ["dns"] },
  { id: "p-deliverability", label: "Deliverability", to: "/app/deliverability", icon: IconShieldCheck, keywords: ["dmarc", "bounces", "suppression", "health"] },
  { id: "p-agents", label: "Agents", to: "/app/agents", icon: IconAgent, keywords: ["assistants", "runs", "triggers"] },
  { id: "p-approvals", label: "Approvals", to: "/app/approvals", icon: IconClipboardCheck, keywords: ["review", "pending"] },
  { id: "p-integrations", label: "Webhooks", to: "/app/settings/apps/webhooks", icon: IconPlug, keywords: ["integrations", "apps", "connect", "slack", "github", "zapier"] },
  { id: "p-activity", label: "Activity", to: "/app/activity", icon: IconActivity, keywords: ["log", "audit"] },
  { id: "p-settings", label: "Settings", to: "/app/settings", icon: IconSettings, keywords: ["workspace", "preferences"] },
  { id: "p-settings-general", label: "General settings", to: "/app/settings/general", icon: IconSettings, keywords: ["workspace name", "logo", "time zone", "preferences"] },
  { id: "p-team", label: "Team", to: "/app/settings/team", icon: IconTeam, keywords: ["members", "people", "invite"] },
  { id: "p-billing", label: "Billing", to: "/app/settings/billing", icon: IconCreditCard, keywords: ["plan", "upgrade", "invoice"] },
  { id: "p-account", label: "Account and security", to: "/app/settings/account", icon: IconUserCog, keywords: ["profile", "password", "two factor", "sessions"] },
  { id: "p-notification-settings", label: "Notification settings", to: "/app/settings/notifications", icon: IconBell, keywords: ["email alerts", "push"] },
  { id: "p-calendar-settings", label: "Calendar settings", to: "/app/settings/calendar", icon: IconCalendarDays, keywords: ["caldav", "ics", "google calendar"] },
  { id: "p-mail-settings", label: "Mail settings", to: "/app/settings/mail", icon: IconMail, keywords: ["signature", "saved replies", "vacation"] },
  { id: "p-connections", label: "Mail accounts", to: "/app/settings/apps/mail", icon: IconLink, keywords: ["gmail", "outlook", "imap", "connections", "connected accounts", "mailboxes"] },
  { id: "p-mail-apps", label: "Mail apps", to: "/app/settings/mail-apps", icon: IconSmartphone, keywords: ["imap", "smtp", "app password", "outlook", "apple mail"] },
  { id: "p-chat-channels", label: "Chat channels", to: "/app/settings/channels", icon: IconChats, keywords: ["whatsapp", "messenger", "instagram", "chat", "connect"], flag: "chatChannels" },
  { id: "p-developers", label: "Developers", to: "/app/settings/developers", icon: IconKey, keywords: ["api", "webhooks", "keys", "mcp"] },
  { id: "p-sign-up-emails", label: "Sign-up emails", to: "/app/settings/sign-up-emails", icon: IconMention, keywords: ["auth emails", "verification", "hook"] },
  { id: "p-connections-hub", label: "Connections", to: "/app/settings/apps", icon: IconPlugZap, keywords: ["apps", "integrations", "social", "facebook", "instagram", "linkedin", "pinterest", "reddit", "slack", "connect"] }, // R80C
  // P1 layout: Social has its own place (it was Settings, Connections, Social posts).
  { id: "p-social", label: "Social planner", to: "/app/social", icon: IconCalendarDays, keywords: ["social", "calendar", "scheduled posts", "plan", "facebook", "instagram", "linkedin"] },
  { id: "p-social-new", label: "New social post", to: "/app/social/new", icon: IconCompose, keywords: ["write a post", "compose", "social", "publish", "schedule", "facebook", "instagram", "linkedin"] },
  { id: "p-social-posts", label: "Social posts", to: "/app/social/posts", icon: IconMegaphone, keywords: ["post", "schedule", "social media", "facebook", "instagram", "linkedin", "share", "failed", "sent"] },
  { id: "p-social-accounts", label: "Social accounts", to: "/app/social/accounts", icon: IconPlugZap, keywords: ["social", "connect", "reconnect", "tiktok", "threads", "facebook", "instagram", "linkedin", "pinterest", "reddit"] },
  { id: "p-branding", label: "Branding", to: "/app/settings/branding", icon: IconSettings, keywords: ["brand", "theme", "logo", "colours", "colors", "font", "company look"] }, // R77
  { id: "p-appearance", label: "Appearance", to: "/app/settings/appearance", icon: IconMoon, keywords: ["dark mode", "light mode", "theme", "accent", "my colour"] }, // R77
  { id: "p-import", label: "Import", to: "/app/settings/import", icon: IconUpload, keywords: ["migrate", "move", "asana", "trello", "jira"] },
];

export const PALETTE_ACTIONS: PaletteAction[] = [
  { id: "compose", label: "Write an email", icon: IconCompose, kind: "navigate", to: "/app/mail?compose=1", keywords: ["compose", "new message", "send", "email"] },
  { id: "new-task", label: "New task", icon: IconSquarePlus, kind: "navigate", to: "/app/tasks?new=1", keywords: ["create task", "add task", "todo", "issue"] },
  { id: "task-tags", label: "Manage task tags", icon: IconTag, kind: "navigate", to: "/app/tasks?view=list&manage=tags", keywords: ["tags", "labels", "colours", "colors"] }, // R84
  { id: "task-fields", label: "Workspace fields for tasks", icon: IconTable, kind: "navigate", to: "/app/tasks?view=list&manage=fields", keywords: ["custom fields", "columns", "client", "budget"] }, // R84
  { id: "new-doc", label: "New doc", icon: IconFilePlus, kind: "navigate", to: "/app/docs?new=1", keywords: ["create doc", "page", "note", "write"] },
  { id: "new-chat", label: "Send a chat message", icon: IconMessageCircle, kind: "navigate", to: "/app/chat", keywords: ["message", "dm", "channel"] },
  { id: "add-domain", label: "Add a domain", icon: IconPlus, kind: "navigate", to: "/app/domains?add=1" },
  { id: "add-mailbox", label: "Create a mailbox", icon: IconPlus, kind: "navigate", to: "/app/mailboxes?add=1" },
  { id: "invite", label: "Invite a teammate", icon: IconAssign, kind: "navigate", to: "/app/settings/team", keywords: ["member", "team"] },
  { id: "api-key", label: "Create an API key", icon: IconKey, kind: "navigate", to: "/app/settings/developers", keywords: ["developer", "token"] },
  { id: "app-password", label: "Set up Outlook or Apple Mail", icon: IconSmartphone, kind: "navigate", to: "/app/settings/mail-apps", keywords: ["imap", "smtp", "app password", "thunderbird", "phone"] },
  { id: "tools-compress", label: "Compress PDF", icon: IconWrench, kind: "navigate", to: "/app/tools?op=compress", keywords: ["smaller pdf", "reduce size", "tools"], flag: "tools" },
  { id: "tools-merge", label: "Merge PDFs", icon: IconWrench, kind: "navigate", to: "/app/tools?op=merge", keywords: ["combine pdf", "join pdf", "tools"], flag: "tools" },
  // R82F (MB-275): the PDF jobs people type by name go straight to the tool.
  { id: "tools-split", label: "Split PDF", icon: IconWrench, kind: "navigate", to: "/app/tools?op=split", keywords: ["split pdf", "extract pages", "separate pages", "page ranges", "tools"], flag: "tools" },
  { id: "tools-rotate", label: "Rotate PDF pages", icon: IconWrench, kind: "navigate", to: "/app/tools?op=rotate", keywords: ["rotate pdf", "turn pages", "tools"], flag: "tools" },
  { id: "tools-to-images", label: "PDF to images", icon: IconWrench, kind: "navigate", to: "/app/tools?op=to-jpeg", keywords: ["pdf to jpg", "pdf to png", "pages as images", "tools"], flag: "tools" },
  { id: "tools-convert", label: "Convert to PDF", icon: IconWrench, kind: "navigate", to: "/app/tools?op=convert", keywords: ["word to pdf", "docx", "excel", "powerpoint", "tools"], flag: "tools" },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: IconKeyboard, kind: "shortcuts", keywords: ["keys", "help", "hotkeys"] },
  { id: "theme", label: "Switch light or dark appearance", icon: IconMoon, kind: "theme", keywords: ["theme", "dark mode", "light mode", "appearance"] },
  { id: "api-reference", label: "API reference", icon: IconBook, kind: "external", to: "/api/v1/reference", keywords: ["docs", "openapi"] },
];

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();
// R82F (MB-275): words in any script (Nepali in Devanagari included, with its vowel signs), not only a to z.
const words = (s: string) => norm(s).split(/[^\p{L}\p{M}\p{N}#/]+/u).filter(Boolean);

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
  // R82F (MB-275): a query with no words at all (punctuation only) matched everything here before.
  if (qWords.length && qWords.every((qw) => qw.length >= 4 && all.some((w) => typo(qw, w)))) return 0.5;
  const spread = isSubsequence(compact, label.replace(/\s+/g, ""));
  if (compact.length >= 2 && spread >= 0 && spread <= 4) return 0.3 - spread * 0.05;
  return 0;
}
