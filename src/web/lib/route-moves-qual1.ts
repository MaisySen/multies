/**
 * QUAL1 (audit rows 29, 48, 58): app addresses that read their last word as an id ("Agent not found" on
 * /app/agents/automations, a contact called "companies") or had no page without an id (/app/files/edit, /app/go).
 * Each opens the list it belongs to instead. The router adds one redirect route per entry (paths are relative to
 * /app); a fixed path always wins over an :id one, so the order of the routes does not matter.
 */
export const APP_MOVES: readonly { path: string; to: string }[] = [
  { path: "agents/automations", to: "/app/automations" },
  { path: "dashboards/reports", to: "/app/reports" },
  { path: "contacts/companies", to: "/app/contacts?tab=companies" },
  { path: "contacts/portals", to: "/app/contacts?tab=portals" },
  { path: "contacts/assets", to: "/app/contacts/staff?view=assets" },
  { path: "docs/sites/blog", to: "/app/docs/sites?tab=blog" },
  { path: "tools/merge/lists", to: "/app/tools/merge?tab=lists" },
  { path: "tools/merge/newsletters", to: "/app/tools/merge?tab=newsletters" },
  { path: "tools/merge/journeys", to: "/app/tools/merge?tab=journeys" },
  { path: "automations/flows", to: "/app/automations" },
  { path: "files/edit", to: "/app/files" },
  { path: "go", to: "/app/tools/links" },
];

/** The target with the address's own query and hash kept; a target with a query of its own gets them joined with &. */
export function movedTarget(to: string, search: string, hash = ""): string {
  const q = search.replace(/^\?/, "");
  return `${to}${q ? `${to.includes("?") ? "&" : "?"}${q}` : ""}${hash}`;
}
