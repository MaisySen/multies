/**
 * OPS1: the console sidebar. Five groups; each item shows only when the operator's role has its read permission, so
 * lower tiers see a shorter menu. Every section's page exists at its final path (placeholders say "Coming soon" until
 * their phase lands); add nothing here when building a section, just replace its page file.
 */
import type { IconComponent } from "@/web/components/ui/icon";
import {
  IconActivity, IconAgent, IconBuilding, IconCode, IconCreditCard, IconDashboard, IconFlag, IconMail, IconMegaphone,
  IconServer, IconShieldAlert, IconSmartphone, IconUserCog, IconUser, IconWorkflow,
} from "@/web/components/ui/icon";
import type { Permission } from "@/shared/operator-permissions";

export interface ConsoleNavItem { to: string; label: string; icon: IconComponent; permission: Permission; end?: boolean }
export interface ConsoleNavGroup { label: string; items: ConsoleNavItem[] }

export const CONSOLE_NAV: ConsoleNavGroup[] = [
  { label: "Overview", items: [
    { to: "/console", label: "Overview", icon: IconDashboard, permission: "overview.read", end: true },
  ] },
  { label: "Customers", items: [
    { to: "/console/workspaces", label: "Workspaces", icon: IconBuilding, permission: "workspaces.read" },
    { to: "/console/users", label: "Users", icon: IconUser, permission: "users.read" },
    { to: "/console/billing", label: "Billing", icon: IconCreditCard, permission: "billing.read" },
  ] },
  { label: "Product", items: [
    { to: "/console/mail", label: "Mail and deliverability", icon: IconMail, permission: "mail.read" },
    { to: "/console/agents", label: "Agents and AI", icon: IconAgent, permission: "agents.read" },
    { to: "/console/developer", label: "Developer platform", icon: IconCode, permission: "developer.read" },
    { to: "/console/mobile", label: "Mobile app", icon: IconSmartphone, permission: "mobile.read" },
    { to: "/console/announcements", label: "Announcements", icon: IconMegaphone, permission: "announcements.read" },
  ] },
  { label: "Platform", items: [
    { to: "/console/moderation", label: "Moderation", icon: IconShieldAlert, permission: "moderation.read" },
    { to: "/console/jobs", label: "Jobs", icon: IconWorkflow, permission: "jobs.read" },
    { to: "/console/flags", label: "Feature flags", icon: IconFlag, permission: "flags.read" },
    { to: "/console/system", label: "System health", icon: IconServer, permission: "system.read" },
  ] },
  { label: "Access", items: [
    { to: "/console/operators", label: "Operators", icon: IconUserCog, permission: "operators.read" },
    { to: "/console/audit", label: "Audit log", icon: IconActivity, permission: "audit.read" },
  ] },
];

/** The groups and items this set of permissions can open (empty groups dropped). */
export function navFor(permissions: readonly Permission[]): ConsoleNavGroup[] {
  const have = new Set(permissions);
  return CONSOLE_NAV.map((g) => ({ ...g, items: g.items.filter((i) => have.has(i.permission)) })).filter((g) => g.items.length > 0);
}
