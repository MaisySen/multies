/**
 * R90: automation builder, the parts both sides share. A flow is a graph: one trigger node, then steps
 * joined by edges. Conditions branch on yes and no; any action may have an "if it fails" edge. The
 * server runs it (services/suite/flows.ts); the web draws it (pages/app/automations).
 */

export const FLOW_TRIGGERS = ["manual", "task_created", "status_changed", "form_submitted", "booking_made", "page_changed", "feed_item"] as const;
export type FlowTrigger = (typeof FLOW_TRIGGERS)[number];

export const FLOW_ACTIONS = ["create_task", "notify", "post_to_channel", "send_webhook", "add_to_digest", "set_status", "set_priority", "add_label"] as const;
export type FlowAction = (typeof FLOW_ACTIONS)[number];
/** Actions that change the task that started the run; only task triggers can use them. */
export const TASK_ONLY_ACTIONS: readonly FlowAction[] = ["set_status", "set_priority", "add_label"];
export const TASK_TRIGGERS: readonly FlowTrigger[] = ["task_created", "status_changed"];

export type NodeKind = "trigger" | "condition" | "wait" | "approval" | "action" | "stop";
export type Branch = "next" | "yes" | "no" | "error";

export interface FlowNode { id: string; kind: NodeKind; label?: string; config: Record<string, unknown>; x: number; y: number }
export interface FlowEdge { id: string; from: string; to: string; branch: Branch }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[] }

export const MAX_NODES = 40;
export const MAX_FLOWS = 50;
export const MAX_WATCHES = 10;
export const WAIT_MAX_MS = 30 * 86_400_000;
export const WATCH_EVERY = [60, 360, 1440] as const;
export const STEP_IO_MAX = 8_000;
/** Automatic retries of a failed action before the run stops as failed (then a person can retry it). */
export const STEP_BACKOFF_MS = [60_000, 5 * 60_000] as const;

export const TRIGGER_LABEL: Record<FlowTrigger, string> = {
  manual: "When I run it", task_created: "When a task is made", status_changed: "When a task changes status",
  form_submitted: "When a form is sent", booking_made: "When someone books a time", page_changed: "When a web page changes", feed_item: "When a feed has a new item",
};
export const ACTION_LABEL: Record<FlowAction, string> = {
  create_task: "Make a task", notify: "Notify people", post_to_channel: "Post in a channel", send_webhook: "Send to a webhook",
  add_to_digest: "Add to an email digest", set_status: "Move the task", set_priority: "Set priority", add_label: "Add a label",
};
export const KIND_LABEL: Record<NodeKind, string> = { trigger: "Trigger", condition: "Condition", wait: "Wait", approval: "Approval", action: "Action", stop: "Stop" };

/** What each trigger hands to the run, for the field picker and {placeholders}. */
export const TRIGGER_FIELDS: Record<FlowTrigger, { key: string; label: string }[]> = {
  manual: [{ key: "note", label: "Note" }],
  task_created: [{ key: "title", label: "Task title" }, { key: "ref", label: "Task number" }, { key: "priority", label: "Priority" }, { key: "status", label: "Status" }, { key: "project", label: "Project" }, { key: "link", label: "Task link" }],
  status_changed: [{ key: "title", label: "Task title" }, { key: "ref", label: "Task number" }, { key: "status", label: "New status" }, { key: "category", label: "New stage" }, { key: "priority", label: "Priority" }, { key: "link", label: "Task link" }],
  form_submitted: [{ key: "form", label: "Form name" }, { key: "summary", label: "Answers" }, { key: "email", label: "Email given" }, { key: "name", label: "Name given" }, { key: "link", label: "Entry link" }],
  booking_made: [{ key: "title", label: "Booking" }, { key: "name", label: "Guest name" }, { key: "email", label: "Guest email" }, { key: "start", label: "Starts" }, { key: "link", label: "Booking link" }],
  page_changed: [{ key: "url", label: "Page address" }, { key: "added", label: "Text added" }, { key: "removed", label: "Text removed" }, { key: "summary", label: "Change summary" }],
  feed_item: [{ key: "title", label: "Item title" }, { key: "link", label: "Item link" }, { key: "summary", label: "Item summary" }, { key: "feed", label: "Feed name" }, { key: "published", label: "Published" }],
};

// ---------- Conditions ----------
export const CONDITION_OPS = ["equals", "not_equals", "contains", "not_contains", "starts_with", "is_empty", "is_not_empty", "greater_than", "less_than"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const OP_LABEL: Record<ConditionOp, string> = {
  equals: "is", not_equals: "is not", contains: "contains", not_contains: "does not contain", starts_with: "starts with",
  is_empty: "is empty", is_not_empty: "is not empty", greater_than: "is more than", less_than: "is less than",
};
export interface ConditionRule { field: string; op: ConditionOp; value?: string }
export interface ConditionConfig { match: "all" | "any"; rules: ConditionRule[] }

/** Reads "trigger.title" or "steps.n2.id" out of the run's variables. */
export function readPath(vars: unknown, path: string): unknown {
  let cur: unknown = vars;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const str = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function testRule(rule: ConditionRule, vars: unknown): boolean {
  const raw = readPath(vars, rule.field);
  const left = str(raw).trim().toLowerCase();
  const right = str(rule.value).trim().toLowerCase();
  switch (rule.op) {
    case "equals": return left === right;
    case "not_equals": return left !== right;
    case "contains": return right !== "" && left.includes(right);
    case "not_contains": return right === "" || !left.includes(right);
    case "starts_with": return right !== "" && left.startsWith(right);
    case "is_empty": return left === "" || left === "[]" || left === "{}";
    case "is_not_empty": return !(left === "" || left === "[]" || left === "{}");
    case "greater_than": case "less_than": {
      const a = Number(left), b = Number(right);
      if (!Number.isFinite(a) || !Number.isFinite(b) || left === "" || right === "") return false;
      return rule.op === "greater_than" ? a > b : a < b;
    }
    default: return false;
  }
}

/** All or any of the rules; a condition with no rules is always yes. */
export function evaluateCondition(cfg: Partial<ConditionConfig> | undefined, vars: unknown): boolean {
  const rules = Array.isArray(cfg?.rules) ? cfg.rules : [];
  if (!rules.length) return true;
  return cfg?.match === "any" ? rules.some((r) => testRule(r, vars)) : rules.every((r) => testRule(r, vars));
}

// ---------- Routing ----------
export function triggerNode(g: FlowGraph): FlowNode | undefined { return g.nodes.find((n) => n.kind === "trigger"); }
export function nodeById(g: FlowGraph, id: string | null | undefined): FlowNode | undefined { return id ? g.nodes.find((n) => n.id === id) : undefined; }

/** The node after `from` for an outcome. A condition follows yes or no; anything else follows next, or its error edge when it failed. */
export function nextNode(g: FlowGraph, from: string, outcome: Branch): string | null {
  const e = g.edges.find((x) => x.from === from && x.branch === outcome);
  return e ? e.to : null;
}

// ---------- Waits and retries ----------
export type WaitUnit = "minutes" | "hours" | "days";
const UNIT_MS: Record<WaitUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
/** When a wait step lets the run go on: at least a minute, at most 30 days. */
export function waitUntil(now: number, cfg: { amount?: unknown; unit?: unknown }): number {
  const unit = (["minutes", "hours", "days"].includes(String(cfg.unit)) ? cfg.unit : "hours") as WaitUnit;
  const amount = Math.max(0, Math.floor(Number(cfg.amount) || 0));
  return now + Math.min(WAIT_MAX_MS, Math.max(60_000, amount * UNIT_MS[unit]));
}
/** The pause before automatic retry `attempt` (2 is the first retry), or null when retries ran out. */
export function stepBackoff(attempt: number): number | null {
  const ms = STEP_BACKOFF_MS[attempt - 2];
  return ms === undefined ? null : ms;
}
/** A watch that keeps failing checks less often: double the gap per failure, at most a day. */
export function watchBackoff(everyMinutes: number, failCount: number): number {
  return Math.min(1440, everyMinutes * 2 ** Math.min(failCount, 5)) * 60_000;
}

// ---------- Placeholders and redaction ----------
/** Fills {trigger.title} style placeholders; unknown ones become empty. */
export function fillPlaceholders(text: string, vars: unknown): string {
  return text.replace(/\{([a-zA-Z0-9_.]{1,80})\}/g, (_, path: string) => str(readPath(vars, path)));
}
const SECRET_KEY = /secret|token|passw|authori[sz]ation|api[_-]?key|cookie|signature|private/i;
/** Copies a value for the run log: secret looking keys hidden, long strings cut, the whole kept under STEP_IO_MAX. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[cut]";
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}[cut]` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? "[hidden]" : redact(v, depth + 1);
    return out;
  }
  return value;
}
export function logJson(value: unknown): string {
  const s = JSON.stringify(redact(value) ?? null);
  return s.length <= STEP_IO_MAX ? s : JSON.stringify({ cut: true, preview: s.slice(0, STEP_IO_MAX - 100) });
}

// ---------- Page change ----------
/** Lines added and removed between two texts (longest common subsequence over lines, first 1500 lines each). */
export function diffLines(before: string, after: string): { added: string[]; removed: string[] } {
  const a = before.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 1500);
  const b = after.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 1500);
  const n = a.length, m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const added: string[] = [], removed: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(a[i++]); else added.push(b[j++]);
  }
  while (i < n) removed.push(a[i++]);
  while (j < m) added.push(b[j++]);
  return { added, removed };
}
export function changeSummary(d: { added: string[]; removed: string[] }): string {
  const parts = [d.added.length && `${d.added.length} ${d.added.length === 1 ? "line" : "lines"} added`, d.removed.length && `${d.removed.length} ${d.removed.length === 1 ? "line" : "lines"} removed`].filter(Boolean);
  return parts.length ? parts.join(", ") : "No change";
}

// ---------- Validation ----------
export interface GraphProblem { nodeId?: string; message: string }

export function validateGraph(g: FlowGraph): GraphProblem[] {
  const out: GraphProblem[] = [];
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return [{ message: "The flow is not readable." }];
  if (g.nodes.length > MAX_NODES) out.push({ message: `A flow can have up to ${MAX_NODES} steps.` });
  const ids = new Set<string>();
  for (const n of g.nodes) { if (ids.has(n.id)) out.push({ nodeId: n.id, message: "Two steps share an id." }); ids.add(n.id); }
  const triggers = g.nodes.filter((n) => n.kind === "trigger");
  if (triggers.length !== 1) out.push({ message: triggers.length ? "A flow has one trigger." : "Pick a trigger to start the flow." });
  const t = triggers[0];
  if (t && !FLOW_TRIGGERS.includes(t.config.trigger as FlowTrigger)) out.push({ nodeId: t.id, message: "Pick what starts the flow." });
  if (t && (t.config.trigger === "page_changed" || t.config.trigger === "feed_item") && !String(t.config.url ?? "").trim()) out.push({ nodeId: t.id, message: t.config.trigger === "feed_item" ? "Add the feed address to watch." : "Add the page address to watch." });
  for (const e of g.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) out.push({ message: "A link points at a missing step." });
    if (e.from === e.to) out.push({ nodeId: e.from, message: "A step cannot lead to itself." });
  }
  for (const n of g.nodes) {
    const outs = g.edges.filter((e) => e.from === n.id);
    const count = (b: Branch) => outs.filter((e) => e.branch === b).length;
    if (n.kind === "condition") {
      if (count("next") || count("error")) out.push({ nodeId: n.id, message: "A condition leads on by yes or no." });
      if (count("yes") > 1 || count("no") > 1) out.push({ nodeId: n.id, message: "A condition has one yes path and one no path." });
    } else {
      if (count("yes") || count("no")) out.push({ nodeId: n.id, message: "Only a condition has yes and no paths." });
      if (count("next") > 1) out.push({ nodeId: n.id, message: "A step leads to one next step. Use a condition to branch." });
      if (count("error") > 1) out.push({ nodeId: n.id, message: "A step has one path for when it fails." });
      if (count("error") && n.kind !== "action") out.push({ nodeId: n.id, message: "Only actions have a path for when they fail." });
    }
    if (n.kind === "trigger" && g.edges.some((e) => e.to === n.id)) out.push({ nodeId: n.id, message: "Nothing can lead back to the trigger." });
    if (n.kind === "stop" && outs.length) out.push({ nodeId: n.id, message: "Stop ends the flow; nothing comes after it." });
    if (n.kind === "action") {
      const a = n.config.action as FlowAction;
      if (!FLOW_ACTIONS.includes(a)) out.push({ nodeId: n.id, message: "Pick what this step does." });
      else if (TASK_ONLY_ACTIONS.includes(a) && t && !TASK_TRIGGERS.includes(t.config.trigger as FlowTrigger)) out.push({ nodeId: n.id, message: `${ACTION_LABEL[a]} works only when a task starts the flow.` });
      if (a === "post_to_channel" && !n.config.channelId) out.push({ nodeId: n.id, message: "Pick a channel to post in." });
      if (a === "send_webhook" && !n.config.endpointId) out.push({ nodeId: n.id, message: "Pick a webhook to send to, or add one in Settings, Connections, Webhooks." });
    }
    if (n.kind === "condition") {
      const rules = (n.config.rules as ConditionRule[] | undefined) ?? [];
      if (!Array.isArray(rules) || rules.some((r) => !r.field || !CONDITION_OPS.includes(r.op))) out.push({ nodeId: n.id, message: "Finish the condition: pick a field and a test." });
    }
  }
  if (hasCycle(g)) out.push({ message: "Steps go round in a loop. A flow runs forward only." });
  if (t) {
    const seen = reachable(g, t.id);
    for (const n of g.nodes) if (!seen.has(n.id)) out.push({ nodeId: n.id, message: "This step is not joined to the flow." });
  }
  return out;
}

export function reachable(g: FlowGraph, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) { const id = stack.pop()!; for (const e of g.edges) if (e.from === id && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); } }
  return seen;
}
export function hasCycle(g: FlowGraph): boolean {
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const e of g.edges) if (e.from === id && visit(e.to)) return true;
    state.set(id, 2);
    return false;
  };
  return g.nodes.some((n) => visit(n.id));
}

/** A readable line for a step, on the canvas card and in the phone list. */
export function describeNode(n: FlowNode): string {
  const c = n.config;
  switch (n.kind) {
    case "trigger": return TRIGGER_LABEL[c.trigger as FlowTrigger] ?? "Pick a trigger";
    case "condition": { const rules = (c.rules as ConditionRule[] | undefined) ?? []; if (!rules.length) return "Always yes"; const r = rules[0]; return `${r.field.replace(/^trigger\./, "")} ${OP_LABEL[r.op] ?? r.op}${r.value ? ` ${r.value}` : ""}${rules.length > 1 ? ` and ${rules.length - 1} more` : ""}`; }
    case "wait": return `Wait ${Number(c.amount) || 0} ${String(c.unit ?? "hours")}`;
    case "approval": return c.approver ? "A chosen person approves" : "An admin approves";
    case "action": return ACTION_LABEL[c.action as FlowAction] ?? "Pick an action";
    case "stop": return "End the flow";
  }
}

// ---------- Templates ----------
export interface FlowTemplate { key: string; name: string; description: string; trigger: FlowTrigger; graph: FlowGraph }
const node = (id: string, kind: NodeKind, config: Record<string, unknown>, y: number, x = 0): FlowNode => ({ id, kind, config, x, y });
const edge = (from: string, to: string, branch: Branch = "next"): FlowEdge => ({ id: `${from}-${to}-${branch}`, from, to, branch });

export const FLOW_TEMPLATES: FlowTemplate[] = [
  { key: "form_to_task", name: "New form entry to task", description: "Each form entry becomes a task for your team, with the answers in it.", trigger: "form_submitted",
    graph: { nodes: [node("t", "trigger", { trigger: "form_submitted" }, 0), node("a1", "action", { action: "create_task", title: "Form entry: {trigger.form}", notes: "{trigger.summary}" }, 140)], edges: [edge("t", "a1")] } },
  { key: "booking_to_digest", name: "Bookings in a daily mail", description: "Every booking goes into one short mail each morning.", trigger: "booking_made",
    graph: { nodes: [node("t", "trigger", { trigger: "booking_made" }, 0), node("a1", "action", { action: "add_to_digest", every: "daily", title: "{trigger.title} with {trigger.name}", link: "{trigger.link}" }, 140)], edges: [edge("t", "a1")] } },
  { key: "feed_to_digest", name: "Feed to a weekly digest", description: "New posts from a blog or news feed, gathered into one mail a week.", trigger: "feed_item",
    graph: { nodes: [node("t", "trigger", { trigger: "feed_item", every: 360 }, 0), node("a1", "action", { action: "add_to_digest", every: "weekly", title: "{trigger.title}", link: "{trigger.link}", summary: "{trigger.summary}" }, 140)], edges: [edge("t", "a1")] } },
  { key: "page_alert", name: "Web page changed alert", description: "Watch a price, a policy or a competitor page and hear when it changes.", trigger: "page_changed",
    graph: { nodes: [node("t", "trigger", { trigger: "page_changed", every: 360 }, 0), node("a1", "action", { action: "notify", to: "admins", message: "{trigger.url} changed: {trigger.summary}" }, 140)], edges: [edge("t", "a1")] } },
  { key: "urgent_task_approval", name: "Urgent task needs an OK", description: "When an urgent task is made, an admin approves before the team is told.", trigger: "task_created",
    graph: { nodes: [node("t", "trigger", { trigger: "task_created" }, 0), node("c1", "condition", { match: "all", rules: [{ field: "trigger.priority", op: "equals", value: "urgent" }] }, 140),
      node("p1", "approval", { note: "An urgent task was made: {trigger.title}" }, 280, -140), node("a1", "action", { action: "notify", to: "admins", message: "Urgent: {trigger.ref} {trigger.title}" }, 420, -140), node("s1", "stop", {}, 280, 140)],
      edges: [edge("t", "c1"), edge("c1", "p1", "yes"), edge("c1", "s1", "no"), edge("p1", "a1")] } },
  { key: "done_to_webhook", name: "Finished task to a webhook", description: "Tell another system when a task is done, signed and retried.", trigger: "status_changed",
    graph: { nodes: [node("t", "trigger", { trigger: "status_changed" }, 0), node("c1", "condition", { match: "all", rules: [{ field: "trigger.category", op: "equals", value: "done" }] }, 140),
      node("a1", "action", { action: "send_webhook" }, 280, -140), node("a2", "action", { action: "notify", to: "admins", message: "The webhook for {trigger.ref} failed." }, 420, 0)],
      edges: [edge("t", "c1"), edge("c1", "a1", "yes"), edge("a1", "a2", "error")] } },
];

export function emptyGraph(trigger: FlowTrigger = "manual"): FlowGraph {
  return { nodes: [node("t", "trigger", { trigger }, 0)], edges: [] };
}
