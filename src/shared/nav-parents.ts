/**
 * MPT-10 (NAV1 slice 1): where app pages without a menu entry, Settings pane or Tools tile live.
 * tests/nav-homes-nav1.test.ts reads this file. Add a new /app page to the menu, or declare its parent here.
 * The data changes no product behaviour. Nothing in the app reads it.
 */
export interface NavParent { parent: string; file: string; reason: string }
export interface NavNoHome { reason: string; slice: string }

/** Pages opened from a parent page. file is the source file that links to the page. */
export const NAV_PARENTS: Record<string, NavParent> = {
  "/app/mail/rules": { parent: "/app/mail", file: "src/web/pages/app/webmail.tsx", reason: "Mail rules opens from a mailbox's menu in Mail." },
  "/app/inbox/helpdesk": { parent: "/app/inbox", file: "src/web/pages/app/inbox.tsx", reason: "Help desk settings opens from the Shared inbox header." },
  "/app/social/new": { parent: "/app/social", file: "src/web/layouts/shell-nav.ts", reason: "New post is the Social section's create action (SOCIAL_NEW)." },
  "/app/docs/learning": { parent: "/app/docs", file: "src/web/pages/app/work/docs.tsx", reason: "My learning opens from the Docs page header." },
  "/app/contacts/assets/labels": { parent: "/app/contacts/staff", file: "src/web/pages/app/people-r126/staff.tsx", reason: "Asset labels opens from the Staff page." },
  "/app/contacts/invoices": { parent: "/app/deals", file: "src/web/pages/app/work/deals.tsx", reason: "Invoices opens from the Deals page header (and from Create, Invoice or Quote)." },
  "/app/admin/reports": { parent: "/app/admin", file: "src/web/pages/app/admin-moderation-r35.tsx", reason: "The Operator page shows ModerationLink, which opens the moderation queue." },
  "/app/contacts/staff": { parent: "/app/contacts", file: "src/web/pages/app/work/contacts.tsx", reason: "Staff is a tab of the Contacts page when PEOPLE_R126 is on." },
  "/app/settings/general": { parent: "/app/settings", file: "src/web/pages/app/settings.tsx", reason: "The phone Settings hub opens General at this address." },
  "/app/settings/team/onboarding": { parent: "/app/settings/team", file: "src/web/pages/app/team.tsx", reason: "Onboarding opens from the Team pane." },
  "/app/settings/apps/mail": { parent: "/app/settings/apps", file: "src/web/pages/app/apps-settings.tsx", reason: "Mail accounts is a tab of Connections." },
  "/app/settings/apps/webhooks": { parent: "/app/settings/apps", file: "src/web/pages/app/apps-settings.tsx", reason: "Webhooks is a tab of Connections." },
};

/** Pages with no home yet. Each names the NAV1 slice that gives it one. The list is empty when NAV1 is done. */
export const NAV_NO_HOME_YET: Record<string, NavNoHome> = {
  "/app/analyses": { reason: "Analyses (CRM_TD10) opens only from the command palette.", slice: "NAV1 D1 to D5 (regroup sections, Contacts)" },
  "/app/automations/rules": { reason: "Automation rules opens only from the command palette.", slice: "NAV1 C1 (the AI and automation section, MPLAT-32)" },
};
