/**
 * R36: the public MCP tool catalog, built from the same registrations the MCP server answers
 * tools/list with (buildMcpServer), so the docs page can never drift from the server. Served as JSON
 * at /api/mcp-tools and as Markdown at /developers/mcp.md; the page at /developers/mcp reads the JSON.
 * Built once per isolate (no D1 reads or writes).
 */
import { z } from "zod";
import { buildMcpServer } from "../../routes/mcp-server";
import { SCOPE_AREAS, canUseTool, normalizeScopes, splitToolList, toolArea, toolScope, type ScopeArea } from "../../lib/api-scopes";
import captured from "./mcp-examples.generated.json"; // R37: real answers, see tests/capture-mcp-examples-r37.test.ts
import type { Deps } from "../../context";

export interface CatalogParam { name: string; type: string; required: boolean; description: string; default?: unknown; values?: string[] }
export interface CatalogTool {
  name: string; title: string; description: string; area: ScopeArea; areaLabel: string; scope: string; readOnly: boolean; destructive: boolean;
  params: CatalogParam[]; example: { arguments: Record<string, unknown>; result: unknown; resultIsShape: boolean; captured?: boolean };
}

type JsonSchema = { type?: string | string[]; description?: string; default?: unknown; enum?: unknown[]; const?: unknown; items?: JsonSchema; properties?: Record<string, JsonSchema>; required?: string[]; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; format?: string; minimum?: number; examples?: unknown[] };

function typeOf(s: JsonSchema): string {
  if (s.enum) return "one of";
  const alt = s.anyOf ?? s.oneOf;
  if (alt) return [...new Set(alt.map(typeOf))].filter((t) => t !== "null").join(" or ") || "any";
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== "null")[0] : s.type;
  if (t === "array") return `array of ${s.items ? typeOf(s.items) : "any"}`;
  if (t === "integer") return "integer";
  return t ?? "any";
}

/** A believable value for one parameter, from its name and schema. Ids follow Multies' prefixes. */
function sample(name: string, s: JsonSchema): unknown {
  if (s.examples?.length) return s.examples[0];
  if (s.enum?.length) return s.enum[0];
  if (s.const !== undefined) return s.const;
  if (s.default !== undefined) return s.default;
  const alt = s.anyOf ?? s.oneOf;
  if (alt) return sample(name, alt.find((x) => x.type !== "null") ?? alt[0]);
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== "null")[0] : s.type;
  const n = name.toLowerCase();
  if (t === "boolean") return true;
  if (t === "integer" || t === "number") return Math.max(s.minimum ?? 1, 1);
  if (t === "array") return [sample(name.replace(/s$/, ""), s.items ?? { type: "string" })];
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const k of s.required ?? []) if (s.properties?.[k]) out[k] = sample(k, s.properties[k]);
    return out;
  }
  if (s.format === "email" || /email|^to$|^cc$|address/.test(n)) return "ada@example.com";
  if (s.format === "date-time" || /(at|until|since|start|end|from|before|after)$/.test(n) && !/format/.test(n)) return "2026-11-02T09:00:00.000Z";
  if (s.format === "date" || /date|due/.test(n)) return "2026-11-02";
  if (s.format === "uri" || /url$/.test(n)) return "https://example.com/hook";
  if (/taskid|^task$|ref$/.test(n)) return "OPS-12";
  if (/threadid/.test(n)) return "thr_8d7c6b5a";
  if (/messageid/.test(n)) return "msg_8d7c6b5a";
  if (/projectid/.test(n)) return "prj_8d7c6b5a";
  if (/channelid/.test(n)) return "chn_8d7c6b5a";
  if (/docid/.test(n)) return "doc_8d7c6b5a";
  if (/agentid/.test(n)) return "agt_8d7c6b5a";
  if (/mailboxid/.test(n)) return "mbx_8d7c6b5a";
  if (/meetingid/.test(n)) return "mtg_8d7c6b5a";
  if (/userid|assignee/.test(n)) return "usr_8d7c6b5a";
  if (/id$/.test(n)) return `${n.replace(/id$/, "").slice(0, 3) || "id"}_8d7c6b5a`;
  if (/title|name|subject/.test(n)) return "Follow up with Ada";
  if (/query|^q$|search/.test(n)) return "invoice";
  if (/color|colour/.test(n)) return "#0071E3";
  return "Example";
}

/** Real answers for the tools people reach for first. Every other tool shows its result shape. */
const RESULTS: Record<string, unknown> = {
  list_inboxes: { agents: [{ agentId: "agt_8d7c6b5a", name: "Support agent", address: "support@acme.io", approvalMode: "first_contact", sentToday: 4, sendCapDaily: 200, status: "active" }], mailboxes: [{ mailboxId: "mbx_8d7c6b5a", address: "hello@acme.io", name: "Hello", replyTo: null }] },
  list_threads: { threads: [{ id: "thr_8d7c6b5a", subject: "Invoice 1042", from: "ada@example.com", snippet: "Hi, the invoice is attached", unread: 1, lastMessageAt: "2026-11-02T08:41:00.000Z" }] },
  read_thread: { thread: { id: "thr_8d7c6b5a", subject: "Invoice 1042" }, messages: [{ id: "msg_8d7c6b5a", from: "ada@example.com", text: "Hi, the invoice is attached.", date: "2026-11-02T08:41:00.000Z" }] },
  send_email: { messageId: "msg_9f8e7d6c", status: "sent" },
  reply: { messageId: "msg_9f8e7d6c", status: "pending_approval", approvalId: "apr_1a2b3c4d" },
  list_tasks: { tasks: [{ id: "tsk_8d7c6b5a", ref: "OPS-12", title: "Follow up with Ada", status: "todo", priority: "high", dueDate: "2026-11-02", assignee: { id: "usr_8d7c6b5a", name: "Sam" } }] },
  create_task: { task: { id: "tsk_9f8e7d6c", ref: "OPS-13", title: "Follow up with Ada", status: "todo", url: "https://multies.si/app/work/tasks/OPS-13" } },
  update_task: { task: { id: "tsk_8d7c6b5a", ref: "OPS-12", status: "done" } },
  next_task: { task: { id: "tsk_8d7c6b5a", ref: "OPS-12", title: "Follow up with Ada", status: "in_progress" } },
  comment_on_task: { comment: { id: "cmt_8d7c6b5a", taskId: "tsk_8d7c6b5a", body: "Sent the invoice reminder." } },
  post_message: { message: { id: "chm_8d7c6b5a", channelId: "chn_8d7c6b5a", body: "Standup: 3 done, 2 in progress, nothing blocked." } },
  list_channels: { channels: [{ id: "chn_8d7c6b5a", name: "general", unread: 2 }] },
  search: { results: [{ threadId: "thr_8d7c6b5a", subject: "Invoice 1042", snippet: "the invoice is attached" }] },
  create_doc: { doc: { id: "doc_9f8e7d6c", title: "Weekly notes", url: "https://multies.si/app/work/docs/doc_9f8e7d6c" } },
  schedule_meeting: { meeting: { id: "mtg_9f8e7d6c", title: "Kickoff", startsAt: "2026-11-02T09:00:00.000Z", joinUrl: "https://multies.si/meet/mtg_9f8e7d6c" } },
  upsert_contact: { contact: { id: "con_9f8e7d6c", email: "ada@example.com", name: "Ada Lovelace" } },
  message_to_task: { task: { id: "tsk_9f8e7d6c", ref: "OPS-14", title: "Login page shows a blank screen on Safari" } },
};

/** Example arguments where the generic sample would not pass the tool's own checks. */
const ARGS: Record<string, Record<string, unknown>> = {
  set_weekly_capacity: { person: "member:usr_8d7c6b5a", points: 20 },
};

/** R37: real example calls and answers, captured from a local server with example seed data. */
export const CAPTURED: Record<string, { arguments: Record<string, unknown>; result: unknown }> = (captured as { examples: Record<string, { arguments: Record<string, unknown>; result: unknown }> }).examples;
export const CAPTURED_AT: string = (captured as { capturedAt: string }).capturedAt;

let cached: { release: string; tools: CatalogTool[] } | null = null;

export function mcpCatalog(release = "dev"): CatalogTool[] {
  if (cached && cached.release === release) return cached.tools;
  const deps = { config: { release } } as unknown as Deps;
  const server = buildMcpServer(deps, { orgId: "org", userId: "usr", email: "docs", name: "docs", role: "admin", sessionId: "docs", scope: "full", agentId: null } as never, "https://multies.si") as unknown as {
    _registeredTools: Record<string, { title?: string; description?: string; inputSchema?: z.ZodType; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
  };
  const tools: CatalogTool[] = [];
  for (const [name, t] of Object.entries(server._registeredTools)) {
    let schema: JsonSchema = {};
    try { if (t.inputSchema) schema = z.toJSONSchema(t.inputSchema, { io: "input", unrepresentable: "any" }) as JsonSchema; } catch { schema = {}; }
    const req = new Set(schema.required ?? []);
    const params = Object.entries(schema.properties ?? {}).map(([pname, p]) => ({
      name: pname, type: typeOf(p), required: req.has(pname), description: p.description ?? "",
      ...(p.default !== undefined ? { default: p.default } : {}), ...(p.enum ? { values: p.enum.map(String) } : {}),
    }));
    const args: Record<string, unknown> = {};
    for (const p of params) if (p.required) args[p.name] = sample(p.name, schema.properties![p.name]);
    Object.assign(args, ARGS[name]);
    const readOnly = !!t.annotations?.readOnlyHint;
    const area = toolArea(name) ?? "admin";
    const real = CAPTURED[name];
    tools.push({
      name, title: t.title ?? name, description: t.description ?? "", area, areaLabel: SCOPE_AREAS.find((a) => a.area === area)!.label,
      scope: toolScope(name, readOnly), readOnly, destructive: !!t.annotations?.destructiveHint, params,
      example: real
        ? { arguments: real.arguments, result: real.result, resultIsShape: false, captured: true }
        : { arguments: args, result: RESULTS[name] ?? { content: [{ type: "text", text: "{ ...the result as JSON... }" }] }, resultIsShape: !RESULTS[name] },
    });
  }
  cached = { release, tools };
  return tools;
}

/** The catalog as Markdown (for /developers/mcp.md and agents that read Markdown). */
export function mcpCatalogMarkdown(release = "dev"): string {
  const tools = mcpCatalog(release);
  const out = [
    "# Multies MCP tools",
    "",
    `> Every tool the Multies MCP server at https://multies.si/api/v1/mcp offers (${tools.length} tools), generated from the server itself. Each tool names the API key scope it needs. Page: https://multies.si/developers/mcp`,
    "",
  ];
  out.push(...SCOPED_TOOL_LIST_MD);
  for (const a of SCOPE_AREAS) {
    const list = tools.filter((t) => t.area === a.area);
    if (!list.length) continue;
    out.push(`## ${a.label}`, "");
    for (const t of list) {
      out.push(`### ${t.name}`, "", t.description, "", `Scope: \`${t.scope}\`${t.readOnly ? " (read only)" : ""}`, "");
      if (t.params.length) {
        out.push("| Parameter | Type | Required | Description |", "| --- | --- | --- | --- |");
        for (const p of t.params) out.push(`| \`${p.name}\` | ${p.type}${p.values ? `: ${p.values.join(", ")}` : ""} | ${p.required ? "yes" : "no"} | ${p.description.replace(/\|/g, "/").replace(/\n/g, " ")}${p.default !== undefined ? ` Default ${JSON.stringify(p.default)}.` : ""} |`);
        out.push("");
      }
      out.push("Example call:", "", "```json", JSON.stringify({ name: t.name, arguments: t.example.arguments }), "```", "");
    }
  }
  out.push(...capturedExamplesMarkdown());
  return `${out.join("\n")}\n`;
}

/**
 * R37: the tools one scope value can use, the same list an MCP client sees in tools/list when the key
 * (or the connection, with ?tools=scoped) hides the rest. Accepts "full", "read" or a per area list.
 */
export function mcpCatalogView(release: string, scope: string): { ok: true; scope: string; total: number; tools: CatalogTool[] } | { ok: false; unknown: string[] } {
  const plain = splitToolList(scope).scope;
  const n = normalizeScopes(plain);
  if (!n.ok) return n;
  const all = mcpCatalog(release);
  return { ok: true, scope: n.value, total: all.length, tools: all.filter((t) => canUseTool(n.value, t.name, t.readOnly)) };
}

/** R37: the captured examples as Markdown, for /developers/mcp.md and llms-full.txt. Long answers are cut. */
export function capturedExamplesMarkdown(maxResultChars = 900): string[] {
  const out = [
    "## Example calls with real results",
    "",
    `These are real answers from a Multies server with example data (captured ${CAPTURED_AT}). Ids are made stable, secrets are hidden and long lists are cut to 3 items. Your ids and data will differ.`,
    "",
  ];
  for (const [name, ex] of Object.entries(CAPTURED)) {
    let result = JSON.stringify(ex.result, null, 2);
    if (result.length > maxResultChars) result = `${result.slice(0, maxResultChars)}\n... (cut)`;
    out.push(`### ${name}`, "", "Call:", "", "```json", JSON.stringify({ name, arguments: ex.arguments }), "```", "", "Result:", "", "```json", result, "```", "");
  }
  return out;
}

/** R37: the docs section on hiding the tools a key can't use. One copy for the page, the .md and llms-full. */
export const SCOPED_TOOL_LIST_MD = [
  "## Show only the tools a key can use",
  "",
  "A key with limited scopes can hide the tools it can't use, so an agent's tool list stays short and every tool it sees will work.",
  "",
  "- Per key: turn on \"Show only the tools this key can use\" when you create or edit a key in Settings, Developers. It is on by default for new keys with limited scopes and off for keys made before it existed. Full access keys always see every tool.",
  "- Per connection: add `?tools=scoped` to the MCP URL (`https://multies.si/api/v1/mcp?tools=scoped`), or send the header `X-Multies-Tools: scoped`. `?tools=all` shows every tool even when the key hides them. This works for API keys and for OAuth sign-ins: a read only sign-in then sees only read tools.",
  "- A hidden tool is only hidden from `tools/list`. Calling it by name still gets the same `insufficient_scope` (or `read_only_key`) answer as before.",
  "- To see a key's list without an MCP client: `GET https://multies.si/api/mcp-tools?view=key` with `Authorization: Bearer <key>`, or preview any scopes with `GET https://multies.si/api/mcp-tools?scope=mail:read+tasks:write`.",
  "",
];