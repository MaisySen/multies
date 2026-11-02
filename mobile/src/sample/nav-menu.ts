/**
 * M2 (1.10.10): the sample workspace's answer to GET /api/nav/menu, the web's R121 menu for an admin with the
 * navigation switch on (sections in the web's order; Sites is left out because the sample workspace has no site).
 */
export const SAMPLE_NAV_MENU = {
  version: 1,
  navP2: true,
  sections: [
    { id: "home", label: "Home", icon: "home", to: "/app/my-work", pages: [
      { to: "/app/my-work", label: "My Work", icon: "today" },
      { to: "/app", label: "Overview", icon: "overview", end: true },
      { to: "/app/notifications", label: "Notifications", icon: "bell", count: "notifications.unread" },
      { to: "/app/triage", label: "Triage", icon: "triage", count: "triage" },
      { to: "/app/approvals", label: "Approvals", icon: "approvals" },
    ] },
    { id: "mail", label: "Mail", icon: "mail", to: "/app/mail", pages: [
      { to: "/app/mail", label: "Mail", icon: "mail", count: "mail.inbox" },
      { to: "/app/inbox", label: "Shared inbox", icon: "sharedInbox" },
    ] },
    { id: "chat", label: "Chat", icon: "chat", to: "/app/chat", pages: [
      { to: "/app/chat", label: "Chat", icon: "chat", count: "chat.unread" },
      { to: "/app/meetings", label: "Meetings", icon: "meetings" },
      { to: "/app/scheduling", label: "Booking page", icon: "booking" },
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
      { to: "/app/files", label: "Files", icon: "files" },
      { to: "/app/forms", label: "Forms", icon: "forms" },
      { to: "/app/docs/links", label: "Link library", icon: "library" },
      { to: "/app/docs/help-center", label: "Help center", icon: "help" },
      { to: "/app/docs/sites", label: "Sites", icon: "sites", whenUsed: "/api/sites/in-use" },
    ] },
    { id: "social", label: "Social", icon: "social", to: "/app/social", pages: [
      { to: "/app/social/inbox", label: "Inbox", icon: "socialInbox" },
      { to: "/app/social", label: "Planner", icon: "planner", end: true },
      { to: "/app/social/posts", label: "Posts", icon: "posts" },
      { to: "/app/social/library", label: "Library", icon: "library" },
      { to: "/app/social/analytics", label: "Analytics", icon: "analytics" },
      { to: "/app/social/accounts", label: "Accounts", icon: "accounts" },
    ] },
    { id: "contacts", label: "Contacts", icon: "contacts", to: "/app/contacts", pages: [
      { to: "/app/contacts", label: "People", icon: "people" },
      { to: "/app/deals", label: "Deals", icon: "deals" },
    ] },
    { id: "tools", label: "Tools", icon: "tools", to: "/app/tools", pages: [
      { to: "/app/tools", label: "Tools", icon: "tools" },
      { to: "/app/tools/convert", label: "Convert files", icon: "convert" },
    ] },
    { id: "dashboards", label: "Dashboards", icon: "dashboards", to: "/app/dashboards", pages: [
      { to: "/app/dashboards", label: "Dashboards", icon: "dashboards" },
      { to: "/app/reports", label: "Reports", icon: "reports" },
    ] },
    { id: "agents", label: "Agents", icon: "agents", to: "/app/agents", pages: [
      { to: "/app/agents", label: "Agents", icon: "agents" },
      { to: "/app/automations", label: "Automations", icon: "automations" },
      { to: "/app/automations/runs", label: "Runs", icon: "activity" },
    ] },
    { id: "workspace", label: "Settings", icon: "workspace", to: "/app/settings", pages: [
      { to: "/app/settings", label: "Settings", icon: "settings" },
      { to: "/app/settings/apps", label: "Connections", icon: "connections" },
      { to: "/app/activity", label: "Activity", icon: "activity" },
    ] },
  ],
  bottom: ["agents", "workspace"],
  mailSetup: [
    { to: "/app/settings/mailboxes", label: "Mailboxes" },
    { to: "/app/settings/domains", label: "Domains" },
    { to: "/app/settings/deliverability", label: "Deliverability" },
    { to: "/app/settings/mail", label: "Routing" },
  ],
  create: [{ label: "Social post", to: "/app/social/new" }],
  phoneTabs: { order: ["home", "mail", "chat", "fourth", "more"], fourth: [], fourthDefault: "tasks" },
  counts: { url: "/api/counts" },
};
