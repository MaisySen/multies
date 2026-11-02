import { m3Route, sampleM3 } from "./m3";
import { SAMPLE_NAV_MENU } from "./nav-menu";
import { dealsRoute, sampleDeals } from "./deals";
import { expensesRoute, sampleExpenses } from "./expenses";
import type { Method, RequestOptions, Transport } from "@/api/transport";
import { sampleJob, sampleToolsInfo } from "./tools";
import { ApiError } from "@/api/errors";
import { m1WorkRoute, sampleM1Work } from "./m1-work";
import type { Approval, Message, SendInput } from "@/api/types";
import { sampleData } from "./fixtures";
import { taskRoute } from "./tasks";
import { extrasRoute, sampleExtras, taskTime } from "./time-meetings";
import { samplePortfolio } from "./fields";
import { samplePeople } from "./people";
import { chatRoute, sampleChat, samplePersonName } from "./chat";
import { emailRoute, sampleEmail } from "./email";
import { runsRoute, sampleRuns } from "./runs";
import { sampleSocial, socialRoute } from "./social";
import { mailExtrasRoute, sampleListExtras, sampleMailExtras, sampleSnooze } from "./mail-r85";
import { snoozeUntil, type SnoozePreset } from "@/lib/snooze";
import { driveRoute, sampleDrive } from "./drive";
import { docsRoute, sampleDocs } from "./docs"; // M1

/**
 * The sample workspace runs entirely on the device with no server. It answers the same paths the
 * live API does, so every screen works the same way in the browser preview, tests and screenshots.
 */
export class SampleTransport implements Transport {
  readonly kind = "sample" as const;
  private data = sampleData();
  private extras = sampleExtras(Date.now(), this.data.work, this.data.messages);
  private seq = 100;
  private chat = sampleChat(Date.now(), this.data.work, this.data.messages);
  private email = sampleEmail(Date.now());
  private runs = sampleRuns(Date.now(), this.data.work);
  private social = sampleSocial(Date.now());
  private docs = sampleDocs(Date.now()); // M1
  private mail = sampleMailExtras(Date.now(), this.data.messages);
  /** M1: the drive (Files). */
  private drive = sampleDrive(Date.now());
  private dealStore = { deals: sampleDeals() };
  private m3 = sampleM3(Date.now());
  private expenseStore = { items: sampleExpenses(), seq: 1 };
  /** R35: report and block in the sample workspace, kept in memory only. */
  private blocks: { userId: string; name: string; avatarUrl: string | null; createdAt: string }[] = [];
  private reports = 0;
  /** M1 (1.10.9): Contacts, Maps, Mail merge, Mail archive and Sync. */
  private m1work = sampleM1Work(Date.now());
  private toolRuns = 3;

  constructor(private latencyMs = 0) {}

  reset() {
    this.data = sampleData();
    this.extras = sampleExtras(Date.now(), this.data.work, this.data.messages);
    this.chat = sampleChat(Date.now(), this.data.work, this.data.messages);
    this.email = sampleEmail(Date.now());
    this.runs = sampleRuns(Date.now(), this.data.work);
    this.social = sampleSocial(Date.now());
    this.docs = sampleDocs(Date.now()); // M1
    this.m1work = sampleM1Work(Date.now());
    this.mail = sampleMailExtras(Date.now(), this.data.messages);
    this.drive = sampleDrive(Date.now());
    this.dealStore = { deals: sampleDeals() };
    this.m3 = sampleM3(Date.now());
    this.expenseStore = { items: sampleExpenses(), seq: 1 };
    this.blocks = [];
    this.reports = 0;
  }

  async request<T>(method: Method, rawPath: string, body?: unknown, _opts?: RequestOptions): Promise<T> {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const [path, qs = ""] = rawPath.split("?");
    const params = Object.fromEntries(qs.split("&").filter(Boolean).map((p) => p.split("=").map(decodeURIComponent)));
    const d = this.data;
    const parts = path.split("/").filter(Boolean);

    const isId = (p: string) => ["msg_", "apr_", "agt_", "thr_"].some((prefix) => p.startsWith(prefix));
    const route = `${method} /${parts.map((p, i) => (i > 0 && isId(p) ? ":id" : p)).join("/")}`;
    const id = parts.find((p, i) => i > 0 && isId(p)) ?? "";
    const json = <R>(v: R) => structuredCloneSafe(v) as unknown as T;

    // M2: the web menu (R121) for the More grid.
    if (method === "GET" && path === "/nav/menu") return json(SAMPLE_NAV_MENU);
    // M3: goals, forms, time and automations.
    const m3 = m3Route(this.m3, method, path, body, params);
    if (m3 !== undefined) return json(m3);
    // M2: deals.
    const deal = dealsRoute(this.dealStore, method, path, body);
    if (deal !== undefined) return json(deal);
    const exp = expensesRoute(this.expenseStore, method, path, params, body);
    if (exp !== undefined) return json(exp);
    // M1: the drive (Files).
    if (path.startsWith("/drive/")) return json(driveRoute(this.drive, method, rawPath, body));
    // M1: global search, Docs, comments and share links.
    const docs = docsRoute(this.docs, this.data.messages, method, path, params, body, Date.now());
    if (docs !== undefined) return json(docs);

    // 1.10.5: social posts and accounts.
    const social = socialRoute(this.social, method, path.startsWith("/social/inbox") ? rawPath : path, body, Date.now());
    if (social !== undefined) return json(social);

    // 1.10.7: Inbox tabs, labels, snoozed mail and mail rules.
    const extras = mailExtrasRoute(this.mail, this.data.messages, method, path, params, body, Date.now());
    if (extras !== undefined) return json(extras);

    // Tools: the catalogue and runs that finish at once (no file is made in the sample workspace).
    if (path === "/tools" && method === "GET") return json(sampleToolsInfo(this.toolRuns));
    if (path === "/tools/jobs/from-attachments" && method === "POST") {
      const b = (body ?? {}) as { op?: string; name?: string };
      this.toolRuns += 1;
      return json(sampleJob(b.op ?? "compress", `sample.${b.op ?? "compress"}.${this.toolRuns}`, b.name ?? "Sample", false));
    }
    if (path === "/tools/warm" && method === "GET") return json({ ok: true, ms: 0 });
    if (path.startsWith("/tools/jobs/") && method === "DELETE") {
      const [, op = "compress"] = decodeURIComponent(parts[2] ?? "").split(".");
      return json({ token: parts[2] ?? "", op, status: "cancelled", name: "Sample" });
    }
    if (path.startsWith("/tools/jobs/") && method === "GET") {
      const [, op = "compress"] = decodeURIComponent(parts[2] ?? "").split(".");
      return json(sampleJob(op, parts[2] ?? "", "Quarterly report", true));
    }

    // R35: report and block, the same shapes as the server.
    if (path === "/reports" && method === "POST") {
      const b = (body ?? {}) as { reason?: string };
      if (!b.reason) throw new ApiError(400, "invalid", "Pick a reason.");
      return json({ id: `rep_s${++this.reports}`, status: "open" });
    }
    if (path === "/blocks" && method === "GET") return json({ blocks: this.blocks });
    if (path === "/blocks" && method === "POST") {
      const userId = String((body as { userId?: string } | undefined)?.userId ?? "");
      if (!userId || userId === "usr_sample") throw new ApiError(400, "invalid", "You can't block yourself.");
      if (!this.blocks.some((x) => x.userId === userId)) {
        const name = samplePersonName(userId) ?? "Someone";
        this.blocks.unshift({ userId, name, avatarUrl: null, createdAt: new Date().toISOString() });
      }
      return json({ ok: true });
    }
    if (parts[0] === "blocks" && parts.length === 2 && method === "DELETE") {
      this.blocks = this.blocks.filter((x) => x.userId !== decodeURIComponent(parts[1]));
      return json({ ok: true });
    }
    const m1 = m1WorkRoute(this.m1work, method, path, params, body, Date.now());
    if (m1 !== undefined) return json(m1);
    if (method === "GET" && path === "/portfolio") return json(samplePortfolio(d.work, this.extras, Date.now()));
    if (method === "GET" && path === "/team/people") return json(samplePeople(Date.now()));
    const mail = emailRoute(this.email, d.mailboxes, method, parts, body, Date.now(), params);
    if (mail !== undefined) return json(mail);
    const talk = chatRoute(this.chat, d.work, d.messages, method, parts, params, body);
    if (talk !== undefined) return json(talk);
    const extra = extrasRoute(this.extras, d.work, method, parts, params, body);
    if (extra !== undefined) return json(extra);
    const run = runsRoute(this.runs, d.work, method, parts, params);
    if (run !== undefined) return json(run);
    const work = taskRoute(d.work, d.messages, method, parts, params, body);
    if (work !== undefined) {
      // GET /tasks/:id also carries the task's time and its dependencies, as the server does.
      if (method === "GET" && parts[0] === "tasks" && parts.length === 2 && work && typeof work === "object" && "task" in work) {
        const id = (work as { task: { id: string } }).task.id;
        return json({ ...work, time: taskTime(this.extras, id, Date.now()), blockedBy: [], blocking: [] });
      }
      return json(work);
    }

    if (method === "POST" && parts[0] === "account" && parts[1] === "workspaces" && parts[3] === "switch") {
      return d.me.organization && parts[2] === d.me.organization.id ? json({ ok: true, workspace: { id: d.me.organization.id, name: d.me.organization.name } }) : (() => { throw new ApiError(404, "not_found", "Workspace not found."); })();
    }
    switch (route) {
      case "POST /auth/sign-out": return json({ success: true });
      case "GET /account/me": return json(d.me);
      // Multiws: the sample person is in one workspace; switching to it is a no op.
      case "GET /account/workspaces": return json({ workspaces: d.me.organization ? [{ id: d.me.organization.id, name: d.me.organization.name, plan: d.me.organization.plan, role: d.me.organization.role, isDemo: true }] : [] });
      case "GET /mail/overview": return json({ mailboxes: d.mailboxes });
      case "GET /agents": return json({ agents: d.agents });
      case "GET /mail/messages": {
        const folder = params.folder || "inbox";
        const search = (params.q || "").toLowerCase();
        let list = d.messages.filter((m) => (folder === "starred" ? m.isStarred : m.folder === folder));
        if (search) {
          list = d.messages.filter((m) => [m.subject, m.text, m.from.address, m.from.name ?? ""].join(" ").toLowerCase().includes(search));
        }
        list = sampleListExtras(this.mail, [...list].sort((a, b) => b.date.localeCompare(a.date)), { ...params, folder });
        return json({ messages: list.map(({ text: _t, cc: _c, bcc: _b, html: _h, attachments: _a, replyTo: _r, ...rest }) => rest), nextCursor: null });
      }
      case "GET /mail/messages/:id": {
        const m = d.messages.find((x) => x.id === id);
        if (!m) throw new ApiError(404, "not_found", "Message not found.");
        d.messages.filter((x) => x.threadId === m.threadId).forEach((x) => { x.isRead = true; });
        const thread = d.messages.filter((x) => x.threadId === m.threadId).sort((a, b) => a.date.localeCompare(b.date));
        return json({ message: m, thread });
      }
      case "PATCH /mail/messages/:id": {
        const m = d.messages.find((x) => x.id === id);
        if (!m) throw new ApiError(404, "not_found", "Message not found.");
        Object.assign(m, body as Partial<Message>);
        return json({ ok: true });
      }
      case "POST /mail-schedules/snooze": {
        // R31: the conversation leaves the inbox until the time (the sample keeps it in Archive).
        const b = (body ?? {}) as { messageId?: string };
        const m = d.messages.find((x) => x.id === b.messageId);
        if (!m) throw new ApiError(404, "not_found", "Message not found.");
        d.messages.filter((x) => x.threadId === m.threadId).forEach((x) => { if (x.folder === "inbox") x.folder = "archive"; });
        sampleSnooze(this.mail, m, snoozeUntil(((body ?? {}) as { preset?: SnoozePreset }).preset ?? "tomorrow").toISOString());
        return json({ ok: true });
      }
      case "DELETE /mail/messages/:id": {
        const m = d.messages.find((x) => x.id === id);
        if (m) m.folder = "trash";
        return json({ ok: true });
      }
      case "POST /mail/send": {
        const input = body as SendInput;
        if (!input.to?.length) throw new ApiError(400, "bad_request", "Add a recipient.");
        const mb = d.mailboxes.find((x) => x.id === input.mailboxId) ?? d.mailboxes[0];
        const parent = input.inReplyToId ? d.messages.find((x) => x.id === input.inReplyToId) : undefined;
        const messageId = `msg_s${this.seq++}`;
        d.messages.push({
          id: messageId, threadId: parent?.threadId ?? `thr_s${this.seq}`, mailboxId: mb.id, folder: "sent",
          from: { address: mb.address, name: mb.displayName }, to: input.to.map((address) => ({ address })), cc: (input.cc ?? []).map((address) => ({ address })), bcc: [],
          subject: input.subject, text: input.text, snippet: input.text.slice(0, 120), html: null, replyTo: null, attachments: [],
          date: new Date().toISOString(), isRead: true, isStarred: false, hasAttachments: false, sentByAgentId: null,
        });
        return json({ messageId, status: "sent" });
      }
      case "GET /approvals": {
        const list = params.status ? d.approvals.filter((a) => a.status === params.status) : d.approvals;
        return json({ approvals: [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
      }
      case "POST /approvals/:id/approve":
      case "POST /approvals/:id/reject": {
        const a = d.approvals.find((x) => x.id === id);
        if (!a) throw new ApiError(404, "not_found", "Approval not found.");
        if (a.status !== "pending") throw new ApiError(409, "conflict", "Someone already decided this one.");
        const approve = route.endsWith("approve");
        const edits = (body ?? {}) as { subject?: string; text?: string; note?: string };
        Object.assign(a, approve ? { status: "sent", subject: edits.subject ?? a.subject, text: edits.text ?? a.text, messageId: `msg_s${this.seq++}` } : { status: "rejected", note: edits.note ?? null },
          { decidedBy: d.me.user.email, decidedAt: new Date().toISOString() } satisfies Partial<Approval>);
        const agent = d.agents.find((x) => x.id === a.agentId);
        if (agent) agent.pendingApprovals = Math.max(0, agent.pendingApprovals - 1);
        return json({ approval: a });
      }
      default:
        throw new ApiError(404, "not_found", `The sample workspace doesn't cover ${method} ${path}.`);
    }
  }
}

function structuredCloneSafe<V>(v: V): V { return JSON.parse(JSON.stringify(v)) as V; }
