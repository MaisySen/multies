/**
 * OPS1 security review L2: live sockets never outlive an impersonation. When it ends (Stop, the console's End, its
 * expiry, a demoted operator) the sockets that session opened close, and a doc socket's edit re-checks the
 * impersonation row first. Node paths run for real here (MemoryChatHub, the ws doc rooms); the Durable Object paths are
 * checked through their fetch and message handlers with fake state (not run on Workers).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs } from "./console-kit";
import { members, operatorImpersonations, sessions } from "@/server/db/schema";
import { clearAuthCache } from "@/server/auth/guards";
import { chatLiveAccess } from "@/server/realtime/access";
import { CLOSE_REVOKED, deliver, MemoryChatHub, type HubConn } from "@/server/realtime/hub";
import { ChatHub } from "@/server/realtime/chat-hub-do";
import { attachCollab } from "@/server/collab/node";
import { DocRoom } from "@/server/collab/durable-object";
import { MESSAGE_SYNC } from "@/server/collab/room";

const REASON = "Ticket 9001: checking live chat and docs";
const WS = { upgrade: "websocket", origin: "http://localhost", host: "localhost" };

async function world(mode: "view" | "act" = "act") {
  const ctx = await makeTestApp();
  const owner = await signUpAs(ctx, "owner@ops.test", "admin", "Ops");
  const op = await signUpAs(ctx, `op.${mode}@ops.test`, mode === "act" ? "ops_admin" : "ops_support", "OpCo");
  const target = await signUpAs(ctx, "tara@example.com", null, "Target Co");
  const orgId = (await ctx.db.select().from(members).where(eq(members.userId, target.id)).get())!.organizationId;
  const opCookie = op.c.cookie;
  const r = await op.c.post("/api/console/impersonation", { userId: target.id, mode, reason: REASON });
  if (r.status !== 201) throw new Error(`start failed ${r.status} ${JSON.stringify(r.body)}`);
  const imp = (await ctx.db.select().from(operatorImpersonations).where(eq(operatorImpersonations.operatorUserId, op.id)).get())!;
  return { ctx, owner, op, target, orgId, imp, opCookie };
}

function conn(userId: string, extra: Partial<HubConn> = {}) {
  const closed: number[] = [];
  const c: HubConn = { userId, openedAt: Date.now(), send: () => undefined, close: (code) => { closed.push(code); }, ...extra };
  return { c, closed };
}

/** The impersonation session's chat socket and the person's own, joined to a MemoryChatHub as the Node entry does. */
async function chatSockets(w: Awaited<ReturnType<typeof world>>) {
  const hub = new MemoryChatHub();
  w.ctx.deps.chatLive = hub;
  const access = await chatLiveAccess(w.ctx.deps, new Request("http://localhost/api/chat/live", { headers: { ...WS, cookie: w.op.c.cookie } }));
  if (!access.ok) throw new Error("no access");
  expect(access.sessionId).toBe(w.imp.sessionId);
  expect(access.until).toBe(w.imp.expiresAt.getTime());
  const imp = conn(w.target.id, { sessionId: access.sessionId, until: access.until });
  const own = conn(w.target.id, { sessionId: "ses_the_persons_own" });
  hub.join(w.orgId, imp.c);
  hub.join(w.orgId, own.c);
  return { hub, imp, own };
}

describe("L2: chat sockets (Node hub)", () => {
  it("Stop closes the impersonation's socket, not the person's own", async () => {
    const w = await world();
    const { hub, imp, own } = await chatSockets(w);
    expect((await w.op.c.post("/api/console/impersonation/stop")).status).toBe(200);
    expect(imp.closed).toEqual([CLOSE_REVOKED]);
    expect(own.closed).toEqual([]);
    expect([...(hub.hubs.get(w.orgId) ?? [])]).toEqual([own.c]);
  }, 90_000);

  it("the console's End closes it", async () => {
    const w = await world();
    const { imp, own } = await chatSockets(w);
    expect((await w.owner.c.post(`/api/console/impersonation/${w.imp.id}/end`, { reason: "Ending this support session" })).status).toBe(200);
    expect(imp.closed).toEqual([CLOSE_REVOKED]);
    expect(own.closed).toEqual([]);
  }, 90_000);

  it("a demoted operator's impersonation ends and its socket closes at once", async () => {
    const w = await world("act");
    const { imp } = await chatSockets(w);
    expect((await w.owner.c.call("PATCH", `/api/console/operators/${w.op.id}`, { role: "ops_readonly", reason: "Moving to read only" })).status).toBe(200);
    expect(imp.closed).toEqual([CLOSE_REVOKED]);
    const row = (await w.ctx.db.select().from(operatorImpersonations).where(eq(operatorImpersonations.id, w.imp.id)).get())!;
    expect(row.endedReason).toBe("revoked");
    expect(await w.ctx.db.select().from(sessions).where(eq(sessions.id, w.imp.sessionId!)).get()).toBeUndefined();
  }, 90_000);

  it("an expiry detected on the session's next request closes it; and the hub never delivers past the expiry", async () => {
    const w = await world();
    const { imp, own } = await chatSockets(w);
    await w.ctx.db.update(operatorImpersonations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(operatorImpersonations.id, w.imp.id));
    clearAuthCache();
    expect((await w.op.c.get("/api/account/me")).status).toBe(401);
    expect(imp.closed).toEqual([CLOSE_REVOKED]);
    expect(own.closed).toEqual([]);
    // deliver() alone: a socket past its `until` is closed instead of sent to.
    const late = conn("u1", { until: Date.now() - 1 });
    const sent = deliver([late.c], { all: true }, { t: "changes", cursor: 1 }, Date.now());
    expect(sent).toBe(0);
    expect(late.closed).toEqual([CLOSE_REVOKED]);
  }, 90_000);

  it("the ChatHub Durable Object closes one session's sockets on /kick { sessionId } (the ban path's /kick)", async () => {
    const sockets: { att: unknown; closed: number[] }[] = [];
    const make = (att: unknown) => { const s = { att, closed: [] as number[], send: () => undefined, close: (code: number) => { s.closed.push(code); }, serializeAttachment: (v: unknown) => { s.att = v; }, deserializeAttachment: () => s.att }; sockets.push(s); return s; };
    const hub = new ChatHub({ acceptWebSocket: () => undefined, getWebSockets: () => sockets as never } as never, {});
    const a = make({ userId: "u1", openedAt: Date.now(), sessionId: "ses_imp" });
    const b = make({ userId: "u1", openedAt: Date.now(), sessionId: "ses_own" });
    const res = await hub.fetch(new Request("https://chat-hub/kick", { method: "POST", body: JSON.stringify({ sessionId: "ses_imp" }) }));
    expect(await res.json()).toEqual({ closed: 1 });
    expect(a.closed).toEqual([CLOSE_REVOKED]);
    expect(b.closed).toEqual([]);
  });
});

function updateMessage(text: string) {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, text);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(enc);
}

async function personDoc(ctx: Awaited<ReturnType<typeof makeTestApp>>): Promise<string> {
  const c = new Client(ctx.app);
  expect((await c.login("tara@example.com")).status).toBe(200);
  const d = await c.post("/api/docs", { title: "Plan" });
  return d.body?.doc?.id ?? d.body?.id;
}

describe("L2: doc co-editing sockets (Node, real ws)", () => {
  let server: Server | undefined;
  afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined; });

  async function open(w: Awaited<ReturnType<typeof world>>, docId: string) {
    server = createServer(getRequestListener(w.ctx.app.fetch));
    const collab = attachCollab(server, w.ctx.app, w.ctx.deps);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/docs/${docId}/collab`, { headers: { cookie: w.op.c.cookie, origin: `http://127.0.0.1:${port}` } });
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => { ws.on("open", () => resolve()); ws.on("error", reject); });
    return { ws, closed, collab };
  }

  it("Stop closes the impersonation's doc socket", async () => {
    const w = await world("act");
    const docId = await personDoc(w.ctx);
    const { closed } = await open(w, docId);
    expect((await w.op.c.post("/api/console/impersonation/stop")).status).toBe(200);
    expect(await closed).toBe(4003);
  }, 90_000);

  it("an edit after the impersonation ended elsewhere is refused: the row is re-checked and the socket closes", async () => {
    const w = await world("act");
    const docId = await personDoc(w.ctx);
    const { ws, closed, collab } = await open(w, docId);
    // Ended in another isolate (no kick here): only the re-check can catch it.
    await w.ctx.db.update(operatorImpersonations).set({ endedAt: new Date(), endedReason: "revoked" }).where(eq(operatorImpersonations.id, w.imp.id));
    ws.send(updateMessage("typed after the end"));
    expect(await closed).toBe(4003);
    const room = collab.rooms.get(docId)!;
    expect(room.doc.getText("t").toString()).toBe("");
  }, 90_000);

  it("while the impersonation is active an edit goes through", async () => {
    const w = await world("act");
    const docId = await personDoc(w.ctx);
    const { ws, collab } = await open(w, docId);
    ws.send(updateMessage("support fixed a typo"));
    for (let i = 0; i < 50 && collab.rooms.get(docId)!.doc.getText("t").toString() === ""; i++) await new Promise((r) => setTimeout(r, 20));
    expect(collab.rooms.get(docId)!.doc.getText("t").toString()).toBe("support fixed a typo");
    ws.close();
  }, 90_000);

  it("the DocRoom Durable Object re-checks the row before an edit and closes the socket (fake state and D1)", async () => {
    let ended = false;
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ ended_at: ended ? Date.now() : null, expires_at: Date.now() + 60_000 }) }) }) };
    const rows: unknown[] = [];
    const storage = { sql: { exec: () => Object.assign(rows, { toArray: () => [] }) }, transactionSync: (fn: () => unknown) => fn(), setAlarm: async () => undefined, deleteAlarm: async () => undefined, deleteAll: async () => undefined };
    const sockets: { att: unknown; closed: number[] }[] = [];
    const ws = { att: { readOnly: false, ids: [], imp: { id: "imp_1", until: Date.now() + 60_000 } } as unknown, closed: [] as number[], send: () => undefined, close: (code: number) => { ws.closed.push(code); }, serializeAttachment: (v: unknown) => { ws.att = v; }, deserializeAttachment: () => ws.att };
    sockets.push(ws);
    const room = new DocRoom({ storage, acceptWebSocket: () => undefined, getWebSockets: () => sockets as never } as never, { DB: db });
    const m = updateMessage("ok");
    await room.webSocketMessage(ws as never, m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) as ArrayBuffer);
    expect(ws.closed).toEqual([]);
    ended = true;
    await room.webSocketMessage(ws as never, m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) as ArrayBuffer);
    expect(ws.closed).toEqual([4003]);
  });
});
