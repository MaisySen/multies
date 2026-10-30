/**
 * R37: captures REAL example results for the MCP tool docs. Runs every listed tool against the local
 * test server with seed data (example names only), cleans the answers (random ids made stable, secrets
 * masked, long lists cut to 3) and writes src/server/services/developer/mcp-examples.generated.json.
 * Skipped in the normal suite; run it with:
 *   CAPTURE_MCP_EXAMPLES=1 npx vitest run tests/capture-mcp-examples-r37.test.ts
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";

const OUT = path.join(__dirname, "../src/server/services/developer/mcp-examples.generated.json");
type Args = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose bag of ids handed between steps
type S = Record<string, any>;
// Tool, arguments (from what earlier steps returned), and what to keep from the answer for later steps.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool answers its own shape
const STEPS: [string, (s: S) => Args, ((r: any, s: S) => void)?][] = [
  ["create_agent_inbox", () => ({ name: "Support agent", localPart: "support", approvalMode: "external" }), (r, s) => { s.agentId = r.agent.id; s.agentAddr = r.agent.address; }],
  ["list_inboxes", () => ({})],
  ["list_threads", () => ({ limit: 3 }), (r, s) => { s.threadId = (r.data ?? r.threads)[0]?.id; }],
  ["read_thread", (s) => ({ threadId: s.threadId })],
  ["search", () => ({ query: "invoice", limit: 3 })],
  ["search_everything", () => ({ q: "invoice", limit: 3 })],
  ["send_email", (s) => ({ agentId: s.agentId, to: ["ada@example.com"], subject: "Your invoice 1042", text: "Hi Ada, here is invoice 1042. Thanks, Sam" })],
  ["reply", (s) => ({ threadId: s.threadId, agentId: s.agentId, text: "Thanks Ada, the invoice is on its way." })],
  ["set_thread_status", (s) => ({ threadId: s.threadId, status: "waiting" })],
  ["assign_thread", (s) => ({ threadId: s.threadId, userId: s.userId })],
  ["add_thread_comment", (s) => ({ threadId: s.threadId, body: "I'll take this one, the PDF is ready." })],
  ["list_thread_comments", (s) => ({ threadId: s.threadId })],
  ["snooze_thread", (s) => ({ threadId: s.threadId, preset: "tomorrow" })],
  ["list_scheduled", () => ({ view: "snoozed" })],
  ["create_snippet", () => ({ name: "Invoice sent", body: "Hi {{first_name}}, your invoice is attached. Thanks!", shortcut: "inv", shared: true }), (r, s) => { s.snippetId = r.snippet?.id ?? r.id; }],
  ["list_snippets", () => ({})],
  ["render_snippet", (s) => ({ snippetId: s.snippetId, threadId: s.threadId })],
  ["schedule_send", (s) => ({ agentId: s.agentId, to: ["ada@example.com"], subject: "Friendly reminder", text: "Hi Ada, a quick reminder about invoice 1042.", preset: "tomorrow" })],
  ["upsert_contact", () => ({ email: "ada@example.com", name: "Ada Lovelace", title: "Head of Finance" }), (r, s) => { s.contactId = r.contact?.id ?? r.id; }],
  ["search_contacts", () => ({ q: "ada", limit: 3 })],
  ["contact_timeline", (s) => ({ id: s.contactId })],
  ["create_task", (s) => ({ title: "Follow up with Ada about invoice 1042", notes: "She asked for a PDF copy.", priority: "high", due: "2026-11-03", labels: ["billing"], ...(s.projectId ? { projectId: s.projectId } : {}) }), (r, s) => { s.taskId = r.task.id; s.taskRef = r.task.ref ?? r.task.id; s.projectId ??= r.task.projectId; }],
  ["list_projects", () => ({})],
  ["create_task", (s) => ({ title: "Send the November statements", priority: "medium", ...(s.projectId ? { projectId: s.projectId } : {}) }), (r, s) => { s.task2 = r.task.id; }],
  ["list_tasks", () => ({ limit: 3 })],
  ["get_task", (s) => ({ id: s.taskRef })],
  ["update_task", (s) => ({ id: s.taskRef, status: "doing", assignee: `member:${s.userId}` })],
  ["comment_on_task", (s) => ({ id: s.taskRef, body: "Sent the PDF, waiting on Ada." })],
  ["list_task_comments", (s) => ({ taskId: s.taskId })],
  ["add_checklist_items", (s) => ({ taskId: s.taskId, items: [{ title: "Export the PDF" }, { title: "Email it to Ada" }] })],
  ["list_checklist", (s) => ({ taskId: s.taskId })],
  ["watch_task", (s) => ({ taskId: s.taskId })],
  ["set_task_blocked_by", (s) => ({ taskId: s.task2, blockedBy: s.taskId })],
  ["search_tasks", () => ({ q: "invoice", limit: 3 })],
  ["duplicate_task", (s) => ({ taskId: s.taskId, title: "Follow up with Grace about invoice 1043" })],
  ["log_time", (s) => ({ taskId: s.taskId, minutes: 25, date: "2026-11-02", note: "Prepared the PDF", billable: true })],
  ["get_timesheet", () => ({ from: "2026-10-27", to: "2026-11-03" })],
  ["my_work", () => ({ timeZone: "Australia/Sydney" })],
  ["get_counts", () => ({ tz: "Australia/Sydney" })],
  ["list_people", () => ({})],
  ["create_goal", () => ({ name: "Get paid faster", description: "Cut the average days to payment.", due: "2026-12-31", keyResults: [{ name: "Average days to payment", kind: "number", start: 30, target: 14, current: 21 }] })],
  ["list_goals", () => ({})],
  ["get_report", () => ({ days: 30 })],
  ["list_channels", () => ({}), (r, s) => { s.channelId = (r.channels ?? r.data ?? [])[0]?.id; }],
  ["post_message", (s) => ({ channelId: s.channelId, body: "Standup: invoices sent, 2 follow ups today, nothing blocked." }), (r, s) => { s.messageId = r.message?.id ?? r.id; }],
  ["read_channel", (s) => ({ channelId: s.channelId, limit: 3 })],
  ["react_to_chat_message", (s) => ({ messageId: s.messageId, emoji: "👍" })],
  ["pin_message", (s) => ({ messageId: s.messageId, pinned: true })],
  ["message_to_task", (s) => ({ messageId: s.messageId, title: "Check the 2 invoice follow ups" })],
  ["create_doc", () => ({ title: "Billing playbook", text: "# Billing playbook\n\nSend invoices on the 1st. Follow up after 7 days." }), (r, s) => { s.docId = r.doc?.id ?? r.id; }],
  ["append_to_doc", (s) => ({ id: s.docId, text: "Escalate to the account owner after 14 days." })],
  ["read_doc", (s) => ({ id: s.docId })],
  ["search_docs", () => ({ q: "billing" })],
  ["get_doc_tree", () => ({ flat: true })],
  ["create_form", () => ({ name: "Billing question", description: "Ask us anything about your invoice.", target: "task", fields: [{ label: "Email", type: "email", required: true }, { label: "Question", type: "textarea", required: true }] })],
  ["list_forms", () => ({})],
  ["schedule_meeting", () => ({ title: "Invoice review with Ada", startsAt: "2026-11-04T23:00:00.000Z", durationMin: 30, invitees: ["ada@example.com"], sendInvites: false })],
  ["list_meetings", () => ({ upcoming: true })],
  ["list_calendar_events", () => ({ from: "2026-11-01", to: "2026-11-08" })],
  ["create_sprint", (s) => ({ projectId: s.projectId, name: "Sprint 12", goal: "Close every open invoice", startAt: "2026-11-02", endAt: "2026-11-15" })],
  ["list_sprints", (s) => ({ projectId: s.projectId })],
  ["create_dashboard", () => ({ name: "Billing", starter: "team" })],
  ["list_dashboards", () => ({})],
  ["list_templates", () => ({})],
  ["list_notifications", () => ({ unread: true })],
  ["catchup_get", (s) => ({ type: "task", id: s.taskId })],
];

// ---------------------------------------------------------------- cleaning

const ID_RE = /\b([a-z]{2,6})_([0-9a-z]{10,32})\b/g;
function cleaner() {
  const seen = new Map<string, string>();
  const stable = (prefix: string, raw: string) => {
    const k = `${prefix}_${raw}`;
    if (!seen.has(k)) seen.set(k, `${prefix}_${(0x1a2b3c4d + seen.size * 0x1f3d5).toString(36).padStart(8, "0").slice(-8)}`);
    return seen.get(k)!;
  };
  const clean = (v: unknown, key = ""): unknown => {
    if (typeof v === "string") {
      if (/secret|token|password/i.test(key) && v) return "(shown once, hidden here)";
      return v.replace(/mm_live_[A-Za-z0-9_-]+/g, "mm_live_(hidden)").replace(ID_RE, (_m, p, r) => stable(p, r)).replace(/https?:\/\/localhost(:\d+)?/g, "https://multies.si");
    }
    if (Array.isArray(v)) { const out = v.slice(0, 3).map((x) => clean(x, key)); return v.length > 3 ? [...out] : out; }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, k)]));
    return v;
  };
  return clean;
}

describe.skipIf(!process.env.CAPTURE_MCP_EXAMPLES)("capture MCP example results (R37)", () => {
  it("runs each tool and writes the examples file", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("sam@acme.io", "Sam Rivera");
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const { body } = await c.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await c.post(`/api/domains/${domainId}/verify`);
    const key = (await c.post("/api/developer/keys", { name: "Docs examples" })).body.secret;
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "docs", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const meBody = (await c.get("/api/account/me")).body;
    const s: S = { userId: meBody?.user?.id ?? meBody?.id };
    const clean = cleaner();
    const out: Record<string, { arguments: Args; result: unknown }> = {};
    const failed: string[] = [];
    let mailed = false;
    for (const [name, argsOf, keep] of STEPS) {
      if (name === "list_threads" && !mailed) {
        mailed = true;
        await deliverInbound(ctx.deps, {
          envelopeFrom: "ada@example.com", rcptTo: s.agentAddr, sizeBytes: 400, via: "test",
          email: { messageId: "<inv-1042@example.com>", from: { address: "ada@example.com", name: "Ada Lovelace" }, to: [{ address: s.agentAddr }], cc: [], subject: "Invoice 1042", text: "Hi, could you send invoice 1042 as a PDF? Thanks, Ada", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
        });
      }
      const args = argsOf(s);
      try {
        const r = await mcp.callTool({ name, arguments: args });
        const text = (r.content as { text: string }[])[0]?.text ?? "";
        if (r.isError) { failed.push(`${name}: ${text.slice(0, 160)}`); continue; }
        const result = JSON.parse(text);
        keep?.(result, s);
        if (!out[name]) out[name] = { arguments: clean(args) as Args, result: clean(result) };
      } catch (err) { failed.push(`${name}: ${(err as Error).message.slice(0, 160)}`); }
    }
    await mcp.close();
    const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(OUT, `${JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), note: "Real answers from a local Multies server with example seed data. Ids are made stable, secrets hidden, lists cut to 3.", examples: sorted }, null, 2)}\n`);
    console.log(`captured ${Object.keys(out).length}; failed ${failed.length}\n${failed.join("\n")}`);
    expect(Object.keys(out).length).toBeGreaterThanOrEqual(40);
  }, 120_000);
});
