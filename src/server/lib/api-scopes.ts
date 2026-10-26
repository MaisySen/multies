/**
 * R36: per area API key scopes. One place says which scope every MCP tool and every /api/v1 route
 * needs, so the v1 auth middleware and the MCP dispatcher run one check, the docs page shows it, and a
 * test fails when a new tool or route has no scope (tests/api-scopes-r36.test.ts).
 *
 * Stored in the existing api_keys.scope / oauth_grants.scope text column (no migration):
 * - "full": every scope (the "Full access" preset, what keys had before R36).
 * - "read": every :read scope (the "Read only" preset). Legacy keys keep their exact old behaviour.
 * - otherwise a space separated list, e.g. "mail:read tasks:read tasks:write".
 * A write scope includes its read scope (tasks:write can also read tasks; mail:send can read mail).
 */

export const SCOPE_AREAS = [
  { area: "mail", label: "Mail", read: "mail:read", write: "mail:send", readLabel: "Read mail", writeLabel: "Send and change mail", note: "Inboxes, threads, search, sends, replies, snippets and splits." },
  { area: "tasks", label: "Tasks and projects", read: "tasks:read", write: "tasks:write", readLabel: "Read", writeLabel: "Create and change", note: "Tasks, projects, sprints, goals, time, dashboards and notifications." },
  { area: "chat", label: "Chat", read: "chat:read", write: "chat:write", readLabel: "Read", writeLabel: "Post and change", note: "Channels, threads, reactions, reports and blocks." },
  { area: "docs", label: "Docs and forms", read: "docs:read", write: "docs:write", readLabel: "Read", writeLabel: "Create and change", note: "Docs, forms, results and share links." },
  { area: "calendar", label: "Calendar and meetings", read: "calendar:read", write: "calendar:write", readLabel: "Read", writeLabel: "Schedule and change", note: "Meetings, notes, transcripts, calls and booking." },
  { area: "contacts", label: "Contacts and deals", read: "contacts:read", write: "contacts:write", readLabel: "Read", writeLabel: "Create and change", note: "Contacts, companies, deals and timelines." },
  { area: "admin", label: "Workspace admin", read: "admin:read", write: "admin:write", readLabel: "Read", writeLabel: "Change", note: "Domains, mailboxes, aliases, webhooks, integrations, agent members, guests and invites." },
] as const;

export type ScopeArea = (typeof SCOPE_AREAS)[number]["area"];
export type Scope = (typeof SCOPE_AREAS)[number]["read"] | (typeof SCOPE_AREAS)[number]["write"];
export const ALL_SCOPES: Scope[] = SCOPE_AREAS.flatMap((a) => [a.read, a.write]);
export const READ_SCOPES: Scope[] = SCOPE_AREAS.map((a) => a.read);
const WRITE_TO_READ = new Map<string, string>(SCOPE_AREAS.map((a) => [a.write, a.read]));

/** The two presets every key had before R36, kept as named values so old keys work exactly as before. */
export const SCOPE_PRESETS = [
  { id: "full", label: "Full access", scopes: ALL_SCOPES },
  { id: "read", label: "Read only", scopes: READ_SCOPES },
] as const;

/** Parses a stored scope value into the set of scopes it grants. */
export function grantedScopes(stored: string | null | undefined): Set<string> {
  const v = (stored ?? "full").trim();
  if (v === "full" || v === "") return new Set(ALL_SCOPES);
  if (v === "read") return new Set(READ_SCOPES);
  const out = new Set<string>();
  for (const s of v.split(/[\s,]+/)) {
    if (!(ALL_SCOPES as string[]).includes(s)) continue;
    out.add(s);
    const r = WRITE_TO_READ.get(s);
    if (r) out.add(r);
  }
  return out;
}

export function hasScope(stored: string | null | undefined, required: Scope | null): boolean {
  if (!required) return true;
  return grantedScopes(stored).has(required);
}

/** A legacy preset value ("full" / "read"): the pre-R36 checks apply unchanged. */
export const isPresetScope = (stored: string | null | undefined) => !stored || stored === "full" || stored === "read";

/**
 * Turns what a client sent (a preset name or a list) into the stored value. Lists that equal a
 * preset are stored as the preset, so "every scope" stays "full". Unknown names are an error.
 */
export function normalizeScopes(input: string | string[]): { ok: true; value: string } | { ok: false; unknown: string[] } {
  if (typeof input === "string") {
    if (input === "full" || input === "read") return { ok: true, value: input };
    input = input.split(/[\s,]+/).filter(Boolean);
  }
  const unknown = input.filter((s) => !(ALL_SCOPES as string[]).includes(s));
  if (unknown.length || input.length === 0) return { ok: false, unknown: unknown.length ? unknown : ["(none)"] };
  const set = new Set<string>(input);
  for (const s of [...set]) { const r = WRITE_TO_READ.get(s); if (r) set.add(r); }
  if (ALL_SCOPES.every((s) => set.has(s))) return { ok: true, value: "full" };
  if (set.size === READ_SCOPES.length && READ_SCOPES.every((s) => set.has(s))) return { ok: true, value: "read" };
  return { ok: true, value: ALL_SCOPES.filter((s) => set.has(s)).join(" ") };
}

/** Chips for a key or grant: a preset name, or one chip per area with its level. */
export function scopeChips(stored: string | null | undefined): string[] {
  const v = (stored ?? "full").trim();
  if (v === "full" || v === "") return ["Full access"];
  if (v === "read") return ["Read only"];
  const g = grantedScopes(v);
  return SCOPE_AREAS.filter((a) => g.has(a.read)).map((a) => `${a.label}: ${g.has(a.write) ? a.writeLabel.toLowerCase() : "read"}`);
}

// ------------------------------------------------------------------------ MCP tools

/**
 * The area of every MCP tool. A tool with readOnlyHint needs the area's read scope, any other tool
 * its write scope. A new tool must be added here or tests/api-scopes-r36.test.ts fails; at run time
 * an unlisted tool needs a Full access key.
 */
const TOOL_AREAS: Record<ScopeArea, string> = {
  mail: "list_inboxes list_threads read_thread search search_everything send_email reply wait_for_email snooze_thread schedule_send list_scheduled cancel_scheduled assign_thread unassign_thread set_thread_status list_threads_by_view get_reply_stats list_thread_comments add_thread_comment delete_thread_comment get_thread_presence list_thread_drafts take_over_draft list_snippets render_snippet create_snippet mail_split_list mail_split_create mail_split_update mail_split_delete mail_read_status mail_bulk_action mail_bulk_job",
  tasks: "my_work list_tasks get_task next_task create_task update_task comment_on_task list_projects start_timer stop_timer log_time get_timesheet set_task_blocked_by check_task_schedule reschedule_task set_project_schedule get_report list_people list_custom_fields create_custom_field set_task_fields find_tasks_by_field get_portfolio set_project_health update_project list_templates use_template create_template set_task_repeat list_goals create_goal update_key_result list_notifications list_epics get_epic add_to_epic list_sprints get_sprint create_sprint start_sprint complete_sprint add_to_sprint remove_from_sprint list_triage triage_accept triage_decline triage_merge create_triage_item list_checklist add_checklist_items update_checklist_item reorder_checklist delete_checklist_item checklist_item_to_subtask list_task_watchers watch_task unwatch_task duplicate_task search_tasks start_task_run add_run_step finish_task_run list_task_runs agent_run_cancel notification_list notification_done notification_undone notification_snooze catchup_get get_counts task_triage_list task_triage_action bulk_update_tasks get_workload set_weekly_capacity list_dashboards get_dashboard_data create_dashboard add_dashboard_widget get_computed_fields create_formula_field create_rollup_field list_saved_views create_saved_view delete_saved_view get_board_settings set_board_settings list_task_comments edit_task_comment delete_task_comment",
  chat: "list_channels read_channel read_chat_thread post_message message_to_task pin_message react_to_chat_message chat_typing create_report list_blocks add_block remove_block edit_chat_message delete_chat_message",
  docs: "search_docs read_doc create_doc append_to_doc list_forms create_form docs_append form_logic_set form_results docs_add_block get_doc_tree move_doc get_backlinks create_share_link list_share_links revoke_share_link",
  calendar: "list_meetings schedule_meeting get_meeting_notes create_action_items get_meeting_transcript get_call_status get_call_minutes meeting_summary_so_far meeting_lobby_list meeting_lobby_decide list_calendar_events",
  contacts: "search_contacts contact_timeline upsert_contact",
  admin: "create_agent_inbox set_mailbox_reply_to list_guests invite_guest list_integrations create_incoming_hook list_agent_triggers create_agent_trigger delete_agent_trigger agent_trigger_history list_automation_recipes enable_automation_recipe update_auth_email_hook list_agent_members create_agent_member update_agent_member get_auth_email_settings update_auth_email_settings regenerate_auth_email_secret preview_auth_email send_auth_email_test",
};
const TOOL_AREA = new Map<string, ScopeArea>();
for (const [area, list] of Object.entries(TOOL_AREAS)) for (const n of list.split(" ")) TOOL_AREA.set(n, area as ScopeArea);

export const toolArea = (name: string): ScopeArea | null => TOOL_AREA.get(name) ?? null;
export const listedTools = () => [...TOOL_AREA.keys()];

/** The scope one MCP tool call needs; "full" when the tool is not in the map (fail closed). */
export function toolScope(name: string, readOnly: boolean): Scope | "full" {
  const area = TOOL_AREA.get(name);
  if (!area) return "full";
  const a = SCOPE_AREAS.find((x) => x.area === area)!;
  return readOnly ? a.read : a.write;
}

// ------------------------------------------------------------------------ REST /api/v1

/** First path segment of a /api/v1 route to its area. */
const ROUTE_AREAS: Record<string, ScopeArea> = {
  mail: "mail", threads: "mail", messages: "mail", attachments: "mail", search: "mail", snippets: "mail", approvals: "mail", drafts: "mail", stats: "mail", events: "mail", agents: "mail",
  tasks: "tasks", projects: "tasks", triage: "tasks", sprints: "tasks", epics: "tasks", dashboards: "tasks", time: "tasks", goals: "tasks", "key-results": "tasks", runs: "tasks", notifications: "tasks", templates: "tasks", comments: "tasks", "checklist-items": "tasks", workload: "tasks", views: "tasks", reports: "tasks", fields: "tasks", catchup: "tasks", "my-work": "tasks", counts: "tasks", portfolio: "tasks", changes: "tasks", people: "tasks",
  chat: "chat", blocks: "chat",
  docs: "docs", forms: "docs", "share-links": "docs",
  meetings: "calendar", calendar: "calendar", scheduling: "calendar",
  contacts: "contacts", companies: "contacts", deals: "contacts",
  domains: "admin", mailboxes: "admin", aliases: "admin", webhooks: "admin", integrations: "admin", "incoming-hooks": "admin", "inbound-keys": "admin", "auth-email-hooks": "admin", "auth-email-settings": "admin", "agent-members": "admin", "agent-triggers": "admin", automations: "admin", "work-imports": "admin", invites: "admin", guests: "admin", "free-address": "admin",
};
/** Exact routes whose area differs from their first segment. */
const ROUTE_OVERRIDES: Record<string, ScopeArea> = {
  "POST /agents": "admin", "PATCH /agents/:id": "admin", "DELETE /agents/:id": "admin", "POST /agents/:id/keys": "admin", "GET /agents/:id/keys": "admin", "DELETE /agents/:id/keys/:keyId": "admin", "GET /agents/:id/audit": "admin",
  "GET /search/everything": "mail",
  "POST /reports": "chat",
};
/** Public routes with no key at all (the spec, the reference page). */
const ROUTE_PUBLIC = new Set(["openapi.json", "reference", "reference.js", "mcp"]);
/** POSTs that only render or preview (read only keys could always call them). */
const ROUTE_READ_POSTS = [/^\/snippets\/[^/]+\/render$/, /^\/mail\/splits\/preview$/, /^\/auth-email-hooks\/[^/]+\/preview$/, /^\/auth-email-settings\/preview$/, /^\/work-imports\/preview$/];

/** The scope a /api/v1 request needs. `path` is relative to /api/v1 (a route pattern or a real path). null: no scope (public or MCP, which checks per tool). "full": not mapped. */
export function routeScope(method: string, path: string, pattern?: string): Scope | "full" | null {
  const seg = path.split("/")[1] ?? "";
  if (ROUTE_PUBLIC.has(seg)) return null;
  const m = method.toUpperCase();
  const area = (pattern && ROUTE_OVERRIDES[`${m} ${pattern}`]) || ROUTE_AREAS[seg];
  if (!area) return "full";
  const a = SCOPE_AREAS.find((x) => x.area === area)!;
  const read = m === "GET" || m === "HEAD" || m === "OPTIONS" || ROUTE_READ_POSTS.some((r) => r.test(path));
  return read ? a.read : a.write;
}

/** Overrides resolve against real paths too (the middleware only has the request path). */
export function routeScopeForRequest(method: string, path: string): Scope | "full" | null {
  const m = method.toUpperCase();
  for (const key of Object.keys(ROUTE_OVERRIDES)) {
    const [km, kp] = key.split(" ");
    if (km !== m) continue;
    const re = new RegExp(`^${kp.replace(/:[A-Za-z]+/g, "[^/]+")}$`);
    if (re.test(path)) return routeScope(method, path, kp);
  }
  return routeScope(method, path);
}

export function insufficientScopeBody(required: string) {
  return { error: { code: "insufficient_scope", message: `This API key does not have the ${required} scope. Edit the key's scopes in Settings, Developers, or use a key with Full access.`, required } };
}

// ------------------------------------------------------------------------ R37: scoped tool list

/**
 * R37: "Show only the tools this key can use". Stored as one extra word in the same scope column (no
 * migration): "mail:read tasks:write list:scoped". grantedScopes() already ignores the word, and the key
 * resolver strips it, so every other check sees the plain scope value it saw before R37.
 */
export const TOOL_LIST_MARKER = "list:scoped";

/** Splits a stored value into the plain scope value and the tool list option. */
export function splitToolList(stored: string | null | undefined): { scope: string; scopedList: boolean } {
  const words = (stored ?? "full").trim().split(/\s+/).filter(Boolean);
  const scopedList = words.includes(TOOL_LIST_MARKER);
  const rest = words.filter((w) => w !== TOOL_LIST_MARKER).join(" ");
  return { scope: rest || "full", scopedList };
}

/** Joins a plain scope value and the option back into the stored value. A Full access key never hides tools. */
export function withToolList(scope: string, scopedList: boolean): string {
  const plain = splitToolList(scope).scope;
  return scopedList && plain !== "full" ? `${plain} ${TOOL_LIST_MARKER}` : plain;
}

/**
 * Whether a tool can run for this scope value (the same rule the MCP dispatcher and writable() apply):
 * "full" runs everything, "read" runs read only tools, a per area value needs the tool's scope.
 */
export function canUseTool(scope: string | null | undefined, name: string, readOnly: boolean): boolean {
  const plain = splitToolList(scope).scope;
  if (plain === "full") return true;
  if (plain === "read") return readOnly;
  const need = toolScope(name, readOnly);
  return need !== "full" && hasScope(plain, need);
}

/**
 * The per connection option: ?tools=scoped (or the X-Multies-Tools header) hides tools the key can't use,
 * ?tools=all shows every tool even when the key hides them. Anything else: the key's own setting.
 */
export function toolListChoice(query: string | null | undefined, header?: string | null): "scoped" | "all" | null {
  const v = (query ?? header ?? "").trim().toLowerCase();
  if (v === "scoped" || v === "usable" || v === "mine") return "scoped";
  if (v === "all") return "all";
  return null;
}
