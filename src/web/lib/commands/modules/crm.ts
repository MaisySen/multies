import type { Command } from "../types";

/**
 * TD10 (CRM_TD10): keys on Contacts, Deals and Analyses, bound by those pages (useCommandHandlers). Listed in the
 * "?" sheet under CRM, which leads the sheet on those pages.
 */
export const crmCommands: Command[] = [
  { id: "crm-next", title: "Next row", group: "CRM", scope: "crm", keys: ["J"], keywords: ["down", "contact", "suggestion"], handler: "page", flag: "crmTd10" },
  { id: "crm-prev", title: "Previous row", group: "CRM", scope: "crm", keys: ["K"], keywords: ["up", "contact", "suggestion"], handler: "page", flag: "crmTd10" },
  { id: "crm-accept", title: "Accept the suggestion", group: "CRM", scope: "crm", keys: ["A"], keywords: ["mail", "update", "yes"], handler: "page", flag: "crmTd10" },
  { id: "crm-discard", title: "Discard the suggestion", group: "CRM", scope: "crm", keys: ["D"], keywords: ["mail", "no", "dismiss"], handler: "page", flag: "crmTd10" },
  { id: "crm-new", title: "New contact, deal or analysis", group: "CRM", scope: "crm", keys: ["N"], keywords: ["add", "create"], handler: "page", flag: "crmTd10" },
  { id: "crm-search", title: "Search this list", group: "CRM", scope: "crm", keys: ["/"], keywords: ["find", "filter"], handler: "page", flag: "crmTd10" },
  { id: "crm-suggestions", title: "Open suggestions from mail", group: "CRM", scope: "crm", keys: ["Shift", "S"], keywords: ["mail", "updates"], handler: "page", flag: "crmTd10" },
];
