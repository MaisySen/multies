import { describe, it, expect } from "vitest";
import { privacyWorld } from "./priv1a-world";
import { v1Routes } from "@/server/routes/v1";
import { r10Routes } from "@/server/routes/suite-r10";
import type { Client } from "./helpers";

// PRIV1a (MB-366): the route walk. Pat's personal (connected) mailbox must not reach anyone but Pat and the people
// Pat shared it with. The workspace's OWNER, an ADMIN and another workspace's person walk EVERY API route the app
// registers (enumerated from the router, never a hand list): list routes must not carry any of the mailbox's ids
// or words, and every route that takes an id, given the mailbox's message, thread or attachment id, must refuse
// (403/404, never 2xx or 5xx). A new route that forgets the mailbox rule fails here.

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

describe("PRIV1a route walk: someone else's personal mailbox", () => {
  it("no route shows or touches it for the workspace owner, an admin or another workspace", async () => {
    const w = await privacyWorld();
    noLimits(w);
    const thread = `thr_pers${w.n}aaaaaaaaaa`;
    // Pat uses the mailbox a little, so list routes have something to leak.
    await w.pat.c.get(`/api/mail/messages/${w.msgs.personal}`);
    await w.pat.c.post("/api/mail/labels", { threadId: thread, label: `LABEL-PERS-${w.n}` });
    await w.pat.c.patch(`/api/mail/messages/${w.msgs.personal}`, { isStarred: true });
    const markers = [w.msgs.personal, thread, w.attId, `SUBJECT-PERS-${w.n}`, `SNIPPET-pers-${w.n}`, "secret.sender.pers@private.example", `LABEL-PERS-${w.n}`];
    // The delegate sees it (the walk would prove nothing if nobody could).
    expect(JSON.stringify((await w.dRead.c.get("/api/mail/messages?folder=inbox")).body)).toContain(w.msgs.personal);

    const routes = [...w.ctx.app.routes, ...r10Routes(new WeakMap()).routes]
      .filter((r) => r.method !== "ALL" && r.path.startsWith("/api/") && !r.path.startsWith("/api/v1/") && !SKIP.test(r.path));
    const v1 = v1Routes().routes.map((r) => ({ method: r.method, path: `/api/v1${r.path === "/" ? "" : r.path}` }));
    const keys: Record<string, string> = {};
    for (const who of ["owner", "admin", "outsider"] as const) {
      const c = who === "owner" ? w.owner : who === "admin" ? w.admin.c : w.outsider;
      const k = await c.post("/api/developer/keys", { name: "walk" });
      if (k.status === 201) keys[who] = k.body.secret;
    }
    const callV1 = async (who: string, method: string, path: string) => {
      const key = keys[who];
      if (!key) return { status: 0, body: null };
      const r = await w.ctx.app.request(path, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(method === "GET" || method === "DELETE" ? {} : { "content-type": "application/json" }) }, body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ text: "x", label: "x" }) });
      const t = await r.text();
      return { status: r.status, body: t as unknown };
    };
    const leaks: string[] = [];
    let lists = 0;
    let ids = 0;
    let limited = 0;
    const walkers: [string, Client][] = [["owner", w.owner], ["admin", w.admin.c], ["outsider", w.outsider]];
    for (const [who, c] of walkers) {
      for (const r of [...routes, ...v1]) {
        const isV1 = r.path.startsWith("/api/v1");
        const params = r.path.split("/").filter((s) => s.startsWith(":"));
        if (!params.length) {
          if (r.method !== "GET" || r.path.includes("*")) continue;
          // Plain, then as a search for the mailbox's own words (search, command bar, AI answers).
          for (const qs of ["", `?q=${encodeURIComponent(markers[3]!)}&search=${encodeURIComponent(markers[3]!)}&query=${encodeURIComponent(markers[3]!)}&mailboxId=${w.boxes.personal}`]) {
            const res = await within(isV1 ? callV1(who, "GET", r.path + qs) : c.get(r.path + qs));
            lists++;
            if (res.status === 429) limited++;
            const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? "");
            const hit = markers.find((m) => text.includes(m) && !(qs && (m === markers[3] || m === w.boxes.personal) && !text.includes(`"${m}`) ));
            if (hit) leaks.push(`${who} GET ${r.path}${qs ? " (search)" : ""} shows ${hit}`);
          }
          continue;
        }
        if (params.length > 2) continue;
        // A device push token is the caller's own (DELETE forgets the caller's device whatever the value): not a mail id.
        if (params.every((p) => p === ":token")) continue;
        // Every id parameter gets the mailbox's message, then thread, then attachment id.
        for (const id of [w.msgs.personal, thread, w.attId]) {
          let path = r.path;
          for (const p of params) path = path.replace(p, id);
          path = path.replace(/\{[^}]*\}/g, "");
          const body = ["GET", "HEAD", "DELETE"].includes(r.method) ? undefined : { name: "x", title: "x", text: "x", body: "x", label: "x" };
          const res = await within(isV1 ? callV1(who, r.method, path) : c.call(r.method, path, body));
          ids++;
          if (res.status === 429) limited++;
          if (res.status === 0) continue;
          const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? "");
          const hit = markers.slice(3).find((m) => text.includes(m));
          if (hit) leaks.push(`${who} ${r.method} ${r.path} shows ${hit}`);
          else if (res.status >= 500) leaks.push(`${who} ${r.method} ${r.path} answered ${res.status}`);
          else if (res.status < 400 && r.method !== "GET") leaks.push(`${who} ${r.method} ${r.path} answered ${res.status}`);
          else if (res.status < 400 && markers.slice(0, 3).some((m) => text.includes(m) && m !== id)) leaks.push(`${who} ${r.method} ${r.path} answered ${res.status} with the mailbox's ids`);
        }
      }
    }
    console.log(`PRIV1a route walk: ${lists} list routes and ${ids} id calls by owner, admin and outsider; ${leaks.length} leaks; ${limited} rate limited`);
    if (leaks.length) console.log(leaks.join("\n"));
    expect(lists).toBeGreaterThan(600);
    expect(ids).toBeGreaterThan(1000);
    expect(leaks).toEqual([]);
    expect(limited).toBeLessThan(ids / 20); // the walk really ran, not into a rate limit

    // Pat's mail is untouched by the walk.
    const mine = await w.pat.c.get(`/api/mail/messages/${w.msgs.personal}`);
    expect(mine.status).toBe(200);
    expect(mine.body.message.folder).toBe("inbox");
  }, 600_000);

  it("no MCP tool shows it to the workspace owner's or an admin's key", async () => {
    const w = await privacyWorld();
    noLimits(w);
    const thread = `thr_pers${w.n}aaaaaaaaaa`;
    await w.pat.c.post("/api/mail/labels", { threadId: thread, label: `LABEL-PERS-${w.n}` });
    const markers = [w.msgs.personal, thread, w.attId, `SUBJECT-PERS-${w.n}`, `SNIPPET-pers-${w.n}`, "secret.sender.pers@private.example", `LABEL-PERS-${w.n}`];
    const keys: Record<string, string> = {};
    keys.owner = (await w.owner.post("/api/developer/keys", { name: "walk" })).body.secret;
    keys.admin = (await w.admin.c.post("/api/developer/keys", { name: "walk" })).body.secret;
    // MCP: an admin's workspace key calls every tool. Id arguments get the mailbox's ids; list tools run with no
    // arguments. No answer may carry the mailbox's ids or words.
    const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const mcpLeaks: string[] = [];
    let mcpTried = 0;
    for (const who of ["owner", "admin"] as const) {
      const mcp = new McpClient({ name: "priv1a", version: "1" });
      const fetchViaApp = ((url: string | URL, init?: RequestInit) => w.ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
      await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${keys[who]}` } }, fetch: fetchViaApp }));
      for (const t of (await mcp.listTools()).tools) {
        const props = (t.inputSchema as { properties?: Record<string, unknown>; required?: string[] }).properties ?? {};
        const idArgs = Object.keys(props).filter((k) => /Id$|^id$/.test(k));
        for (const id of idArgs.length ? [w.msgs.personal, thread] : [null]) {
          const args: Record<string, unknown> = {};
          for (const k of idArgs) args[k] = k === "mailboxId" ? w.boxes.personal : id;
          if (/send|delete|remove|archive|trash|move/.test(t.name) && !idArgs.length) continue; // writes with no target: nothing of Pat's to aim at
          mcpTried++;
          const out = await within(mcp.callTool({ name: t.name, arguments: args }).then((x) => ({ status: 200, body: x })).catch((e: Error) => ({ status: 400, body: e.message })));
          const text = JSON.stringify(out.body ?? "");
          const hit = markers.find((m) => text.includes(m) && m !== id);
          if (hit && !(out.body as { isError?: boolean })?.isError) mcpLeaks.push(`${who} mcp ${t.name} shows ${hit}`);
        }
      }
      await mcp.close();
    }
    console.log(`PRIV1a route walk: ${mcpTried} MCP tool calls; ${mcpLeaks.length} leaks`);
    if (mcpLeaks.length) console.log(mcpLeaks.join("\n"));
    expect(mcpTried).toBeGreaterThan(30);
    expect(mcpLeaks).toEqual([]);
  }, 300_000);
});
