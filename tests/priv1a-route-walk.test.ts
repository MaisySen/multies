import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { privacyWorld } from "./priv1a-world";
import { changed, norm, patState, richBody, sample, type Ids, type W } from "./priv1a-walk-kit";
import { v1Routes } from "@/server/routes/v1";
import { r10Routes } from "@/server/routes/suite-r10";
import type { LogOutbound } from "@/server/services/mail/outbound";
import type { Client } from "./helpers";

// PRIV1a (MB-366): the route walk. Pat's personal (connected) mailbox must not reach anyone but Pat and the people
// Pat shared it with. The workspace's OWNER, an ADMIN and another workspace's person walk EVERY API route the app
// registers (enumerated from the router, never a hand list): list routes must not carry any of the mailbox's ids
// or words, and every route that takes an id, given the mailbox's message, thread or attachment id, must refuse
// (403/404, never 2xx or 5xx). A new route that forgets the mailbox rule fails here.
//
// PRIV1b (F24 to F27, F30): the walk now reaches the rule, not the validator. Each id parameter gets the id its name
// asks for (mailbox, thread, message, attachment, draft, connection; a user parameter gets the walker's own id), and
// each body is one that passes the route's own zod schema (captured from parseBody on a first 422 and filled by
// `sample`) with Pat's ids in it. Routes with no path parameter that take mail ids in the body (send, drafts, bulk,
// labels, snooze, tasks from email, v1 messages) are called too. A 2xx counts as a leak when its body differs from the
// same call with an id that does not exist (so it carries data about Pat's mail), and any write to a row of Pat's mail
// fails the walk whatever the route answered. Pat's read delegate walks every write: a read share changes nothing.
// The flag gated surfaces PRIV1a changed are on, and the walk counts the routes that answered, not just the calls.

const schemaSeen: { last: unknown } = { last: null };
vi.mock("@/server/middleware", async (orig) => {
  const real = await orig<typeof import("@/server/middleware")>();
  return { ...real, parseBody: async (c: never, schema: never) => { try { return await real.parseBody(c, schema); } catch (e) { schemaSeen.last = schema; throw e; } } };
});

async function within<T extends { status: number; body: unknown }>(p: Promise<T>): Promise<{ status: number; body: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ status: number; body: unknown }>((resolve) => { timer = setTimeout(() => resolve({ status: 0, body: null }), 2000); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

/** The walk makes thousands of calls a minute: no request limits for it (they are tested elsewhere). */
function noLimits(w: { ctx: { deps: { rateLimiters?: unknown } } }) {
  const ok = { limit: async () => ({ success: true }) };
  w.ctx.deps.rateLimiters = new Proxy({}, { get: () => ok });
}

const SKIP = /\/api\/(auth|webhooks|inbound|import-runner|guest)\b|\/api\/v1\/mcp|\/events$|\/stream$|\/ws$/;
/** Routes with no path parameter whose body names mail (the rest act on the walker's own things). */
const MAILISH = /mail|thread|message|draft|label|snooze|remind|schedule|tasks\/from|doc-inbox|archive|data-moves|bulk|connections|mailboxes|inbox|ai\/|ask|search|send|agents|approvals|sign/;
/** Writes that end the walker's own session or workspace, never Pat's mail. */
const SELF = /\/(leave|sign-out|logout|delete-account)$|\/api\/account$|\/api\/org$/;
/**
 * Left out on purpose, by name: an owner or admin deleting or disconnecting a colleague's personal mailbox is P59 (a
 * product decision still open: "management by design, but destruction needs a decision"). The walk would also lose
 * Pat's mailbox for every route after it. Remove these lines once P59 is decided.
 */
const DESIGN = new Set(["DELETE /api/mailboxes/:id", "DELETE /api/v1/mailboxes/:id", "DELETE /api/connections/:id", "DELETE /api/v1/connections/:id"]);

/** Valid bodies for the routes that check their body without parseBody (the v1 OpenAPI routes), so no schema is captured. */
const BODIES: Record<string, (ids: Ids) => unknown> = {
  "POST /api/v1/mail/messages/bulk": (ids) => ({ ids: [ids.message], action: "trash" }),
  "POST /api/v1/mail/bulk-jobs": (ids) => ({ client_job_id: "walkjob0001", action: "trash", scope: { mailboxId: ids.mailbox }, max_received_at: new Date(Date.now() + 86_400_000).toISOString() }),
  "POST /api/v1/threads/:id/status": () => ({ status: "done" }),
  "PATCH /api/v1/threads/:id": () => ({ status: "done" }),
  "PATCH /api/v1/mailboxes/:id": () => ({ displayName: "walk", replyTo: "walk@example.com" }),
  "PATCH /api/mailboxes/:id": () => ({ displayName: "walk", replyTo: "walk@example.com" }),
  "POST /api/mail/rules": (ids) => ({ name: "walk", mailboxId: ids.mailbox, conditions: [{ field: "subject", value: "walk" }], actions: [{ kind: "create_task" }, { kind: "forward", to: "walk@example.com" }] }),
  "POST /api/mail/rules/test": (ids) => ({ mailboxId: ids.mailbox, match: "any", conditions: [{ field: "subject", value: "SUBJECT" }] }),
  "PATCH /api/v1/agents/:id": (ids) => ({ status: "active", mailboxIds: [ids.mailbox] }),
  "PUT /api/v1/auth-email-settings": (ids) => ({ from: ids.address, supabaseUrl: "https://walk.example.com" }),
  // PRIV1b (W1): the v1 hook create checks its secret before the sender, so a bad body answered 400 and never reached it.
  "POST /api/v1/auth-email-hooks": (ids) => ({ from: ids.address, secret: `v1,whsec_${"A".repeat(32)}`, supabaseUrl: "https://walk.example.com" }),
  "POST /api/v1/messages": (ids) => ({ mailboxId: ids.mailbox, to: ["walk@example.com"], subject: "walk", text: "walk" }),
};

/** The route ran (not missing, not behind an off flag, not stuck in validation): a refusal from the rule counts. */
const reached = (res: { status: number; body: unknown }) => res.status !== 0 && res.status !== 422 && !(res.status === 404 && /No such endpoint|Page not found/.test(txt(res.body)));

/** The text of an answer. */
const txt = (b: unknown) => (typeof b === "string" ? b : JSON.stringify(b ?? ""));

/** Which of Pat's ids a path parameter takes, from its name and the segment before it. */
function idsForParam(path: string, p: string, ids: Ids): string[] {
  const seg = path.split("/")[path.split("/").indexOf(p) - 1] ?? "";
  const name = p.slice(1).toLowerCase();
  if (/user|member|delegate/.test(name)) return [ids.user];
  if (/mailbox/.test(name) || seg === "mailboxes") return [ids.mailbox];
  if (/connection/.test(name) || seg === "connections") return [ids.connection];
  if (/attachment/.test(name) || seg === "attachments") return [ids.attachment];
  if (/draft/.test(name) || seg === "drafts") return [ids.draft, ids.message];
  if (/thread/.test(name) || seg === "threads") return [ids.thread];
  if (/message/.test(name) || seg === "messages") return [ids.message];
  return [ids.message, ids.thread, ids.mailbox, ids.attachment];
}

/** The same shape of id, for nothing. */
const ghost = (id: string) => id.replace(/_(.*)$/, (_, rest: string) => `_${"z".repeat(rest.length)}`);

async function walkWorld() {
  const w = await privacyWorld({ real: true });
  noLimits(w);
  const r = w.real!;
  // Pat uses the mailbox a little, so list routes have something to leak: a label, a star, a draft, a private comment.
  await w.pat.c.get(`/api/mail/messages/${w.msgs.personal}`);
  await w.pat.c.post("/api/mail/labels", { threadId: w.thread, label: `LABEL-PERS-${w.n}` });
  await w.pat.c.patch(`/api/mail/messages/${w.msgs.personal}`, { isStarred: true });
  const draft = await w.pat.c.post("/api/mail/drafts", { mailboxId: w.boxes.personal, to: ["friend@example.com"], subject: `DRAFTSUBJ-${w.n}`, text: `DRAFTBODY-${w.n}` });
  expect(draft.status).toBeLessThan(300);
  const draftId = (draft.body.message?.id ?? draft.body.draft?.id ?? draft.body.id) as string;
  expect(draftId).toBeTruthy();
  const comment = await w.pat.c.post(`/api/threads/${w.thread}/comments`, { body: `COMMENTWORD-${w.n}`, text: `COMMENTWORD-${w.n}` });
  expect(comment.status).toBeLessThan(300);
  const ids: Ids = { mailbox: w.boxes.personal, thread: w.thread, message: w.msgs.personal, attachment: w.attId, draft: draftId, connection: r.connectionId, user: "", address: `pat.private${w.n}@acme.io`, label: `LABEL-PERS-${w.n}` };
  const words = [`SUBJECT-PERS-${w.n}`, `SNIPPET-pers-${w.n}`, "secret.sender.pers@private.example", `LABEL-PERS-${w.n}`, `DRAFTSUBJ-${w.n}`, `DRAFTBODY-${w.n}`, `COMMENTWORD-${w.n}`,
    r.words.subject, r.words.body, r.words.file, r.words.from, `BYTES-${r.words.subject}`];
  const idMarks = [w.msgs.personal, w.thread, w.attId, draftId, ...r.pat.msgs.map((m) => m.id), ...r.pat.msgs.map((m) => m.threadId), ...r.pat.attIds];
  const pat = { mailboxes: [w.boxes.personal, r.connected], threads: [w.thread, ...r.pat.msgs.map((m) => m.threadId)], messages: [w.msgs.personal, draftId, ...r.pat.msgs.map((m) => m.id)], attachments: [w.attId, ...r.pat.attIds], connections: [r.connectionId] };
  return { w, ids, words, idMarks, pat };
}

/** An answer's body for a walker: the session client, or the walker's v1 key. */
function caller(w: W, keys: Record<string, string>) {
  return async (who: string, c: Client, method: string, path: string, body?: unknown) => {
    if (!path.startsWith("/api/v1")) return within(c.call(method, path, body));
    const key = keys[who];
    if (!key) throw new Error(`no v1 key for ${who}`);
    const send = body !== undefined && method !== "GET" && method !== "DELETE";
    return within(Promise.resolve(w.ctx.app.request(path, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(send ? { "content-type": "application/json" } : {}) }, body: send ? JSON.stringify(body) : undefined }))
      .then(async (res: Response) => ({ status: res.status, body: await res.text() as unknown })));
  };
}

describe("PRIV1a route walk: someone else's personal mailbox", () => {
  it("no route shows or touches it for the workspace owner, an admin, another workspace or a read delegate", async () => {
    const { w, ids, words, idMarks, pat } = await walkWorld();
    const markers = [...idMarks, ...words];
    // The delegate sees it (the walk would prove nothing if nobody could).
    expect(txt((await w.dRead.c.get("/api/mail/messages?folder=inbox")).body)).toContain(w.msgs.personal);

    const routes = [...w.ctx.app.routes, ...r10Routes(new WeakMap()).routes]
      .filter((r) => r.method !== "ALL" && r.path.startsWith("/api/") && !r.path.startsWith("/api/v1/") && !SKIP.test(r.path));
    const v1 = v1Routes().routes.map((r) => ({ method: r.method, path: `/api/v1${r.path === "/" ? "" : r.path}` }));
    const all = [...new Map([...routes, ...v1].map((r) => [`${r.method} ${r.path}`, r])).values()];
    const keys: Record<string, string> = {};
    const walkers: [string, Client][] = [["owner", w.owner], ["admin", w.admin.c], ["outsider", w.outsider], ["dRead", w.dRead.c]];
    for (const [who, c] of walkers) {
      const k = await c.post("/api/developer/keys", { name: "walk" });
      if (k.status === 201) keys[who] = k.body.secret;
    }
    // PRIV1b (F30): a v1 walk that silently lost its keys proved nothing.
    expect(Object.keys(keys).sort()).toEqual(["admin", "outsider", "owner"]); // a member makes no workspace key
    const call = caller(w, keys);
    const outbox = () => (w.ctx.deps.outbound as LogOutbound).sent;
    const patFrom = new Set([`pat.private${w.n}@acme.io`, `pat.gmail${w.n}@gmail.example`]);

    const leaks: string[] = [];
    const answered = new Set<string>(); // routes some walker reached past routing, flags and validation
    const stuck = new Map<string, string>(); // write routes no body got past validation, and why
    let lists = 0;
    let idCalls = 0;
    let limited = 0;
    const slow = new Set<string>(); // PRIV1b: calls past the 2s limit are not checked, so they are counted

    /** One call with a body that passes the route's schema: the rich body first, then one filled from the schema the route refused it with. */
    const write = async (who: string, c: Client, method: string, path: string, ids2: Ids, route: string) => {
      schemaSeen.last = null;
      const fixed = BODIES[`${method} ${route}`];
      // A DELETE reads its target from the query (DELETE /api/mail/labels): Pat's ids and label there too.
      if (method === "DELETE" && !path.includes("?")) path += `?threadId=${ids2.thread}&messageId=${ids2.message}&mailboxId=${ids2.mailbox}&label=${encodeURIComponent(ids2.label ?? "walk")}`;
      let res = await call(who, c, method, path, fixed ? fixed(ids2) : richBody(ids2));
      if (res.status === 422 && schemaSeen.last) {
        let json: unknown;
        try { json = z.toJSONSchema(schemaSeen.last as z.ZodType, { unrepresentable: "any", io: "input" }); } catch { json = null; }
        if (json) res = await call(who, c, method, path, sample(json as never, "", ids2));
      }
      return res;
    };

    // Phase 1: every route that takes an id, and every mail write with ids in the body.
    for (const [who, c] of walkers) {
      const me = { ...ids, user: w.nobody.id }; // a user parameter names a bystander, never the walker or Pat
      let before = await patState(w, pat, who === "dRead");
      for (const r of all) {
        const isV1 = r.path.startsWith("/api/v1");
        if (isV1 && !keys[who]) continue;
        const params = r.path.split("/").filter((s) => s.startsWith(":"));
        if (params.length > 2 || r.path.includes("*")) continue;
        if (params.length && params.every((p) => p === ":token")) continue; // a device push token is the caller's own
        if (who === "dRead" && r.method === "GET") continue; // a read share reads; its writes are what is walked
        if (!params.length && (r.method === "GET" || !MAILISH.test(r.path) || SELF.test(r.path))) continue;
        if (SELF.test(r.path) && r.method !== "GET") continue;
        if (DESIGN.has(`${r.method} ${r.path}`) && who !== "dRead") continue;
        if (params.length && /user|member|delegate/i.test(params[0]!)) continue; // people, not mail (team member pages)
        const sentBefore = outbox().length;
        const choices = params.length ? idsForParam(r.path, params[0]!, me) : [ids.message];
        for (const id of choices) {
          let path = r.path;
          for (const p of params) path = path.replace(p, p === params[0] ? id : idsForParam(r.path, p, me)[0]!);
          path = path.replace(/\{[^}]*\}/g, "");
          const res = r.method === "GET" ? await call(who, c, "GET", path) : await write(who, c, r.method, path, me, r.path);
          idCalls++;
          if (res.status === 429) limited++;
          if (res.status === 0) { slow.add(`${who} ${r.method} ${r.path}`); continue; }
          if (reached(res)) answered.add(`${r.method} ${r.path}`);
          // PRIV1b (W1): a 400 is a body the route refused before its access check, as stuck as a 422.
          if ((res.status === 422 || res.status === 400) && r.method !== "GET") stuck.set(`${r.method} ${r.path}`, txt(res.body).slice(0, 160));
          const text = txt(res.body);
          if (res.status >= 500 && res.status !== 503) { leaks.push(`${who} ${r.method} ${r.path} answered ${res.status}`); continue; }
          if (res.status >= 300 || who === "dRead") continue; // dRead may read; its writes show in the state below
          const hit = markers.find((m) => m !== id && text.includes(m));
          if (hit) { leaks.push(`${who} ${r.method} ${r.path} shows ${hit}`); continue; }
          if (!params.length) continue; // a write of the walker's own (a task, a search): its rows are checked below
          // 2xx: the same call for an id that does not exist. A different answer carries data about Pat's mail.
          const g = ghost(id);
          const ctl = r.method === "GET" ? await call(who, c, "GET", path.split(id).join(g)) : await write(who, c, r.method, path.split(id).join(g), { ...me, [Object.entries(me).find(([, v]) => v === id)?.[0] ?? "message"]: g }, r.path);
          if (ctl.status !== res.status || norm(text, id) !== norm(txt(ctl.body), g)) leaks.push(`${who} ${r.method} ${r.path} answered ${res.status} for Pat's ${Object.entries(me).find(([, v]) => v === id)?.[0]} (${ctl.status} for none)`);
        }
        const after = await patState(w, pat, who === "dRead");
        const diff = changed(before, after);
        if (diff.length) leaks.push(`${who} ${r.method} ${r.path} changed Pat's ${diff.join(", ")}`);
        before = after;
        if (outbox().slice(sentBefore).some((m) => patFrom.has(m.from.address.toLowerCase()))) leaks.push(`${who} ${r.method} ${r.path} sent mail as Pat`);
      }
    }

    // Phase 2: every list route, plain and as a search for the mailbox's words and ids (after the writes, so a copy
    // that a write made somewhere shared shows up too).
    const q = encodeURIComponent(words[0]!);
    const qs = ["", `?q=${q}&search=${q}&query=${q}&mailboxId=${ids.mailbox}&threadId=${ids.thread}&messageId=${ids.message}&ids=${ids.thread},${ids.message}&folder=inbox`];
    for (const [who, c] of walkers.filter(([who]) => who !== "dRead")) {
      for (const r of all) {
        if (r.method !== "GET" || r.path.includes(":") || r.path.includes("*")) continue;
        if (r.path.startsWith("/api/v1") && !keys[who]) continue;
        for (const s of qs) {
          const res = await call(who, c, "GET", r.path + s);
          lists++;
          if (res.status === 429) limited++;
          if (res.status === 0) slow.add(`${who} GET ${r.path}${s ? " (search)" : ""}`);
          if (reached(res)) answered.add(`GET ${r.path}`);
          const text = txt(res.body);
          // A search echoes its own query (and a mailbox filter its id) back: a quoted echo is not a leak.
          const hit = markers.find((m) => text.includes(m) && !(s && (m === words[0] || [ids.mailbox, ids.thread, ids.message].includes(m)) && !text.includes(`"${m}`)));
          if (hit && res.status < 300) leaks.push(`${who} GET ${r.path}${s ? " (search)" : ""} shows ${hit}`);
          if (res.status >= 500 && res.status !== 503) leaks.push(`${who} GET ${r.path}${s ? " (search)" : ""} answered ${res.status}`);
        }
      }
    }
    console.log(`PRIV1a route walk: ${lists} list calls, ${idCalls} id and write calls, ${answered.size} routes reached; ${stuck.size} writes stuck in validation; ${leaks.length} leaks; ${limited} rate limited`);
    if (slow.size) console.log(`slow (not checked): ${[...slow].sort().join(", ")}`);
    if (stuck.size) console.log(`stuck: ${[...stuck.keys()].sort().join(", ")}`);
    if (process.env.WALK_DEBUG) console.log([...stuck].map(([k, v]) => `${k}: ${v}`).join("\n"));
    if (leaks.length) console.log(leaks.join("\n"));
    expect(lists).toBeGreaterThan(600);
    expect(idCalls).toBeGreaterThan(1500);
    // PRIV1b (F30): routes, not calls. With the flags on, the archive, doc inbox, one inbox and Ask routes answer.
    expect(answered.size).toBeGreaterThan(300);
    for (const r of ["POST /api/mail-archive/search", "GET /api/doc-inbox/mailboxes", "GET /api/one-inbox", "POST /api/mail/send", "POST /api/mail/messages/bulk", "POST /api/tasks/from-email", "POST /api/v1/messages"]) {
      if (all.some((x) => `${x.method} ${x.path}` === r)) expect([r, answered.has(r)]).toEqual([r, true]);
    }
    expect(stuck.size).toBeLessThan(60);
    expect(leaks).toEqual([]);
    expect(limited).toBeLessThan(idCalls / 20); // the walk really ran, not into a rate limit
    expect(slow.size).toBeLessThan(10);

    // Pat's mail is untouched by the walk, and Pat still reads it.
    const mine = await w.pat.c.get(`/api/mail/messages/${w.msgs.personal}`);
    expect(mine.status).toBe(200);
    expect(mine.body.message.folder).toBe("inbox");
  }, 600_000);

  it("no MCP tool shows or touches it for the workspace owner's, an admin's or an agent's key", async () => {
    const { w, ids, words, idMarks, pat } = await walkWorld();
    const markers = [...idMarks, ...words];
    const keys: Record<string, string> = {};
    keys.owner = (await w.owner.post("/api/developer/keys", { name: "walk" })).body.secret;
    keys.admin = (await w.admin.c.post("/api/developer/keys", { name: "walk" })).body.secret;
    // PRIV1b: an agent key walks too (an agent on the team mailbox). A member or delegate can't make a key at all
    // (developer keys need an admin), so a read share has no MCP surface to walk.
    const agent = await w.admin.c.post("/api/agents", { name: "Walk bot", localPart: `walkbot${w.n}`, approvalMode: "never", mailboxIds: [w.boxes.team] });
    expect(agent.status).toBe(201);
    keys.agent = agent.body.apiKey.secret as string;
    // MCP: each key calls every tool with arguments that pass its input schema (PRIV1b, F24: filled by `sample`, with
    // Pat's ids wherever an argument names one), once with the message id and once with the thread id for a generic id.
    const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const mcpLeaks: string[] = [];
    const reached = new Set<string>();
    let mcpTried = 0;
    let tools = 0;
    for (const who of ["owner", "admin", "agent"] as const) {
      const me = { ...ids, user: w.nobody.id };
      const mcp = new McpClient({ name: "priv1a", version: "1" });
      const fetchViaApp = ((url: string | URL, init?: RequestInit) => w.ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
      await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${keys[who]}` } }, fetch: fetchViaApp }));
      const list = (await mcp.listTools()).tools;
      tools = Math.max(tools, list.length);
      let before = await patState(w, pat);
      for (const t of list) {
        const generic = Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).some((k) => /^id$|^ids$/.test(k));
        for (const message of generic ? [ids.message, ids.thread] : [ids.message]) {
          const args = sample(t.inputSchema as never, "", { ...me, message }) as Record<string, unknown>;
          mcpTried++;
          const out = await within(mcp.callTool({ name: t.name, arguments: args }).then((x) => ({ status: 200, body: x })).catch((e: Error) => ({ status: 400, body: e.message })));
          const text = txt(out.body);
          if (!/Input validation error|Invalid arguments/.test(text)) reached.add(t.name);
          const hit = markers.find((m) => text.includes(m) && !Object.values(args).flat().includes(m));
          if (hit && !(out.body as { isError?: boolean })?.isError) mcpLeaks.push(`${who} mcp ${t.name} shows ${hit}`);
        }
        const after = await patState(w, pat);
        const diff = changed(before, after);
        if (diff.length) mcpLeaks.push(`${who} mcp ${t.name} changed Pat's ${diff.join(", ")}`);
        before = after;
      }
      await mcp.close();
    }
    console.log(`PRIV1a MCP walk: ${mcpTried} calls over ${tools} tools, ${reached.size} reached past validation; ${mcpLeaks.length} leaks`);
    if (mcpLeaks.length) console.log(mcpLeaks.join("\n"));
    expect(mcpTried).toBeGreaterThan(200);
    // PRIV1b (F24): nearly every tool now gets past its own input validation (set_mailbox_reply_to, search, reply...).
    for (const name of ["search", "search_everything", "reply", "send_email", "set_mailbox_reply_to", "set_thread_status", "add_thread_comment", "mail_bulk_action", "schedule_send", "catchup_get"]) {
      expect([name, reached.has(name)]).toEqual([name, true]);
    }
    expect(reached.size).toBeGreaterThan(tools - 20);
    expect(mcpLeaks).toEqual([]);
  }, 300_000);
});
