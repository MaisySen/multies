import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let wsKey: string;

async function connect(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
  wsKey = (await c.post("/api/developer/keys", { name: "MCP" })).body.secret;
});

describe("MCP server", () => {
  it("lists tools and creates an agent inbox with a workspace key", async () => {
    const mcp = await connect(wsKey);
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "add_dashboard_widget",
      "add_thread_comment",
      "add_to_epic",
      "add_to_sprint",
      "append_to_doc",
      "assign_thread",
      "bulk_update_tasks",
      "cancel_scheduled",
      "comment_on_task",
      "complete_sprint",
      "contact_timeline",
      "create_action_items",
      "create_agent_inbox",
      "create_custom_field",
      "create_dashboard",
      "create_doc",
      "create_form",
      "create_formula_field",
      "create_goal",
      "create_incoming_hook",
      "create_rollup_field",
      "create_saved_view",
      "create_snippet",
      "create_sprint",
      "create_task",
      "create_template",
      "create_triage_item",
      "delete_saved_view",
      "delete_thread_comment",
      "enable_automation_recipe",
      "find_tasks_by_field",
      "get_backlinks",
      "get_call_status",
      "get_computed_fields",
      "get_dashboard_data",
      "get_doc_tree",
      "get_epic",
      "get_meeting_notes",
      "get_meeting_transcript",
      "get_portfolio",
      "get_reply_stats",
      "get_report",
      "get_sprint",
      "get_task",
      "get_thread_presence",
      "get_timesheet",
      "get_workload",
      "invite_guest",
      "list_automation_recipes",
      "list_calendar_events",
      "list_channels",
      "list_custom_fields",
      "list_dashboards",
      "list_epics",
      "list_forms",
      "list_goals",
      "list_guests",
      "list_inboxes",
      "list_integrations",
      "list_meetings",
      "list_notifications",
      "list_people",
      "list_projects",
      "list_saved_views",
      "list_scheduled",
      "list_snippets",
      "list_sprints",
      "list_tasks",
      "list_templates",
      "list_thread_comments",
      "list_thread_drafts",
      "list_threads",
      "list_threads_by_view",
      "list_triage",
      "log_time",
      "message_to_task",
      "move_doc",
      "my_work",
      "next_task",
      "pin_message",
      "post_message",
      "react_to_chat_message",
      "read_channel",
      "read_chat_thread",
      "read_doc",
      "read_thread",
      "remove_from_sprint",
      "render_snippet",
      "reply",
      "schedule_meeting",
      "schedule_send",
      "search",
      "search_contacts",
      "search_docs",
      "search_everything",
      "send_email",
      "set_mailbox_reply_to",
      "set_project_health",
      "set_task_blocked_by",
      "set_task_fields",
      "set_task_repeat",
      "set_thread_status",
      "set_weekly_capacity",
      "snooze_thread",
      "start_sprint",
      "start_timer",
      "stop_timer",
      "take_over_draft",
      "triage_accept",
      "triage_decline",
      "triage_merge",
      "unassign_thread",
      "update_auth_email_hook",
      "update_key_result",
      "update_task",
      "upsert_contact",
      "use_template",
      "wait_for_email",
    ]);
    const made = data(await mcp.callTool({ name: "create_agent_inbox", arguments: { name: "Research bot", localPart: "research" } }));
    expect(made.agent.address).toBe("research@acme.io");
    expect(made.apiKey.secret).toMatch(/^mm_live_/);
    const inboxes = data(await mcp.callTool({ name: "list_inboxes", arguments: {} }));
    expect(inboxes.agents.map((a: { address: string }) => a.address)).toEqual(["research@acme.io"]);
    // Sending needs an agent.
    const noAgent = await mcp.callTool({ name: "send_email", arguments: { to: ["x@example.com"], subject: "Hi", text: "Hi" } });
    expect(noAgent.isError).toBe(true);
    await mcp.close();
  });

  it("acts as one agent with an agent key: reads, searches, waits for mail and replies for approval", async () => {
    const { agent, apiKey } = (await c.post("/api/agents", { name: "Signup bot", localPart: "signups" })).body;
    await c.post("/api/developer/keys", { name: "spare" });
    const mcp = await connect(apiKey.secret);
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("create_agent_inbox");
    const waiting = mcp.callTool({ name: "wait_for_email", arguments: { timeoutSeconds: 10 } });
    await new Promise((r) => setTimeout(r, 300));
    await deliverInbound(ctx.deps, {
      envelopeFrom: "no-reply@service.example", rcptTo: agent.address, sizeBytes: 300, via: "test",
      email: { messageId: "<code-1@service.example>", from: { address: "no-reply@service.example", name: "Service" }, to: [{ address: agent.address }], cc: [], subject: "Your code", text: "Your code is 731904.", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const got = data(await waiting);
    expect(got.messages[0]).toMatchObject({ subject: "Your code", codes: ["731904"] });
    const threads = data(await mcp.callTool({ name: "list_threads", arguments: {} }));
    expect(threads.data).toHaveLength(1);
    const thread = data(await mcp.callTool({ name: "read_thread", arguments: { threadId: threads.data[0].id } }));
    expect(thread.messages[0].latestText).toBe("Your code is 731904.");
    const found = data(await mcp.callTool({ name: "search", arguments: { query: "731904" } }));
    expect(found.results).toHaveLength(1);
    const replied = data(await mcp.callTool({ name: "reply", arguments: { threadId: threads.data[0].id, text: "Thanks." } }));
    expect(replied.status).toBe("pending_approval");
    // Another agent's id is refused.
    const other = await mcp.callTool({ name: "send_email", arguments: { agentId: "agt_someoneelse", to: ["x@example.com"], subject: "s", text: "t" } });
    expect(other.isError).toBe(true);
    // The reads were logged as MCP reads by the agent.
    const audit = (await c.get(`/api/agents/${agent.id}/audit`)).body.entries;
    expect(audit.find((e: { action: string }) => e.action === "agent.message_read").metadata).toMatchObject({ via: "mcp" });
    await mcp.close();
  });

  it("refuses without a key, and refuses writes with a read-only key", async () => {
    const res = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const mcp = await connect(ro);
    const r = await mcp.callTool({ name: "create_agent_inbox", arguments: { name: "Nope" } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toContain("read_only_key");
    await mcp.close();
  });
});
